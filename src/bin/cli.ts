#!/usr/bin/env bun

import { BunRuntime } from "@effect/platform-bun";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  APP_NAME,
  APP_VERSION,
  DEFAULT_HOST,
  DEFAULT_PORT,
} from "#/app/app-info";
import type { AccountSummary } from "#/domain/accounts/account-types";
import { runServer } from "#/http/server-runner";
import { AccountRepository } from "#/services/account-repository";
import {
  formatImportedAccount,
  importGitHubToken,
  requestDeviceLogin,
  waitForDeviceLogin,
} from "#/services/account-login";
import { AppConfig } from "#/services/app-config";
import type {
  CopilotPremiumRequestUsageReport,
  CopilotQuotaSnapshot,
  CopilotUsageOverview,
} from "#/services/github-copilot-auth";
import { GitHubCopilotAuth } from "#/services/github-copilot-auth";
import {
  fetchPremiumRequestUsageStatus,
} from "#/services/premium-request-usage";
import { ProxyRuntimeService } from "#/services/proxy-runtime-service";

interface ServeOptions {
  readonly host: string;
  readonly port: number;
}

interface AuthLoginOptions {
  readonly githubToken: string | undefined;
}

interface StatusRow {
  readonly account: string;
  readonly api: string;
  readonly cooldown: string;
  readonly error: string;
  readonly github: string;
  readonly lastRateLimit: string;
  readonly lastUsed: string;
  readonly localRequests: string;
  readonly localTokens: string;
  readonly models: string;
  readonly plan: string;
  readonly premium: string;
  readonly priority: string;
  readonly state: string;
  readonly token: string;
}

interface AccountUsageStatus {
  readonly accountId: string;
  readonly error: string | null;
  readonly usage: CopilotUsageOverview | null;
}

const usage = `${APP_NAME} ${APP_VERSION}

Usage:
  copilotx --version
  copilotx serve [--host HOST] [--port PORT]
  copilotx status
  copilotx auth login [--token TOKEN]
  copilotx auth status
  copilotx models
`;

const parseServeOptions = (args: readonly string[]): ServeOptions => {
  let host = DEFAULT_HOST;
  let port = DEFAULT_PORT;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const nextArg = args[index + 1];

    if (arg === "--host" || arg === "-h") {
      if (nextArg === undefined || nextArg.length === 0) {
        throw new Error("Missing value for --host");
      }
      host = nextArg;
      index += 1;
      continue;
    }

    if (arg === "--port" || arg === "-p") {
      if (nextArg === undefined || nextArg.length === 0) {
        throw new Error("Missing value for --port");
      }

      const parsedPort = Number(nextArg);
      if (
        !Number.isInteger(parsedPort) ||
        parsedPort <= 0 ||
        parsedPort > 65_535
      ) {
        throw new Error(`Invalid port: ${nextArg}`);
      }

      port = parsedPort;
      index += 1;
      continue;
    }
  }

  return { host, port };
};

const parseAuthLoginOptions = (args: readonly string[]): AuthLoginOptions => {
  let githubToken: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const nextArg = args[index + 1];

    if (arg === "--token" || arg === "-t") {
      if (nextArg === undefined || nextArg.trim().length === 0) {
        throw new Error("Missing value for --token");
      }

      githubToken = nextArg.trim();
      index += 1;
      continue;
    }

    throw new Error(`Unknown auth login option: ${arg}`);
  }

  return { githubToken };
};


const failCli = (message: string) =>
  Console.error(message).pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        process.exitCode = 1;
      })
    ),
    Effect.asVoid
  );
const describeUnknownError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const formatDuration = (totalSeconds: number): string => {
  const seconds = Math.max(Math.floor(totalSeconds), 0);
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainingSeconds = seconds % 60;

  if (days > 0) {
    return `${days}d ${hours}h`;
  }

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }

  if (minutes > 0) {
    return `${minutes}m ${remainingSeconds}s`;
  }

  return `${remainingSeconds}s`;
};

const formatAge = (value: Date | null, now: Date): string => {
  if (value === null) {
    return "-";
  }

  return `${formatDuration((now.getTime() - value.getTime()) / 1000)} ago`;
};

const formatRemaining = (value: Date | null, now: Date): string => {
  if (value === null) {
    return "-";
  }

  return formatDuration((value.getTime() - now.getTime()) / 1000);
};

const truncate = (value: string, maxLength: number): string => {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(maxLength - 1, 1))}…`;
};

const formatApiHost = (apiBaseUrl: string): string => {
  try {
    return new URL(apiBaseUrl).host;
  } catch {
    return apiBaseUrl;
  }
};

const formatTimestamp = (value: Date | null): string =>
  value === null ? "-" : value.toISOString();

const compactQuota = (snapshot: CopilotQuotaSnapshot | null | undefined): string => {
  if (snapshot === null || snapshot === undefined) {
    return "n/a";
  }

  if (snapshot.unlimited) {
    return "included";
  }

  return `${snapshot.remaining}/${snapshot.entitlement}`;
};

const detailedQuota = (snapshot: CopilotQuotaSnapshot | null | undefined): string => {
  if (snapshot === null || snapshot === undefined) {
    return "unavailable";
  }

  if (snapshot.unlimited) {
    return "included";
  }

  const used = Math.max(snapshot.entitlement - snapshot.remaining, 0);
  const overageSuffix =
    snapshot.overageCount > 0 ? `, ${snapshot.overageCount} overage` : "";

  return `${used}/${snapshot.entitlement} used, ${snapshot.remaining} remaining (${snapshot.percentRemaining.toFixed(1)}% left${overageSuffix})`;
};

const formatObservedRequests = (account: AccountSummary): string =>
  `${account.successfulRequestCount}/${account.successfulStreamCount}`;

const formatObservedTokens = (account: AccountSummary): string =>
  `${account.inputTokenCount}/${account.outputTokenCount}`;

const describeObservedUsage = (account: AccountSummary): string =>
  `${account.successfulRequestCount} requests, ${account.successfulStreamCount} streams, ${account.inputTokenCount} input tokens, ${account.outputTokenCount} output tokens`;

const formatQuantity = (value: number): string => {
  if (!Number.isFinite(value)) {
    return "0";
  }

  const rounded = Math.round(value * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2);
};

const describePremiumRequestReport = (report: CopilotPremiumRequestUsageReport): string => {
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

  const billedCostSuffix =
    totals.billedAmount > 0
      ? ` ($${totals.billedAmount.toFixed(2)} billed)`
      : "";

  return `${formatQuantity(totals.totalQuantity)} this month, ${formatQuantity(totals.includedQuantity)} included, ${formatQuantity(totals.billedQuantity)} billed overage${billedCostSuffix}`;
};

const describePremiumRequestModels = (report: CopilotPremiumRequestUsageReport): string => {
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
    .slice(0, 5);

  return topModels.length === 0
    ? "none"
    : topModels
        .map(([model, quantity]) => `${model} ${formatQuantity(quantity)}`)
        .join(", ");
};


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

const tokenState = (
  account: AccountSummary,
  now: Date,
  refreshBufferSeconds: number
): string => {
  if (account.reauthRequired) {
    return "reauth required";
  }

  if (account.copilotTokenExpiresAt === null) {
    return "missing";
  }

  const remaining = tokenRemainingSeconds(account, now);
  if (remaining === 0) {
    return "expired";
  }

  if (remaining <= refreshBufferSeconds) {
    return `refresh due ${formatDuration(remaining)}`;
  }

  return `valid ${formatDuration(remaining)}`;
};

const accountState = (account: AccountSummary, now: Date): string => {
  if (!account.enabled) {
    return "disabled";
  }

  if (account.reauthRequired) {
    return "reauth required";
  }

  if (account.cooldownUntil !== null && account.cooldownUntil.getTime() > now.getTime()) {
    return "cooling down";
  }

  if (account.lastError.length > 0) {
    return "degraded";
  }

  return "ready";
};

const renderTable = (
  headers: readonly string[],
  rows: ReadonlyArray<ReadonlyArray<string>>
): readonly string[] => {
  const widths = headers.map((header, index) =>
    rows.reduce(
      (width, row) => Math.max(width, row[index]?.length ?? 0),
      header.length
    )
  );

  const renderLine = (columns: readonly string[]) =>
    columns
      .map((column, index) => column.padEnd(widths[index] ?? column.length))
      .join("  ")
      .trimEnd();

  const separator = widths.map((width) => "-".repeat(width)).join("  ");
  return [renderLine(headers), separator, ...rows.map(renderLine)];
};

const authLive = Layer.mergeAll(
  AppConfig.Default,
  AccountRepository.Default,
  GitHubCopilotAuth.Default
);

const runAuthLoginCommand = (options: AuthLoginOptions) =>
  Effect.gen(function* runAuthLoginCommand() {
    const repository = yield* AccountRepository;
    const auth = yield* GitHubCopilotAuth;

    if (options.githubToken !== undefined) {
      const importedAccount = yield* importGitHubToken(
        auth,
        repository,
        options.githubToken
      );

      return yield* Console.log(
        [
          "Login mode: GitHub token",
          ...formatImportedAccount(importedAccount),
        ].join("\n")
      );
    }

    const deviceCode = yield* requestDeviceLogin(auth);
    yield* Console.log(
      [
        `Open this URL in your browser: ${deviceCode.verificationUri}`,
        `Enter this code: ${deviceCode.userCode}`,
        `Polling GitHub every ${deviceCode.intervalSeconds}s for up to ${formatDuration(deviceCode.expiresInSeconds)}...`,
      ].join("\n")
    );

    const importedAccount = yield* waitForDeviceLogin(
      auth,
      repository,
      deviceCode.deviceCode,
      { timeoutSeconds: deviceCode.expiresInSeconds }
    );

    return yield* Console.log(
      ["", ...formatImportedAccount(importedAccount)].join("\n")
    );
  }).pipe(
    Effect.catch((error) => failCli(describeUnknownError(error))),
    Effect.provide(authLive)
  );


const statusLive = Layer.mergeAll(
  AppConfig.Default,
  AccountRepository.Default,
  GitHubCopilotAuth.Default,
  ProxyRuntimeService.Default
);

const runModelsCommand = Effect.gen(function* runModelsCommand() {
  const repository = yield* AccountRepository;
  const runtime = yield* ProxyRuntimeService;
  const accounts = yield* repository.listAccounts();

  if (accounts.length === 0) {
    return yield* failCli(
      "Not authenticated.\n\nRun `copilotx auth login`, or import an existing account first."
    );
  }

  const models = yield* runtime.listModels();
  const sortedModels = [...models].sort(
    (left, right) =>
      left.id.localeCompare(right.id) ||
      (left.vendor ?? "").localeCompare(right.vendor ?? "")
  );
  const hiddenCount = sortedModels.filter((model) => model.hidden === true).length;
  const visibleCount = sortedModels.length - hiddenCount;
  const tableLines = renderTable(
    ["Model", "Vendor", "Hidden"],
    sortedModels.map((model) => [
      model.id,
      model.vendor?.trim() || "github-copilot",
      model.hidden === true ? "yes" : "no",
    ])
  );

  const summaryLines = [
    `${APP_NAME} v${APP_VERSION}`,
    `Models: ${sortedModels.length} total, ${visibleCount} visible, ${hiddenCount} hidden`,
    "",
    ...tableLines,
  ];

  return yield* Console.log(summaryLines.join("\n"));
}).pipe(
  Effect.catch((error) => failCli(describeUnknownError(error))),
  Effect.provide(statusLive)
);

const runStatusCommand = Effect.gen(function* runStatusCommand() {
  const config = yield* AppConfig;
  const repository = yield* AccountRepository;
  const auth = yield* GitHubCopilotAuth;
  const runtime = yield* ProxyRuntimeService;
  let accounts = yield* repository.listAccounts();

  if (accounts.length === 0) {
    return yield* failCli(
      "Not authenticated.\n\nRun `copilotx auth login`, or import an existing account first."
    );
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
  const longestValidTokenLifetime =
    validTokenLifetimes.length === 0 ? 0 : Math.max(...validTokenLifetimes);
  const defaultAccount = accounts.find(
    (account) => account.accountId === runtimeSettings.defaultAccountId
  );
  const primaryAccount = defaultAccount ?? accounts[0] ?? null;
  const primaryUsage =
    primaryAccount === null
      ? null
      : (usageByAccountId.get(primaryAccount.accountId) ?? null);
  const primaryBillingUsage =
    primaryAccount === null
      ? null
      : yield* fetchPremiumRequestUsageStatus(
          auth,
          primaryAccount,
          config.security.githubBillingToken,
          now
        );

  const cachedModelCount = new Set(accounts.flatMap((account) => account.modelIds)).size;

  const rows: StatusRow[] = accounts.map((account) => {
    const usageStatus = usageByAccountId.get(account.accountId) ?? null;
    const usageError = usageStatus?.error ?? "";
    const premium =
      usageStatus?.usage === null || usageStatus?.usage === undefined
        ? usageError.length === 0
          ? "n/a"
          : "error"
        : compactQuota(usageStatus.usage.quotaSnapshots.premiumInteractions);

    return {
      account:
        account.accountId === runtimeSettings.defaultAccountId
          ? `${account.label} *`
          : account.label,
      api: formatApiHost(account.apiBaseUrl),
      cooldown:
        account.cooldownUntil !== null && account.cooldownUntil.getTime() > now.getTime()
          ? formatRemaining(account.cooldownUntil, now)
          : "-",
      error:
        account.lastError.length > 0
          ? truncate(account.lastError, 48)
          : usageError.length > 0
            ? truncate(`quota: ${usageError}`, 48)
            : "-",
      github: account.githubLogin,
      lastRateLimit: formatAge(account.lastRateLimitedAt, now),
      lastUsed: formatAge(account.lastUsedAt, now),
      localRequests: formatObservedRequests(account),
      localTokens: formatObservedTokens(account),
      models: String(account.modelIds.length),
      plan: usageStatus?.usage?.plan || "-",
      premium,
      priority: String(account.priority),
      state: accountState(account, now),
      token: tokenState(account, now, config.upstream.tokenRefreshBufferSeconds),
    } satisfies StatusRow;
  });

  const tableLines = renderTable(
    [
      "Account",
      "GitHub",
      "State",
      "Cooldown",
      "Token",
      "Premium",
      "Plan",
      "Req/Str",
      "In/Out Tok",
      "Models",
      "Last 429",
      "Last Used",
      "Priority",
      "API",
      "Last Error",
    ],
    rows.map((row) => [
      row.account,
      row.github,
      row.state,
      row.cooldown,
      row.token,
      row.premium,
      row.plan,
      row.localRequests,
      row.localTokens,
      row.models,
      row.lastRateLimit,
      row.lastUsed,
      row.priority,
      row.api,
      row.error,
    ])
  );

  const quotaSummaryLines =
    primaryUsage?.usage === null || primaryUsage?.usage === undefined
      ? [
          `Premium requests: unavailable${primaryUsage?.error ? ` (${primaryUsage.error})` : ""}`,
        ]
      : [
          `Copilot plan: ${primaryUsage.usage.plan || "-"}`,
          `Premium requests: ${detailedQuota(primaryUsage.usage.quotaSnapshots.premiumInteractions)}`,
          `Chat requests: ${detailedQuota(primaryUsage.usage.quotaSnapshots.chat)}`,
          `Completions: ${detailedQuota(primaryUsage.usage.quotaSnapshots.completions)}`,
          `Quota reset: ${formatTimestamp(primaryUsage.usage.quotaResetAt)}`,
        ];

  const billingSummaryLines =
    primaryBillingUsage?.report === null || primaryBillingUsage?.report === undefined
      ? [
          `Premium request report: unavailable${primaryBillingUsage?.error ? ` (${primaryBillingUsage.error})` : ""}`,
        ]
      : [
          `Premium request report user: ${primaryBillingUsage.report.user || "-"}`,
          `Premium request report: ${describePremiumRequestReport(primaryBillingUsage.report)}`,
          `Premium request models: ${describePremiumRequestModels(primaryBillingUsage.report)}`,
        ];

  const summaryLines = [
    `${APP_NAME} v${APP_VERSION}`,
    `Authenticated: yes`,
    `Accounts: ${accounts.length} total, ${enabledAccounts.length} enabled, ${healthyAccounts.length} healthy, ${coolingDownAccounts.length} cooling down, ${reauthAccounts.length} reauth required`,
    `Rotation strategy: ${runtimeSettings.rotationStrategy}`,
    `Default account: ${defaultAccount?.label ?? "-"}`,
    `Token status: ${longestValidTokenLifetime > 0 ? `valid (${formatDuration(longestValidTokenLifetime)} remaining)` : "no valid Copilot token cached"}`,
    `Model catalog: ${modelRefresh.mergedModelCount ?? cachedModelCount} ${modelRefresh.mergedModelCount === null ? "cached" : "live"}`,
    `Catalog refresh: ${modelRefresh.error === null ? "ok" : `failed (${modelRefresh.error})`}`,
    ...quotaSummaryLines,
    ...billingSummaryLines,
    "Global token usage: unavailable — GitHub's Copilot and billing APIs expose request/quota data, not prompt/completion token totals.",
    `Local proxy usage: ${primaryAccount === null ? "unavailable" : describeObservedUsage(primaryAccount)}`,
    "",
    ...tableLines,
  ];

  return yield* Console.log(summaryLines.join("\n"));
}).pipe(
  Effect.catch((error) => failCli(describeUnknownError(error))),
  Effect.provide(statusLive)
);

const runCli = (args: readonly string[]) => {
  if (args.length === 0 || args[0] === "--version" || args[0] === "-v") {
    return Console.log(`${APP_NAME} v${APP_VERSION}`);
  }

  if (args[0] === "serve") {
    return Effect.suspend(() => {
      const options = parseServeOptions(args.slice(1));
      return runServer(options);
    });
  }

  if (args[0] === "status" || (args[0] === "auth" && args[1] === "status")) {
    return runStatusCommand;
  }

  if (args[0] === "auth" && args[1] === "login") {
    return runAuthLoginCommand(parseAuthLoginOptions(args.slice(2)));
  }

  if (args[0] === "models") {
    return runModelsCommand;
  }

  return failCli(`Unknown command.\n\n${usage}`);
};

BunRuntime.runMain(runCli(Bun.argv.slice(2)));
