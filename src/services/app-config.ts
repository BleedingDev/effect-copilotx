import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Redacted from "effect/Redacted";
import * as ServiceMap from "effect/ServiceMap";

import {
  DEFAULT_DEVICE_CODE_POLL_INTERVAL_SECONDS,
  DEFAULT_DEVICE_CODE_TIMEOUT_SECONDS,
  DEFAULT_MODEL_CACHE_TTL_SECONDS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_TOKEN_REFRESH_BUFFER_SECONDS,
} from "#/config/copilot-constants";

export interface AppConfigShape {
  readonly database: {
    readonly connectTimeoutMs: number;
    readonly idleTimeoutMs: number;
    readonly maxConnections: number;
    readonly minConnections: number;
    readonly url: Redacted.Redacted;
  };
  readonly runtime: {
    readonly host: string;
    readonly idleTimeoutSeconds: number;
    readonly logLevel: string;
    readonly port: number;
    readonly requestTimeoutMs: number;
  };
  readonly security: {
    readonly apiKey: string | undefined;
    readonly corsOrigins: readonly string[];
    readonly forceModels: readonly string[];
    readonly githubBillingToken: string | undefined;
    readonly adminApiKey: string | undefined;
    readonly publicPaths: readonly string[];
    readonly tokenEncryptionKey: Redacted.Redacted;
    readonly tokenEncryptionKeyId: string;
    readonly trustLocalhost: boolean;
  };
  readonly upstream: {
    readonly deviceCodePollIntervalSeconds: number;
    readonly deviceCodeTimeoutSeconds: number;
    readonly modelCacheTtlSeconds: number;
    readonly tokenRefreshBufferSeconds: number;
  };
}

const splitList = (value: string): readonly string[] =>
  value
    .split(/[\s,]+/u)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

const optionalString = (name: string) =>
  Config.string(name).pipe(
    Config.withDefault(""),
    Config.map((value) => {
      const trimmed = value.trim();
      return trimmed.length === 0 ? undefined : trimmed;
    })
  );

const stringList = (name: string, fallback: string) =>
  Config.string(name).pipe(Config.withDefault(fallback), Config.map(splitList));

const configSchema = Config.all({
  database: Config.all({
    connectTimeoutMs: Config.int("COPILOTX_DB_CONNECT_TIMEOUT_MS").pipe(
      Config.withDefault(10_000)
    ),
    idleTimeoutMs: Config.int("COPILOTX_DB_IDLE_TIMEOUT_MS").pipe(
      Config.withDefault(30_000)
    ),
    maxConnections: Config.int("COPILOTX_DB_MAX_CONNECTIONS").pipe(
      Config.withDefault(10)
    ),
    minConnections: Config.int("COPILOTX_DB_MIN_CONNECTIONS").pipe(
      Config.withDefault(1)
    ),
    url: Config.redacted("DATABASE_URL"),
  }),
  runtime: Config.all({
    host: Config.string("COPILOTX_HOST").pipe(Config.withDefault("127.0.0.1")),
    idleTimeoutSeconds: Config.int("COPILOTX_IDLE_TIMEOUT_SECONDS").pipe(
      Config.withDefault(0)
    ),
    logLevel: Config.string("COPILOTX_LOG_LEVEL").pipe(
      Config.withDefault("info")
    ),
    port: Config.int("COPILOTX_PORT").pipe(Config.withDefault(24_680)),
    requestTimeoutMs: Config.int("COPILOTX_REQUEST_TIMEOUT_MS").pipe(
      Config.withDefault(DEFAULT_REQUEST_TIMEOUT_MS)
    ),
  }),
  security: Config.all({
    apiKey: optionalString("COPILOTX_API_KEY"),
    corsOrigins: stringList(
      "COPILOTX_CORS_ORIGINS",
      "http://127.0.0.1:1111,http://localhost:1111"
    ),
    forceModels: stringList("COPILOTX_FORCE_MODELS", ""),
    githubBillingToken: optionalString("COPILOTX_GITHUB_BILLING_TOKEN"),
    adminApiKey: optionalString("COPILOTX_ADMIN_API_KEY"),
    publicPaths: stringList("COPILOTX_PUBLIC_PATHS", "/,/health,/readyz"),
    tokenEncryptionKey: Config.redacted("COPILOTX_TOKEN_ENCRYPTION_KEY"),
    tokenEncryptionKeyId: Config.string(
      "COPILOTX_TOKEN_ENCRYPTION_KEY_ID"
    ).pipe(Config.withDefault("default")),
    trustLocalhost: Config.boolean("COPILOTX_TRUST_LOCALHOST").pipe(
      Config.withDefault(false)
    ),
  }),
  upstream: Config.all({
    deviceCodePollIntervalSeconds: Config.int(
      "COPILOTX_DEVICE_CODE_POLL_INTERVAL_SECONDS"
    ).pipe(Config.withDefault(DEFAULT_DEVICE_CODE_POLL_INTERVAL_SECONDS)),
    deviceCodeTimeoutSeconds: Config.int(
      "COPILOTX_DEVICE_CODE_TIMEOUT_SECONDS"
    ).pipe(Config.withDefault(DEFAULT_DEVICE_CODE_TIMEOUT_SECONDS)),
    modelCacheTtlSeconds: Config.int("COPILOTX_MODEL_CACHE_TTL_SECONDS").pipe(
      Config.withDefault(DEFAULT_MODEL_CACHE_TTL_SECONDS)
    ),
    tokenRefreshBufferSeconds: Config.int(
      "COPILOTX_TOKEN_REFRESH_BUFFER_SECONDS"
    ).pipe(Config.withDefault(DEFAULT_TOKEN_REFRESH_BUFFER_SECONDS)),
  }),
});

export class AppConfig extends ServiceMap.Service<AppConfig, AppConfigShape>()(
  "copilotx/AppConfig",
  {
    make: Effect.gen(function* loadAppConfig() {
      return yield* configSchema;
    }),
  }
) {
  static readonly Default = Layer.effect(this, this.make);
}
