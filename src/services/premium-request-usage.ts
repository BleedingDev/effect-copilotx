import * as Effect from "effect/Effect";

import type {
  CopilotPremiumRequestUsageReport,
  GitHubUser,
} from "#/services/github-copilot-auth";
export interface PremiumRequestUsageStatus {
  readonly error: string | null;
  readonly report: CopilotPremiumRequestUsageReport | null;
}

interface BillingUsageAuth {
  readonly fetchGitHubUser: (
    githubToken: string,
    signal?: AbortSignal
  ) => Effect.Effect<GitHubUser, Error>;
  readonly fetchPremiumRequestUsage: (
    username: string,
    githubToken: string,
    options?: {
      readonly day?: number;
      readonly month?: number;
      readonly signal?: AbortSignal;
      readonly year?: number;
    }
  ) => Effect.Effect<CopilotPremiumRequestUsageReport, Error>;
}

interface BillingUsageAccount {
  readonly githubLogin: string;
  readonly githubToken: string;
}

const describeUnknownError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const normalizeToken = (token: string | undefined): string | null => {
  const trimmed = token?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : null;
};

const buildTokenCandidates = (
  account: BillingUsageAccount,
  billingToken: string | undefined
): ReadonlyArray<readonly [token: string, preferredUsername: string | undefined]> => {
  const candidates = new Map<string, string | undefined>();

  const accountToken = normalizeToken(account.githubToken);
  if (accountToken !== null) {
    candidates.set(accountToken, account.githubLogin);
  }

  const configuredBillingToken = normalizeToken(billingToken);
  if (configuredBillingToken !== null && !candidates.has(configuredBillingToken)) {
    candidates.set(configuredBillingToken, undefined);
  }

  return [...candidates.entries()];
};

const resolveUsername = (
  auth: BillingUsageAuth,
  token: string,
  preferredUsername: string | undefined,
  signal: AbortSignal | undefined
): Effect.Effect<string, Error> => {
  const username = preferredUsername?.trim() ?? "";
  if (username.length > 0) {
    return Effect.succeed(username);
  }

  return auth.fetchGitHubUser(token, signal).pipe(
    Effect.map((user) => user.login.trim()),
    Effect.flatMap((login) =>
      login.length > 0
        ? Effect.succeed(login)
        : Effect.fail(new Error("GitHub billing token resolved without a login."))
    )
  );
};

export const fetchPremiumRequestUsageStatus = (
  auth: BillingUsageAuth,
  account: BillingUsageAccount,
  billingToken: string | undefined,
  now: Date,
  signal?: AbortSignal
): Effect.Effect<PremiumRequestUsageStatus, never> =>
  Effect.gen(function* () {
    let lastError: string | null = null;

    for (const [token, preferredUsername] of buildTokenCandidates(account, billingToken)) {
      const attempt = yield* resolveUsername(
        auth,
        token,
        preferredUsername,
        signal
      ).pipe(
        Effect.flatMap((username) =>
          auth.fetchPremiumRequestUsage(username, token, {
            month: now.getUTCMonth() + 1,
            ...(signal === undefined ? {} : { signal }),
            year: now.getUTCFullYear(),
          })
        ),
        Effect.map((report) => ({ error: null, report } satisfies PremiumRequestUsageStatus)),
        Effect.catch((error) =>
          Effect.succeed({
            error: describeUnknownError(error),
            report: null,
          } satisfies PremiumRequestUsageStatus)
        )
      );

      if (attempt.report !== null) {
        return attempt;
      }

      lastError = attempt.error;
    }

    return {
      error: lastError ?? "no billing-capable GitHub token configured",
      report: null,
    } satisfies PremiumRequestUsageStatus;
  });
