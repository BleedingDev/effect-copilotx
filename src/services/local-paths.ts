import { homedir } from "node:os";
import { join } from "node:path";

const effectiveHomeDir = () => process.env.HOME?.trim() || homedir();

export const getCopilotXHomeDir = (homeDir = effectiveHomeDir()) =>
  join(homeDir, ".copilotx");

export const getServerInfoPath = (homeDir = effectiveHomeDir()) =>
  join(getCopilotXHomeDir(homeDir), "server.json");

export const getClaudeCodeSettingsPath = (homeDir = effectiveHomeDir()) =>
  join(homeDir, ".claude", "settings.json");
