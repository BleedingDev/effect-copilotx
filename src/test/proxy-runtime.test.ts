import { describe, expect, it } from "@effect-native/bun-test";
import * as Effect from "effect/Effect";

import type { AccountRecord, ModelCatalogEntry } from "#/domain/accounts/account-types";
import { RESPONSES_API } from "#/domain/models/runtime-types";
import { UpstreamHttpError } from "#/http/upstream-compat";
import { makeProxyRuntime } from "#/services/proxy-runtime";

const emptyCatalog: readonly ModelCatalogEntry[] = [
  {
    hidden: false,
    modelId: "gemini-3.1-pro-preview",
    vendor: "Google",
  },
];

const makeAccount = (
  accountId: string,
  githubLogin: string,
  priority: number
): AccountRecord => ({
  accountId,
  apiBaseUrl: "https://api.githubcopilot.com",
  cooldownUntil: null,
  copilotToken: `token-${accountId}`,
  copilotTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  enabled: true,
  errorStreak: 0,
  githubLogin,
  githubToken: `gh-${accountId}`,
  githubUserId: `user-${accountId}`,
  inputTokenCount: 0,
  label: githubLogin,
  lastError: "",
  lastErrorAt: null,
  lastRateLimitedAt: null,
  lastUsedAt: null,
  modelCatalog: emptyCatalog,
  modelIds: ["gemini-3.1-pro-preview"],
  outputTokenCount: 0,
  priority,
  reauthRequired: false,
  successfulRequestCount: 0,
  successfulStreamCount: 0,
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
});

const toError = (error: unknown) =>
  error instanceof Error ? error : new Error(String(error));

describe("proxy runtime retry handling", () => {
  it.effect("retries 402 quota errors across the account pool", () =>
    Effect.tryPromise({
      catch: toError,
      try: async () => {
        const accounts = [
          makeAccount("a1", "alice", 0),
          makeAccount("a2", "bob", 1),
          makeAccount("a3", "carol", 2),
        ] as const;
        const attempted: string[] = [];
        const marked: Array<{ accountId: string; lastError?: string; cooldownUntil?: Date | null }> = [];

        const runtime = makeProxyRuntime({
          hooks: {
            refreshAccount: ({ account }) =>
              Effect.succeed({
                apiBaseUrl: account.apiBaseUrl,
                copilotToken: account.copilotToken,
                copilotTokenExpiresAt: account.copilotTokenExpiresAt,
              }),
          },
          now: () => new Date("2026-03-30T00:00:00.000Z"),
          repository: {
            getRotationStrategy: () => Effect.succeed("fill-first" as const),
            listAccounts: () => Effect.succeed(accounts),
            markAccount: (accountId, patch) =>
              Effect.sync(() => {
                marked.push({
                  accountId,
                  cooldownUntil: patch.cooldownUntil,
                  lastError: patch.lastError,
                });
              }),
            nextRoundRobinOffset: () => Effect.succeed(0),
            updateModels: () => Effect.void,
            updateTokens: () => Effect.void,
          },
          scheduler: {
            maxRetryAttempts: Number.MAX_SAFE_INTEGER,
            rateLimitCooldownMs: 60_000,
            syncIntervalMs: 0,
          },
        });

        const result = await Effect.runPromise(
          runtime
            .execute({
              allowUnsupportedSurfaceFallback: false,
              model: "gemini-3.1-pro-preview",
              operation: ({ account }) => {
                attempted.push(account.githubLogin);
                return Effect.fail(
                  new UpstreamHttpError({
                    responseBody: {
                      error: { code: "quota_exceeded", message: "You have no quota" },
                    },
                    responseText: JSON.stringify({
                      error: { code: "quota_exceeded", message: "You have no quota" },
                    }),
                    statusCode: 402,
                    url: "https://api.githubcopilot.com/responses",
                  })
                );
              },
              requestedApi: RESPONSES_API,
            })
            .pipe(
              Effect.map(() => null as Error | null),
              Effect.catch((error) => Effect.succeed(toError(error)))
            )
        );

        expect(result).toBeInstanceOf(Error);
        expect(attempted).toEqual(["alice", "bob", "carol"]);
        expect(marked).toHaveLength(3);
        for (const patch of marked) {
          expect(patch.lastError).toContain("HTTP 402");
          expect(patch.cooldownUntil).toBeInstanceOf(Date);
        }
      },
    })
  );
});
