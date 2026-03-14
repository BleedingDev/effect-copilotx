import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { GitHubCopilotAuth } from "#/services/github-copilot-auth";

interface LegacyAuthJson {
  readonly github_token?: unknown;
}

const home = process.env.HOME;
if (typeof home !== "string" || home.length === 0) {
  throw new Error("HOME is required.");
}

const authPath = `${home}/.copilotx/auth.json`;
const authJson = (await Bun.file(authPath).json()) as LegacyAuthJson;
const githubToken =
  typeof authJson.github_token === "string" ? authJson.github_token.trim() : "";

if (githubToken.length === 0) {
  throw new Error(`No github_token found in ${authPath}`);
}

const exchange = await Effect.runPromise(
  Effect.gen(function* () {
    const auth = yield* GitHubCopilotAuth;
    return yield* auth.fetchCopilotToken(githubToken);
  }).pipe(Effect.provide(Layer.mergeAll(GitHubCopilotAuth.Default)))
);

console.log(JSON.stringify(exchange));
