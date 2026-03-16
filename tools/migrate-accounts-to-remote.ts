import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { AccountRepository } from "#/services/account-repository";

const requireEnv = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
};

const parseSelectors = (value: string | undefined): readonly string[] => {
  const trimmed = value?.trim() ?? "";
  if (trimmed.length === 0) {
    return [];
  }

  return [...new Set(trimmed.split(/[\s,]+/u).map((item) => item.trim()).filter(Boolean))];
};

const normalizeBaseUrl = (value: string): string => value.replace(/\/+$/u, "");

const describeRemoteError = (payload: unknown): string => {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return `Unexpected remote response: ${String(payload)}`;
  }

  const error = (payload as Record<string, unknown>).error;
  if (typeof error !== "object" || error === null || Array.isArray(error)) {
    return JSON.stringify(payload);
  }

  const message = (error as Record<string, unknown>).message;
  return typeof message === "string" ? message : JSON.stringify(payload);
};

const remoteBaseUrl = normalizeBaseUrl(requireEnv("COPILOTX_REMOTE_BASE_URL"));
const remoteImportApiKey = requireEnv("COPILOTX_REMOTE_IMPORT_API_KEY");
const selectors = parseSelectors(process.env.COPILOTX_MIGRATE_SELECTORS);

const services = Layer.mergeAll(AccountRepository.Default);

const localAccounts = await Effect.runPromise(
  Effect.gen(function* () {
    const repository = yield* AccountRepository;
    const accounts = yield* repository.listAccounts();
    if (accounts.length === 0) {
      throw new Error("No local CopilotX accounts found.");
    }

    if (selectors.length === 0) {
      return accounts;
    }

    const deduped = new Map<string, (typeof accounts)[number]>();
    for (const selector of selectors) {
      const matched = accounts.find(
        (account) =>
          account.accountId === selector ||
          account.githubLogin === selector ||
          account.label === selector
      );
      if (matched === undefined) {
        throw new Error(`No local account matches selector: ${selector}`);
      }
      deduped.set(matched.accountId, matched);
    }

    return [...deduped.values()];
  }).pipe(Effect.provide(services))
);

const successes: Array<Record<string, unknown>> = [];
const failures: Array<Record<string, unknown>> = [];

for (const account of localAccounts) {
  const response = await fetch(`${remoteBaseUrl}/auth/import-github-token`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${remoteImportApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      enabled: account.enabled,
      github_token: account.githubToken,
      label: account.label,
      priority: account.priority,
    }),
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    failures.push({
      account_id: account.accountId,
      github_login: account.githubLogin,
      label: account.label,
      response_status: response.status,
      response_status_text: response.statusText,
      error: describeRemoteError(payload),
    });
    continue;
  }

  const importedAccount =
    typeof payload === "object" && payload !== null && !Array.isArray(payload)
      ? (payload as Record<string, unknown>).account
      : null;

  successes.push({
    account_id:
      typeof importedAccount === "object" && importedAccount !== null && !Array.isArray(importedAccount)
        ? (importedAccount as Record<string, unknown>).account_id
        : account.accountId,
    github_login: account.githubLogin,
    label: account.label,
    priority: account.priority,
    response_status: response.status,
  });
}

const summary = {
  failures,
  remote_base_url: remoteBaseUrl,
  requested_accounts: localAccounts.length,
  selectors,
  succeeded: successes.length,
  successes,
};

console.log(JSON.stringify(summary, null, 2));

if (failures.length > 0) {
  process.exitCode = 1;
}
