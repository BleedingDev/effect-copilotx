
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { importGitHubToken } from "#/services/account-login";
import { AccountRepository } from "#/services/account-repository";
import { GitHubCopilotAuth } from "#/services/github-copilot-auth";

interface LegacyAuthJson {
  readonly github_token?: unknown;
}


const home = process.env.HOME;
if (typeof home !== "string" || home.length === 0) {
  throw new Error("HOME is required to import legacy CopilotX auth state.");
}

const authPath = `${home}/.copilotx/auth.json`;
const authJson = (await Bun.file(authPath).json()) as LegacyAuthJson;
const githubToken =
  typeof authJson.github_token === "string" ? authJson.github_token.trim() : "";

if (githubToken.length === 0) {
  throw new Error(`No github_token found in ${authPath}`);
}


const services = Layer.mergeAll(
  AccountRepository.Default,
  GitHubCopilotAuth.Default
);

const imported = await Effect.runPromise(
  Effect.gen(function* () {
    const accountRepository = yield* AccountRepository;
    const auth = yield* GitHubCopilotAuth;
    const account = yield* importGitHubToken(
      auth,
      accountRepository,
      githubToken
    );

    return {
      accountId: account.accountId,
      apiBaseUrl: account.apiBaseUrl,
      copilotTokenExpiresAt: account.copilotTokenExpiresAt?.toISOString() ?? null,
      githubLogin: account.githubLogin,
      githubUserId: account.githubUserId,
      label: account.label,
      modelCount: account.modelCount,
    };
  }).pipe(Effect.provide(services))
);

console.log(JSON.stringify(imported, null, 2));
