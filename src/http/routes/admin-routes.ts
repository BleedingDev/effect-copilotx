import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/unstable/http/HttpRouter";

import {
  authorizeAdminRequest,
  jsonResponse,
  readJsonRecord,
} from "#/http/http-helpers";
import { importGitHubToken } from "#/services/account-login";
import { collectAdminStatusSnapshot } from "#/services/admin-status";
import { AccountRepository } from "#/services/account-repository";
import { AppConfig } from "#/services/app-config";
import { GitHubCopilotAuth } from "#/services/github-copilot-auth";

const enabledValidationMessage = "`enabled` must be a boolean when provided.";
const githubTokenValidationMessage =
  "`github_token` must be a non-empty string.";
const priorityValidationMessage =
  "`priority` must be a non-negative integer when provided.";
const labelValidationMessage = "`label` must be a string when provided.";
const validationMessages = new Set([
  "Expected a JSON object request body.",
  enabledValidationMessage,
  githubTokenValidationMessage,
  labelValidationMessage,
  priorityValidationMessage,
]);

interface GitHubTokenImportPayload {
  readonly enabled: boolean;
  readonly githubToken: string;
  readonly label: string | undefined;
  readonly priority: number | undefined;
}

const asOptionalLabel = (value: unknown): string | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(labelValidationMessage);
  }

  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
};

const asGitHubTokenImportPayload = (
  body: Record<string, unknown>
): GitHubTokenImportPayload => {
  const githubTokenValue = body.github_token;
  if (typeof githubTokenValue !== "string") {
    throw new Error(githubTokenValidationMessage);
  }

  const githubToken = githubTokenValue.trim();
  if (githubToken.length === 0) {
    throw new Error(githubTokenValidationMessage);
  }

  const enabledValue = body.enabled;
  if (enabledValue !== undefined && typeof enabledValue !== "boolean") {
    throw new Error(enabledValidationMessage);
  }

  const priorityValue = body.priority;
  if (
    priorityValue !== undefined &&
    (typeof priorityValue !== "number" ||
      !Number.isInteger(priorityValue) ||
      priorityValue < 0)
  ) {
    throw new Error(priorityValidationMessage);
  }

  return {
    enabled: enabledValue ?? true,
    githubToken,
    label: asOptionalLabel(body.label),
    priority: priorityValue,
  };
};

const adminRouteErrorStatus = (error: unknown): number => {
  const message = error instanceof Error ? error.message : String(error);
  return validationMessages.has(message) ? 400 : 500;
};

const adminStatusRoute = HttpRouter.add("GET", "/admin/status", (request) =>
  Effect.gen(function* adminStatusRoute() {
    const config = yield* AppConfig;
    const unauthorized = authorizeAdminRequest(request, config);
    if (unauthorized !== null) {
      return unauthorized;
    }

    const snapshot = yield* collectAdminStatusSnapshot;
    return jsonResponse(request, config, {
      accounts: snapshot.accounts.map((account) => ({
        account_id: account.accountId,
        api_host: account.apiHost,
        cooldown_until: account.cooldownUntil?.toISOString() ?? null,
        default_account: account.defaultAccount,
        enabled: account.enabled,
        github_login: account.githubLogin,
        last_error: account.lastError,
        last_rate_limited_at: account.lastRateLimitedAt?.toISOString() ?? null,
        last_used_at: account.lastUsedAt?.toISOString() ?? null,
        local_proxy_usage: {
          input_tokens: account.localProxyUsage.inputTokens,
          output_tokens: account.localProxyUsage.outputTokens,
          requests: account.localProxyUsage.requests,
          streams: account.localProxyUsage.streams,
        },
        model_count: account.modelCount,
        plan: account.plan,
        premium_requests:
          account.premiumRequests === null
            ? null
            : {
                entitlement: account.premiumRequests.entitlement,
                overage_count: account.premiumRequests.overageCount,
                remaining: account.premiumRequests.remaining,
                unlimited: account.premiumRequests.unlimited,
              },
        priority: account.priority,
        reauth_required: account.reauthRequired,
        state: account.state,
        token_expires_at: account.tokenExpiresAt?.toISOString() ?? null,
        token_remaining_seconds: account.tokenRemainingSeconds,
        token_valid: account.tokenValid,
        usage_error: account.usageError,
      })),
      authenticated: snapshot.authenticated,
      billing: {
        error: snapshot.billing.error,
        summary: snapshot.billing.summary,
        top_models: snapshot.billing.topModels.map((model) => ({
          model: model.model,
          quantity: model.quantity,
        })),
      },
      counts: {
        cooling_down: snapshot.counts.coolingDown,
        enabled: snapshot.counts.enabled,
        healthy: snapshot.counts.healthy,
        reauth_required: snapshot.counts.reauthRequired,
        total: snapshot.counts.total,
      },
      default_account_id: snapshot.defaultAccountId,
      local_proxy_usage: {
        input_tokens: snapshot.localProxyUsage.inputTokens,
        output_tokens: snapshot.localProxyUsage.outputTokens,
        requests: snapshot.localProxyUsage.requests,
        streams: snapshot.localProxyUsage.streams,
      },
      longest_valid_token_lifetime_seconds:
        snapshot.longestValidTokenLifetimeSeconds,
      model_catalog: {
        count: snapshot.modelCatalog.count,
        live: snapshot.modelCatalog.live,
        refresh_error: snapshot.modelCatalog.refreshError,
      },
      premium_requests_global: {
        entitlement: snapshot.premiumRequestsGlobal.entitlement,
        metered_accounts: snapshot.premiumRequestsGlobal.meteredAccounts,
        remaining: snapshot.premiumRequestsGlobal.remaining,
        unavailable_accounts: snapshot.premiumRequestsGlobal.unavailableAccounts,
        unlimited_accounts: snapshot.premiumRequestsGlobal.unlimitedAccounts,
        used: snapshot.premiumRequestsGlobal.used,
      },
      rotation_strategy: snapshot.rotationStrategy,
      unhealthy_accounts: snapshot.accounts
        .filter((account) => account.state !== "ready")
        .map((account) => account.accountId),
    });
  }).pipe(
    Effect.catch((error) =>
      Effect.gen(function* () {
        const config = yield* AppConfig;
        return jsonResponse(
          request,
          config,
          {
            error: {
              message: error instanceof Error ? error.message : String(error),
              type: "admin_status_error",
            },
          },
          500
        );
      })
    )
  )
);

const importGitHubTokenRoute = HttpRouter.add(
  "POST",
  "/admin/accounts/import-github-token",
  (request) =>
    Effect.gen(function* importGitHubTokenRoute() {
      const config = yield* AppConfig;
      const unauthorized = authorizeAdminRequest(request, config);
      if (unauthorized !== null) {
        return unauthorized;
      }

      const body = yield* readJsonRecord(request);
      const payload = asGitHubTokenImportPayload(body);
      const auth = yield* GitHubCopilotAuth;
      const repository = yield* AccountRepository;
      const importOptions = {
        enabled: payload.enabled,
        ...(payload.label === undefined ? {} : { label: payload.label }),
        ...(payload.priority === undefined ? {} : { priority: payload.priority }),
      };
      const account = yield* importGitHubToken(
        auth,
        repository,
        payload.githubToken,
        undefined,
        importOptions
      );
      const persisted = yield* repository.getAccountSummary(account.accountId);

      return jsonResponse(request, config, {
        account: {
          account_id: account.accountId,
          api_base_url: account.apiBaseUrl,
          copilot_token_expires_at:
            account.copilotTokenExpiresAt?.toISOString() ?? null,
          enabled: persisted?.enabled ?? payload.enabled,
          github_login: account.githubLogin,
          github_user_id: account.githubUserId,
          label: account.label,
          model_count: account.modelCount,
          priority: persisted?.priority ?? payload.priority ?? null,
        },
        object: "github_token_import",
        status: "imported",
      });
    }).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          const config = yield* AppConfig;
          const status = adminRouteErrorStatus(error);
          return jsonResponse(
            request,
            config,
            {
              error: {
                message: error instanceof Error ? error.message : String(error),
                type: "github_token_import_error",
              },
            },
            status
          );
        })
      )
    )
);

export const adminRoutes = [adminStatusRoute, importGitHubTokenRoute] as const;
