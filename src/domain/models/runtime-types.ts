import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Stream from "effect/Stream";

import type {
  AccountRecord,
  AccountRuntimePatch,
  ModelCatalogEntry,
  RotationStrategy,
} from "#/domain/accounts/account-types";

export const CHAT_COMPLETIONS_API = "chat_completions";
export const RESPONSES_API = "responses";

export const proxyApiSurfaces = [CHAT_COMPLETIONS_API, RESPONSES_API] as const;
export type ProxyApiSurface = (typeof proxyApiSurfaces)[number];

export interface RuntimeModelDescriptor {
  readonly hidden?: boolean;
  readonly id: string;
  readonly vendor?: string;
}

export interface ModelRoutingState {
  readonly chatSupported: boolean | null;
  readonly preferredApi: ProxyApiSurface | null;
  readonly responsesSupported: boolean | null;
  readonly vendor: string;
}

export interface ProxyRuntimeSchedulerOptions {
  readonly failureCooldownMs?: number;
  readonly maxRetryAttempts?: number;
  readonly rateLimitCooldownMs?: number;
  readonly singleAccountRateLimitCooldownMs?: number;
  readonly syncIntervalMs?: number;
  readonly tokenRefreshBufferSeconds?: number;
}

export interface ProxyRuntimeRefreshResult {
  readonly apiBaseUrl: string;
  readonly copilotToken: string;
  readonly copilotTokenExpiresAt: Date | null;
}

export interface ProxyRuntimeAccountRepository {
  readonly getRotationStrategy: () => Effect.Effect<RotationStrategy, unknown>;
  readonly listAccounts: (options?: {
    readonly enabledOnly?: boolean;
  }) => Effect.Effect<readonly AccountRecord[], unknown>;
  readonly markAccount: (
    accountId: string,
    patch: AccountRuntimePatch
  ) => Effect.Effect<void, unknown>;
  readonly nextRoundRobinOffset: (
    candidateCount: number
  ) => Effect.Effect<number, unknown>;
  readonly updateModels: (
    accountId: string,
    modelCatalog: readonly ModelCatalogEntry[]
  ) => Effect.Effect<void, unknown>;
  readonly updateTokens: (
    accountId: string,
    input: ProxyRuntimeRefreshResult
  ) => Effect.Effect<void, unknown>;
}

export interface ProxyRuntimeHooks {
  readonly listAccountModels?: (input: {
    readonly account: AccountRecord;
  }) => Effect.Effect<readonly RuntimeModelDescriptor[], unknown>;
  readonly refreshAccount: (input: {
    readonly account: AccountRecord;
  }) => Effect.Effect<ProxyRuntimeRefreshResult, unknown>;
}

export interface ProxyRuntimeDependencies {
  readonly hooks: ProxyRuntimeHooks;
  readonly now?: () => Date;
  readonly repository: ProxyRuntimeAccountRepository;
  readonly scheduler?: ProxyRuntimeSchedulerOptions;
}

export interface ProxyRuntimeOperationContext {
  readonly account: AccountRecord;
  readonly apiSurface: ProxyApiSurface;
  readonly attempt: number;
  readonly refreshed: boolean;
}

export interface ProxyRuntimeRequest<A, E = never, R = never> {
  readonly allowUnsupportedSurfaceFallback?: boolean;
  readonly model?: string | null;
  readonly operation: (
    context: ProxyRuntimeOperationContext
  ) => Effect.Effect<A, E, R>;
  readonly requestedApi: ProxyApiSurface;
}

export interface ProxyRuntimeStreamRequest<Chunk, E = never, R = never> {
  readonly allowUnsupportedSurfaceFallback?: boolean;
  readonly model?: string | null;
  readonly operation: (
    context: ProxyRuntimeOperationContext
  ) => Stream.Stream<Chunk, E, R>;
  readonly requestedApi: ProxyApiSurface;
}

export interface ProxyRuntimeHealthSnapshot {
  readonly accountsCoolingDown: number;
  readonly accountsEnabled: number;
  readonly accountsHealthy: number;
  readonly accountsReauthRequired: number;
  readonly accountsTotal: number;
  readonly authenticated: boolean;
  readonly strategy: RotationStrategy;
  readonly tokenExpiresInSeconds: number;
  readonly tokenValid: boolean;
}

export interface ProxyRuntime {
  readonly execute: <A, E = never, R = never>(
    request: ProxyRuntimeRequest<A, E, R>
  ) => Effect.Effect<A, unknown, R>;
  readonly healthSnapshot: () => Effect.Effect<
    ProxyRuntimeHealthSnapshot,
    unknown
  >;
  readonly listModels: () => Effect.Effect<
    readonly RuntimeModelDescriptor[],
    unknown
  >;
  readonly markApiSuccess: (
    model: string | null | undefined,
    apiSurface: ProxyApiSurface
  ) => void;
  readonly markApiUnsupported: (
    model: string | null | undefined,
    apiSurface: ProxyApiSurface
  ) => void;
  readonly observeModels: (models: readonly RuntimeModelDescriptor[]) => void;
  readonly preferredApiSurface: (
    model: string | null | undefined,
    requestedApi: ProxyApiSurface
  ) => ProxyApiSurface;
  readonly probe: <A, E = never, R = never>(
    request: ProxyRuntimeRequest<A, E, R>
  ) => Effect.Effect<A, unknown, R>;
  readonly shutdown: () => Effect.Effect<void>;
  readonly startup: () => Effect.Effect<void, unknown>;
  readonly stream: <Chunk, E = never, R = never>(
    request: ProxyRuntimeStreamRequest<Chunk, E, R>
  ) => Stream.Stream<Chunk, unknown, R>;
}

export interface ProxyRuntimeUnavailableError {
  readonly _tag: "ProxyRuntimeUnavailableError";
  readonly message: string;
}
export const ProxyRuntimeUnavailableError =
  Schema.TaggedErrorClass<ProxyRuntimeUnavailableError>()(
    "ProxyRuntimeUnavailableError",
    {
      message: Schema.String,
    }
  );

export interface ModelUnavailableError {
  readonly _tag: "ModelUnavailableError";
  readonly accountId: string;
  readonly message: string;
  readonly modelId: string;
}
export const ModelUnavailableError =
  Schema.TaggedErrorClass<ModelUnavailableError>()("ModelUnavailableError", {
    accountId: Schema.String,
    message: Schema.String,
    modelId: Schema.String,
  });

export interface UnsupportedApiSurfaceError {
  readonly _tag: "UnsupportedApiSurfaceError";
  readonly apiSurface: ProxyApiSurface;
  readonly message: string;
  readonly statusCode?: number | undefined;
  readonly upstreamCode?: string | undefined;
}
export const UnsupportedApiSurfaceError =
  Schema.TaggedErrorClass<UnsupportedApiSurfaceError>()(
    "UnsupportedApiSurfaceError",
    {
      apiSurface: Schema.Union([
        Schema.Literal(CHAT_COMPLETIONS_API),
        Schema.Literal(RESPONSES_API),
      ]),
      message: Schema.String,
      statusCode: Schema.optional(Schema.Number),
      upstreamCode: Schema.optional(Schema.String),
    }
  );
