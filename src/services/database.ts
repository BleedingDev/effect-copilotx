import * as PgClient from "@effect/sql-pg/PgClient";
import { makeWithDefaults } from "drizzle-orm/effect-postgres";
import type { EffectPgDatabase } from "drizzle-orm/effect-postgres";
import { types as pgTypes } from "pg";

import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ServiceMap from "effect/ServiceMap";
import * as Reactivity from "effect/unstable/reactivity/Reactivity";

import {
  accountModels,
  accountRuntimeStates,
  accounts,
  runtimeSettings,
} from "#/db/schema";
import { AppConfig } from "#/services/app-config";

export const drizzleSchema = {
  accountModels,
  accountRuntimeStates,
  accounts,
  runtimeSettings,
};

export type CopilotDatabase = EffectPgDatabase<typeof drizzleSchema> & {
  readonly $client: PgClient.PgClient;
};

const DATE_TIME_TYPE_IDS = new Set([
  1082, 1114, 1115, 1182, 1184, 1185, 1186, 1187, 1231,
]);

const pgTypeConfig: NonNullable<PgClient.PgClientConfig["types"]> = {
  getTypeParser: (typeId, format) => {
    if (DATE_TIME_TYPE_IDS.has(typeId)) {
      return (value: string) => value;
    }

    const parserResult: unknown = pgTypes.getTypeParser(typeId, format);

    if (typeof parserResult !== "function") {
      return (value: string) => value;
    }

    return (value: string): unknown =>
      Reflect.apply(parserResult, undefined, [value]);
  },
};

export class Database extends ServiceMap.Service<Database, CopilotDatabase>()(
  "copilotx/Database",
  {
    make: Effect.gen(function* makeDatabase() {
      const config = yield* AppConfig;
      const client = yield* PgClient.make({
        connectTimeout: Duration.millis(config.database.connectTimeoutMs),
        idleTimeout: Duration.millis(config.database.idleTimeoutMs),
        maxConnections: config.database.maxConnections,
        minConnections: config.database.minConnections,
        types: pgTypeConfig,
        url: config.database.url,
      });

      const db = yield* makeWithDefaults({ schema: drizzleSchema }).pipe(
        Effect.provideService(PgClient.PgClient, client)
      );

      return db;
    }),
  }
) {
  static readonly Default = Layer.effect(this, this.make).pipe(
    Layer.provide(AppConfig.Default),
    Layer.provide(Reactivity.layer)
  );
}
