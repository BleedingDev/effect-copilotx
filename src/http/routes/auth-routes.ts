import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/unstable/http/HttpRouter";

import {
  authorizeImportRequest,
  authorizeRequest,
  jsonResponse,
  readJsonRecord,
} from "#/http/http-helpers";
import {
  importGitHubToken,
  pollDeviceLogin,
  requestDeviceLogin,
} from "#/services/account-login";
import { AccountRepository } from "#/services/account-repository";
import { AppConfig } from "#/services/app-config";
import { GitHubCopilotAuth } from "#/services/github-copilot-auth";

const deviceCodeValidationMessage = "`device_code` must be a non-empty string.";
const enabledValidationMessage = "`enabled` must be a boolean when provided.";
const githubTokenValidationMessage =
  "`github_token` must be a non-empty string.";
const priorityValidationMessage =
  "`priority` must be a non-negative integer when provided.";
const validationMessages = new Set([
  "Expected a JSON object request body.",
  deviceCodeValidationMessage,
  enabledValidationMessage,
  githubTokenValidationMessage,
  priorityValidationMessage,
]);

interface GitHubTokenImportPayload {
  readonly enabled: boolean;
  readonly githubToken: string;
  readonly label: string | undefined;
  readonly priority: number | undefined;
}

const asDeviceCode = (body: Record<string, unknown>): string => {
  const value = body.device_code;
  if (typeof value !== "string") {
    throw new Error(deviceCodeValidationMessage);
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(deviceCodeValidationMessage);
  }

  return trimmed;
};

const asOptionalLabel = (value: unknown): string | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error("`label` must be a string when provided.");
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

const authRouteErrorStatus = (error: unknown): number => {
  const message = error instanceof Error ? error.message : String(error);
  return validationMessages.has(message) ||
    message === "`label` must be a string when provided."
    ? 400
    : 500;
};

const deviceAuthorizationRoute = HttpRouter.add("POST", "/auth/device", (request) =>
  Effect.gen(function* deviceAuthorizationRoute() {
    const config = yield* AppConfig;
    const unauthorized = authorizeRequest(request, config);
    if (unauthorized !== null) {
      return unauthorized;
    }

    const auth = yield* GitHubCopilotAuth;
    const deviceCode = yield* requestDeviceLogin(auth);

    return jsonResponse(request, config, {
      expires_in_seconds: deviceCode.expiresInSeconds,
      interval_seconds: deviceCode.intervalSeconds,
      object: "device_authorization",
      status: "authorization_pending",
      device_code: deviceCode.deviceCode,
      user_code: deviceCode.userCode,
      verification_uri: deviceCode.verificationUri,
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
              type: "device_authorization_error",
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
  "/auth/import-github-token",
  (request) =>
    Effect.gen(function* importGitHubTokenRoute() {
      const config = yield* AppConfig;
      const unauthorized = authorizeImportRequest(request, config);
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
          const status = authRouteErrorStatus(error);
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

const pollDeviceAuthorizationRoute = HttpRouter.add(
  "POST",
  "/auth/device/poll",
  (request) =>
    Effect.gen(function* pollDeviceAuthorizationRoute() {
      const config = yield* AppConfig;
      const unauthorized = authorizeRequest(request, config);
      if (unauthorized !== null) {
        return unauthorized;
      }

      const body = yield* readJsonRecord(request);
      const deviceCode = asDeviceCode(body);
      const auth = yield* GitHubCopilotAuth;
      const repository = yield* AccountRepository;
      const result = yield* pollDeviceLogin(auth, repository, deviceCode);

      switch (result.status) {
        case "authorized":
          return jsonResponse(request, config, {
            account: {
              account_id: result.account.accountId,
              api_base_url: result.account.apiBaseUrl,
              copilot_token_expires_at:
                result.account.copilotTokenExpiresAt?.toISOString() ?? null,
              github_login: result.account.githubLogin,
              github_user_id: result.account.githubUserId,
              label: result.account.label,
              model_count: result.account.modelCount,
            },
            object: "device_authorization",
            status: "authorized",
          });
        case "authorization_pending":
        case "slow_down":
          return jsonResponse(
            request,
            config,
            {
              interval_seconds: result.intervalSeconds,
              object: "device_authorization",
              status: result.status,
            },
            202
          );
        case "access_denied":
          return jsonResponse(
            request,
            config,
            {
              error: {
                message: result.message,
                type: result.status,
              },
              object: "device_authorization",
              status: result.status,
            },
            403
          );
        case "expired_token":
          return jsonResponse(
            request,
            config,
            {
              error: {
                message: result.message,
                type: result.status,
              },
              object: "device_authorization",
              status: result.status,
            },
            410
          );
      }
    }).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          const config = yield* AppConfig;
          const status = authRouteErrorStatus(error);
          return jsonResponse(
            request,
            config,
            {
              error: {
                message: error instanceof Error ? error.message : String(error),
                type: "device_authorization_error",
              },
            },
            status
          );
        })
      )
    )
);

export const authRoutes = [
  deviceAuthorizationRoute,
  importGitHubTokenRoute,
  pollDeviceAuthorizationRoute,
] as const;
