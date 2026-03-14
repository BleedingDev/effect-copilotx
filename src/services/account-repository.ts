import { asc, eq, inArray, or, sql } from "drizzle-orm";
import type { InferSelectModel } from "drizzle-orm";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ServiceMap from "effect/ServiceMap";

import { defaultRotationStrategy } from "#/domain/accounts/account-types";
import type {
  AccountRecord,
  AccountRuntimePatch,
  AccountSummary,
  AccountUsageDelta,
  ModelCatalogEntry,
  RotationStrategy,
  RuntimeSettingsRecord,
  UpsertAccountInput,
} from "#/domain/accounts/account-types";
import { AccountRepositoryError } from "#/domain/errors/account-repository-error";
import {
  accountModels,
  accountRuntimeStates,
  accounts,
  DEFAULT_RUNTIME_SETTINGS_ID,
  runtimeSettings,
} from "#/db/schema";
import { Database } from "#/services/database";
import type { CopilotDatabase } from "#/services/database";
import { TokenCipher } from "#/services/token-cipher";

type AccountRow = InferSelectModel<typeof accounts>;
type AccountRuntimeStateRow = InferSelectModel<typeof accountRuntimeStates>;
type DatabaseTransaction = Parameters<
  CopilotDatabase["transaction"]
>[0] extends (tx: infer Transaction) => Effect.Effect<unknown, unknown, unknown>
  ? Transaction
  : never;
type DatabaseExecutor = CopilotDatabase | DatabaseTransaction;

const orderedAccountColumns = [
  asc(accounts.priority),
  asc(accounts.createdAt),
  asc(accounts.accountId),
] as const;

const collapseToSummary = (account: AccountRecord): AccountSummary => ({
  accountId: account.accountId,
  cooldownUntil: account.cooldownUntil,
  copilotTokenExpiresAt: account.copilotTokenExpiresAt,
  createdAt: account.createdAt,
  enabled: account.enabled,
  errorStreak: account.errorStreak,
  githubLogin: account.githubLogin,
  githubUserId: account.githubUserId,
  inputTokenCount: account.inputTokenCount,
  label: account.label,
  lastError: account.lastError,
  lastErrorAt: account.lastErrorAt,
  lastRateLimitedAt: account.lastRateLimitedAt,
  lastUsedAt: account.lastUsedAt,
  modelCatalog: account.modelCatalog,
  modelIds: account.modelIds,
  outputTokenCount: account.outputTokenCount,
  priority: account.priority,
  reauthRequired: account.reauthRequired,
  successfulRequestCount: account.successfulRequestCount,
  successfulStreamCount: account.successfulStreamCount,
  updatedAt: account.updatedAt,
});

const ensureSelector = (selector: string) => selector.trim();

const describeError = (error: unknown) =>
  error instanceof Error ? error.message : `Unexpected error: ${String(error)}`;

const toInitializationError = (error: unknown) =>
  new AccountRepositoryError({
    message: describeError(error),
    operation: "initialize",
  });

export class AccountRepository extends ServiceMap.Service<AccountRepository>()(
  "copilotx/AccountRepository",
  {
    make: Effect.gen(function* make() {
      const db = yield* Database;
      const tokenCipher = yield* TokenCipher;

      const ensureSettingsRow = Effect.fn(
        "AccountRepository.ensureSettingsRow"
      )(function* ensureSettingsRow(executor: DatabaseExecutor) {
        const existing = yield* executor
          .select()
          .from(runtimeSettings)
          .where(eq(runtimeSettings.id, DEFAULT_RUNTIME_SETTINGS_ID))
          .limit(1);

        const [found] = existing;
        if (found !== undefined) {
          return found;
        }

        yield* executor.insert(runtimeSettings).values({
          id: DEFAULT_RUNTIME_SETTINGS_ID,
          rotationStrategy: defaultRotationStrategy,
        });

        const created = yield* executor
          .select()
          .from(runtimeSettings)
          .where(eq(runtimeSettings.id, DEFAULT_RUNTIME_SETTINGS_ID))
          .limit(1);

        const [row] = created;
        if (row === undefined) {
          return yield* Effect.fail(
            new AccountRepositoryError({
              message: "Failed to initialize runtime settings.",
              operation: "ensureSettingsRow",
            })
          );
        }

        return row;
      });

      const listAccountRows = Effect.fn("AccountRepository.listAccountRows")(
        function* listAccountRows(enabledOnly: boolean) {
          if (enabledOnly) {
            return yield* db
              .select()
              .from(accounts)
              .where(eq(accounts.enabled, true))
              .orderBy(...orderedAccountColumns);
          }

          return yield* db
            .select()
            .from(accounts)
            .orderBy(...orderedAccountColumns);
        }
      );

      const loadRuntimeStateMap = Effect.fn(
        "AccountRepository.loadRuntimeStateMap"
      )(function* loadRuntimeStateMap(accountIds: readonly string[]) {
        if (accountIds.length === 0) {
          return new Map<string, AccountRuntimeStateRow>();
        }

        const rows = yield* db
          .select()
          .from(accountRuntimeStates)
          .where(inArray(accountRuntimeStates.accountId, [...accountIds]));

        return new Map(rows.map((row) => [row.accountId, row]));
      });

      const loadModelCatalogMap = Effect.fn(
        "AccountRepository.loadModelCatalogMap"
      )(function* loadModelCatalogMap(accountIds: readonly string[]) {
        if (accountIds.length === 0) {
          return new Map<string, readonly ModelCatalogEntry[]>();
        }

        const rows = yield* db
          .select()
          .from(accountModels)
          .where(inArray(accountModels.accountId, [...accountIds]))
          .orderBy(asc(accountModels.accountId), asc(accountModels.modelId));

        const grouped = new Map<string, ModelCatalogEntry[]>();
        for (const row of rows) {
          const existing = grouped.get(row.accountId) ?? [];
          existing.push({
            hidden: row.hidden,
            modelId: row.modelId,
            vendor: row.vendor,
          });
          grouped.set(row.accountId, existing);
        }

        return grouped as Map<string, readonly ModelCatalogEntry[]>;
      });

      const decryptCopilotToken = Effect.fn(
        "AccountRepository.decryptCopilotToken"
      )(function* decryptCopilotToken(row: AccountRow) {
        return yield* tokenCipher.decryptOptional({
          ciphertext: row.copilotTokenCiphertext,
          keyId: row.copilotTokenKeyId,
        });
      });

      const hydrateAccount = Effect.fn("AccountRepository.hydrateAccount")(
        function* hydrateAccount(
          row: AccountRow,
          runtimeState: AccountRuntimeStateRow | undefined,
          modelCatalog: readonly ModelCatalogEntry[] | undefined
        ) {
          const githubToken = yield* tokenCipher.decrypt({
            ciphertext: row.githubTokenCiphertext,
            keyId: row.githubTokenKeyId,
          });
          const copilotToken = yield* decryptCopilotToken(row);
          const models = modelCatalog ?? [];

          return {
            accountId: row.accountId,
            apiBaseUrl: row.apiBaseUrl,
            cooldownUntil: runtimeState?.cooldownUntil ?? null,
            copilotToken,
            copilotTokenExpiresAt: row.copilotTokenExpiresAt ?? null,
            createdAt: row.createdAt,
            enabled: row.enabled,
            errorStreak: runtimeState?.errorStreak ?? 0,
            githubLogin: row.githubLogin,
            githubToken,
            githubUserId: row.githubUserId,
            inputTokenCount: runtimeState?.inputTokenCount ?? 0,
            label: row.label,
            lastError: runtimeState?.lastError ?? "",
            lastErrorAt: runtimeState?.lastErrorAt ?? null,
            lastRateLimitedAt: runtimeState?.lastRateLimitedAt ?? null,
            lastUsedAt: row.lastUsedAt ?? null,
            modelCatalog: models,
            modelIds: models.map((model) => model.modelId),
            outputTokenCount: runtimeState?.outputTokenCount ?? 0,
            priority: row.priority,
            reauthRequired: row.reauthRequired,
            successfulRequestCount: runtimeState?.successfulRequestCount ?? 0,
            successfulStreamCount: runtimeState?.successfulStreamCount ?? 0,
            updatedAt: row.updatedAt,
          } satisfies AccountRecord;
        }
      );

      const hydrateAccounts = Effect.fn("AccountRepository.hydrateAccounts")(
        function* hydrateAccounts(rows: readonly AccountRow[]) {
          const accountIds = rows.map((row) => row.accountId);
          const runtimeStateMap = yield* loadRuntimeStateMap(accountIds);
          const modelCatalogMap = yield* loadModelCatalogMap(accountIds);

          const effects = rows.map((row) =>
            hydrateAccount(
              row,
              runtimeStateMap.get(row.accountId),
              modelCatalogMap.get(row.accountId)
            )
          );

          return yield* Effect.all(effects);
        }
      );

      const getAccountRow = Effect.fn("AccountRepository.getAccountRow")(
        function* getAccountRow(selector: string) {
          const normalizedSelector = ensureSelector(selector);
          if (normalizedSelector.length === 0) {
            return null;
          }

          const rows = yield* db
            .select()
            .from(accounts)
            .where(
              or(
                eq(accounts.accountId, normalizedSelector),
                eq(accounts.githubLogin, normalizedSelector),
                eq(accounts.label, normalizedSelector)
              )
            )
            .orderBy(...orderedAccountColumns)
            .limit(1);

          return rows[0] ?? null;
        }
      );

      const loadAccountById = Effect.fn("AccountRepository.loadAccountById")(
        function* loadAccountById(accountId: string) {
          const row = yield* getAccountRow(accountId);
          if (row === null) {
            return null;
          }

          const [account] = yield* hydrateAccounts([row]);
          return account ?? null;
        }
      );

      const ensureUniqueLabel = Effect.fn(
        "AccountRepository.ensureUniqueLabel"
      )(function* ensureUniqueLabel(label: string, excludeAccountId?: string) {
        const normalizedBase =
          label.trim().length === 0 ? "account" : label.trim();
        let candidate = normalizedBase;
        let suffix = 2;

        while (true) {
          const rows = yield* db
            .select({ accountId: accounts.accountId })
            .from(accounts)
            .where(
              excludeAccountId === undefined
                ? eq(accounts.label, candidate)
                : or(
                    eq(accounts.label, candidate),
                    eq(accounts.accountId, excludeAccountId)
                  )
            )
            .limit(10);

          const conflict = rows.some(
            (row) =>
              row.accountId !== excludeAccountId && row.accountId !== undefined
          );

          if (!conflict) {
            return candidate;
          }

          candidate = `${normalizedBase}-${suffix}`;
          suffix += 1;
        }
      });

      const nextPriority = Effect.fn("AccountRepository.nextPriority")(
        function* nextPriority() {
          const rows = yield* db
            .select({
              value: sql<number>`coalesce(max(${accounts.priority}), -1) + 1`,
            })
            .from(accounts)
            .limit(1);

          return rows[0]?.value ?? 0;
        }
      );

      const replaceModelCatalog = Effect.fn(
        "AccountRepository.replaceModelCatalog"
      )(function* replaceModelCatalog(
        executor: DatabaseExecutor,
        accountId: string,
        modelCatalog: readonly ModelCatalogEntry[]
      ) {
        yield* executor
          .delete(accountModels)
          .where(eq(accountModels.accountId, accountId));

        if (modelCatalog.length === 0) {
          return;
        }

        yield* executor.insert(accountModels).values(
          modelCatalog.map((model) => ({
            accountId,
            hidden: model.hidden,
            modelId: model.modelId,
            vendor: model.vendor,
          }))
        );
      });

      const pickNextDefaultAccountId = Effect.fn(
        "AccountRepository.pickNextDefaultAccountId"
      )(function* pickNextDefaultAccountId(executor: DatabaseExecutor) {
        const rows = yield* executor
          .select({ accountId: accounts.accountId })
          .from(accounts)
          .where(eq(accounts.enabled, true))
          .orderBy(...orderedAccountColumns)
          .limit(1);

        return rows[0]?.accountId ?? null;
      });

      const toEncryptedSecret = Effect.fn(
        "AccountRepository.toEncryptedSecret"
      )(function* toEncryptedSecret(plaintext: string) {
        if (plaintext.length === 0) {
          return null;
        }

        return yield* tokenCipher.encrypt(plaintext);
      });

      const updateDefaultAfterChange = Effect.fn(
        "AccountRepository.updateDefaultAfterChange"
      )(function* updateDefaultAfterChange(
        executor: DatabaseExecutor,
        nextDefaultAccountId: string | null
      ) {
        yield* ensureSettingsRow(executor);
        yield* executor
          .update(runtimeSettings)
          .set({
            defaultAccountId: nextDefaultAccountId,
            updatedAt: new Date(),
          })
          .where(eq(runtimeSettings.id, DEFAULT_RUNTIME_SETTINGS_ID));
      });

      return {
        clearAccounts: Effect.fn("AccountRepository.clearAccounts")(
          function* clearAccounts() {
            const countRows = yield* db
              .select({ value: sql<number>`count(*)` })
              .from(accounts)
              .limit(1);
            const [{ value = 0 } = {}] = countRows;
            const count = Number(value);

            yield* db.transaction((transaction) =>
              Effect.gen(function* clearAccountsTransaction() {
                yield* transaction.delete(accounts);
                yield* ensureSettingsRow(transaction);
                yield* transaction
                  .update(runtimeSettings)
                  .set({
                    defaultAccountId: null,
                    rotationStrategy: defaultRotationStrategy,
                    roundRobinCursor: 0,
                    updatedAt: new Date(),
                  })
                  .where(eq(runtimeSettings.id, DEFAULT_RUNTIME_SETTINGS_ID));
              })
            );

            return count;
          }
        ),
        countAccounts: Effect.fn("AccountRepository.countAccounts")(
          function* countAccounts() {
            const rows = yield* db
              .select({ value: sql<number>`count(*)` })
              .from(accounts)
              .limit(1);
            const [{ value = 0 } = {}] = rows;

            return Number(value);
          }
        ),
        deleteAccount: Effect.fn("AccountRepository.deleteAccount")(
          function* deleteAccount(selector: string) {
            const account = yield* getAccountRow(selector);
            if (account === null) {
              return false;
            }

            yield* db.transaction((transaction) =>
              Effect.gen(function* deleteAccountTransaction() {
                const settings = yield* ensureSettingsRow(transaction);
                yield* transaction
                  .delete(accounts)
                  .where(eq(accounts.accountId, account.accountId));

                if (settings.defaultAccountId === account.accountId) {
                  const nextDefaultAccountId =
                    yield* pickNextDefaultAccountId(transaction);
                  yield* updateDefaultAfterChange(
                    transaction,
                    nextDefaultAccountId
                  );
                }
              })
            );

            return true;
          }
        ),
        getAccount: Effect.fn("AccountRepository.getAccount")(
          function* getAccount(selector: string) {
            return yield* loadAccountById(selector);
          }
        ),
        getAccountSummary: Effect.fn("AccountRepository.getAccountSummary")(
          function* getAccountSummary(selector: string) {
            const account = yield* loadAccountById(selector);

            return account === null ? null : collapseToSummary(account);
          }
        ),
        getDefaultAccountId: Effect.fn("AccountRepository.getDefaultAccountId")(
          function* getDefaultAccountId() {
            const settings = yield* ensureSettingsRow(db);
            return settings.defaultAccountId ?? "";
          }
        ),
        getRotationStrategy: Effect.fn("AccountRepository.getRotationStrategy")(
          function* getRotationStrategy() {
            const settings = yield* ensureSettingsRow(db);
            return settings.rotationStrategy;
          }
        ),
        getRuntimeSettings: Effect.fn("AccountRepository.getRuntimeSettings")(
          function* getRuntimeSettings() {
            const settings = yield* ensureSettingsRow(db);
            return {
              defaultAccountId: settings.defaultAccountId ?? null,
              id: settings.id,
              rotationStrategy: settings.rotationStrategy,
              roundRobinCursor: settings.roundRobinCursor,
              updatedAt: settings.updatedAt,
            } satisfies RuntimeSettingsRecord;
          }
        ),
        hasAccounts: Effect.fn("AccountRepository.hasAccounts")(
          function* hasAccounts() {
            const count = yield* db
              .select({ value: sql<number>`count(*)` })
              .from(accounts)
              .limit(1);

            return Number(count[0]?.value ?? 0) > 0;
          }
        ),
        listAccountSummaries: Effect.fn(
          "AccountRepository.listAccountSummaries"
        )(function* listAccountSummaries(options?: {
          readonly enabledOnly?: boolean;
        }) {
          const accountsList = yield* listAccountRows(
            options?.enabledOnly ?? false
          ).pipe(Effect.flatMap((rows) => hydrateAccounts(rows)));

          return accountsList.map(collapseToSummary);
        }),
        listAccounts: Effect.fn("AccountRepository.listAccounts")(
          function* listAccounts(options?: { readonly enabledOnly?: boolean }) {
            const rows = yield* listAccountRows(options?.enabledOnly ?? false);
            return yield* hydrateAccounts(rows);
          }
        ),
        markAccount: Effect.fn("AccountRepository.markAccount")(
          function* markAccount(accountId: string, patch: AccountRuntimePatch) {
            const now = new Date();

            yield* db.transaction((transaction) =>
              Effect.gen(function* markAccountTransaction() {
                const accountRows = yield* transaction
                  .select()
                  .from(accounts)
                  .where(eq(accounts.accountId, accountId))
                  .limit(1);
                const [account] = accountRows;
                if (account === undefined) {
                  return;
                }

                const stateRows = yield* transaction
                  .select()
                  .from(accountRuntimeStates)
                  .where(eq(accountRuntimeStates.accountId, accountId))
                  .limit(1);
                const [state] = stateRows;

                yield* transaction
                  .update(accounts)
                  .set({
                    lastUsedAt:
                      patch.lastUsedAt === undefined
                        ? account.lastUsedAt
                        : patch.lastUsedAt,
                    reauthRequired:
                      patch.reauthRequired ?? account.reauthRequired,
                    updatedAt: now,
                  })
                  .where(eq(accounts.accountId, accountId));

                if (state === undefined) {
                  yield* transaction.insert(accountRuntimeStates).values({
                    accountId,
                    cooldownUntil: patch.cooldownUntil ?? null,
                    errorStreak: patch.errorStreak ?? 0,
                    lastError: patch.lastError ?? "",
                    lastErrorAt: patch.lastErrorAt ?? null,
                    lastRateLimitedAt: patch.lastRateLimitedAt ?? null,
                    updatedAt: now,
                  });
                  return;
                }

                yield* transaction
                  .update(accountRuntimeStates)
                  .set({
                    cooldownUntil:
                      patch.cooldownUntil === undefined
                        ? state.cooldownUntil
                        : patch.cooldownUntil,
                    errorStreak: patch.errorStreak ?? state.errorStreak,
                    lastError: patch.lastError ?? state.lastError,
                    lastErrorAt:
                      patch.lastErrorAt === undefined
                        ? state.lastErrorAt
                        : patch.lastErrorAt,
                    lastRateLimitedAt:
                      patch.lastRateLimitedAt === undefined
                        ? state.lastRateLimitedAt
                        : patch.lastRateLimitedAt,
                    updatedAt: now,
                  })
                  .where(eq(accountRuntimeStates.accountId, accountId));
              })
            );
          }
        ),
        recordUsage: Effect.fn("AccountRepository.recordUsage")(
          function* recordUsage(accountId: string, delta: AccountUsageDelta) {
            const inputTokenCount = Math.max(delta.inputTokenCount ?? 0, 0);
            const outputTokenCount = Math.max(delta.outputTokenCount ?? 0, 0);
            const successfulRequestCount = Math.max(
              delta.successfulRequestCount ?? 0,
              0
            );
            const successfulStreamCount = Math.max(
              delta.successfulStreamCount ?? 0,
              0
            );

            if (
              inputTokenCount === 0 &&
              outputTokenCount === 0 &&
              successfulRequestCount === 0 &&
              successfulStreamCount === 0
            ) {
              return;
            }

            const now = new Date();

            yield* db.transaction((transaction) =>
              Effect.gen(function* recordUsageTransaction() {
                const stateRows = yield* transaction
                  .select()
                  .from(accountRuntimeStates)
                  .where(eq(accountRuntimeStates.accountId, accountId))
                  .limit(1);
                const [state] = stateRows;

                if (state === undefined) {
                  yield* transaction.insert(accountRuntimeStates).values({
                    accountId,
                    cooldownUntil: null,
                    errorStreak: 0,
                    inputTokenCount,
                    lastError: "",
                    lastErrorAt: null,
                    lastRateLimitedAt: null,
                    outputTokenCount,
                    successfulRequestCount,
                    successfulStreamCount,
                    updatedAt: now,
                  });
                  return;
                }

                yield* transaction
                  .update(accountRuntimeStates)
                  .set({
                    inputTokenCount: state.inputTokenCount + inputTokenCount,
                    outputTokenCount: state.outputTokenCount + outputTokenCount,
                    successfulRequestCount:
                      state.successfulRequestCount + successfulRequestCount,
                    successfulStreamCount:
                      state.successfulStreamCount + successfulStreamCount,
                    updatedAt: now,
                  })
                  .where(eq(accountRuntimeStates.accountId, accountId));
              })
            );
          }
        ),
        nextRoundRobinOffset: Effect.fn(
          "AccountRepository.nextRoundRobinOffset"
        )(function* nextRoundRobinOffset(candidateCount: number) {
          const settings = yield* ensureSettingsRow(db);
          const divisor = Math.max(candidateCount, 1);
          const current = settings.roundRobinCursor % divisor;
          const next = (current + 1) % divisor;

          yield* db
            .update(runtimeSettings)
            .set({
              roundRobinCursor: next,
              updatedAt: new Date(),
            })
            .where(eq(runtimeSettings.id, DEFAULT_RUNTIME_SETTINGS_ID));

          return current;
        }),
        setAccountEnabled: Effect.fn("AccountRepository.setAccountEnabled")(
          function* setAccountEnabled(selector: string, enabled: boolean) {
            const row = yield* getAccountRow(selector);
            if (row === null) {
              return null;
            }

            yield* db.transaction((transaction) =>
              Effect.gen(function* setAccountEnabledTransaction() {
                yield* transaction
                  .update(accounts)
                  .set({
                    enabled,
                    reauthRequired: enabled ? false : row.reauthRequired,
                    updatedAt: new Date(),
                  })
                  .where(eq(accounts.accountId, row.accountId));

                const settings = yield* ensureSettingsRow(transaction);
                if (enabled && settings.defaultAccountId === null) {
                  yield* updateDefaultAfterChange(transaction, row.accountId);
                  return;
                }

                if (!enabled && settings.defaultAccountId === row.accountId) {
                  const nextDefaultAccountId =
                    yield* pickNextDefaultAccountId(transaction);
                  yield* updateDefaultAfterChange(
                    transaction,
                    nextDefaultAccountId
                  );
                }
              })
            );

            return yield* loadAccountById(row.accountId);
          }
        ),
        setAccountPriority: Effect.fn("AccountRepository.setAccountPriority")(
          function* setAccountPriority(selector: string, priority: number) {
            const row = yield* getAccountRow(selector);
            if (row === null) {
              return null;
            }

            yield* db
              .update(accounts)
              .set({
                priority,
                updatedAt: new Date(),
              })
              .where(eq(accounts.accountId, row.accountId));

            return yield* loadAccountById(row.accountId);
          }
        ),
        setDefaultAccountId: Effect.fn("AccountRepository.setDefaultAccountId")(
          function* setDefaultAccountId(accountId: string | null) {
            yield* updateDefaultAfterChange(db, accountId);
          }
        ),
        setRotationStrategy: Effect.fn("AccountRepository.setRotationStrategy")(
          function* setRotationStrategy(strategy: RotationStrategy) {
            yield* ensureSettingsRow(db);
            yield* db
              .update(runtimeSettings)
              .set({
                rotationStrategy: strategy,
                updatedAt: new Date(),
              })
              .where(eq(runtimeSettings.id, DEFAULT_RUNTIME_SETTINGS_ID));

            return strategy;
          }
        ),
        updateModels: Effect.fn("AccountRepository.updateModels")(
          function* updateModels(
            accountId: string,
            modelCatalog: readonly ModelCatalogEntry[]
          ) {
            yield* db.transaction((transaction) =>
              replaceModelCatalog(transaction, accountId, modelCatalog)
            );
          }
        ),
        updateTokens: Effect.fn("AccountRepository.updateTokens")(
          function* updateTokens(
            accountId: string,
            input: {
              readonly apiBaseUrl: string;
              readonly copilotToken: string;
              readonly copilotTokenExpiresAt: Date | null;
            }
          ) {
            const encryptedCopilotToken = yield* toEncryptedSecret(
              input.copilotToken
            );

            yield* db
              .update(accounts)
              .set({
                apiBaseUrl: input.apiBaseUrl,
                copilotTokenCiphertext:
                  encryptedCopilotToken?.ciphertext ?? null,
                copilotTokenExpiresAt: input.copilotTokenExpiresAt,
                copilotTokenKeyId: encryptedCopilotToken?.keyId ?? null,
                reauthRequired: false,
                updatedAt: new Date(),
              })
              .where(eq(accounts.accountId, accountId));
          }
        ),
        upsertAccount: Effect.fn("AccountRepository.upsertAccount")(
          function* upsertAccount(input: UpsertAccountInput) {
            const existing = yield* getAccountRow(input.accountId);
            const encryptedGithubToken = yield* tokenCipher.encrypt(
              input.githubToken
            );
            const encryptedCopilotToken = yield* toEncryptedSecret(
              input.copilotToken
            );
            const label = yield* ensureUniqueLabel(
              input.label,
              existing?.accountId
            );
            const now = new Date();

            if (existing === null) {
              const priority = input.priority ?? (yield* nextPriority());

              yield* db.transaction((transaction) =>
                Effect.gen(function* insertAccountTransaction() {
                  yield* transaction.insert(accounts).values({
                    accountId: input.accountId,
                    apiBaseUrl: input.apiBaseUrl,
                    copilotTokenCiphertext:
                      encryptedCopilotToken?.ciphertext ?? null,
                    copilotTokenExpiresAt: input.copilotTokenExpiresAt,
                    copilotTokenKeyId: encryptedCopilotToken?.keyId ?? null,
                    createdAt: now,
                    enabled: input.enabled,
                    githubLogin: input.githubLogin,
                    githubTokenCiphertext: encryptedGithubToken.ciphertext,
                    githubTokenKeyId: encryptedGithubToken.keyId,
                    githubUserId: input.githubUserId,
                    label,
                    priority,
                    reauthRequired: input.reauthRequired,
                    updatedAt: now,
                  });
                  yield* transaction.insert(accountRuntimeStates).values({
                    accountId: input.accountId,
                    updatedAt: now,
                  });
                  yield* replaceModelCatalog(
                    transaction,
                    input.accountId,
                    input.modelCatalog
                  );

                  const settings = yield* ensureSettingsRow(transaction);
                  if (settings.defaultAccountId === null && input.enabled) {
                    yield* updateDefaultAfterChange(
                      transaction,
                      input.accountId
                    );
                  }
                })
              );
            } else {
              const priority = input.priority ?? existing.priority;

              yield* db.transaction((transaction) =>
                Effect.gen(function* updateAccountTransaction() {
                  yield* transaction
                    .update(accounts)
                    .set({
                      apiBaseUrl: input.apiBaseUrl,
                      copilotTokenCiphertext:
                        encryptedCopilotToken?.ciphertext ?? null,
                      copilotTokenExpiresAt: input.copilotTokenExpiresAt,
                      copilotTokenKeyId: encryptedCopilotToken?.keyId ?? null,
                      enabled: input.enabled,
                      githubLogin: input.githubLogin,
                      githubTokenCiphertext: encryptedGithubToken.ciphertext,
                      githubTokenKeyId: encryptedGithubToken.keyId,
                      githubUserId: input.githubUserId,
                      label,
                      priority,
                      reauthRequired: input.reauthRequired,
                      updatedAt: now,
                    })
                    .where(eq(accounts.accountId, existing.accountId));
                  yield* replaceModelCatalog(
                    transaction,
                    existing.accountId,
                    input.modelCatalog
                  );

                  const settings = yield* ensureSettingsRow(transaction);
                  if (input.enabled && settings.defaultAccountId === null) {
                    yield* updateDefaultAfterChange(
                      transaction,
                      existing.accountId
                    );
                  }
                  if (
                    !input.enabled &&
                    settings.defaultAccountId === existing.accountId
                  ) {
                    const nextDefaultAccountId =
                      yield* pickNextDefaultAccountId(transaction);
                    yield* updateDefaultAfterChange(
                      transaction,
                      nextDefaultAccountId
                    );
                  }
                })
              );
            }

            const account = yield* loadAccountById(input.accountId);

            if (account === null) {
              return yield* Effect.fail(
                new AccountRepositoryError({
                  message: "Account was not found after the upsert completed.",
                  operation: "upsertAccount",
                })
              );
            }

            return account;
          }
        ),
      };
    }).pipe(Effect.mapError(toInitializationError)),
  }
) {
  static readonly Default = Layer.effect(this, this.make).pipe(
    Layer.provideMerge(Database.Default),
    Layer.provideMerge(TokenCipher.Default)
  );
}
