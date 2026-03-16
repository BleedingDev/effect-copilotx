import { describe, expect, it } from "@effect-native/bun-test";
import * as Effect from "effect/Effect";

import {
  importGitHubToken,
  pollDeviceLogin,
} from "#/services/account-login";

describe("account login helpers", () => {
  it.effect("imports a GitHub token into a persisted account", () =>
    Effect.tryPromise({
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      try: async () => {
        const calls = {
          copilotTokenLookups: [] as string[],
          gitHubUserLookups: [] as string[],
          upserts: [] as Array<Record<string, unknown>>,
        };

        const result = await Effect.runPromise(
          importGitHubToken(
            {
              fetchCopilotToken: (githubToken) => {
                calls.copilotTokenLookups.push(githubToken);
                return Effect.succeed({
                  apiBaseUrl: "https://api.individual.githubcopilot.com",
                  copilotToken: "copilot-token",
                  copilotTokenExpiresAt: new Date("2026-03-14T12:00:00.000Z"),
                });
              },
              fetchGitHubUser: (githubToken) => {
                calls.gitHubUserLookups.push(githubToken);
                return Effect.succeed({ login: "monalisa", userId: "42" });
              },
            },
            {
              upsertAccount: (input) => {
                calls.upserts.push(input as Record<string, unknown>);
                return Effect.succeed({
                  accountId: input.accountId,
                  apiBaseUrl: input.apiBaseUrl,
                  copilotTokenExpiresAt: input.copilotTokenExpiresAt,
                  githubLogin: input.githubLogin,
                  githubUserId: input.githubUserId,
                  label: input.label,
                  modelIds: [],
                });
              },
            },
            "ghu_test"
          )
        );

        expect(calls.gitHubUserLookups).toEqual(["ghu_test"]);
        expect(calls.copilotTokenLookups).toEqual(["ghu_test"]);
        expect(calls.upserts).toHaveLength(1);
        expect(calls.upserts[0]).toMatchObject({
          accountId: "github-42",
          apiBaseUrl: "https://api.individual.githubcopilot.com",
          enabled: true,
          githubLogin: "monalisa",
          githubToken: "ghu_test",
          githubUserId: "42",
          label: "monalisa",
          reauthRequired: false,
        });
        expect(result).toEqual({
          accountId: "github-42",
          apiBaseUrl: "https://api.individual.githubcopilot.com",
          copilotTokenExpiresAt: new Date("2026-03-14T12:00:00.000Z"),
          githubLogin: "monalisa",
          githubUserId: "42",
          label: "monalisa",
          modelCount: 0,
        });
      },
    })
  );

  it.effect("preserves explicit import settings when requested", () =>
    Effect.tryPromise({
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      try: async () => {
        const upserts: Array<Record<string, unknown>> = [];

        await Effect.runPromise(
          importGitHubToken(
            {
              fetchCopilotToken: () =>
                Effect.succeed({
                  apiBaseUrl: "https://api.individual.githubcopilot.com",
                  copilotToken: "copilot-token",
                  copilotTokenExpiresAt: null,
                }),
              fetchGitHubUser: () =>
                Effect.succeed({ login: "octocat", userId: "7" }),
            },
            {
              upsertAccount: (input) => {
                upserts.push(input as Record<string, unknown>);
                return Effect.succeed({
                  accountId: input.accountId,
                  apiBaseUrl: input.apiBaseUrl,
                  copilotTokenExpiresAt: input.copilotTokenExpiresAt,
                  githubLogin: input.githubLogin,
                  githubUserId: input.githubUserId,
                  label: input.label,
                  modelIds: [],
                });
              },
            },
            "ghu_authorized",
            undefined,
            {
              enabled: false,
              label: "team-octo",
              priority: 9,
              modelCatalog: [
                { hidden: false, modelId: "gpt-5", vendor: "github-copilot" },
              ],
              reauthRequired: true,
            }
          )
        );

        expect(upserts).toHaveLength(1);
        expect(upserts[0]).toMatchObject({
          enabled: false,
          githubToken: "ghu_authorized",
          label: "team-octo",
          priority: 9,
          reauthRequired: true,
        });
        expect(upserts[0]?.modelCatalog).toEqual([
          { hidden: false, modelId: "gpt-5", vendor: "github-copilot" },
        ]);
      },
    })
  );

  it.effect("reports device authorization as pending without importing", () =>
    Effect.tryPromise({
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      try: async () => {
        let upsertCalled = false;

        const result = await Effect.runPromise(
          pollDeviceLogin(
            {
              fetchCopilotToken: () => Effect.fail(new Error("should not import")),
              fetchGitHubUser: () => Effect.fail(new Error("should not import")),
              pollForAccessTokenStep: () =>
                Effect.succeed({
                  intervalSeconds: 5,
                  status: "authorization_pending",
                } as const),
            },
            {
              upsertAccount: () => {
                upsertCalled = true;
                return Effect.fail(new Error("should not persist"));
              },
            },
            "device-code"
          )
        );

        expect(result).toEqual({
          intervalSeconds: 5,
          status: "authorization_pending",
        });
        expect(upsertCalled).toBe(false);
      },
    })
  );

  it.effect("imports the account once device authorization succeeds", () =>
    Effect.tryPromise({
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      try: async () => {
        const result = await Effect.runPromise(
          pollDeviceLogin(
            {
              fetchCopilotToken: () =>
                Effect.succeed({
                  apiBaseUrl: "https://api.enterprise.githubcopilot.com",
                  copilotToken: "copilot-token",
                  copilotTokenExpiresAt: null,
                }),
              fetchGitHubUser: () =>
                Effect.succeed({ login: "octocat", userId: "7" }),
              pollForAccessTokenStep: () =>
                Effect.succeed({ accessToken: "ghu_authorized", status: "authorized" }),
            },
            {
              upsertAccount: (input) =>
                Effect.succeed({
                  accountId: input.accountId,
                  apiBaseUrl: input.apiBaseUrl,
                  copilotTokenExpiresAt: input.copilotTokenExpiresAt,
                  githubLogin: input.githubLogin,
                  githubUserId: input.githubUserId,
                  label: input.label,
                  modelIds: ["gpt-5"],
                }),
            },
            "device-code"
          )
        );

        expect(result).toEqual({
          account: {
            accountId: "github-7",
            apiBaseUrl: "https://api.enterprise.githubcopilot.com",
            copilotTokenExpiresAt: null,
            githubLogin: "octocat",
            githubUserId: "7",
            label: "octocat",
            modelCount: 1,
          },
          status: "authorized",
        });
      },
    })
  );
});
