import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ServiceMap from "effect/ServiceMap";

import {
  COPILOT_HEADERS,
  GITHUB_ACCESS_TOKEN_URL,
  GITHUB_CLIENT_ID,
  GITHUB_COPILOT_TOKEN_URL,
  GITHUB_DEVICE_CODE_URL,
  GITHUB_SCOPE,
} from "#/config/copilot-constants";
import { AppConfig } from "#/services/app-config";

export interface CopilotQuotaSnapshot {
  readonly entitlement: number;
  readonly overageCount: number;
  readonly overagePermitted: boolean;
  readonly percentRemaining: number;
  readonly quotaId: string;
  readonly quotaRemaining: number;
  readonly remaining: number;
  readonly timestamp: Date | null;
  readonly unlimited: boolean;
}

export interface CopilotUsageOverview {
  readonly apiBaseUrl: string;
  readonly login: string;
  readonly plan: string;
  readonly quotaResetAt: Date | null;
  readonly quotaSnapshots: {
    readonly chat: CopilotQuotaSnapshot | null;
    readonly completions: CopilotQuotaSnapshot | null;
    readonly premiumInteractions: CopilotQuotaSnapshot | null;
  };
}

export interface CopilotBillingTimePeriod {
  readonly day: number | null;
  readonly month: number | null;
  readonly year: number;
}

export interface CopilotBillingUsageItem {
  readonly discountAmount: number;
  readonly discountQuantity: number;
  readonly grossAmount: number;
  readonly grossQuantity: number;
  readonly model: string;
  readonly netAmount: number;
  readonly netQuantity: number;
  readonly pricePerUnit: number;
  readonly product: string;
  readonly sku: string;
  readonly unitType: string;
}

export interface CopilotPremiumRequestUsageReport {
  readonly timePeriod: CopilotBillingTimePeriod;
  readonly usageItems: readonly CopilotBillingUsageItem[];
  readonly user: string;
}

export interface CopilotTokenExchange {
  readonly apiBaseUrl: string;
  readonly copilotToken: string;
  readonly copilotTokenExpiresAt: Date | null;
}

export interface DeviceCodeResponse {
  readonly deviceCode: string;
  readonly expiresInSeconds: number;
  readonly intervalSeconds: number;
  readonly userCode: string;
  readonly verificationUri: string;
}

export type DeviceCodePollResult =
  | {
      readonly accessToken: string;
      readonly status: "authorized";
    }
  | {
      readonly intervalSeconds: number;
      readonly status: "authorization_pending" | "slow_down";
    }
  | {
      readonly message: string;
      readonly status: "access_denied" | "expired_token";
    };

export interface GitHubUser {
  readonly login: string;
  readonly userId: string;
}

const describeError = (error: unknown) =>
  error instanceof Error ? error.message : `Unexpected error: ${String(error)}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readString = (record: Record<string, unknown>, key: string): string => {
  const value = record[key];
  return typeof value === "string" ? value : "";
};

const readNumber = (record: Record<string, unknown>, key: string): number => {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
};

const readOptionalNumber = (
  record: Record<string, unknown>,
  key: string
): number | null => {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

const readBoolean = (record: Record<string, unknown>, key: string): boolean => {
  const value = record[key];
  return typeof value === "boolean" ? value : false;
};

const readTimestamp = (record: Record<string, unknown>, key: string): Date | null => {
  const raw = readString(record, key);
  if (raw.length === 0) {
    return null;
  }

  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp) ? new Date(timestamp) : null;
};

const parseQuotaSnapshot = (value: unknown): CopilotQuotaSnapshot | null => {
  if (!isRecord(value)) {
    return null;
  }

  return {
    entitlement: readNumber(value, "entitlement"),
    overageCount: readNumber(value, "overage_count"),
    overagePermitted: readBoolean(value, "overage_permitted"),
    percentRemaining: readNumber(value, "percent_remaining"),
    quotaId: readString(value, "quota_id"),
    quotaRemaining: readNumber(value, "quota_remaining"),
    remaining: readNumber(value, "remaining"),
    timestamp: readTimestamp(value, "timestamp_utc"),
    unlimited: readBoolean(value, "unlimited"),
  } satisfies CopilotQuotaSnapshot;
};

const parseBillingTimePeriod = (value: unknown): CopilotBillingTimePeriod => {
  const period = isRecord(value) ? value : {};

  return {
    day: readOptionalNumber(period, "day"),
    month: readOptionalNumber(period, "month"),
    year: readNumber(period, "year"),
  } satisfies CopilotBillingTimePeriod;
};

const parseBillingUsageItem = (value: unknown): CopilotBillingUsageItem | null => {
  if (!isRecord(value)) {
    return null;
  }

  return {
    discountAmount: readNumber(value, "discountAmount"),
    discountQuantity: readNumber(value, "discountQuantity"),
    grossAmount: readNumber(value, "grossAmount"),
    grossQuantity: readNumber(value, "grossQuantity"),
    model: readString(value, "model"),
    netAmount: readNumber(value, "netAmount"),
    netQuantity: readNumber(value, "netQuantity"),
    pricePerUnit: readNumber(value, "pricePerUnit"),
    product: readString(value, "product"),
    sku: readString(value, "sku"),
    unitType: readString(value, "unitType"),
  } satisfies CopilotBillingUsageItem;
};

const parseBillingUsageItems = (value: unknown): readonly CopilotBillingUsageItem[] =>
  Array.isArray(value)
    ? value.flatMap((item) => {
        const parsed = parseBillingUsageItem(item);
        return parsed === null ? [] : [parsed];
      })
    : [];

const mergeSignals = (
  signal: AbortSignal | undefined,
  timeoutMs: number
): AbortSignal | undefined => {
  const signals: AbortSignal[] = [];

  if (signal !== undefined) {
    signals.push(signal);
  }

  if (timeoutMs > 0) {
    signals.push(AbortSignal.timeout(timeoutMs));
  }

  if (signals.length === 0) {
    return undefined;
  }

  const [singleSignal] = signals;
  if (signals.length === 1 && singleSignal !== undefined) {
    return singleSignal;
  }

  return AbortSignal.any(signals);
};

const buildRequestInit = (
  method: string,
  headers: HeadersInit,
  signal: AbortSignal | undefined,
  body?: unknown
): RequestInit => {
  const requestInit: RequestInit = { headers, method };

  if (body !== undefined) {
    requestInit.body = JSON.stringify(body);
  }

  if (signal !== undefined) {
    requestInit.signal = signal;
  }

  return requestInit;
};

const withSignalOption = (signal: AbortSignal | undefined) =>
  signal === undefined ? {} : { signal };

const parseJsonResponse = async (response: Response) => {
  const text = await response.text();
  if (text.trim().length === 0) {
    return {} as Record<string, unknown>;
  }

  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : {};
  } catch (error) {
    throw new Error(`Expected JSON response: ${text.slice(0, 500)}`, {
      cause: error,
    });
  }
};

export class GitHubCopilotAuth extends ServiceMap.Service<GitHubCopilotAuth>()(
  "copilotx/GitHubCopilotAuth",
  {
    make: Effect.gen(function* makeGitHubCopilotAuth() {
      const config = yield* AppConfig;
      const { requestTimeoutMs } = config.runtime;

      const fetchJson = Effect.fn("GitHubCopilotAuth.fetchJson")(
        function* fetchJson(
          url: string,
          options: {
            readonly body?: unknown;
            readonly headers: HeadersInit;
            readonly method: string;
            readonly signal?: AbortSignal;
          }
        ) {
          const signal = mergeSignals(options.signal, requestTimeoutMs);
          const response = yield* Effect.tryPromise({
            catch: (error) => new Error(describeError(error), { cause: error }),
            try: async () => {
              const fetchedResponse = await fetch(
                url,
                buildRequestInit(
                  options.method,
                  options.headers,
                  signal,
                  options.body
                )
              );

              return fetchedResponse;
            },
          });

          const data = yield* Effect.tryPromise({
            catch: (error) => new Error(describeError(error), { cause: error }),
            try: async () => {
              const parsedData = await parseJsonResponse(response);
              return parsedData;
            },
          });

          return { data, response };
        }
      );

      const pollForAccessTokenStep = Effect.fn(
        "GitHubCopilotAuth.pollForAccessTokenStep"
      )(function* pollForAccessTokenStep(
        deviceCode: string,
        signal?: AbortSignal
      ) {
        const { data } = yield* fetchJson(GITHUB_ACCESS_TOKEN_URL, {
          ...withSignalOption(signal),
          body: {
            client_id: GITHUB_CLIENT_ID,
            device_code: deviceCode,
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          },
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          method: "POST",
        });

        const accessToken = readString(data, "access_token").trim();
        if (accessToken.length > 0) {
          return {
            accessToken,
            status: "authorized",
          } satisfies DeviceCodePollResult;
        }

        const error = readString(data, "error");
        const intervalSeconds =
          readNumber(data, "interval") ||
          config.upstream.deviceCodePollIntervalSeconds;

        if (error === "authorization_pending") {
          return {
            intervalSeconds,
            status: "authorization_pending",
          } satisfies DeviceCodePollResult;
        }

        if (error === "slow_down") {
          return {
            intervalSeconds: intervalSeconds + 5,
            status: "slow_down",
          } satisfies DeviceCodePollResult;
        }

        if (error === "expired_token") {
          return {
            message: "Device code expired. Please try again.",
            status: "expired_token",
          } satisfies DeviceCodePollResult;
        }

        if (error === "access_denied") {
          return {
            message: "Authorization was denied by the user.",
            status: "access_denied",
          } satisfies DeviceCodePollResult;
        }

        return yield* Effect.fail(
          new Error(`Unexpected OAuth error: ${error || "unknown"}`)
        );
      });

      return {
        fetchCopilotToken: Effect.fn("GitHubCopilotAuth.fetchCopilotToken")(
          function* fetchCopilotToken(
            githubToken: string,
            signal?: AbortSignal
          ) {
            const { data, response } = yield* fetchJson(
              GITHUB_COPILOT_TOKEN_URL,
              {
                ...withSignalOption(signal),
                headers: {
                  ...COPILOT_HEADERS,
                  Accept: "application/json",
                  Authorization: `token ${githubToken}`,
                  "Content-Type": "application/json",
                },
                method: "GET",
              }
            );

            if (response.status === 401) {
              return yield* Effect.fail(
                new Error(
                  "GitHub token is invalid or expired. Run `copilotx auth login` again."
                )
              );
            }

            if (response.status === 403) {
              return yield* Effect.fail(
                new Error(
                  "GitHub Copilot is not enabled for this account. Make sure you have a Copilot subscription."
                )
              );
            }

            if (!response.ok) {
              return yield* Effect.fail(
                new Error(
                  `Copilot token exchange failed with status ${response.status}.`
                )
              );
            }

            const token = readString(data, "token");
            if (token.length === 0) {
              return yield* Effect.fail(
                new Error(
                  "GitHub Copilot token response did not include a token."
                )
              );
            }

            const endpoints = isRecord(data.endpoints) ? data.endpoints : {};
            const expiresAtUnix = readNumber(data, "expires_at");

            return {
              apiBaseUrl: readString(endpoints, "api"),
              copilotToken: token,
              copilotTokenExpiresAt:
                expiresAtUnix > 0 ? new Date(expiresAtUnix * 1000) : null,
            } satisfies CopilotTokenExchange;
          }
        ),
        fetchGitHubUser: Effect.fn("GitHubCopilotAuth.fetchGitHubUser")(
          function* fetchGitHubUser(githubToken: string, signal?: AbortSignal) {
            const { data, response } = yield* fetchJson(
              "https://api.github.com/user",
              {
                ...withSignalOption(signal),
                headers: {
                  Accept: "application/json",
                  Authorization: `token ${githubToken}`,
                },
                method: "GET",
              }
            );

            if (response.status === 401) {
              return yield* Effect.fail(
                new Error("GitHub token is invalid or expired.")
              );
            }

            if (!response.ok) {
              return yield* Effect.fail(
                new Error(
                  `GitHub user lookup failed with status ${response.status}.`
                )
              );
            }

            const userId =
              typeof data.id === "number" || typeof data.id === "string"
                ? String(data.id)
                : "";

            return {
              login: readString(data, "login"),
              userId,
            } satisfies GitHubUser;
          }
        ),
        fetchUsage: Effect.fn("GitHubCopilotAuth.fetchUsage")(
          function* fetchUsage(githubToken: string, signal?: AbortSignal) {
            const { data, response } = yield* fetchJson(
              "https://api.github.com/copilot_internal/user",
              {
                ...withSignalOption(signal),
                headers: {
                  ...COPILOT_HEADERS,
                  Accept: "application/json",
                  Authorization: `Bearer ${githubToken}`,
                  "Content-Type": "application/json",
                },
                method: "GET",
              }
            );

            if (response.status === 401) {
              return yield* Effect.fail(
                new Error(
                  "GitHub token is invalid or expired. Run `copilotx auth login` again."
                )
              );
            }

            if (response.status === 403) {
              return yield* Effect.fail(
                new Error(
                  "GitHub Copilot usage is unavailable for this account or plan."
                )
              );
            }

            if (!response.ok) {
              return yield* Effect.fail(
                new Error(
                  `Copilot usage lookup failed with status ${response.status}.`
                )
              );
            }

            const endpoints = isRecord(data.endpoints) ? data.endpoints : {};
            const quotaSnapshots = isRecord(data.quota_snapshots) ? data.quota_snapshots : {};
            const quotaResetAt =
              readTimestamp(data, "quota_reset_date_utc") ??
              readTimestamp(data, "quota_reset_date");

            return {
              apiBaseUrl: readString(endpoints, "api"),
              login: readString(data, "login"),
              plan: readString(data, "copilot_plan"),
              quotaResetAt,
              quotaSnapshots: {
                chat: parseQuotaSnapshot(quotaSnapshots.chat),
                completions: parseQuotaSnapshot(quotaSnapshots.completions),
                premiumInteractions: parseQuotaSnapshot(
                  quotaSnapshots.premium_interactions
                ),
              },
            } satisfies CopilotUsageOverview;
          }
        ),
        fetchPremiumRequestUsage: Effect.fn(
          "GitHubCopilotAuth.fetchPremiumRequestUsage"
        )(
          function* fetchPremiumRequestUsage(
            username: string,
            githubToken: string,
            options?: {
              readonly day?: number;
              readonly month?: number;
              readonly signal?: AbortSignal;
              readonly year?: number;
            }
          ) {
            const url = new URL(
              `https://api.github.com/users/${encodeURIComponent(username)}/settings/billing/premium_request/usage`
            );

            if (options?.year !== undefined) {
              url.searchParams.set("year", String(options.year));
            }

            if (options?.month !== undefined) {
              url.searchParams.set("month", String(options.month));
            }

            if (options?.day !== undefined) {
              url.searchParams.set("day", String(options.day));
            }

            const { data, response } = yield* fetchJson(url.toString(), {
              ...withSignalOption(options?.signal),
              headers: {
                Accept: "application/vnd.github+json",
                Authorization: `Bearer ${githubToken}`,
                "X-GitHub-Api-Version": "2022-11-28",
              },
              method: "GET",
            });

            if (response.status === 401) {
              return yield* Effect.fail(
                new Error(
                  "GitHub token is invalid or expired. Run `copilotx auth login` again."
                )
              );
            }

            if (response.status === 403) {
              return yield* Effect.fail(
                new Error(
                  "GitHub billing usage requires a billing-capable token. Copilot device-code OAuth tokens are rejected by this endpoint."
                )
              );
            }

            if (response.status === 404) {
              return yield* Effect.fail(
                new Error(
                  "GitHub premium request billing usage is unavailable for this account. Managed organization or enterprise billing may require a different endpoint."
                )
              );
            }

            if (!response.ok) {
              return yield* Effect.fail(
                new Error(
                  `Copilot premium request billing lookup failed with status ${response.status}.`
                )
              );
            }

            return {
              timePeriod: parseBillingTimePeriod(data.timePeriod),
              usageItems: parseBillingUsageItems(data.usageItems),
              user: readString(data, "user"),
            } satisfies CopilotPremiumRequestUsageReport;
          }
        ),
        pollForAccessTokenStep,
        pollForAccessToken: Effect.fn("GitHubCopilotAuth.pollForAccessToken")(
          function* pollForAccessToken(
            deviceCode: string,
            options?: {
              readonly intervalSeconds?: number;
              readonly signal?: AbortSignal;
              readonly timeoutSeconds?: number;
            }
          ) {
            let elapsedSeconds = 0;
            let pollIntervalSeconds =
              options?.intervalSeconds ??
              config.upstream.deviceCodePollIntervalSeconds;
            const timeoutSeconds =
              options?.timeoutSeconds ??
              config.upstream.deviceCodeTimeoutSeconds;

            while (elapsedSeconds < timeoutSeconds) {
              yield* Effect.sleep(`${pollIntervalSeconds} seconds`);
              elapsedSeconds += pollIntervalSeconds;

              const result = yield* pollForAccessTokenStep(
                deviceCode,
                options?.signal
              );

              switch (result.status) {
                case "authorized":
                  return result.accessToken;
                case "authorization_pending":
                case "slow_down":
                  pollIntervalSeconds = Math.max(result.intervalSeconds, 1);
                  continue;
                case "expired_token":
                case "access_denied":
                  return yield* Effect.fail(new Error(result.message));
              }
            }

            return yield* Effect.fail(
              new Error(
                `Timed out waiting for authorization (${timeoutSeconds}s).`
              )
            );
          }
        ),
        requestDeviceCode: Effect.fn("GitHubCopilotAuth.requestDeviceCode")(
          function* requestDeviceCode(signal?: AbortSignal) {
            const { data, response } = yield* fetchJson(
              GITHUB_DEVICE_CODE_URL,
              {
                ...withSignalOption(signal),
                body: {
                  client_id: GITHUB_CLIENT_ID,
                  scope: GITHUB_SCOPE,
                },
                headers: {
                  Accept: "application/json",
                  "Content-Type": "application/json",
                },
                method: "POST",
              }
            );

            if (!response.ok) {
              return yield* Effect.fail(
                new Error(
                  `Device code request failed with status ${response.status}.`
                )
              );
            }

            const deviceCode = readString(data, "device_code").trim();
            const userCode = readString(data, "user_code").trim();
            const verificationUri = readString(data, "verification_uri").trim();
            const expiresInSeconds = readNumber(data, "expires_in");
            const intervalSeconds =
              readNumber(data, "interval") ||
              config.upstream.deviceCodePollIntervalSeconds;

            if (deviceCode.length === 0 || userCode.length === 0 || verificationUri.length === 0) {
              return yield* Effect.fail(
                new Error("Device code response was missing required fields.")
              );
            }

            if (expiresInSeconds <= 0) {
              return yield* Effect.fail(
                new Error("Device code response did not include a valid expiry.")
              );
            }

            return {
              deviceCode,
              expiresInSeconds,
              intervalSeconds,
              userCode,
              verificationUri,
            } satisfies DeviceCodeResponse;
          }
        ),
      };
    }),
  }
) {
  static readonly Default = Layer.effect(this, this.make).pipe(
    Layer.provide(AppConfig.Default)
  );
}
