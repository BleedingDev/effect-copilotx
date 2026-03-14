import { describe, expect, it } from "@effect-native/bun-test";
import * as Effect from "effect/Effect";

import { fetchPremiumRequestUsageStatus } from "#/services/premium-request-usage";

describe("fetchPremiumRequestUsageStatus", () => {
  it.effect("uses the account login for the primary token before falling back", () =>
    Effect.tryPromise({
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      try: async () => {
        const premiumRequestCalls: Array<{ token: string; username: string }> = [];
        let userLookups = 0;

        const status = await Effect.runPromise(
          fetchPremiumRequestUsageStatus(
            {
              fetchGitHubUser: () => {
                userLookups += 1;
                return Effect.succeed({ login: "should-not-be-used", userId: "1" });
              },
              fetchPremiumRequestUsage: (username, githubToken) => {
                premiumRequestCalls.push({ token: githubToken, username });
                return Effect.succeed({
                  timePeriod: { day: null, month: 3, year: 2026 },
                  usageItems: [],
                  user: username,
                });
              },
            },
            {
              githubLogin: "primary-user",
              githubToken: "primary-token",
            },
            "billing-token",
            new Date("2026-03-14T12:00:00.000Z")
          )
        );

        expect(status).toEqual({
          error: null,
          report: {
            timePeriod: { day: null, month: 3, year: 2026 },
            usageItems: [],
            user: "primary-user",
          },
        });
        expect(premiumRequestCalls).toEqual([
          { token: "primary-token", username: "primary-user" },
        ]);
        expect(userLookups).toBe(0);
      },
    })
  );

  it.effect("resolves the configured billing token username after primary-token failure", () =>
    Effect.tryPromise({
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      try: async () => {
        const premiumRequestCalls: Array<{ token: string; username: string }> = [];
        const userLookupTokens: string[] = [];

        const status = await Effect.runPromise(
          fetchPremiumRequestUsageStatus(
            {
              fetchGitHubUser: (githubToken) => {
                userLookupTokens.push(githubToken);
                return Effect.succeed({ login: "billing-user", userId: "42" });
              },
              fetchPremiumRequestUsage: (username, githubToken) => {
                premiumRequestCalls.push({ token: githubToken, username });
                return githubToken === "primary-token"
                  ? Effect.fail(new Error("primary token rejected"))
                  : Effect.succeed({
                      timePeriod: { day: null, month: 3, year: 2026 },
                      usageItems: [],
                      user: username,
                    });
              },
            },
            {
              githubLogin: "primary-user",
              githubToken: "primary-token",
            },
            "billing-token",
            new Date("2026-03-14T12:00:00.000Z")
          )
        );

        expect(status).toEqual({
          error: null,
          report: {
            timePeriod: { day: null, month: 3, year: 2026 },
            usageItems: [],
            user: "billing-user",
          },
        });
        expect(premiumRequestCalls).toEqual([
          { token: "primary-token", username: "primary-user" },
          { token: "billing-token", username: "billing-user" },
        ]);
        expect(userLookupTokens).toEqual(["billing-token"]);
      },
    })
  );
});
