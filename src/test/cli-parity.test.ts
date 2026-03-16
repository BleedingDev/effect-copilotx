import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "@effect-native/bun-test";
import * as Effect from "effect/Effect";

import {
  mergeClaudeCodeSettings,
  readProjectApiKey,
  resolveAgentBaseUrl,
  selectPreferredModel,
  writeClaudeCodeSettings,
  writeCodexCliSetup,
  writeFactoryDroidSetup,
  writeOhMyPiSetup,
} from "#/services/agent-config";
import {
  getClaudeCodeSettingsPath,
  getCodexConfigPath,
  getFactorySettingsLocalPath,
} from "#/services/local-paths";
import { resolveListenOptions } from "#/services/port-selection";
import {
  cleanupServerInfo,
  readServerInfo,
  writeServerInfo,
} from "#/services/server-discovery";

const toError = (error: unknown) =>
  error instanceof Error ? error : new Error(String(error));

describe("CLI parity helpers", () => {
  it.effect("selects preferred models and falls back when needed", () =>
    Effect.sync(() => {
      expect(
        selectPreferredModel(
          ["gpt-5-mini", "claude-opus-4.6", "gpt-4o"],
          ["opus", "gpt-5"],
          "gpt-4o"
        )
      ).toBe("claude-opus-4.6");
      expect(selectPreferredModel([], ["haiku"], "gpt-5-mini")).toBe("gpt-5-mini");
      expect(
        resolveAgentBaseUrl(undefined, {
          base_url: "http://127.0.0.1:4312",
          host: "127.0.0.1",
          pid: 1,
          port: 4312,
          public_url: "https://copilotx.localhost",
          started_at: new Date().toISOString(),
        })
      ).toBe("https://copilotx.localhost");
    }));



  it.effect("writes Claude Code settings while preserving existing keys", () =>
    Effect.tryPromise({
      try: async () => {
        const homeDir = await mkdtemp(join(tmpdir(), "copilotx-claude-"));
        try {
          const settingsPath = getClaudeCodeSettingsPath(homeDir);
          await mkdir(dirname(settingsPath), { recursive: true });
          await writeFile(
            settingsPath,
            JSON.stringify({ env: { KEEP_ME: "1" }, theme: "dark" }, null, 2),
            "utf8"
          );
          await writeClaudeCodeSettings(
            {
              apiKey: "copilotx",
              baseUrl: "http://127.0.0.1:24680",
              model: "claude-opus-4.6",
              smallModel: "gpt-5-mini",
            },
            homeDir
          );

          const parsed = JSON.parse(await readFile(settingsPath, "utf8")) as {
            env: Record<string, string>;
            theme: string;
          };

          expect(parsed.theme).toBe("dark");
          expect(parsed.env.KEEP_ME).toBe("1");
          expect(parsed.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:24680");
          expect(parsed.env.ANTHROPIC_MODEL).toBe("claude-opus-4.6");
          expect(parsed.env.ANTHROPIC_SMALL_FAST_MODEL).toBe("gpt-5-mini");
        } finally {
          await rm(homeDir, { force: true, recursive: true });
        }
      },
      catch: toError,
    }));

  it.effect("reads API keys from the project .env file", () =>
    Effect.tryPromise({
      try: async () => {
        const projectDir = await mkdtemp(join(tmpdir(), "copilotx-env-"));
        try {
          await writeFile(
            join(projectDir, ".env"),
            "# comment\nCOPILOTX_API_KEY=test-secret\n",
            "utf8"
          );

          expect(await readProjectApiKey(projectDir, {})).toBe("test-secret");
          expect(
            mergeClaudeCodeSettings(null, { ANTHROPIC_AUTH_TOKEN: "token" })
          ).toContain("ANTHROPIC_AUTH_TOKEN");
        } finally {
          await rm(projectDir, { force: true, recursive: true });
        }
      },
      catch: toError,
    }));

  it.effect("writes Codex CLI config and launcher", () =>
    Effect.tryPromise({
      try: async () => {
        const homeDir = await mkdtemp(join(tmpdir(), "copilotx-codex-"));
        try {
          const configPath = getCodexConfigPath(homeDir);
          await mkdir(dirname(configPath), { recursive: true });
          await writeFile(
            configPath,
            '# existing\n[profiles.default]\nmodel = "gpt-5.4"\n',
            "utf8"
          );

          const result = await writeCodexCliSetup(
            {
              apiKey: "test-key",
              baseUrl: "https://copilotx.example.com",
              model: "gpt-5.4",
              smallModel: "gpt-5-mini",
            },
            homeDir
          );

          const configContent = await readFile(configPath, "utf8");
          if (result.launcherPath === null) {
            throw new Error("Expected Codex launcher path.");
          }
          const launcher = await readFile(result.launcherPath, "utf8");
          const launcherCmd = await readFile(`${result.launcherPath}.cmd`, "utf8");
          const launcherPs1 = await readFile(`${result.launcherPath}.ps1`, "utf8");

          expect(result.configPath).toBe(configPath);
          expect(result.launcherPath).toContain("codex-copilotx");
          expect(configContent).toContain("[model_providers.copilotx]");
          expect(configContent).toContain('experimental_bearer_token = "test-key"');
          expect(configContent).toContain('[profiles.copilotx]');
          expect(configContent).toContain('model = "gpt-5.4"');
          expect(launcher).toContain('exec codex --profile copilotx "$@"');
          expect(launcherCmd).toContain("codex --profile copilotx %*");
          expect(launcherPs1).toContain("& codex --profile copilotx @args");
        } finally {
          await rm(homeDir, { force: true, recursive: true });
        }
      },
      catch: toError,
    }));

  it.effect("writes Factory Droid settings and launcher", () =>
    Effect.tryPromise({
      try: async () => {
        const homeDir = await mkdtemp(join(tmpdir(), "copilotx-factory-"));
        try {
          const settingsPath = getFactorySettingsLocalPath(homeDir);
          await mkdir(dirname(settingsPath), { recursive: true });
          await writeFile(
            settingsPath,
            JSON.stringify({ customModels: [{ displayName: "Other" }], ui: "dark" }, null, 2),
            "utf8"
          );

          const result = await writeFactoryDroidSetup(
            {
              apiKey: "factory-key",
              baseUrl: "https://copilotx.example.com",
              model: "claude-opus-4.6",
              smallModel: "gpt-5-mini",
            },
            homeDir
          );

          const parsed = JSON.parse(await readFile(settingsPath, "utf8")) as {
            customModels: Array<Record<string, unknown>>;
            ui: string;
          };
          const copilotxModel = parsed.customModels.find(
            (model) => model.displayName === "CopilotX Remote"
          );

          if (result.launcherPath === null) {
            throw new Error("Expected Factory Droid launcher path.");
          }
          const launcher = await readFile(result.launcherPath, "utf8");
          const launcherCmd = await readFile(`${result.launcherPath}.cmd`, "utf8");
          const launcherPs1 = await readFile(`${result.launcherPath}.ps1`, "utf8");

          expect(result.configPath).toBe(settingsPath);
          expect(result.launcherPath).toContain("droid-copilotx");
          expect(parsed.ui).toBe("dark");
          expect(copilotxModel).toMatchObject({
            apiKey: "factory-key",
            baseUrl: "https://copilotx.example.com",
            model: "claude-opus-4.6",
            provider: "anthropic",
          });
          expect(launcher).toContain('exec droid -m custom-model "$@"');
          expect(launcherCmd).toContain('if /I "%~1"=="exec" (');
          expect(launcherCmd).toContain("droid exec -m custom-model %*");
          expect(launcherPs1).toContain("& droid exec -m custom-model @remaining");
          expect(launcherPs1).toContain("& droid -m custom-model @args");
        } finally {
          await rm(homeDir, { force: true, recursive: true });
        }
      },
      catch: toError,
    }));

  it.effect("writes Oh My Pi launcher with CopilotX env", () =>
    Effect.tryPromise({
      try: async () => {
        const homeDir = await mkdtemp(join(tmpdir(), "copilotx-omp-"));
        try {
          const result = await writeOhMyPiSetup(
            {
              apiKey: "omp-key",
              baseUrl: "https://copilotx.example.com",
              model: "gpt-5.4",
              smallModel: "gpt-5-mini",
            },
            homeDir
          );

          if (result.launcherPath === null) {
            throw new Error("Expected Oh My Pi launcher path.");
          }

          const launcher = await readFile(result.launcherPath, "utf8");
          const launcherCmd = await readFile(`${result.launcherPath}.cmd`, "utf8");
          const launcherPs1 = await readFile(`${result.launcherPath}.ps1`, "utf8");
          expect(launcher).toContain('export OPENAI_BASE_URL="https://copilotx.example.com/v1"');
          expect(launcher).toContain('export OPENAI_API_KEY="omp-key"');
          expect(launcher).toContain('export PI_SMOL_MODEL="gpt-5-mini"');
          expect(launcher).toContain('exec omp --model "gpt-5.4" "$@"');
          expect(launcherCmd).toContain('set "OPENAI_BASE_URL=https://copilotx.example.com/v1"');
          expect(launcherCmd).toContain("omp --model gpt-5.4 %*");
          expect(launcherPs1).toContain('$env:OPENAI_API_KEY = "omp-key"');
          expect(launcherPs1).toContain('& omp --model "gpt-5.4" @args');
        } finally {
          await rm(homeDir, { force: true, recursive: true });
        }
      },
      catch: toError,
    }));


  it.effect("writes and cleans server discovery metadata safely", () =>
    Effect.tryPromise({
      try: async () => {
        const homeDir = await mkdtemp(join(tmpdir(), "copilotx-server-"));
        try {
          const written = await writeServerInfo(
            {
              host: "127.0.0.1",
              pid: 4321,
              port: 4123,
              publicUrl: "https://copilotx.localhost",
            },
            homeDir
          );

          expect(await readServerInfo(homeDir)).toEqual(written);
          expect(await cleanupServerInfo(homeDir, 1234)).toBe(false);
          expect(await cleanupServerInfo(homeDir, 4321)).toBe(true);
          expect(await readServerInfo(homeDir)).toBeNull();
        } finally {
          await rm(homeDir, { force: true, recursive: true });
        }
      },
      catch: toError,
    }));

  it.effect("honors portless env ports and falls back when a port is busy", () =>
    Effect.tryPromise({
      try: async () => {
        const portless = await resolveListenOptions(
          { host: "0.0.0.0", port: 24680, portExplicit: false },
          {
            HOST: "127.0.0.1",
            PORT: "4123",
            PORTLESS_URL: "https://copilotx.localhost",
          }
        );

        expect(portless.host).toBe("127.0.0.1");
        expect(portless.port).toBe(4123);
        expect(portless.publicUrl).toBe("https://copilotx.localhost");

        const busyServer = net.createServer();
        await new Promise<void>((resolve, reject) => {
          busyServer.once("error", reject);
          busyServer.listen(0, "127.0.0.1", () => resolve());
        });

        try {
          const address = busyServer.address();
          if (address === null || typeof address === "string") {
            throw new Error("Expected a TCP server address.");
          }

          const resolved = await resolveListenOptions(
            { host: "127.0.0.1", port: address.port, portExplicit: false },
            {}
          );

          expect(resolved.port).not.toBe(address.port);
          expect(resolved.port).toBeGreaterThanOrEqual(4000);
          expect(resolved.port).toBeLessThanOrEqual(4999);
        } finally {
          await new Promise<void>((resolve, reject) => {
            busyServer.close((error) => (error ? reject(error) : resolve()));
          });
        }
      },
      catch: toError,
    }));
});
