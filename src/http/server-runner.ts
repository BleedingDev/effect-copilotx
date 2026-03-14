import { fileURLToPath } from "node:url";

import { migrate } from "drizzle-orm/effect-postgres/migrator";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { makeServerLayer, type ServerListenOptions } from "#/http/server-layer";
import { AppConfig } from "#/services/app-config";
import { Database } from "#/services/database";
import { resolveListenOptions } from "#/services/port-selection";
import { cleanupServerInfo, writeServerInfo } from "#/services/server-discovery";

const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));

const applyStartupMigrations = Effect.fn("ServerRunner.applyStartupMigrations")(
  function* applyStartupMigrations() {
    const db = yield* Database;
    yield* migrate(db, { migrationsFolder }).pipe(
      Effect.mapError(
        (error) =>
          new Error(
            `Failed to apply database migrations from ${migrationsFolder}: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error }
          )
      )
    );
  }
);

const resolveServerOptions = (options: ServerListenOptions) =>
  Effect.tryPromise({
    try: async () =>
      resolveListenOptions({
        host: options.host,
        port: options.port,
        portExplicit: options.portExplicit ?? false,
      }),
    catch: (error) => new Error(`Failed to resolve server listen options: ${String(error)}`, {
      cause: error,
    }),
  });

const writeServerInfoEffect = (options: {
  readonly host: string;
  readonly port: number;
  readonly publicUrl: string | null;
}) =>
  Effect.tryPromise({
    try: async () =>
      writeServerInfo({
        host: options.host,
        port: options.port,
        publicUrl: options.publicUrl,
      }),
    catch: (error) => new Error(`Failed to write server discovery file: ${String(error)}`, {
      cause: error,
    }),
  });

const cleanupServerInfoEffect = Effect.tryPromise({
  try: async () => {
    await cleanupServerInfo(undefined, process.pid);
  },
  catch: (error) => new Error(`Failed to clean server discovery file: ${String(error)}`, {
    cause: error,
  }),
}).pipe(Effect.catch(() => Effect.sync(() => {})));

export const runServer = (options: ServerListenOptions) =>
  Effect.gen(function* runServerEffect() {
    const resolved = yield* resolveServerOptions(options);
    if (resolved.message !== null) {
      yield* Console.log(resolved.message);
    }

    yield* applyStartupMigrations().pipe(Effect.provide(Database.Default));
    yield* writeServerInfoEffect(resolved);

    return yield* Layer.launch(makeServerLayer(resolved)).pipe(
      Effect.asVoid,
      Effect.ensuring(cleanupServerInfoEffect)
    );
  });

export const runConfiguredServer = Effect.gen(function* runConfiguredServerEffect() {
  const config = yield* AppConfig;
  return yield* runServer({
    host: config.runtime.host,
    port: config.runtime.port,
    portExplicit: true,
  });
}).pipe(Effect.provide(AppConfig.Default));