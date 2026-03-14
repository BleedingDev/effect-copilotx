export const GITHUB_CLIENT_ID = "Iv1.b507a08c87ecfe98";
export const GITHUB_SCOPE = "read:user";
export const GITHUB_DEVICE_CODE_URL = "https://github.com/login/device/code";
export const GITHUB_ACCESS_TOKEN_URL =
  "https://github.com/login/oauth/access_token";
export const GITHUB_COPILOT_TOKEN_URL =
  "https://api.github.com/copilot_internal/v2/token";

export const COPILOT_API_BASE_FALLBACK = "https://api.githubcopilot.com";
export const COPILOT_CHAT_COMPLETIONS_PATH = "/chat/completions";
export const COPILOT_MODELS_PATH = "/models";
export const COPILOT_RESPONSES_PATH = "/responses";

export const COPILOT_HEADERS = {
  "Copilot-Integration-Id": "vscode-chat",
  "Editor-Plugin-Version": "copilot-chat/0.36.1",
  "Editor-Version": "vscode/1.108.0",
  "User-Agent": "GitHubCopilotChat/0.36.1",
  "X-GitHub-Api-Version": "2025-10-01",
  "openai-intent": "conversation-panel",
  "x-vscode-user-agent-library-version": "electron-fetch",
} as const;

export const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
export const DEFAULT_MODEL_CACHE_TTL_SECONDS = 300;
export const DEFAULT_DEVICE_CODE_POLL_INTERVAL_SECONDS = 5;
export const DEFAULT_DEVICE_CODE_TIMEOUT_SECONDS = 900;
export const DEFAULT_TOKEN_REFRESH_BUFFER_SECONDS = 60;
export const DEFAULT_ROTATION_STRATEGY = "fill-first" as const;
export const ROTATION_STRATEGIES = [
  DEFAULT_ROTATION_STRATEGY,
  "round-robin",
] as const;
