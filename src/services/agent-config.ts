import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { URL } from "node:url";

import { DEFAULT_HOST, DEFAULT_PORT } from "#/app/app-info";
import {
  getClaudeCodeSettingsPath,
  getCodexConfigPath,
  getCopilotXBinDir,
  getCopilotXOhMyPiAgentDir,
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
const ompProviderName = "copilotx";
const ompApiKeyEnvName = "COPILOTX_OMP_API_KEY";


export interface AgentSetupInput {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly smallModel: string;
  readonly modelCatalog?: readonly string[];
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

interface LauncherScriptBundle {
  readonly posix: string;
  readonly cmd: string;
  readonly powerShell: string;
}

const writeExecutableScript = async (
  name: string,
  scripts: LauncherScriptBundle,
  homeDir?: string
): Promise<string> => {
  const path = join(getCopilotXBinDir(homeDir), name);
  await ensureParentDir(path);
  await writeFile(path, scripts.posix, "utf8");
  await chmod(path, 0o755);
  await writeFile(`${path}.cmd`, scripts.cmd, "utf8");
  await writeFile(`${path}.ps1`, scripts.powerShell, "utf8");
  return path;
};


const openAiBaseUrl = (baseUrl: string): string => new URL("/v1", baseUrl).toString();

const isAnthropicModel = (model: string): boolean => model.toLowerCase().startsWith("claude-");

const factoryDroidProviderForModel = (model: string) =>
  isAnthropicModel(model) ? "generic-chat-completion-api" : "openai";

const factoryBaseUrlForModel = (baseUrl: string): string => openAiBaseUrl(baseUrl);

const factoryMaxOutputTokens = (model: string): number =>
  isAnthropicModel(model) ? 8192 : 16384;

const toFactoryCustomModelId = (model: string, index: number): string => {
  const sanitizedModel = model
    .replace(/[^A-Za-z0-9.-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return `custom:CopilotX-${sanitizedModel.length > 0 ? sanitizedModel : "Model"}-${index}`;
};

const tomlString = (value: string): string => JSON.stringify(value);
const ompScopedModel = (modelId: string): string => `${ompProviderName}/${modelId}`;

const resolveOhMyPiModelCatalog = (input: AgentSetupInput): readonly string[] => {
  const catalog = normalizeIds([...(input.modelCatalog ?? []), input.model, input.smallModel]);
  return catalog.length > 0 ? catalog : [input.model, input.smallModel];
};

const buildOhMyPiModelsConfig = (baseUrl: string, modelCatalog: readonly string[]): string =>
  [
    "providers:",
    `  ${ompProviderName}:`,
    `    baseUrl: ${tomlString(openAiBaseUrl(baseUrl))}`,
    `    apiKey: ${tomlString(ompApiKeyEnvName)}`,
    '    api: "openai-responses"',
    "    models:",
    ...modelCatalog.map((modelId) => `      - id: ${tomlString(modelId)}`),
    "",
  ].join("\n");


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
    {
      cmd: [
        "@echo off",
        "setlocal",
        "if /I \"%~1\"==\"exec\" (",
        "  shift",
        `  codex exec --profile ${codexProfileName} %*`,
        "  exit /b %ERRORLEVEL%",
        ")",
        "if /I \"%~1\"==\"review\" (",
        "  shift",
        `  codex review --profile ${codexProfileName} %*`,
        "  exit /b %ERRORLEVEL%",
        ")",
        `codex --profile ${codexProfileName} %*`,
        "",
      ].join("\r\n"),
      posix: [
        "#!/bin/sh",
        'if [ "$1" = "exec" ] || [ "$1" = "review" ]; then',
        "  command=$1",
        "  shift",
        `  exec codex "$command" --profile ${codexProfileName} "$@"`,
        "fi",
        `exec codex --profile ${codexProfileName} "$@"`,
        "",
      ].join("\n"),
      powerShell: [
        "#!/usr/bin/env pwsh",
        '$ErrorActionPreference = "Stop"',
        "if ($args.Count -gt 0) {",
        '  $first = $args[0].ToLowerInvariant()',
        '  if ($first -eq "exec" -or $first -eq "review") {',
        "    $remaining = if ($args.Count -gt 1) { $args[1..($args.Count - 1)] } else { @() }",
        `    & codex $first --profile ${codexProfileName} @remaining`,
        "    exit $LASTEXITCODE",
        "  }",
        "}",
        `& codex --profile ${codexProfileName} @args`,
        "exit $LASTEXITCODE",
        "",
      ].join("\n"),
    },
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

  const nextCustomModelIndex =
    existingModels.reduce((maxIndex, entry) => {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        return maxIndex;
      }
      const maybeIndex = (entry as { readonly index?: unknown }).index;
      return typeof maybeIndex === "number" && Number.isFinite(maybeIndex)
        ? Math.max(maxIndex, Math.trunc(maybeIndex))
        : maxIndex;
    }, -1) + 1;

  const customModelId = toFactoryCustomModelId(input.model, nextCustomModelIndex);

  const nextSettings = {
    ...settings,
    customModels: [
      ...existingModels,
      {
        apiKey: input.apiKey,
        baseUrl: factoryBaseUrlForModel(input.baseUrl),
        displayName: factoryDisplayName,
        id: customModelId,
        index: nextCustomModelIndex,
        maxOutputTokens: factoryMaxOutputTokens(input.model),
        model: input.model,
        noImageSupport: false,
        provider: factoryDroidProviderForModel(input.model),
      },
    ],
  };

  await ensureParentDir(configPath);
  await writeFile(configPath, `${JSON.stringify(nextSettings, null, 2)}\n`, "utf8");

  const launcherPath = await writeExecutableScript(
    "droid-copilotx",
    {
      cmd: [
        "@echo off",
        "setlocal",
        "if /I \"%~1\"==\"exec\" (",
        "  shift",
        `  droid exec -m ${tomlString(customModelId)} %*`,
        "  exit /b %ERRORLEVEL%",
        ")",
        `droid -m ${tomlString(customModelId)} %*`,
        "exit /b %ERRORLEVEL%",
        "",
      ].join("\r\n"),
      posix: [
        "#!/bin/sh",
        'if [ "$1" = "exec" ]; then',
        "  shift",
        `  exec droid exec -m ${tomlString(customModelId)} "$@"`,
        "fi",
        `exec droid -m ${tomlString(customModelId)} "$@"`,
        "",
      ].join("\n"),
      powerShell: [
        "#!/usr/bin/env pwsh",
        '$ErrorActionPreference = "Stop"',
        'if ($args.Count -gt 0 -and $args[0].ToLowerInvariant() -eq "exec") {',
        "  $remaining = if ($args.Count -gt 1) { $args[1..($args.Count - 1)] } else { @() }",
        `  & droid exec -m ${tomlString(customModelId)} @remaining`,
        "  exit $LASTEXITCODE",
        "}",
        `& droid -m ${tomlString(customModelId)} @args`,
        "exit $LASTEXITCODE",
        "",
      ].join("\n"),
    },
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
  const configPath = join(getCopilotXOhMyPiAgentDir(homeDir), "models.yml");
  const modelCatalog = resolveOhMyPiModelCatalog(input);
  const scopedModel = ompScopedModel(input.model);
  const scopedSmallModel = ompScopedModel(input.smallModel);

  await ensureParentDir(configPath);
  await writeFile(configPath, buildOhMyPiModelsConfig(input.baseUrl, modelCatalog), "utf8");

  const launcherPath = await writeExecutableScript(
    "omp-copilotx",
    {
      cmd: [
        "@echo off",
        "setlocal",
        "set \"OPENAI_API_KEY=\"",
        "set \"OPENROUTER_API_KEY=\"",
        "set \"GITHUB_TOKEN=\"",
        "set \"ANTHROPIC_API_KEY=\"",
        "set \"GEMINI_API_KEY=\"",
        `set "PI_CODING_AGENT_DIR=${getCopilotXOhMyPiAgentDir(homeDir)}"`,
        `set "${ompApiKeyEnvName}=${input.apiKey}"`,
        `set "PI_SMOL_MODEL=${scopedSmallModel}"`,
        `set "PI_SLOW_MODEL=${scopedModel}"`,
        `set "PI_PLAN_MODEL=${scopedModel}"`,
        `omp --model ${scopedModel} --models ${ompProviderName}/* %*`,
        "exit /b %ERRORLEVEL%",
        "",
      ].join("\r\n"),
      posix: [
        "#!/bin/sh",
        "unset OPENAI_API_KEY OPENROUTER_API_KEY GITHUB_TOKEN ANTHROPIC_API_KEY GEMINI_API_KEY",
        `export PI_CODING_AGENT_DIR=${tomlString(getCopilotXOhMyPiAgentDir(homeDir))}`,
        `export ${ompApiKeyEnvName}=${tomlString(input.apiKey)}`,
        `export PI_SMOL_MODEL=${tomlString(scopedSmallModel)}`,
        `export PI_SLOW_MODEL=${tomlString(scopedModel)}`,
        `export PI_PLAN_MODEL=${tomlString(scopedModel)}`,
        `exec omp --model ${tomlString(scopedModel)} --models ${tomlString(`${ompProviderName}/*`)} "$@"`,
        "",
      ].join("\n"),
      powerShell: [
        "#!/usr/bin/env pwsh",
        '$ErrorActionPreference = "Stop"',
        'foreach ($name in @("OPENAI_API_KEY", "OPENROUTER_API_KEY", "GITHUB_TOKEN", "ANTHROPIC_API_KEY", "GEMINI_API_KEY")) { Remove-Item "Env:$name" -ErrorAction SilentlyContinue }',
        `$env:PI_CODING_AGENT_DIR = ${tomlString(getCopilotXOhMyPiAgentDir(homeDir))}`,
        `$env:${ompApiKeyEnvName} = ${tomlString(input.apiKey)}`,
        `$env:PI_SMOL_MODEL = ${tomlString(scopedSmallModel)}`,
        `$env:PI_SLOW_MODEL = ${tomlString(scopedModel)}`,
        `$env:PI_PLAN_MODEL = ${tomlString(scopedModel)}`,
        `& omp --model ${tomlString(scopedModel)} --models ${tomlString(`${ompProviderName}/*`)} @args`,
        "exit $LASTEXITCODE",
        "",
      ].join("\n"),
    },
    homeDir
  );

  return {
    configPath,
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
