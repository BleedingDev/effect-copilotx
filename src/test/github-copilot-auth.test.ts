import { describe, expect, it } from "@effect-native/bun-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import { AppConfig, type AppConfigShape } from "#/services/app-config";
import { GitHubCopilotAuth } from "#/services/github-copilot-auth";

const testConfig: AppConfigShape = {
  database: {
    connectTimeoutMs: 10_000,
    idleTimeoutMs: 30_000,
    maxConnections: 10,
    minConnections: 1,
    url: Redacted.make("postgresql://example"),
  },
  runtime: {
    host: "127.0.0.1",
    idleTimeoutSeconds: 0,
    logLevel: "info",
    port: 24_680,
    requestTimeoutMs: 5_000,
  },
  security: {
    apiKey: undefined,
    corsOrigins: [],
    forceModels: [],
    githubBillingToken: undefined,
    publicPaths: ["/", "/health", "/readyz"],
    tokenEncryptionKey: Redacted.make("0123456789abcdef0123456789abcdef"),
    tokenEncryptionKeyId: "default",
    trustLocalhost: false,
  },
  upstream: {
    deviceCodePollIntervalSeconds: 5,
    deviceCodeTimeoutSeconds: 900,
    modelCacheTtlSeconds: 300,
    tokenRefreshBufferSeconds: 60,
  },
};

const makeAuth = () =>
  GitHubCopilotAuth.make.pipe(Effect.provideService(AppConfig, testConfig));

describe("GitHubCopilotAuth.fetchPremiumRequestUsage", () => {
  it.effect("parses premium request billing reports", () =>
    Effect.tryPromise({
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      try: async () => {
        const originalFetch = globalThis.fetch;
        let observedUrl = "";
        let observedAuthorization = "";

        const mockFetch: typeof fetch = async (input, init) => {
          observedUrl = String(input);
          observedAuthorization = String((init?.headers as Record<string, string>)?.Authorization ?? "");

          return new Response(
            JSON.stringify({
              timePeriod: { year: 2026, month: 3 },
              user: "monalisa",
              usageItems: [
                {
                  product: "Copilot",
                  sku: "Copilot Premium Request",
                  model: "GPT-5.4",
                  unitType: "requests",
                  pricePerUnit: 0.04,
                  grossQuantity: 12,
                  grossAmount: 0.48,
                  discountQuantity: 10,
                  discountAmount: 0.4,
                  netQuantity: 2,
                  netAmount: 0.08,
                },
              ],
            }),
            {
              headers: { "Content-Type": "application/json" },
              status: 200,
            }
          );
        };

        globalThis.fetch = mockFetch;

        try {
          const report = await Effect.runPromise(
            Effect.gen(function* () {
              const auth = yield* makeAuth();
              return yield* auth.fetchPremiumRequestUsage("monalisa", "ghp_test", {
                month: 3,
                year: 2026,
              });
            })
          );

          expect(observedUrl).toContain("/users/monalisa/settings/billing/premium_request/usage");
          expect(observedUrl).toContain("month=3");
          expect(observedUrl).toContain("year=2026");
          expect(observedAuthorization).toBe("Bearer ghp_test");
          expect(report).toEqual({
            timePeriod: { day: null, month: 3, year: 2026 },
            usageItems: [
              {
                discountAmount: 0.4,
                discountQuantity: 10,
                grossAmount: 0.48,
                grossQuantity: 12,
                model: "GPT-5.4",
                netAmount: 0.08,
                netQuantity: 2,
                pricePerUnit: 0.04,
                product: "Copilot",
                sku: "Copilot Premium Request",
                unitType: "requests",
              },
            ],
            user: "monalisa",
          });
        } finally {
          globalThis.fetch = originalFetch;
        }
      },
    })
  );

  it.effect("explains when the token cannot access billing usage", () =>
    Effect.tryPromise({
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      try: async () => {
        const originalFetch = globalThis.fetch;

        const mockFetch: typeof fetch = async () =>
          new Response(
            JSON.stringify({
              message: "Resource not accessible by integration",
            }),
            {
              headers: { "Content-Type": "application/json" },
              status: 403,
            }
          );

        globalThis.fetch = mockFetch;

        try {
          const result = await Effect.runPromise(
            Effect.gen(function* () {
              const auth = yield* makeAuth();
              return yield* auth.fetchPremiumRequestUsage(
                "monalisa",
                "ghu_integration",
                {
                  month: 3,
                  year: 2026,
                }
              ).pipe(
                Effect.map(() => null as Error | null),
                Effect.catch((error) => Effect.succeed(error))
              );
            })
          );

          expect(result).toBeInstanceOf(Error);
          if (result instanceof Error) {
            expect(result.message).toContain("billing-capable token");
          }
        } finally {
          globalThis.fetch = originalFetch;
        }
      },
    })
  );
});


describe("GitHubCopilotAuth.pollForAccessTokenStep", () => {
  it.effect("returns authorization_pending with the server interval", () =>
    Effect.tryPromise({
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      try: async () => {
        const originalFetch = globalThis.fetch;

        const mockFetch: typeof fetch = async () =>
          new Response(
            JSON.stringify({
              error: "authorization_pending",
              interval: 7,
            }),
            {
              headers: { "Content-Type": "application/json" },
              status: 200,
            }
          );

        globalThis.fetch = mockFetch;

        try {
          const result = await Effect.runPromise(
            Effect.gen(function* () {
              const auth = yield* makeAuth();
              return yield* auth.pollForAccessTokenStep("device-code");
            })
          );

          expect(result).toEqual({
            intervalSeconds: 7,
            status: "authorization_pending",
          });
        } finally {
          globalThis.fetch = originalFetch;
        }
      },
    })
  );

  it.effect("returns authorized when GitHub issues an access token", () =>
    Effect.tryPromise({
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      try: async () => {
        const originalFetch = globalThis.fetch;

        const mockFetch: typeof fetch = async () =>
          new Response(
            JSON.stringify({
              access_token: "ghu_authorized",
            }),
            {
              headers: { "Content-Type": "application/json" },
              status: 200,
            }
          );

        globalThis.fetch = mockFetch;

        try {
          const result = await Effect.runPromise(
            Effect.gen(function* () {
              const auth = yield* makeAuth();
              return yield* auth.pollForAccessTokenStep("device-code");
            })
          );

          expect(result).toEqual({
            accessToken: "ghu_authorized",
            status: "authorized",
          });
        } finally {
          globalThis.fetch = originalFetch;
        }
      },
    })
  );
});