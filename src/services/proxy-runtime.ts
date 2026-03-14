import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as Semaphore from "effect/Semaphore";

import * as Scope from "effect/Scope";

import type {
  AccountRecord,
  ModelCatalogEntry,
} from "#/domain/accounts/account-types";
import {
  ModelUnavailableError,
  ProxyRuntimeUnavailableError,
} from "#/domain/models/runtime-types";
import type {
  ProxyApiSurface,
  ProxyRuntime,
  ProxyRuntimeDependencies,
  ProxyRuntimeHealthSnapshot,
  ProxyRuntimeRefreshResult,
  ProxyRuntimeRequest,
  ProxyRuntimeSchedulerOptions,
  ProxyRuntimeStreamRequest,
  RuntimeModelDescriptor,
} from "#/domain/models/runtime-types";
import {
  ModelRoutingRegistry,
  alternateApiSurface,
  isUnsupportedApiSurfaceError,
} from "#/services/model-routing";

const DEFAULT_POOL_SYNC_INTERVAL_MS = 5000;
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 60_000;
const DEFAULT_SINGLE_ACCOUNT_RATE_LIMIT_COOLDOWN_MS = 8000;
const DEFAULT_FAILURE_COOLDOWN_MS = 15_000;
const DEFAULT_MAX_RETRY_ATTEMPTS = 3;
const DEFAULT_TOKEN_REFRESH_BUFFER_SECONDS = 60;

interface RuntimeEntry {
  account: AccountRecord;
  activeRequests: number;
  activeStreams: number;
  cooldownUntil: Date | null;
  readonly refreshLock: AsyncMutex;
  removed: boolean;
}

interface RuntimeLease {
  readonly accountId: string;
  readonly entry: RuntimeEntry;
  forceRefreshed: boolean;
  readonly isStream: boolean;
}

interface RetryDecision {
  readonly retryOtherAccount: boolean;
  readonly retrySameAccount: boolean;
}

interface StreamSurfaceFailure {
  readonly _tag: "StreamSurfaceFailure";
  readonly cause: unknown;
  readonly yielded: boolean;
}

type AsyncMutex = Semaphore.Semaphore;

const makeMutex = (): AsyncMutex => Semaphore.makeUnsafe(1);

const withLock = <A, E, R>(
  mutex: AsyncMutex,
  effect: () => Effect.Effect<A, E, R>
): Effect.Effect<A, E, R> => mutex.withPermit(effect());

const makeStreamSurfaceFailure = (
  cause: unknown,
  yielded: boolean
): StreamSurfaceFailure => ({
  _tag: "StreamSurfaceFailure",
  cause,
  yielded,
});

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : `Unexpected error: ${String(error)}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asRecord = (value: unknown): Record<string, unknown> | null =>
  isRecord(value) ? value : null;

const isHeaderEntry = (value: unknown): value is readonly [unknown, unknown] =>
  Array.isArray(value) && value.length >= 2;

const isStreamSurfaceFailure = (
  error: unknown
): error is StreamSurfaceFailure =>
  typeof error === "object" &&
  error !== null &&
  !Array.isArray(error) &&
  "_tag" in error &&
  error._tag === "StreamSurfaceFailure" &&
  "yielded" in error &&
  typeof error.yielded === "boolean" &&
  "cause" in error;

const streamFailureCause = (error: unknown): unknown =>
  isStreamSurfaceFailure(error) ? error.cause : error;

const readString = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

const readNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const normalizedModel = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim() ?? "";
  return trimmed.length === 0 ? null : trimmed;
};

const maxDate = (left: Date | null, right: Date | null): Date | null => {
  if (left === null) {
    return right;
  }

  if (right === null) {
    return left;
  }

  return left.getTime() >= right.getTime() ? left : right;
};

const normalizeModelCatalog = (
  models: readonly RuntimeModelDescriptor[]
): readonly ModelCatalogEntry[] => {
  const catalog: ModelCatalogEntry[] = [];
  const seen = new Set<string>();

  for (const model of models) {
    const modelId = model.id.trim();
    if (modelId.length === 0 || seen.has(modelId)) {
      continue;
    }

    seen.add(modelId);
    catalog.push({
      hidden: model.hidden ?? false,
      modelId,
      vendor: model.vendor?.trim() ?? "",
    });
  }

  return catalog;
};

const modelCatalogToDescriptors = (
  catalog: readonly ModelCatalogEntry[]
): readonly RuntimeModelDescriptor[] =>
  catalog.map((model) => ({
    hidden: model.hidden,
    id: model.modelId,
    vendor: model.vendor,
  }));

const extractStatusCode = (error: unknown): number | null => {
  const root = asRecord(error);
  const response = asRecord(root?.response);

  return (
    readNumber(root?.statusCode) ??
    readNumber(root?.status) ??
    readNumber(response?.statusCode) ??
    readNumber(response?.status)
  );
};

const headerValue = (headers: unknown, name: string): string | null => {
  const lowered = name.toLowerCase();

  if (headers instanceof Headers) {
    return headers.get(name);
  }

  if (headers instanceof Map) {
    for (const [key, value] of headers.entries()) {
      if (String(key).toLowerCase() === lowered) {
        return String(value);
      }
    }
    return null;
  }

  if (Array.isArray(headers)) {
    for (const entry of headers) {
      if (!isHeaderEntry(entry)) {
        continue;
      }

      const [key, value] = entry;
      if (String(key).toLowerCase() === lowered) {
        return String(value);
      }
    }

    return null;
  }

  const record = asRecord(headers);
  if (record === null) {
    return null;
  }

  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase() === lowered) {
      return readString(value) ?? String(value);
    }
  }

  return null;
};

const extractRetryAfter = (error: unknown): string | null => {
  const root = asRecord(error);
  const response = asRecord(root?.response);

  return (
    headerValue(root?.headers, "retry-after") ??
    headerValue(response?.headers, "retry-after")
  );
};

const isInvalidOrExpiredTokenError = (error: unknown): boolean =>
  describeError(error).toLowerCase().includes("invalid or expired");

const isTransientRequestError = (error: unknown): boolean => {
  const root = asRecord(error);
  const tag =
    readString(root?.name) ?? (error instanceof Error ? error.name : "");
  if (tag === "AbortError") {
    return false;
  }

  if (tag === "TypeError") {
    return true;
  }

  return root?.requestError === true || root?.networkError === true;
};

const looksRateLimited = (message: string): boolean => {
  const lowered = message.toLowerCase();
  return (
    lowered.includes(" 429") ||
    lowered.includes("rate limit") ||
    lowered.includes("rate-limit") ||
    lowered.includes("rate_limited") ||
    lowered.includes("too many requests") ||
    lowered.includes("token usage")
  );
};

const defaultSchedulerOptions = (
  scheduler: ProxyRuntimeSchedulerOptions | undefined
): Required<ProxyRuntimeSchedulerOptions> => ({
  failureCooldownMs:
    scheduler?.failureCooldownMs ?? DEFAULT_FAILURE_COOLDOWN_MS,
  maxRetryAttempts: scheduler?.maxRetryAttempts ?? DEFAULT_MAX_RETRY_ATTEMPTS,
  rateLimitCooldownMs:
    scheduler?.rateLimitCooldownMs ?? DEFAULT_RATE_LIMIT_COOLDOWN_MS,
  singleAccountRateLimitCooldownMs:
    scheduler?.singleAccountRateLimitCooldownMs ??
    DEFAULT_SINGLE_ACCOUNT_RATE_LIMIT_COOLDOWN_MS,
  syncIntervalMs: scheduler?.syncIntervalMs ?? DEFAULT_POOL_SYNC_INTERVAL_MS,
  tokenRefreshBufferSeconds:
    scheduler?.tokenRefreshBufferSeconds ??
    DEFAULT_TOKEN_REFRESH_BUFFER_SECONDS,
});

export const makeProxyRuntime = (
  dependencies: ProxyRuntimeDependencies
): ProxyRuntime => {
  const scheduler = defaultSchedulerOptions(dependencies.scheduler);
  const now = dependencies.now ?? (() => new Date());
  const routing = new ModelRoutingRegistry();
  const entries = new Map<string, RuntimeEntry>();
  const selectionLock = makeMutex();
  let lastSyncAt = 0;

  const nowDate = () => now();
  const nowMs = () => nowDate().getTime();

  const tokenValid = (entry: RuntimeEntry): boolean => {
    const expiresAt = entry.account.copilotTokenExpiresAt;
    if (!entry.account.copilotToken || expiresAt === null) {
      return false;
    }

    return (
      expiresAt.getTime() > nowMs() + scheduler.tokenRefreshBufferSeconds * 1000
    );
  };

  const surfaceOrder = (
    model: string | null,
    requestedApi: ProxyApiSurface,
    allowUnsupportedSurfaceFallback: boolean
  ): readonly ProxyApiSurface[] => {
    const preferred = routing.preferredApi(model, requestedApi);
    if (!allowUnsupportedSurfaceFallback) {
      return [preferred];
    }

    const alternate = alternateApiSurface(preferred);
    return alternate === preferred ? [preferred] : [preferred, alternate];
  };

  const syncAccounts = (options?: {
    readonly force?: boolean;
  }): Effect.Effect<void, unknown> =>
    Effect.gen(function* syncAccountsEffect() {
      const current = nowMs();
      if (
        !(options?.force ?? false) &&
        current - lastSyncAt < scheduler.syncIntervalMs
      ) {
        return;
      }

      const accounts = yield* dependencies.repository.listAccounts();
      yield* withLock(selectionLock, () =>
        Effect.sync(() => {
          const seen = new Set<string>();

          for (const account of accounts) {
            seen.add(account.accountId);
            const existing = entries.get(account.accountId);
            if (existing) {
              existing.account = account;
              existing.cooldownUntil = maxDate(
                existing.cooldownUntil,
                account.cooldownUntil
              );
              existing.removed = false;
              continue;
            }

            entries.set(account.accountId, {
              account,
              activeRequests: 0,
              activeStreams: 0,
              cooldownUntil: account.cooldownUntil,
              refreshLock: makeMutex(),
              removed: false,
            });
          }

          for (const [accountId, entry] of entries) {
            if (seen.has(accountId)) {
              continue;
            }

            if (entry.activeRequests === 0) {
              entries.delete(accountId);
              continue;
            }

            entry.removed = true;
          }

          lastSyncAt = current;
        })
      );
    });

  const candidateEntries = (options: {
    readonly excludeAccountIds: ReadonlySet<string>;
  }): Effect.Effect<readonly RuntimeEntry[], unknown> =>
    Effect.gen(function* candidateEntriesEffect() {
      const candidates = [...entries.values()]
        .filter(
          (entry) => !options.excludeAccountIds.has(entry.account.accountId)
        )
        .toSorted((left, right) => {
          if (left.account.priority !== right.account.priority) {
            return left.account.priority - right.account.priority;
          }

          const createdAtDelta =
            left.account.createdAt.getTime() -
            right.account.createdAt.getTime();
          if (createdAtDelta !== 0) {
            return createdAtDelta;
          }

          return left.account.accountId.localeCompare(right.account.accountId);
        });

      const strategy = yield* dependencies.repository.getRotationStrategy();
      if (strategy !== "round-robin" || candidates.length === 0) {
        return candidates;
      }

      const offset = yield* dependencies.repository.nextRoundRobinOffset(
        candidates.length
      );
      const cursor = offset % candidates.length;
      return [...candidates.slice(cursor), ...candidates.slice(0, cursor)];
    });

  const persistRefreshedAccount = (
    entry: RuntimeEntry,
    refreshed: ProxyRuntimeRefreshResult
  ): Effect.Effect<void, unknown> =>
    Effect.gen(function* persistRefreshedAccountEffect() {
      const apiBaseUrl =
        refreshed.apiBaseUrl.trim().length > 0
          ? refreshed.apiBaseUrl
          : entry.account.apiBaseUrl;

      entry.account = {
        ...entry.account,
        apiBaseUrl,
        copilotToken: refreshed.copilotToken,
        copilotTokenExpiresAt: refreshed.copilotTokenExpiresAt,
        reauthRequired: false,
      };

      yield* dependencies.repository.updateTokens(entry.account.accountId, {
        ...refreshed,
        apiBaseUrl,
      });
    });

  const persistModelCatalog = (
    entry: RuntimeEntry,
    models: readonly RuntimeModelDescriptor[]
  ): Effect.Effect<void, unknown> => {
    const catalog = normalizeModelCatalog(models);
    entry.account = {
      ...entry.account,
      modelCatalog: catalog,
      modelIds: catalog.map((model) => model.modelId),
    };
    routing.observeModels(modelCatalogToDescriptors(catalog));
    return dependencies.repository.updateModels(
      entry.account.accountId,
      catalog
    );
  };

  const forceRefreshEntry = (
    entry: RuntimeEntry
  ): Effect.Effect<void, unknown> =>
    withLock(entry.refreshLock, () =>
      Effect.gen(function* forceRefreshEntryEffect() {
        if (tokenValid(entry)) {
          return;
        }

        const refreshed = yield* dependencies.hooks.refreshAccount({
          account: entry.account,
        });
        yield* persistRefreshedAccount(entry, refreshed);
      })
    );

  const prepareEntry = (
    entry: RuntimeEntry,
    model: string | null
  ): Effect.Effect<void, unknown> =>
    Effect.gen(function* prepareEntryEffect() {
      if (!tokenValid(entry)) {
        yield* forceRefreshEntry(entry);
      }

      if (
        model === null ||
        entry.account.modelIds.length === 0 ||
        entry.account.modelIds.includes(model) ||
        dependencies.hooks.listAccountModels === undefined
      ) {
        return;
      }

      const models = yield* dependencies.hooks.listAccountModels({
        account: entry.account,
      });
      yield* persistModelCatalog(entry, models);
      if (entry.account.modelIds.includes(model)) {
        return;
      }

      yield* Effect.fail(
        new ModelUnavailableError({
          accountId: entry.account.accountId,
          message: `Account '${entry.account.label}' does not expose model '${model}'.`,
          modelId: model,
        })
      );
    });

  const cooldownActive = (
    entry: RuntimeEntry,
    currentTime = nowDate()
  ): boolean => {
    const cooldownUntil = maxDate(
      entry.cooldownUntil,
      entry.account.cooldownUntil
    );
    entry.cooldownUntil = cooldownUntil;
    return (
      cooldownUntil !== null && cooldownUntil.getTime() > currentTime.getTime()
    );
  };

  const markSuccess = (entry: RuntimeEntry): Effect.Effect<void, unknown> =>
    Effect.gen(function* markSuccessEffect() {
      const usedAt = nowDate();
      entry.cooldownUntil = null;
      entry.account = {
        ...entry.account,
        cooldownUntil: null,
        errorStreak: 0,
        lastError: "",
        lastErrorAt: null,
        lastUsedAt: usedAt,
        reauthRequired: false,
      };

      yield* dependencies.repository.markAccount(entry.account.accountId, {
        cooldownUntil: null,
        errorStreak: 0,
        lastError: "",
        lastErrorAt: null,
        lastUsedAt: usedAt,
        reauthRequired: false,
      });
    });

  const cooldown = (
    entry: RuntimeEntry,
    durationMs: number,
    message: string
  ): Effect.Effect<void, unknown> =>
    Effect.gen(function* cooldownEffect() {
      const recordedAt = nowDate();
      const cooldownUntil = new Date(
        recordedAt.getTime() + Math.max(durationMs, 0)
      );
      const lastRateLimitedAt = looksRateLimited(message)
        ? recordedAt
        : entry.account.lastRateLimitedAt;

      entry.cooldownUntil = cooldownUntil;
      entry.account = {
        ...entry.account,
        cooldownUntil,
        errorStreak: entry.account.errorStreak + 1,
        lastError: message,
        lastErrorAt: recordedAt,
        lastRateLimitedAt,
      };

      yield* dependencies.repository.markAccount(entry.account.accountId, {
        cooldownUntil,
        errorStreak: entry.account.errorStreak,
        lastError: message,
        lastErrorAt: recordedAt,
        lastRateLimitedAt,
      });
    });

  const healthyEnabledAccountCount = (): number => {
    let count = 0;
    const current = nowDate();
    for (const entry of entries.values()) {
      if (
        entry.removed ||
        !entry.account.enabled ||
        entry.account.reauthRequired ||
        cooldownActive(entry, current)
      ) {
        continue;
      }

      count += 1;
    }

    return count;
  };

  const parseRetryAfterMs = (retryAfter: string | null): number => {
    const value = retryAfter?.trim() ?? "";
    if (value.length > 0) {
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds >= 0) {
        return seconds * 1000;
      }

      const retryAt = Date.parse(value);
      if (Number.isFinite(retryAt)) {
        return Math.max(retryAt - nowMs(), 0);
      }
    }

    return healthyEnabledAccountCount() <= 1
      ? scheduler.singleAccountRateLimitCooldownMs
      : scheduler.rateLimitCooldownMs;
  };

  const markReauthRequired = (
    entry: RuntimeEntry,
    message: string
  ): Effect.Effect<void, unknown> =>
    Effect.gen(function* markReauthRequiredEffect() {
      const recordedAt = nowDate();
      entry.account = {
        ...entry.account,
        lastError: message,
        lastErrorAt: recordedAt,
        reauthRequired: true,
      };

      yield* dependencies.repository.markAccount(entry.account.accountId, {
        lastError: message,
        lastErrorAt: recordedAt,
        reauthRequired: true,
      });
    });

  const markLastError = (
    entry: RuntimeEntry,
    message: string
  ): Effect.Effect<void, unknown> =>
    Effect.gen(function* markLastErrorEffect() {
      const recordedAt = nowDate();
      entry.account = {
        ...entry.account,
        lastError: message,
        lastErrorAt: recordedAt,
      };

      yield* dependencies.repository.markAccount(entry.account.accountId, {
        lastError: message,
        lastErrorAt: recordedAt,
      });
    });

  const handlePrepareError = (
    entry: RuntimeEntry,
    error: unknown
  ): Effect.Effect<void, unknown> => {
    if (isInvalidOrExpiredTokenError(error)) {
      return markReauthRequired(entry, describeError(error));
    }

    return cooldown(entry, scheduler.failureCooldownMs, describeError(error));
  };

  const handleRequestError = (
    lease: RuntimeLease,
    error: unknown
  ): Effect.Effect<RetryDecision, unknown> => {
    const message = describeError(error);
    const statusCode = extractStatusCode(error);

    if (isInvalidOrExpiredTokenError(error)) {
      return Effect.as(markReauthRequired(lease.entry, message), {
        retryOtherAccount: true,
        retrySameAccount: false,
      } satisfies RetryDecision);
    }

    if (statusCode === 401) {
      if (!lease.forceRefreshed) {
        return Effect.succeed({
          retryOtherAccount: false,
          retrySameAccount: true,
        } satisfies RetryDecision);
      }

      return Effect.as(markReauthRequired(lease.entry, message), {
        retryOtherAccount: true,
        retrySameAccount: false,
      } satisfies RetryDecision);
    }

    if (statusCode === 429) {
      const retryAfterMs = parseRetryAfterMs(extractRetryAfter(error));
      return Effect.as(cooldown(lease.entry, retryAfterMs, message), {
        retryOtherAccount: true,
        retrySameAccount: false,
      } satisfies RetryDecision);
    }

    if (
      statusCode === 500 ||
      statusCode === 502 ||
      statusCode === 503 ||
      statusCode === 504
    ) {
      return Effect.as(
        cooldown(lease.entry, scheduler.failureCooldownMs, message),
        {
          retryOtherAccount: true,
          retrySameAccount: false,
        } satisfies RetryDecision
      );
    }

    if (statusCode === 403) {
      return Effect.as(
        cooldown(lease.entry, scheduler.rateLimitCooldownMs, message),
        {
          retryOtherAccount: true,
          retrySameAccount: false,
        } satisfies RetryDecision
      );
    }

    if (isTransientRequestError(error)) {
      return Effect.as(
        cooldown(lease.entry, scheduler.failureCooldownMs, message),
        {
          retryOtherAccount: true,
          retrySameAccount: false,
        } satisfies RetryDecision
      );
    }

    return Effect.as(markLastError(lease.entry, message), {
      retryOtherAccount: false,
      retrySameAccount: false,
    } satisfies RetryDecision);
  };

  const releaseEntry = (
    entry: RuntimeEntry,
    isStream: boolean
  ): Effect.Effect<void> =>
    withLock(selectionLock, () =>
      Effect.sync(() => {
        entry.activeRequests = Math.max(entry.activeRequests - 1, 0);
        if (isStream) {
          entry.activeStreams = Math.max(entry.activeStreams - 1, 0);
        }

        if (entry.removed && entry.activeRequests === 0) {
          entries.delete(entry.account.accountId);
        }
      })
    );

  const acquire = (options: {
    readonly excludeAccountIds: ReadonlySet<string>;
    readonly isStream: boolean;
    readonly model: string | null;
  }): Effect.Effect<RuntimeLease, unknown> =>
    Effect.gen(function* acquireLeaseEffect() {
      yield* syncAccounts();
      let lastError: unknown = null;

      for (const entry of yield* candidateEntries({
        excludeAccountIds: options.excludeAccountIds,
      })) {
        let entryError: unknown = null;
        if (
          entry.removed ||
          !entry.account.enabled ||
          entry.account.reauthRequired ||
          cooldownActive(entry)
        ) {
          continue;
        }

        const reserved = yield* withLock(selectionLock, () =>
          Effect.sync(() => {
            if (
              entry.removed ||
              !entry.account.enabled ||
              entry.account.reauthRequired ||
              cooldownActive(entry)
            ) {
              return false;
            }

            entry.activeRequests += 1;
            if (options.isStream) {
              entry.activeStreams += 1;
            }
            return true;
          })
        );
        if (!reserved) {
          continue;
        }

        try {
          yield* prepareEntry(entry, options.model);
          return {
            accountId: entry.account.accountId,
            entry,
            forceRefreshed: false,
            isStream: options.isStream,
          } satisfies RuntimeLease;
        } catch (error) {
          entryError = error;
          lastError = error;
          yield* error instanceof ModelUnavailableError
            ? cooldown(entry, 0, describeError(error))
            : handlePrepareError(entry, error);
        } finally {
          if (entryError !== null) {
            yield* releaseEntry(entry, options.isStream);
          }
        }
      }

      if (lastError !== null) {
        return yield* Effect.fail(lastError);
      }

      return yield* Effect.fail(
        new ProxyRuntimeUnavailableError({
          message: "No healthy Copilot accounts are available.",
        })
      );
    });

  const executeOnSurface = <A, E, R>(
    request: ProxyRuntimeRequest<A, E, R>,
    apiSurface: ProxyApiSurface
  ): Effect.Effect<A, unknown, R> =>
    Effect.gen(function* executeOnSurfaceEffect() {
      yield* syncAccounts();
      const tried = new Set<string>();
      let lastError: unknown = null;
      const maxAttempts = Math.max(
        1,
        Math.min(scheduler.maxRetryAttempts, Math.max(entries.size, 1))
      );

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const lease = yield* acquire({
          excludeAccountIds: tried,
          isStream: false,
          model: normalizedModel(request.model),
        });

        try {
          const result = yield* request.operation({
            account: lease.entry.account,
            apiSurface,
            attempt,
            refreshed: lease.forceRefreshed,
          });
          yield* markSuccess(lease.entry);
          return result;
        } catch (error) {
          const decision = yield* handleRequestError(lease, error);
          lastError = error;

          if (decision.retrySameAccount && !lease.forceRefreshed) {
            lease.forceRefreshed = true;
            try {
              yield* forceRefreshEntry(lease.entry);
              const retried = yield* request.operation({
                account: lease.entry.account,
                apiSurface,
                attempt,
                refreshed: true,
              });
              yield* markSuccess(lease.entry);
              return retried;
            } catch (retryError) {
              lastError = retryError;
              const retryDecision = yield* handleRequestError(
                lease,
                retryError
              );
              if (!retryDecision.retryOtherAccount) {
                return yield* Effect.fail(retryError);
              }
            }
          } else if (!decision.retryOtherAccount) {
            return yield* Effect.fail(error);
          }

          tried.add(lease.accountId);
        } finally {
          yield* releaseEntry(lease.entry, false);
        }
      }

      return yield* Effect.fail(
        lastError ??
          new ProxyRuntimeUnavailableError({
            message: "No upstream account could satisfy the request.",
          })
      );
    });

  const probeOnSurface = <A, E, R>(
    request: ProxyRuntimeRequest<A, E, R>,
    apiSurface: ProxyApiSurface
  ): Effect.Effect<A, unknown, R> =>
    Effect.gen(function* probeOnSurfaceEffect() {
      yield* syncAccounts();
      const lease = yield* acquire({
        excludeAccountIds: new Set<string>(),
        isStream: false,
        model: normalizedModel(request.model),
      });

      try {
        const result = yield* request.operation({
          account: lease.entry.account,
          apiSurface,
          attempt: 1,
          refreshed: false,
        });
        yield* markSuccess(lease.entry);
        return result;
      } finally {
        yield* releaseEntry(lease.entry, false);
      }
    });

  const consumeStreamAttempt = <Chunk, E, R>(options: {
    readonly apiSurface: ProxyApiSurface;
    readonly attempt: number;
    readonly lease: RuntimeLease;
    readonly queue: Queue.Queue<Chunk, unknown>;
    readonly request: ProxyRuntimeStreamRequest<Chunk, E, R>;
    readonly routingMarked: { value: boolean };
  }): Effect.Effect<boolean, unknown, R> =>
    Effect.gen(function* consumeStreamAttemptEffect() {
      let yielded = false;

      try {
        yield* options.request
          .operation({
            account: options.lease.entry.account,
            apiSurface: options.apiSurface,
            attempt: options.attempt,
            refreshed: options.lease.forceRefreshed,
          })
          .pipe(
            Stream.runForEach((chunk) =>
              Effect.gen(function* enqueueChunkEffect() {
                yielded = true;
                if (!options.routingMarked.value) {
                  routing.markApiSuccess(
                    options.request.model,
                    options.apiSurface
                  );
                  options.routingMarked.value = true;
                }
                yield* Queue.offer(options.queue, chunk);
              })
            )
          );

        return yielded;
      } catch (error) {
        return yield* Effect.fail(makeStreamSurfaceFailure(error, yielded));
      }
    });

  const drainStreamSurface = <Chunk, E, R>(options: {
    readonly apiSurface: ProxyApiSurface;
    readonly queue: Queue.Queue<Chunk, unknown>;
    readonly request: ProxyRuntimeStreamRequest<Chunk, E, R>;
  }): Effect.Effect<void, unknown, R> =>
    Effect.gen(function* drainStreamSurfaceEffect() {
      yield* syncAccounts();
      const tried = new Set<string>();
      const routingMarked = { value: false };
      let lastError: unknown = null;
      const maxAttempts = Math.max(
        1,
        Math.min(scheduler.maxRetryAttempts, Math.max(entries.size, 1))
      );

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const lease = yield* acquire({
          excludeAccountIds: tried,
          isStream: true,
          model: normalizedModel(options.request.model),
        }).pipe(
          Effect.mapError((error) => makeStreamSurfaceFailure(error, false))
        );

        try {
          const yielded = yield* consumeStreamAttempt({
            apiSurface: options.apiSurface,
            attempt,
            lease,
            queue: options.queue,
            request: options.request,
            routingMarked,
          });

          if (!routingMarked.value) {
            routing.markApiSuccess(options.request.model, options.apiSurface);
          }
          yield* markSuccess(lease.entry).pipe(
            Effect.mapError((error) => makeStreamSurfaceFailure(error, yielded))
          );
          return;
        } catch (caughtError) {
          const cause = streamFailureCause(caughtError);
          const decision = yield* handleRequestError(lease, cause).pipe(
            Effect.mapError((error) => makeStreamSurfaceFailure(error, false))
          );
          lastError = cause;

          if (isStreamSurfaceFailure(caughtError) && caughtError.yielded) {
            return yield* Effect.fail(caughtError);
          }

          if (decision.retrySameAccount && !lease.forceRefreshed) {
            lease.forceRefreshed = true;
            try {
              yield* forceRefreshEntry(lease.entry).pipe(
                Effect.mapError((refreshError) =>
                  makeStreamSurfaceFailure(refreshError, false)
                )
              );
              const yielded = yield* consumeStreamAttempt({
                apiSurface: options.apiSurface,
                attempt,
                lease,
                queue: options.queue,
                request: options.request,
                routingMarked,
              });
              if (!routingMarked.value) {
                routing.markApiSuccess(
                  options.request.model,
                  options.apiSurface
                );
              }
              yield* markSuccess(lease.entry).pipe(
                Effect.mapError((markSuccessError) =>
                  makeStreamSurfaceFailure(markSuccessError, yielded)
                )
              );
              return;
            } catch (error) {
              const retryError = streamFailureCause(error);
              lastError = retryError;
              const retryDecision = yield* handleRequestError(
                lease,
                retryError
              ).pipe(
                Effect.mapError((retryDecisionError) =>
                  makeStreamSurfaceFailure(retryDecisionError, false)
                )
              );
              if (
                (isStreamSurfaceFailure(error) && error.yielded) ||
                !retryDecision.retryOtherAccount
              ) {
                return yield* Effect.fail(
                  isStreamSurfaceFailure(error)
                    ? error
                    : makeStreamSurfaceFailure(retryError, false)
                );
              }
            }
          } else if (!decision.retryOtherAccount) {
            return yield* Effect.fail(makeStreamSurfaceFailure(cause, false));
          }

          tried.add(lease.accountId);
        } finally {
          yield* releaseEntry(lease.entry, true);
        }
      }

      return yield* Effect.fail(
        makeStreamSurfaceFailure(
          lastError ??
            new ProxyRuntimeUnavailableError({
              message: "No upstream account could open the requested stream.",
            }),
          false
        )
      );
    });

  return {
    execute: <A, E, R>(request: ProxyRuntimeRequest<A, E, R>) =>
      Effect.gen(function* executeEffect() {
        const model = normalizedModel(request.model);
        let lastError: unknown = null;

        for (const apiSurface of surfaceOrder(
          model,
          request.requestedApi,
          request.allowUnsupportedSurfaceFallback ?? true
        )) {
          try {
            const result = yield* executeOnSurface(request, apiSurface);
            routing.markApiSuccess(model, apiSurface);
            return result;
          } catch (error) {
            lastError = error;
            if (!isUnsupportedApiSurfaceError(error, apiSurface)) {
              return yield* Effect.fail(error);
            }

            routing.markApiUnsupported(model, apiSurface);
          }
        }

        return yield* Effect.fail(lastError);
      }),
    healthSnapshot: (): Effect.Effect<ProxyRuntimeHealthSnapshot, unknown> =>
      Effect.gen(function* healthSnapshotEffect() {
        yield* syncAccounts();
        const current = nowDate();
        const enabledEntries = [...entries.values()].filter(
          (entry) => entry.account.enabled && !entry.removed
        );
        const validExpiries = enabledEntries
          .filter((entry) => tokenValid(entry))
          .map((entry) => {
            const expiresAt = entry.account.copilotTokenExpiresAt;
            return expiresAt === null
              ? 0
              : Math.max(
                  Math.floor((expiresAt.getTime() - current.getTime()) / 1000),
                  0
                );
          });
        const healthy = enabledEntries.filter(
          (entry) =>
            !entry.account.reauthRequired && !cooldownActive(entry, current)
        );
        const coolingDown = enabledEntries.filter(
          (entry) =>
            cooldownActive(entry, current) && !entry.account.reauthRequired
        );
        const reauth = enabledEntries.filter(
          (entry) => entry.account.reauthRequired
        );

        return {
          accountsCoolingDown: coolingDown.length,
          accountsEnabled: enabledEntries.length,
          accountsHealthy: healthy.length,
          accountsReauthRequired: reauth.length,
          accountsTotal: entries.size,
          authenticated: enabledEntries.length > 0,
          strategy: yield* dependencies.repository.getRotationStrategy(),
          tokenExpiresInSeconds:
            validExpiries.length === 0 ? 0 : Math.max(...validExpiries),
          tokenValid: validExpiries.length > 0,
        } satisfies ProxyRuntimeHealthSnapshot;
      }),
    listModels: () =>
      Effect.gen(function* listModelsEffect() {
        if (dependencies.hooks.listAccountModels === undefined) {
          return yield* Effect.fail(
            new ProxyRuntimeUnavailableError({
              message: "Model inspection hook is not configured.",
            })
          );
        }

        yield* syncAccounts({ force: true });
        const merged = new Map<string, RuntimeModelDescriptor>();

        for (const entry of yield* candidateEntries({
          excludeAccountIds: new Set<string>(),
        })) {
          if (
            entry.removed ||
            !entry.account.enabled ||
            entry.account.reauthRequired ||
            cooldownActive(entry)
          ) {
            continue;
          }

          try {
            yield* prepareEntry(entry, null);
            const models = yield* dependencies.hooks.listAccountModels({
              account: entry.account,
            });
            yield* persistModelCatalog(entry, models);

            for (const model of models) {
              const modelId = model.id.trim();
              if (modelId.length === 0 || merged.has(modelId)) {
                continue;
              }

              merged.set(modelId, {
                hidden: model.hidden ?? false,
                id: modelId,
                vendor: model.vendor?.trim() ?? "",
              });
            }
          } catch (error) {
            yield* handlePrepareError(entry, error);
          }
        }

        const models = [...merged.values()];
        routing.observeModels(models);
        return models;
      }),
    markApiSuccess: (model, apiSurface) => {
      routing.markApiSuccess(model, apiSurface);
    },
    markApiUnsupported: (model, apiSurface) => {
      routing.markApiUnsupported(model, apiSurface);
    },
    observeModels: (models) => {
      routing.observeModels(models);
    },
    preferredApiSurface: (model, requestedApi) =>
      routing.preferredApi(normalizedModel(model), requestedApi),
    probe: <A, E, R>(request: ProxyRuntimeRequest<A, E, R>) =>
      Effect.gen(function* probeEffect() {
        const model = normalizedModel(request.model);
        let lastError: unknown = null;

        for (const apiSurface of surfaceOrder(
          model,
          request.requestedApi,
          request.allowUnsupportedSurfaceFallback ?? true
        )) {
          try {
            const result = yield* probeOnSurface(request, apiSurface);
            routing.markApiSuccess(model, apiSurface);
            return result;
          } catch (error) {
            lastError = error;
            if (!isUnsupportedApiSurfaceError(error, apiSurface)) {
              return yield* Effect.fail(error);
            }

            routing.markApiUnsupported(model, apiSurface);
          }
        }

        return yield* Effect.fail(lastError);
      }),
    shutdown: () =>
      Effect.sync(() => {
        entries.clear();
        lastSyncAt = 0;
      }),
    startup: () => syncAccounts({ force: true }),
    stream: <Chunk, E, R>(request: ProxyRuntimeStreamRequest<Chunk, E, R>) =>
      Stream.callback<Chunk, unknown, R>((queue) =>
        Effect.gen(function* streamEffect() {
          const model = normalizedModel(request.model);
          let lastError: unknown = null;
          yield* Scope.Scope;
          for (const apiSurface of surfaceOrder(
            model,
            request.requestedApi,
            request.allowUnsupportedSurfaceFallback ?? true
          )) {
            try {
              yield* drainStreamSurface({ apiSurface, queue, request });
              yield* Queue.end(queue);
              return;
            } catch (caughtError) {
              const failure = isStreamSurfaceFailure(caughtError)
                ? caughtError
                : null;
              const cause = failure?.cause ?? caughtError;
              lastError = cause;

              if (failure !== null && failure.yielded) {
                yield* Queue.fail(queue, failure.cause);
                return;
              }

              if (!isUnsupportedApiSurfaceError(cause, apiSurface)) {
                yield* Queue.fail(queue, cause);
                return;
              }

              routing.markApiUnsupported(model, apiSurface);
            }
          }

          yield* Queue.fail(
            queue,
            lastError ??
              new ProxyRuntimeUnavailableError({
                message: "No upstream account could open the requested stream.",
              })
          );
        })
      ),
  } satisfies ProxyRuntime;
};
