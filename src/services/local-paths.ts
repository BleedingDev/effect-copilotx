import { homedir } from "node:os";
import { join } from "node:path";

const effectiveHomeDir = () => process.env.HOME?.trim() || homedir();

const effectivePiConfigDirName = () => process.env.PI_CONFIG_DIR?.trim() || ".omp";

export const getCopilotXHomeDir = (homeDir = effectiveHomeDir()) =>
  join(homeDir, ".copilotx");

export const getCopilotXBinDir = (homeDir = effectiveHomeDir()) =>
  join(getCopilotXHomeDir(homeDir), "bin");

export const getServerInfoPath = (homeDir = effectiveHomeDir()) =>
  join(getCopilotXHomeDir(homeDir), "server.json");

export const getClaudeCodeSettingsPath = (homeDir = effectiveHomeDir()) =>
  join(homeDir, ".claude", "settings.json");

export const getCodexConfigPath = (homeDir = effectiveHomeDir()) =>
  join(homeDir, ".codex", "config.toml");

export const getFactorySettingsLocalPath = (homeDir = effectiveHomeDir()) =>
  join(homeDir, ".factory", "settings.local.json");

export const getOhMyPiAgentDir = (homeDir = effectiveHomeDir()) =>
  process.env.PI_CODING_AGENT_DIR?.trim() ||
  join(homeDir, effectivePiConfigDirName(), "agent");

