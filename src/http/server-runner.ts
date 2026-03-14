import { fileURLToPath } from "node:url";

import { migrate } from "drizzle-orm/effect-postgres/migrator";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { makeServerLayer, type ServerListenOptions } from "#/http/server-layer";
import { AppConfig } from "#/services/app-config";
import { Database } from "#/services/database";

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

export const runServer = (options: ServerListenOptions) =>
  Effect.gen(function* runServerEffect() {
    yield* applyStartupMigrations().pipe(Effect.provide(Database.Default));
    return yield* Layer.launch(makeServerLayer(options)).pipe(Effect.asVoid);
  });

export const runConfiguredServer = Effect.gen(function* runConfiguredServerEffect() {
  const config = yield* AppConfig;
  return yield* runServer({
    host: config.runtime.host,
    port: config.runtime.port,
  });
}).pipe(Effect.provide(AppConfig.Default));
