import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { DEFAULT_HOST, DEFAULT_PORT } from "#/app/app-info";
import { getClaudeCodeSettingsPath } from "#/services/local-paths";
import type { CopilotXServerInfoFile } from "#/services/server-discovery";

export const primaryModelPreferences = [
  "opus-4.6",
  "opus-4.5",
  "opus",
  "gpt-5",
  "gpt-4o",
] as const;

export const smallModelPreferences = ["haiku", "gpt-5-mini", "mini", "sonnet"] as const;

const defaultBaseUrl = `http://${DEFAULT_HOST}:${DEFAULT_PORT}`;

const parseJsonRecord = (content: string): Record<string, unknown> => {
  const parsed = JSON.parse(content) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Expected a JSON object.");
  }

  return parsed as Record<string, unknown>;
};

const normalizeIds = (modelIds: readonly string[]): readonly string[] =>
  [...new Set(modelIds.map((modelId) => modelId.trim()).filter((modelId) => modelId.length > 0))];

export const selectPreferredModel = (
  modelIds: readonly string[],
  preference: readonly string[],
  fallback: string
): string => {
  const normalized = normalizeIds(modelIds);

  for (const preferred of preference) {
    const match = normalized.find((modelId) => modelId.toLowerCase().includes(preferred));
    if (match !== undefined) {
      return match;
    }
  }

  return normalized[0] ?? fallback;
};

export const resolveClaudeBaseUrl = (
  explicitBaseUrl: string | undefined,
  serverInfo: CopilotXServerInfoFile | null | undefined
): string => {
  const trimmedExplicit = explicitBaseUrl?.trim();
  if (trimmedExplicit !== undefined && trimmedExplicit.length > 0) {
    return trimmedExplicit;
  }

  const discovered = serverInfo?.public_url?.trim() || serverInfo?.base_url?.trim();
  return discovered && discovered.length > 0 ? discovered : defaultBaseUrl;
};

export const extractModelIdsFromOpenAiList = (payload: unknown): readonly string[] => {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return [];
  }

  const data = (payload as { readonly data?: unknown }).data;
  if (!Array.isArray(data)) {
    return [];
  }

  return normalizeIds(
    data.flatMap((entry) => {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        return [];
      }

      const id = (entry as { readonly id?: unknown }).id;
      return typeof id === "string" ? [id] : [];
    })
  );
};

export const buildClaudeCodeEnv = (input: {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly smallModel: string;
}): Record<string, string> => ({
  ANTHROPIC_AUTH_TOKEN: input.apiKey,
  ANTHROPIC_BASE_URL: input.baseUrl,
  ANTHROPIC_MODEL: input.model,
  ANTHROPIC_SMALL_FAST_MODEL: input.smallModel,
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
});

export const mergeClaudeCodeSettings = (
  existingContent: string | null,
  envConfig: Record<string, string>
): string => {
  let settings: Record<string, unknown> = {};

  if (existingContent !== null && existingContent.trim().length > 0) {
    try {
      settings = parseJsonRecord(existingContent);
    } catch {
      settings = {};
    }
  }

  const existingEnv =
    settings.env !== null && typeof settings.env === "object" && !Array.isArray(settings.env)
      ? (settings.env as Record<string, unknown>)
      : {};

  return `${JSON.stringify(
    {
      ...settings,
      env: {
        ...existingEnv,
        ...envConfig,
      },
    },
    null,
    2
  )}\n`;
};

export const writeClaudeCodeSettings = async (
  input: {
    readonly apiKey: string;
    readonly baseUrl: string;
    readonly model: string;
    readonly smallModel: string;
  },
  homeDir?: string
): Promise<string> => {
  const configPath = getClaudeCodeSettingsPath(homeDir);
  let existingContent: string | null = null;

  try {
    existingContent = await readFile(configPath, "utf8");
  } catch {
    existingContent = null;
  }

  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(
    configPath,
    mergeClaudeCodeSettings(existingContent, buildClaudeCodeEnv(input)),
    "utf8"
  );
  return configPath;
};

export const readProjectApiKey = async (
  cwd = process.cwd(),
  env: NodeJS.ProcessEnv = process.env
): Promise<string | undefined> => {
  const fromEnv = env.COPILOTX_API_KEY?.trim();
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return fromEnv;
  }

  try {
    const dotEnv = await readFile(join(cwd, ".env"), "utf8");
    for (const rawLine of dotEnv.split(/\r?\n/u)) {
      const line = rawLine.trim();
      if (line.length === 0 || line.startsWith("#")) {
        continue;
      }

      const separatorIndex = line.indexOf("=");
      if (separatorIndex < 0) {
        continue;
      }

      const key = line.slice(0, separatorIndex).trim();
      const value = line.slice(separatorIndex + 1).trim();
      if (key === "COPILOTX_API_KEY" && value.length > 0) {
        return value;
      }
    }
  } catch {
    return undefined;
  }

  return undefined;
};
