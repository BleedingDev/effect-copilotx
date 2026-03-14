import { randomBytes } from "node:crypto";
import { access, copyFile, readFile, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = resolve(repoRoot, ".env");
const envExamplePath = resolve(repoRoot, ".env.example");
const nodeModulesPath = resolve(repoRoot, "node_modules");

const defaultDatabaseUrl =
  "postgresql://postgres:postgres@127.0.0.1:5433/effect_copilotx_dev";
const defaultHost = "127.0.0.1";
const defaultPort = "24680";
const databaseReadyTimeoutMs = 60_000;
const databasePollIntervalMs = 1_000;

type EnvMap = Map<string, string>;

const sleep = (ms: number) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

const fileExists = async (path: string): Promise<boolean> => {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
};

const parseDotEnv = (content: string): EnvMap => {
  const env = new Map<string, string>();

  for (const line of content.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex < 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    if (key.length > 0) {
      env.set(key, value);
    }
  }

  return env;
};

const setEnvValue = (content: string, key: string, value: string): string => {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, "mu");

  if (pattern.test(content)) {
    return content.replace(pattern, line);
  }

  const normalized = content.endsWith("\n") || content.length === 0 ? content : `${content}\n`;
  return `${normalized}${line}\n`;
};

const ensureDependencies = async (): Promise<void> => {
  if (await fileExists(nodeModulesPath)) {
    return;
  }

  console.log("Installing Bun dependencies...");
  const install = Bun.spawn(["bun", "install"], {
    cwd: repoRoot,
    stderr: "inherit",
    stdin: "inherit",
    stdout: "inherit",
  });

  const exitCode = await install.exited;
  if (exitCode !== 0) {
    throw new Error(`bun install failed with exit code ${exitCode}.`);
  }
};

const ensureLocalEnv = async (): Promise<EnvMap> => {
  let createdEnv = false;
  if (!(await fileExists(envPath))) {
    await copyFile(envExamplePath, envPath);
    createdEnv = true;
  }

  let content = await readFile(envPath, "utf8");
  let changed = createdEnv;

  const env = parseDotEnv(content);
  if ((env.get("DATABASE_URL") ?? "").trim().length === 0) {
    content = setEnvValue(content, "DATABASE_URL", defaultDatabaseUrl);
    changed = true;
  }

  if ((env.get("COPILOTX_HOST") ?? "").trim().length === 0) {
    content = setEnvValue(content, "COPILOTX_HOST", defaultHost);
    changed = true;
  }

  if ((env.get("COPILOTX_PORT") ?? "").trim().length === 0) {
    content = setEnvValue(content, "COPILOTX_PORT", defaultPort);
    changed = true;
  }

  if ((env.get("COPILOTX_TOKEN_ENCRYPTION_KEY") ?? "").trim().length === 0) {
    const generatedKey = randomBytes(32).toString("hex");
    content = setEnvValue(content, "COPILOTX_TOKEN_ENCRYPTION_KEY", generatedKey);
    changed = true;
    console.log("Generated COPILOTX_TOKEN_ENCRYPTION_KEY in .env");
  }

  if (changed) {
    await writeFile(envPath, content, "utf8");
  }

  if (createdEnv) {
    console.log("Created .env from .env.example");
  }

  return parseDotEnv(content);
};

const waitForDatabase = async (
  databaseUrl: string,
  timeoutMs = databaseReadyTimeoutMs
): Promise<void> => {
  const { Client } = await import("pg");
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;

  while (Date.now() < deadline) {
    const client = new Client({ connectionString: databaseUrl });

    try {
      await client.connect();
      await client.query("select 1");
      await client.end();
      return;
    } catch (error) {
      lastError = error;
      try {
        await client.end();
      } catch {
        // ignore cleanup failure while polling for readiness
      }
      await sleep(databasePollIntervalMs);
    }
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(
    `PostgreSQL did not become ready within ${timeoutMs / 1000}s: ${message}`
  );
};

const databaseAvailable = async (databaseUrl: string): Promise<boolean> => {
  try {
    await waitForDatabase(databaseUrl, 1_500);
    return true;
  } catch {
    return false;
  }
};

const startPostgres = async (databaseUrl: string): Promise<void> => {
  if (await databaseAvailable(databaseUrl)) {
    console.log("Using existing PostgreSQL instance...");
    return;
  }

  console.log("Starting PostgreSQL 18...");
  const postgres = Bun.spawn(["docker", "compose", "up", "-d", "postgres"], {
    cwd: repoRoot,
    stderr: "inherit",
    stdin: "inherit",
    stdout: "inherit",
  });

  const exitCode = await postgres.exited;
  if (exitCode === 0) {
    return;
  }

  if (await databaseAvailable(databaseUrl)) {
    console.log(
      "PostgreSQL was already reachable after docker compose up failed; continuing with the existing database."
    );
    return;
  }

  throw new Error(`docker compose up failed with exit code ${exitCode}.`);
};

const runServer = async (env: EnvMap): Promise<void> => {
  const host = (env.get("COPILOTX_HOST") ?? defaultHost).trim() || defaultHost;
  const port = (env.get("COPILOTX_PORT") ?? defaultPort).trim() || defaultPort;
  const mergedEnv = {
    ...process.env,
    ...Object.fromEntries(env.entries()),
  } as Record<string, string>;

  console.log(`Starting CopilotX on http://${host}:${port}`);
  console.log("Use `mise run auth-login` in another terminal to add an account.");

  const server = Bun.spawn(
    ["bun", "run", "src/bin/cli.ts", "serve", "--host", host, "--port", port],
    {
      cwd: repoRoot,
      env: mergedEnv,
      stderr: "inherit",
      stdin: "inherit",
      stdout: "inherit",
    }
  );

  const forwardSignal = () => {
    try {
      server.kill();
    } catch {
      // ignore if the child already exited
    }
  };

  process.on("SIGINT", forwardSignal);
  process.on("SIGTERM", forwardSignal);

  const exitCode = await server.exited;
  process.exitCode = exitCode;
};

const main = async () => {
  await ensureDependencies();
  const env = await ensureLocalEnv();
  const databaseUrl =
    (env.get("DATABASE_URL") ?? defaultDatabaseUrl).trim() || defaultDatabaseUrl;

  await startPostgres(databaseUrl);
  await waitForDatabase(databaseUrl);
  await runServer(env);
};

await main();
