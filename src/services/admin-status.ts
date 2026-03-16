import * as Effect from "effect/Effect";

import type { AccountSummary, RotationStrategy } from "#/domain/accounts/account-types";
import { AccountRepository } from "#/services/account-repository";
import { AppConfig } from "#/services/app-config";
import type {
  CopilotPremiumRequestUsageReport,
  CopilotQuotaSnapshot,
  CopilotUsageOverview,
} from "#/services/github-copilot-auth";
import { GitHubCopilotAuth } from "#/services/github-copilot-auth";
import { fetchPremiumRequestUsageStatus } from "#/services/premium-request-usage";
import { ProxyRuntimeService } from "#/services/proxy-runtime-service";

interface AccountUsageStatus {
  readonly accountId: string;
  readonly error: string | null;
  readonly usage: CopilotUsageOverview | null;
}

export interface AdminStatusQuotaAggregate {
  readonly entitlement: number;
  readonly meteredAccounts: number;
  readonly remaining: number;
  readonly unavailableAccounts: number;
  readonly unlimitedAccounts: number;
  readonly used: number;
}

export interface AdminStatusBillingSummary {
  readonly error: string | null;
  readonly summary: string | null;
  readonly topModels: readonly {
    readonly model: string;
    readonly quantity: number;
  }[];
}

export interface AdminStatusAccountSnapshot {
  readonly accountId: string;
  readonly apiHost: string;
  readonly cooldownUntil: Date | null;
  readonly defaultAccount: boolean;
  readonly enabled: boolean;
  readonly githubLogin: string;
  readonly lastError: string;
  readonly lastRateLimitedAt: Date | null;
  readonly lastUsedAt: Date | null;
  readonly localProxyUsage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly requests: number;
    readonly streams: number;
  };
  readonly modelCount: number;
  readonly plan: string | null;
  readonly premiumRequests: CopilotQuotaSnapshot | null;
  readonly priority: number;
  readonly reauthRequired: boolean;
  readonly state: "cooling_down" | "degraded" | "disabled" | "ready" | "reauth_required";
  readonly tokenExpiresAt: Date | null;
  readonly tokenRemainingSeconds: number;
  readonly tokenValid: boolean;
  readonly usageError: string | null;
}

export interface AdminStatusSnapshot {
  readonly accounts: readonly AdminStatusAccountSnapshot[];
  readonly authenticated: boolean;
  readonly billing: AdminStatusBillingSummary;
  readonly counts: {
    readonly coolingDown: number;
    readonly enabled: number;
    readonly healthy: number;
    readonly reauthRequired: number;
    readonly total: number;
  };
  readonly defaultAccountId: string | null;
  readonly localProxyUsage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly requests: number;
    readonly streams: number;
  };
  readonly longestValidTokenLifetimeSeconds: number;
  readonly modelCatalog: {
    readonly count: number;
    readonly live: boolean;
    readonly refreshError: string | null;
  };
  readonly premiumRequestsGlobal: AdminStatusQuotaAggregate;
  readonly rotationStrategy: RotationStrategy;
}

const describeUnknownError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const tokenRemainingSeconds = (
  account: Pick<AccountSummary, "copilotTokenExpiresAt">,
  now: Date
): number => {
  if (account.copilotTokenExpiresAt === null) {
    return 0;
  }

  return Math.max(
    Math.floor((account.copilotTokenExpiresAt.getTime() - now.getTime()) / 1000),
    0
  );
};

const accountState = (
  account: AccountSummary,
  now: Date
): AdminStatusAccountSnapshot["state"] => {
  if (!account.enabled) {
    return "disabled";
  }

  if (account.reauthRequired) {
    return "reauth_required";
  }

  if (account.cooldownUntil !== null && account.cooldownUntil.getTime() > now.getTime()) {
    return "cooling_down";
  }

  if (account.lastError.length > 0) {
    return "degraded";
  }

  return "ready";
};

const formatApiHost = (apiBaseUrl: string): string => {
  try {
    return new URL(apiBaseUrl).host;
  } catch {
    return apiBaseUrl;
  }
};

const aggregateQuotaSnapshots = (
  snapshots: readonly (CopilotQuotaSnapshot | null | undefined)[]
): AdminStatusQuotaAggregate =>
  snapshots.reduce<AdminStatusQuotaAggregate>(
    (summary, snapshot) => {
      if (snapshot === null || snapshot === undefined) {
        return {
          ...summary,
          unavailableAccounts: summary.unavailableAccounts + 1,
        };
      }

      if (snapshot.unlimited) {
        return {
          ...summary,
          unlimitedAccounts: summary.unlimitedAccounts + 1,
        };
      }

      return {
        entitlement: summary.entitlement + snapshot.entitlement,
        meteredAccounts: summary.meteredAccounts + 1,
        remaining: summary.remaining + snapshot.remaining,
        unavailableAccounts: summary.unavailableAccounts,
        unlimitedAccounts: summary.unlimitedAccounts,
        used:
          summary.used + Math.max(snapshot.entitlement - snapshot.remaining, 0),
      };
    },
    {
      entitlement: 0,
      meteredAccounts: 0,
      remaining: 0,
      unavailableAccounts: 0,
      unlimitedAccounts: 0,
      used: 0,
    }
  );

const summarizeBillingReport = (
  report: CopilotPremiumRequestUsageReport | null,
  error: string | null
): AdminStatusBillingSummary => {
  if (report === null) {
    return {
      error,
      summary: null,
      topModels: [],
    };
  }

  const totals = report.usageItems.reduce(
    (summary, item) => ({
      billedAmount: summary.billedAmount + item.netAmount,
      billedQuantity: summary.billedQuantity + item.netQuantity,
      includedQuantity: summary.includedQuantity + item.discountQuantity,
      totalQuantity: summary.totalQuantity + item.grossQuantity,
    }),
    {
      billedAmount: 0,
      billedQuantity: 0,
      includedQuantity: 0,
      totalQuantity: 0,
    }
  );

  const usageByModel = new Map<string, number>();
  for (const item of report.usageItems) {
    const model = item.model.trim();
    if (model.length === 0) {
      continue;
    }

    usageByModel.set(model, (usageByModel.get(model) ?? 0) + item.grossQuantity);
  }

  const topModels = [...usageByModel.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 5)
    .map(([model, quantity]) => ({ model, quantity }));

  const billedCostSuffix =
    totals.billedAmount > 0
      ? ` ($${totals.billedAmount.toFixed(2)} billed)`
      : "";

  return {
    error: null,
    summary: `${totals.totalQuantity} this month, ${totals.includedQuantity} included, ${totals.billedQuantity} billed overage${billedCostSuffix}`,
    topModels,
  };
};

export const collectAdminStatusSnapshot = Effect.gen(
  function* collectAdminStatusSnapshot() {
    const config = yield* AppConfig;
    const repository = yield* AccountRepository;
    const auth = yield* GitHubCopilotAuth;
    const runtime = yield* ProxyRuntimeService;
    let accounts = yield* repository.listAccounts();

    if (accounts.length === 0) {
      return {
        accounts: [],
        authenticated: false,
        billing: { error: null, summary: null, topModels: [] },
        counts: {
          coolingDown: 0,
          enabled: 0,
          healthy: 0,
          reauthRequired: 0,
          total: 0,
        },
        defaultAccountId: null,
        localProxyUsage: {
          inputTokens: 0,
          outputTokens: 0,
          requests: 0,
          streams: 0,
        },
        longestValidTokenLifetimeSeconds: 0,
        modelCatalog: {
          count: 0,
          live: false,
          refreshError: null,
        },
        premiumRequestsGlobal: aggregateQuotaSnapshots([]),
        rotationStrategy: "fill-first" as RotationStrategy,
      } satisfies AdminStatusSnapshot;
    }

    const modelRefresh = yield* runtime.listModels().pipe(
      Effect.map((models) => ({
        error: null as string | null,
        mergedModelCount: models.length,
      })),
      Effect.catch((error) =>
        Effect.succeed({
          error: describeUnknownError(error),
          mergedModelCount: null as number | null,
        })
      )
    );

    accounts = yield* repository.listAccounts();

    const usageStatuses = yield* Effect.all(
      accounts.map((account) =>
        auth.fetchUsage(account.githubToken).pipe(
          Effect.map(
            (usage) =>
              ({
                accountId: account.accountId,
                error: null,
                usage,
              }) satisfies AccountUsageStatus
          ),
          Effect.catch((error) =>
            Effect.succeed({
              accountId: account.accountId,
              error: describeUnknownError(error),
              usage: null,
            } satisfies AccountUsageStatus)
          )
        )
      )
    );

    const usageByAccountId = new Map(
      usageStatuses.map((status) => [status.accountId, status] as const)
    );

    const runtimeSettings = yield* repository.getRuntimeSettings();
    const now = new Date();
    const enabledAccounts = accounts.filter((account) => account.enabled);
    const coolingDownAccounts = enabledAccounts.filter(
      (account) =>
        account.cooldownUntil !== null && account.cooldownUntil.getTime() > now.getTime()
    );
    const reauthAccounts = enabledAccounts.filter((account) => account.reauthRequired);
    const healthyAccounts = enabledAccounts.filter(
      (account) =>
        !account.reauthRequired &&
        (account.cooldownUntil === null || account.cooldownUntil.getTime() <= now.getTime()) &&
        account.lastError.length === 0
    );
    const validTokenLifetimes = enabledAccounts
      .map((account) => tokenRemainingSeconds(account, now))
      .filter(
        (remaining) => remaining > config.upstream.tokenRefreshBufferSeconds
      );
    const longestValidTokenLifetimeSeconds =
      validTokenLifetimes.length === 0 ? 0 : Math.max(...validTokenLifetimes);
    const billingAccount =
      accounts.find((account) => account.accountId === runtimeSettings.defaultAccountId) ??
      accounts[0] ??
      null;
    const billingUsage =
      billingAccount === null
        ? null
        : yield* fetchPremiumRequestUsageStatus(
            auth,
            billingAccount,
            config.security.githubBillingToken,
            now
          );

    const snapshotAccounts = accounts.map((account) => {
      const usageStatus = usageByAccountId.get(account.accountId) ?? null;
      const remainingSeconds = tokenRemainingSeconds(account, now);

      return {
        accountId: account.accountId,
        apiHost: formatApiHost(account.apiBaseUrl),
        cooldownUntil: account.cooldownUntil,
        defaultAccount: account.accountId === runtimeSettings.defaultAccountId,
        enabled: account.enabled,
        githubLogin: account.githubLogin,
        lastError: account.lastError,
        lastRateLimitedAt: account.lastRateLimitedAt,
        lastUsedAt: account.lastUsedAt,
        localProxyUsage: {
          inputTokens: account.inputTokenCount,
          outputTokens: account.outputTokenCount,
          requests: account.successfulRequestCount,
          streams: account.successfulStreamCount,
        },
        modelCount: account.modelIds.length,
        plan: usageStatus?.usage?.plan || null,
        premiumRequests: usageStatus?.usage?.quotaSnapshots.premiumInteractions ?? null,
        priority: account.priority,
        reauthRequired: account.reauthRequired,
        state: accountState(account, now),
        tokenExpiresAt: account.copilotTokenExpiresAt,
        tokenRemainingSeconds: remainingSeconds,
        tokenValid:
          remainingSeconds > config.upstream.tokenRefreshBufferSeconds &&
          !account.reauthRequired,
        usageError: usageStatus?.error ?? null,
      } satisfies AdminStatusAccountSnapshot;
    });

    const localProxyUsage = accounts.reduce(
      (summary, account) => ({
        inputTokens: summary.inputTokens + account.inputTokenCount,
        outputTokens: summary.outputTokens + account.outputTokenCount,
        requests: summary.requests + account.successfulRequestCount,
        streams: summary.streams + account.successfulStreamCount,
      }),
      {
        inputTokens: 0,
        outputTokens: 0,
        requests: 0,
        streams: 0,
      }
    );

    return {
      accounts: snapshotAccounts,
      authenticated: true,
      billing: summarizeBillingReport(
        billingUsage?.report ?? null,
        billingUsage?.error ?? null
      ),
      counts: {
        coolingDown: coolingDownAccounts.length,
        enabled: enabledAccounts.length,
        healthy: healthyAccounts.length,
        reauthRequired: reauthAccounts.length,
        total: accounts.length,
      },
      defaultAccountId: runtimeSettings.defaultAccountId,
      localProxyUsage,
      longestValidTokenLifetimeSeconds,
      modelCatalog: {
        count:
          modelRefresh.mergedModelCount ??
          new Set(accounts.flatMap((account) => account.modelIds)).size,
        live: modelRefresh.mergedModelCount !== null,
        refreshError: modelRefresh.error,
      },
      premiumRequestsGlobal: aggregateQuotaSnapshots(
        usageStatuses.map(
          (status) => status.usage?.quotaSnapshots.premiumInteractions ?? null
        )
      ),
      rotationStrategy: runtimeSettings.rotationStrategy,
    } satisfies AdminStatusSnapshot;
  }
);
