import * as Effect from "effect/Effect";

import type {
  ModelCatalogEntry,
  UpsertAccountInput,
} from "#/domain/accounts/account-types";
import type {
  CopilotTokenExchange,
  DeviceCodePollResult,
  DeviceCodeResponse,
  GitHubUser,
} from "#/services/github-copilot-auth";

export interface ImportedAccountSummary {
  readonly accountId: string;
  readonly apiBaseUrl: string;
  readonly copilotTokenExpiresAt: Date | null;
  readonly githubLogin: string;
  readonly githubUserId: string;
  readonly label: string;
  readonly modelCount: number;
}

export interface ImportGitHubTokenOptions {
  readonly enabled?: boolean;
  readonly label?: string;
  readonly modelCatalog?: readonly ModelCatalogEntry[];
  readonly priority?: number;
  readonly reauthRequired?: boolean;
}

export type DeviceLoginPollResult =
  | {
      readonly intervalSeconds: number;
      readonly status: "authorization_pending" | "slow_down";
    }
  | {
      readonly account: ImportedAccountSummary;
      readonly status: "authorized";
    }
  | {
      readonly message: string;
      readonly status: "access_denied" | "expired_token";
    };

interface AccountLoginAuth {
  readonly fetchCopilotToken: (
    githubToken: string,
    signal?: AbortSignal
  ) => Effect.Effect<CopilotTokenExchange, Error>;
  readonly fetchGitHubUser: (
    githubToken: string,
    signal?: AbortSignal
  ) => Effect.Effect<GitHubUser, Error>;
  readonly pollForAccessTokenStep: (
    deviceCode: string,
    signal?: AbortSignal
  ) => Effect.Effect<DeviceCodePollResult, Error>;
  readonly requestDeviceCode: (
    signal?: AbortSignal
  ) => Effect.Effect<DeviceCodeResponse, Error>;
}

interface AccountLoginRepository {
  readonly upsertAccount: (
    input: UpsertAccountInput
  ) => Effect.Effect<
    {
      readonly accountId: string;
      readonly apiBaseUrl: string;
      readonly copilotTokenExpiresAt: Date | null;
      readonly githubLogin: string;
      readonly githubUserId: string;
      readonly label: string;
      readonly modelIds: readonly string[];
    },
    unknown
  >;
}

const describeUnknownError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const toImportedAccountSummary = (account: {
  readonly accountId: string;
  readonly apiBaseUrl: string;
  readonly copilotTokenExpiresAt: Date | null;
  readonly githubLogin: string;
  readonly githubUserId: string;
  readonly label: string;
  readonly modelIds: readonly string[];
}): ImportedAccountSummary => ({
  accountId: account.accountId,
  apiBaseUrl: account.apiBaseUrl,
  copilotTokenExpiresAt: account.copilotTokenExpiresAt,
  githubLogin: account.githubLogin,
  githubUserId: account.githubUserId,
  label: account.label,
  modelCount: account.modelIds.length,
});

const normalizedLabel = (label: string | undefined, fallback: string): string => {
  const trimmed = label?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : fallback;
};

const buildUpsertAccountInput = (
  githubToken: string,
  user: GitHubUser,
  tokenExchange: CopilotTokenExchange,
  options?: ImportGitHubTokenOptions
) => {
  const baseInput = {
    accountId: `github-${user.userId}`,
    apiBaseUrl: tokenExchange.apiBaseUrl,
    copilotToken: tokenExchange.copilotToken,
    copilotTokenExpiresAt: tokenExchange.copilotTokenExpiresAt,
    enabled: options?.enabled ?? true,
    githubLogin: user.login,
    githubToken,
    githubUserId: user.userId,
    label: normalizedLabel(options?.label, user.login),
    modelCatalog: options?.modelCatalog ?? [],
    reauthRequired: options?.reauthRequired ?? false,
  } satisfies UpsertAccountInput;

  return options?.priority === undefined
    ? baseInput
    : { ...baseInput, priority: options.priority };
};

export const requestDeviceLogin = (
  auth: AccountLoginAuth,
  signal?: AbortSignal
): Effect.Effect<DeviceCodeResponse, Error> => auth.requestDeviceCode(signal);

export const importGitHubToken = (
  auth: Pick<AccountLoginAuth, "fetchCopilotToken" | "fetchGitHubUser">,
  repository: AccountLoginRepository,
  githubToken: string,
  signal?: AbortSignal,
  options?: ImportGitHubTokenOptions
): Effect.Effect<ImportedAccountSummary, Error | unknown> =>
  Effect.gen(function* () {
    const user = yield* auth.fetchGitHubUser(githubToken, signal);
    const tokenExchange = yield* auth.fetchCopilotToken(githubToken, signal);
    const account = yield* repository.upsertAccount(
      buildUpsertAccountInput(githubToken, user, tokenExchange, options)
    );
    return toImportedAccountSummary(account);
  });

export const pollDeviceLogin = (
  auth: Pick<
    AccountLoginAuth,
    "fetchCopilotToken" | "fetchGitHubUser" | "pollForAccessTokenStep"
  >,
  repository: AccountLoginRepository,
  deviceCode: string,
  signal?: AbortSignal
): Effect.Effect<DeviceLoginPollResult, Error | unknown> =>
  Effect.gen(function* () {
    const result = yield* auth.pollForAccessTokenStep(deviceCode, signal);

    switch (result.status) {
      case "authorization_pending":
      case "slow_down":
        return result;
      case "access_denied":
      case "expired_token":
        return result;
      case "authorized": {
        const account = yield* importGitHubToken(
          auth,
          repository,
          result.accessToken,
          signal
        );
        return { account, status: "authorized" } satisfies DeviceLoginPollResult;
      }
    }
  });

export const waitForDeviceLogin = (
  auth: Pick<
    AccountLoginAuth,
    "fetchCopilotToken" | "fetchGitHubUser" | "pollForAccessTokenStep"
  >,
  repository: AccountLoginRepository,
  deviceCode: string,
  options?: {
    readonly signal?: AbortSignal;
    readonly timeoutSeconds?: number;
  }
): Effect.Effect<ImportedAccountSummary, Error | unknown> =>
  Effect.gen(function* () {
    const timeoutSeconds = Math.max(options?.timeoutSeconds ?? 900, 1);
    let elapsedSeconds = 0;

    while (elapsedSeconds < timeoutSeconds) {
      const result = yield* pollDeviceLogin(
        auth,
        repository,
        deviceCode,
        options?.signal
      );

      switch (result.status) {
        case "authorized":
          return result.account;
        case "access_denied":
        case "expired_token":
          return yield* Effect.fail(new Error(result.message));
        case "authorization_pending":
        case "slow_down": {
          const intervalSeconds = Math.max(result.intervalSeconds, 1);
          yield* Effect.sleep(`${intervalSeconds} seconds`);
          elapsedSeconds += intervalSeconds;
          break;
        }
      }
    }

    return yield* Effect.fail(
      new Error(`Timed out waiting for authorization (${timeoutSeconds}s).`)
    );
  });

export const formatImportedAccount = (account: ImportedAccountSummary): string[] => [
  `Authenticated GitHub account: ${account.githubLogin}`,
  `Account ID: ${account.accountId}`,
  `Copilot API: ${account.apiBaseUrl}`,
  `Copilot token expires: ${account.copilotTokenExpiresAt?.toISOString() ?? "-"}`,
  `Models cached: ${account.modelCount}`,
];

export const formatDeviceLoginError = (error: unknown): string =>
  describeUnknownError(error);