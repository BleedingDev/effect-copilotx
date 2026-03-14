import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { DEFAULT_HOST, DEFAULT_PORT } from "#/app/app-info";
import { getServerInfoPath } from "#/services/local-paths";

export interface CopilotXServerInfoFile {
  readonly base_url: string;
  readonly host: string;
  readonly pid: number;
  readonly port: number;
  readonly public_url?: string;
  readonly started_at: string;
}

const defaultBaseUrl = `http://${DEFAULT_HOST}:${DEFAULT_PORT}`;

const asNonEmptyString = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const asPositiveInteger = (value: unknown): number | null => {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return null;
  }

  return value;
};

const asPort = (value: unknown): number | null => {
  const numeric = asPositiveInteger(value);
  if (numeric === null || numeric > 65_535) {
    return null;
  }

  return numeric;
};

const parseServerInfo = (payload: unknown): CopilotXServerInfoFile | null => {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }

  const record = payload as Record<string, unknown>;
  const host = asNonEmptyString(record.host);
  const baseUrl = asNonEmptyString(record.base_url);
  const startedAt = asNonEmptyString(record.started_at);
  const publicUrl = asNonEmptyString(record.public_url);
  const pid = asPositiveInteger(record.pid);
  const port = asPort(record.port);

  if (host === null || baseUrl === null || startedAt === null || pid === null || port === null) {
    return null;
  }

  return {
    base_url: baseUrl,
    host,
    pid,
    port,
    ...(publicUrl === null ? {} : { public_url: publicUrl }),
    started_at: startedAt,
  };
};

export const resolveDiscoveredBaseUrl = (
  info: CopilotXServerInfoFile | null | undefined
): string => info?.public_url?.trim() || info?.base_url?.trim() || defaultBaseUrl;

export const readServerInfo = async (
  homeDir?: string
): Promise<CopilotXServerInfoFile | null> => {
  try {
    const raw = await readFile(getServerInfoPath(homeDir), "utf8");
    return parseServerInfo(JSON.parse(raw));
  } catch {
    return null;
  }
};

export const writeServerInfo = async (
  input: {
    readonly host: string;
    readonly pid?: number;
    readonly port: number;
    readonly publicUrl?: string | null;
    readonly startedAt?: Date;
  },
  homeDir?: string
): Promise<CopilotXServerInfoFile> => {
  const path = getServerInfoPath(homeDir);
  await mkdir(dirname(path), { recursive: true });

  const info = {
    base_url: `http://${input.host}:${input.port}`,
    host: input.host,
    pid: input.pid ?? process.pid,
    port: input.port,
    ...(input.publicUrl?.trim() ? { public_url: input.publicUrl.trim() } : {}),
    started_at: (input.startedAt ?? new Date()).toISOString(),
  } satisfies CopilotXServerInfoFile;

  await writeFile(path, `${JSON.stringify(info, null, 2)}\n`, "utf8");
  return info;
};

export const cleanupServerInfo = async (
  homeDir?: string,
  pid = process.pid
): Promise<boolean> => {
  const path = getServerInfoPath(homeDir);
  const existing = await readServerInfo(homeDir);
  if (existing !== null && existing.pid !== pid) {
    return false;
  }

  try {
    await rm(path, { force: true });
    return true;
  } catch {
    return false;
  }
};
