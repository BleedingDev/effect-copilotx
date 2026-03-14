import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/unstable/http/HttpRouter";

import {
  authorizeRequest,
  jsonResponse,
  readJsonRecord,
} from "#/http/http-helpers";
import {
  pollDeviceLogin,
  requestDeviceLogin,
} from "#/services/account-login";
import { AccountRepository } from "#/services/account-repository";
import { AppConfig } from "#/services/app-config";
import { GitHubCopilotAuth } from "#/services/github-copilot-auth";

const asDeviceCode = (body: Record<string, unknown>): string => {
  const value = body.device_code;
  if (typeof value !== "string") {
    throw new Error("`device_code` must be a non-empty string.");
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error("`device_code` must be a non-empty string.");
  }

  return trimmed;
};

const authRouteErrorStatus = (error: unknown): number => {
  const message = error instanceof Error ? error.message : String(error);
  return message === "Expected a JSON object request body." ||
    message === "`device_code` must be a non-empty string."
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

export const authRoutes = [deviceAuthorizationRoute, pollDeviceAuthorizationRoute] as const;
