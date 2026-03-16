import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { URL } from "node:url";

import { DEFAULT_HOST, DEFAULT_PORT } from "#/app/app-info";
import {
  getClaudeCodeSettingsPath,
  getCodexConfigPath,
  getCopilotXBinDir,
  getFactorySettingsLocalPath,
} from "#/services/local-paths";
import type { CopilotXServerInfoFile } from "#/services/server-discovery";

export const primaryModelPreferences = [
  "opus-4.6",
  "opus-4.5",
  "opus",
  "gpt-5",
  "gpt-4o",
] as const;

export const smallModelPreferences = ["haiku", "gpt-5-mini", "mini", "sonnet"] as const;

export const codexModelPreferences = [
  "gpt-5.4",
  "gpt-5.3-codex",
  "gpt-5.2-codex",
  "gpt-5.2",
  "gpt-5.1",
  "gpt-4.1",
] as const;

export const ompModelPreferences = [...codexModelPreferences] as const;
export const ompSmallModelPreferences = ["gpt-5-mini", "gpt-4o-mini", "gpt-4o"] as const;

const defaultBaseUrl = `http://${DEFAULT_HOST}:${DEFAULT_PORT}`;
const codexProfileName = "copilotx";
const copilotxBlockBegin = "BEGIN COPILOTX MANAGED BLOCK";
const copilotxBlockEnd = "END COPILOTX MANAGED BLOCK";
const factoryDisplayName = "CopilotX Remote";

export interface AgentSetupInput {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly smallModel: string;
}

export interface AgentSetupResult {
  readonly configPath: string | null;
  readonly launcherPath: string | null;
  readonly target: string;
}

const parseJsonRecord = (content: string): Record<string, unknown> => {
  const parsed = JSON.parse(content) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Expected a JSON object.");
  }

  return parsed as Record<string, unknown>;
};

const normalizeIds = (modelIds: readonly string[]): readonly string[] =>
  [...new Set(modelIds.map((modelId) => modelId.trim()).filter((modelId) => modelId.length > 0))];

const readExistingText = async (path: string): Promise<string | null> => {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
};

const ensureParentDir = async (path: string) => {
  await mkdir(dirname(path), { recursive: true });
};

const managedBlock = (body: string): string =>
  `# ${copilotxBlockBegin}\n${body.trimEnd()}\n# ${copilotxBlockEnd}\n`;

const mergeManagedBlock = (existingContent: string | null, body: string): string => {
  const nextBlock = managedBlock(body);
  if (existingContent === null || existingContent.trim().length === 0) {
    return nextBlock;
  }

  const beginMarker = `# ${copilotxBlockBegin}`;
  const endMarker = `# ${copilotxBlockEnd}`;
  const start = existingContent.indexOf(beginMarker);
  const end = existingContent.indexOf(endMarker);

  if (start >= 0 && end >= start) {
    const replacementEnd = end + endMarker.length;
    const before = existingContent.slice(0, start).trimEnd();
    const after = existingContent.slice(replacementEnd).trimStart();
    return `${before.length === 0 ? "" : `${before}\n\n`}${nextBlock}${after.length === 0 ? "" : `\n${after}`}`;
  }

  const trimmed = existingContent.trimEnd();
  return `${trimmed}\n\n${nextBlock}`;
};

const writeExecutableScript = async (
  name: string,
  content: string,
  homeDir?: string
): Promise<string> => {
  const path = join(getCopilotXBinDir(homeDir), name);
  await ensureParentDir(path);
  await writeFile(path, content, "utf8");
  await chmod(path, 0o755);
  return path;
};

const openAiBaseUrl = (baseUrl: string): string => new URL("/v1", baseUrl).toString();

const isAnthropicModel = (model: string): boolean => model.toLowerCase().startsWith("claude-");

const factoryProviderForModel = (model: string) =>
  isAnthropicModel(model) ? "anthropic" : "openai";

const factoryBaseUrlForModel = (baseUrl: string, model: string): string =>
  factoryProviderForModel(model) === "anthropic" ? baseUrl : openAiBaseUrl(baseUrl);

const factoryMaxOutputTokens = (model: string): number =>
  factoryProviderForModel(model) === "anthropic" ? 8192 : 16384;

const tomlString = (value: string): string => JSON.stringify(value);

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

export const resolveAgentBaseUrl = (
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

export const buildClaudeCodeEnv = (input: AgentSetupInput): Record<string, string> => ({
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
  input: AgentSetupInput,
  homeDir?: string
): Promise<string> => {
  const configPath = getClaudeCodeSettingsPath(homeDir);
  const existingContent = await readExistingText(configPath);
  await ensureParentDir(configPath);
  await writeFile(
    configPath,
    mergeClaudeCodeSettings(existingContent, buildClaudeCodeEnv(input)),
    "utf8"
  );
  return configPath;
};

export const writeCodexCliSetup = async (
  input: AgentSetupInput,
  homeDir?: string
): Promise<AgentSetupResult> => {
  const configPath = getCodexConfigPath(homeDir);
  const existingContent = await readExistingText(configPath);
  const block = [
    `[model_providers.${codexProfileName}]`,
    `name = ${tomlString("CopilotX")}`,
    `base_url = ${tomlString(openAiBaseUrl(input.baseUrl))}`,
    `experimental_bearer_token = ${tomlString(input.apiKey)}`,
    'wire_api = "responses"',
    "",
    `[profiles.${codexProfileName}]`,
    `model = ${tomlString(input.model)}`,
    `model_provider = ${tomlString(codexProfileName)}`,
  ].join("\n");

  await ensureParentDir(configPath);
  await writeFile(configPath, mergeManagedBlock(existingContent, block), "utf8");

  const launcherPath = await writeExecutableScript(
    "codex-copilotx",
    `#!/bin/sh\nexec codex --profile ${codexProfileName} "$@"\n`,
    homeDir
  );

  return {
    configPath,
    launcherPath,
    target: "codex-cli",
  };
};

export const writeFactoryDroidSetup = async (
  input: AgentSetupInput,
  homeDir?: string
): Promise<AgentSetupResult> => {
  const configPath = getFactorySettingsLocalPath(homeDir);
  const existingContent = await readExistingText(configPath);
  let settings: Record<string, unknown> = {};

  if (existingContent !== null && existingContent.trim().length > 0) {
    try {
      settings = parseJsonRecord(existingContent);
    } catch {
      settings = {};
    }
  }

  const existingModels = Array.isArray(settings.customModels)
    ? settings.customModels.filter(
        (entry) =>
          !(
            entry !== null &&
            typeof entry === "object" &&
            !Array.isArray(entry) &&
            (entry as { readonly displayName?: unknown }).displayName === factoryDisplayName
          )
      )
    : [];

  const nextSettings = {
    ...settings,
    customModels: [
      ...existingModels,
      {
        apiKey: input.apiKey,
        baseUrl: factoryBaseUrlForModel(input.baseUrl, input.model),
        displayName: factoryDisplayName,
        maxOutputTokens: factoryMaxOutputTokens(input.model),
        model: input.model,
        provider: factoryProviderForModel(input.model),
      },
    ],
  };

  await ensureParentDir(configPath);
  await writeFile(configPath, `${JSON.stringify(nextSettings, null, 2)}\n`, "utf8");

  const launcherPath = await writeExecutableScript(
    "droid-copilotx",
    [
      "#!/bin/sh",
      'if [ "$1" = "exec" ]; then',
      "  shift",
      '  exec droid exec -m custom-model "$@"',
      "fi",
      'exec droid -m custom-model "$@"',
      "",
    ].join("\n"),
    homeDir
  );

  return {
    configPath,
    launcherPath,
    target: "factory-droid",
  };
};

export const writeOhMyPiSetup = async (
  input: AgentSetupInput,
  homeDir?: string
): Promise<AgentSetupResult> => {
  const launcherPath = await writeExecutableScript(
    "omp-copilotx",
    [
      "#!/bin/sh",
      `export OPENAI_BASE_URL=${tomlString(openAiBaseUrl(input.baseUrl))}`,
      `export OPENAI_API_KEY=${tomlString(input.apiKey)}`,
      `export PI_SMOL_MODEL=${tomlString(input.smallModel)}`,
      `export PI_SLOW_MODEL=${tomlString(input.model)}`,
      `export PI_PLAN_MODEL=${tomlString(input.model)}`,
      `exec omp --model ${tomlString(input.model)} "$@"`,
      "",
    ].join("\n"),
    homeDir
  );

  return {
    configPath: null,
    launcherPath,
    target: "oh-my-pi",
  };
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
