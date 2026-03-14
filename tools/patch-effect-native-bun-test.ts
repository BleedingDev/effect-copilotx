import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const rootPackagePath = resolve(
  "node_modules/@effect-native/bun-test/package.json"
);
const indexPackagePath = resolve(
  "node_modules/@effect-native/bun-test/index/package.json"
);
const drizzleQueryEffectJsPath = resolve(
  "node_modules/drizzle-orm/effect-core/query-effect.js"
);
const drizzleQueryEffectCjsPath = resolve(
  "node_modules/drizzle-orm/effect-core/query-effect.cjs"
);
const drizzleErrorsJsPath = resolve(
  "node_modules/drizzle-orm/effect-core/errors.js"
);
const drizzleErrorsCjsPath = resolve(
  "node_modules/drizzle-orm/effect-core/errors.cjs"
);
const drizzleLoggerJsPath = resolve(
  "node_modules/drizzle-orm/effect-core/logger.js"
);
const drizzleLoggerCjsPath = resolve(
  "node_modules/drizzle-orm/effect-core/logger.cjs"
);
const drizzleCacheEffectJsPath = resolve(
  "node_modules/drizzle-orm/cache/core/cache-effect.js"
);
const drizzleCacheEffectCjsPath = resolve(
  "node_modules/drizzle-orm/cache/core/cache-effect.cjs"
);
const drizzleEffectPostgresSessionJsPath = resolve(
  "node_modules/drizzle-orm/effect-postgres/session.js"
);
const drizzleEffectPostgresSessionCjsPath = resolve(
  "node_modules/drizzle-orm/effect-postgres/session.cjs"
);
const drizzlePgCoreSessionJsPath = resolve(
  "node_modules/drizzle-orm/pg-core/effect/session.js"
);
const drizzlePgCoreSessionCjsPath = resolve(
  "node_modules/drizzle-orm/pg-core/effect/session.cjs"
);

const drizzleQueryEffectJsPatched = `import { pipeArguments } from "effect/Pipeable";
import { SingleShotGen } from "effect/Utils";

const EffectTypeId = "~effect/Effect";
const identifier = EffectTypeId + "/identifier";
const evaluate = EffectTypeId + "/evaluate";
const identity = (value) => value;
const effectVariance = {
  _A: identity,
  _E: identity,
  _R: identity,
};

//#region src/effect-core/query-effect.ts
function applyEffectWrapper(baseClass) {
  Object.assign(baseClass.prototype, {
    [EffectTypeId]: effectVariance,
    [identifier]: "DrizzleQuery",
    [evaluate]() {
      return this.execute();
    },
    [Symbol.iterator]() {
      return new SingleShotGen(this);
    },
    asEffect() {
      return this;
    },
    pipe() {
      return pipeArguments(this, arguments);
    },
  });
  baseClass.prototype.commit = function() {
    return this.execute();
  };
}

//#endregion
export { applyEffectWrapper };
`;

const drizzleQueryEffectCjsPatched = `const { pipeArguments } = require("effect/Pipeable");
const { SingleShotGen } = require("effect/Utils");

const EffectTypeId = "~effect/Effect";
const identifier = EffectTypeId + "/identifier";
const evaluate = EffectTypeId + "/evaluate";
const identity = (value) => value;
const effectVariance = {
  _A: identity,
  _E: identity,
  _R: identity,
};

//#region src/effect-core/query-effect.ts
function applyEffectWrapper(baseClass) {
  Object.assign(baseClass.prototype, {
    [EffectTypeId]: effectVariance,
    [identifier]: "DrizzleQuery",
    [evaluate]() {
      return this.execute();
    },
    [Symbol.iterator]() {
      return new SingleShotGen(this);
    },
    asEffect() {
      return this;
    },
    pipe() {
      return pipeArguments(this, arguments);
    },
  });
  baseClass.prototype.commit = function() {
    return this.execute();
  };
}

//#endregion
exports.applyEffectWrapper = applyEffectWrapper;
`;

const drizzleLoggerJsPatched = `import { entityKind } from "../entity.js";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Service } from "effect/ServiceMap";

const defaultLogger = {
  logQuery: (_query, _params) => Effect.void,
};

//#region src/effect-core/logger.ts
class EffectLogger extends Service()("drizzle-orm/EffectLogger") {
  static [entityKind] = "EffectLogger";
  static Default = Layer.succeed(EffectLogger, defaultLogger);
  static fromDrizzle(logger) {
    return {
      logQuery: (query, params) => Effect.sync(() => logger.logQuery(query, params)),
    };
  }
  static layerFromDrizzle(logger) {
    return Layer.succeed(EffectLogger, EffectLogger.fromDrizzle(logger));
  }
  static layer = Layer.succeed(EffectLogger, {
    logQuery: Effect.fn("EffectLogger.logQuery")(function* (query, params) {
      const stringifiedParams = params.map((p) => {
        try {
          return JSON.stringify(p);
        } catch {
          return String(p);
        }
      });
      yield* Effect.log().pipe(
        Effect.annotateLogs({
          params: stringifiedParams,
          query,
        })
      );
    }),
  });
  static logQuery(query, params) {
    return this.use((logger) => logger.logQuery(query, params));
  }
}

//#endregion
export { EffectLogger };
`;

const drizzleLoggerCjsPatched = `const require_rolldown_runtime = require("../_virtual/rolldown_runtime.cjs");
let __entity_ts = require("../entity.cjs");
let effect_Effect = require("effect/Effect");
effect_Effect = require_rolldown_runtime.__toESM(effect_Effect);
let effect_Layer = require("effect/Layer");
effect_Layer = require_rolldown_runtime.__toESM(effect_Layer);
let effect_ServiceMap = require("effect/ServiceMap");
effect_ServiceMap = require_rolldown_runtime.__toESM(effect_ServiceMap);

const defaultLogger = {
  logQuery: (_query, _params) => effect_Effect.void,
};

//#region src/effect-core/logger.ts
class EffectLogger extends effect_ServiceMap.Service()("drizzle-orm/EffectLogger") {
  static [__entity_ts.entityKind] = "EffectLogger";
  static Default = effect_Layer.succeed(EffectLogger, defaultLogger);
  static fromDrizzle(logger) {
    return {
      logQuery: (query, params) => effect_Effect.sync(() => logger.logQuery(query, params)),
    };
  }
  static layerFromDrizzle(logger) {
    return effect_Layer.succeed(EffectLogger, EffectLogger.fromDrizzle(logger));
  }
  static layer = effect_Layer.succeed(EffectLogger, {
    logQuery: effect_Effect.fn("EffectLogger.logQuery")(function* (query, params) {
      const stringifiedParams = params.map((p) => {
        try {
          return JSON.stringify(p);
        } catch {
          return String(p);
        }
      });
      yield* effect_Effect.log().pipe(
        effect_Effect.annotateLogs({
          params: stringifiedParams,
          query,
        })
      );
    }),
  });
  static logQuery(query, params) {
    return this.use((logger) => logger.logQuery(query, params));
  }
}

//#endregion
exports.EffectLogger = EffectLogger;
`;

const drizzleCacheEffectJsPatched = `import { NoopCache } from "./cache.js";
import { entityKind } from "../../entity.js";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { TaggedErrorClass, Unknown } from "effect/Schema";
import { Service } from "effect/ServiceMap";

//#region src/cache/core/cache-effect.ts
class EffectCache extends Service()("drizzle-orm/EffectCache") {
  static [entityKind] = "EffectCache";
  static Default = Layer.succeed(EffectCache, make(new NoopCache()));
  static fromDrizzle(cache) {
    return make(cache);
  }
  static layerFromDrizzle(cache) {
    return Layer.succeed(EffectCache, EffectCache.fromDrizzle(cache));
  }
}
function make(cache) {
  const strategy = () => cache.strategy();
  const get = (...args) => Effect.tryPromise({
    catch: (error) => new EffectCacheError({ cause: error }),
    try: () => cache.get(...args),
  });
  const put = (...args) => Effect.tryPromise({
    catch: (error) => new EffectCacheError({ cause: error }),
    try: () => cache.put(...args),
  });
  const onMutate = (params) => Effect.tryPromise({
    catch: (error) => new EffectCacheError({ cause: error }),
    try: () => cache.onMutate(params),
  });
  return {
    strategy,
    get,
    put,
    onMutate,
    cache,
  };
}
class EffectCacheError extends TaggedErrorClass()("EffectCacheError", {
  cause: Unknown,
}) {
  static [entityKind] = "EffectCacheError";
}

//#endregion
export { EffectCache, EffectCacheError };
`;

const drizzleCacheEffectCjsPatched = `const require_rolldown_runtime = require("../../_virtual/rolldown_runtime.cjs");
const require_cache_core_cache = require("./cache.cjs");
let __entity_ts = require("../../entity.cjs");
let effect_Effect = require("effect/Effect");
effect_Effect = require_rolldown_runtime.__toESM(effect_Effect);
let effect_Layer = require("effect/Layer");
effect_Layer = require_rolldown_runtime.__toESM(effect_Layer);
let effect_Schema = require("effect/Schema");
effect_Schema = require_rolldown_runtime.__toESM(effect_Schema);
let effect_ServiceMap = require("effect/ServiceMap");
effect_ServiceMap = require_rolldown_runtime.__toESM(effect_ServiceMap);

//#region src/cache/core/cache-effect.ts
class EffectCache extends effect_ServiceMap.Service()("drizzle-orm/EffectCache") {
  static [__entity_ts.entityKind] = "EffectCache";
  static Default = effect_Layer.succeed(
    EffectCache,
    make(new require_cache_core_cache.NoopCache())
  );
  static fromDrizzle(cache) {
    return make(cache);
  }
  static layerFromDrizzle(cache) {
    return effect_Layer.succeed(EffectCache, EffectCache.fromDrizzle(cache));
  }
}
function make(cache) {
  const strategy = () => cache.strategy();
  const get = (...args) => effect_Effect.tryPromise({
    catch: (error) => new EffectCacheError({ cause: error }),
    try: () => cache.get(...args),
  });
  const put = (...args) => effect_Effect.tryPromise({
    catch: (error) => new EffectCacheError({ cause: error }),
    try: () => cache.put(...args),
  });
  const onMutate = (params) => effect_Effect.tryPromise({
    catch: (error) => new EffectCacheError({ cause: error }),
    try: () => cache.onMutate(params),
  });
  return {
    strategy,
    get,
    put,
    onMutate,
    cache,
  };
}
class EffectCacheError extends effect_Schema.TaggedErrorClass()("EffectCacheError", {
  cause: effect_Schema.Unknown,
}) {
  static [__entity_ts.entityKind] = "EffectCacheError";
}

//#endregion
exports.EffectCache = EffectCache;
exports.EffectCacheError = EffectCacheError;
`;

const patchJsonFile = async (
  path: string,
  mutate: (value: Record<string, unknown>) => Record<string, unknown>
) => {
  const source = await readFile(path, "utf8");
  const nextValue = mutate(JSON.parse(source) as Record<string, unknown>);
  await writeFile(path, `${JSON.stringify(nextValue, null, 2)}\n`, "utf8");
};

const patchTextFile = async (
  path: string,
  nextSource: string,
  legacyNeedle: string
) => {
  const source = await readFile(path, "utf8");
  if (source === nextSource) {
    return;
  }

  if (!source.includes(legacyNeedle)) {
    throw new Error(`Refusing to patch unexpected file contents at ${path}`);
  }

  await writeFile(path, nextSource, "utf8");
};

const replaceTextInFile = async (
  path: string,
  searchValue: string,
  replaceValue: string
) => {
  const source = await readFile(path, "utf8");
  if (!source.includes(searchValue)) {
    if (source.includes(replaceValue)) {
      return;
    }

    throw new Error(`Refusing to patch unexpected file contents at ${path}`);
  }

  await writeFile(path, source.replaceAll(searchValue, replaceValue), "utf8");
};

await patchJsonFile(rootPackagePath, (pkg) => {
  const exportsField = (pkg.exports ?? {}) as Record<
    string,
    Record<string, string>
  >;

  const patchedRoot = {
    ...exportsField["."],
    default: "./dist/cjs/src/index.js",
    import: "./dist/esm/src/index.js",
    types: "./dist/dts/src/index.d.ts",
  };

  const patchedIndex = {
    ...exportsField["./index"],
    default: "./dist/cjs/src/index.js",
    import: "./dist/esm/src/index.js",
    types: "./dist/dts/src/index.d.ts",
  };

  const patchedTypes = {
    ...exportsField["./types"],
    default: "./dist/cjs/src/types.js",
    import: "./dist/esm/src/types.js",
    types: "./dist/dts/src/types.d.ts",
  };

  return {
    ...pkg,
    exports: {
      ...exportsField,
      ".": patchedRoot,
      "./index": patchedIndex,
      "./types": patchedTypes,
    },
    main: "./dist/cjs/src/index.js",
    module: "./dist/esm/src/index.js",
    types: "./dist/dts/src/index.d.ts",
  };
});

await patchJsonFile(indexPackagePath, (pkg) => ({
  ...pkg,
  main: "../dist/cjs/src/index.js",
  module: "../dist/esm/src/index.js",
  types: "../dist/dts/src/index.d.ts",
}));

await patchTextFile(
  drizzleQueryEffectJsPath,
  drizzleQueryEffectJsPatched,
  "effect/Effectable"
);

await patchTextFile(
  drizzleQueryEffectCjsPath,
  drizzleQueryEffectCjsPatched,
  "effect/Effectable"
);

await replaceTextInFile(
  drizzleErrorsJsPath,
  "TaggedError()",
  "TaggedErrorClass()"
);

await replaceTextInFile(
  drizzleErrorsCjsPath,
  "TaggedError()",
  "TaggedErrorClass()"
);

await patchTextFile(
  drizzleLoggerJsPath,
  drizzleLoggerJsPatched,
  "Effect.Service()"
);

await patchTextFile(
  drizzleLoggerCjsPath,
  drizzleLoggerCjsPatched,
  "effect_Effect.Service()"
);

await patchTextFile(
  drizzleCacheEffectJsPath,
  drizzleCacheEffectJsPatched,
  "Effect.Service()"
);

await patchTextFile(
  drizzleCacheEffectCjsPath,
  drizzleCacheEffectCjsPatched,
  "effect_Effect.Service()"
);


await replaceTextInFile(
  drizzleEffectPostgresSessionJsPath,
  `\texecute(placeholderValues) {
		return Effect.gen(this, function* () {
			if (this.isRqbV2Query) return yield* this.executeRqbV2(placeholderValues);
			const { query, customResultMapper, fields, joinsNotNullableMap, client } = this;
			const params = fillPlaceholders(query.params, placeholderValues ?? {});
			yield* EffectLogger.logQuery(query.sql, params);
			if (!fields && !customResultMapper) return yield* this.queryWithCache(query.sql, params, this.client.unsafe(query.sql, params).withoutTransform);
			return yield* this.queryWithCache(query.sql, params, client.unsafe(query.sql, params).values).pipe(Effect.map((rows) => {
				if (customResultMapper) return customResultMapper(rows);
				return rows.map((row) => mapResultRow(fields, row, joinsNotNullableMap));
			}));
		}).pipe(Effect.provideService(EffectLogger, this.logger));
	}` ,
  `\texecute(placeholderValues) {
		const self = this;
		return Effect.gen(function* () {
			if (self.isRqbV2Query) return yield* self.executeRqbV2(placeholderValues);
			const { query, customResultMapper, fields, joinsNotNullableMap, client } = self;
			const params = fillPlaceholders(query.params, placeholderValues ?? {});
			yield* EffectLogger.logQuery(query.sql, params);
			if (!fields && !customResultMapper) return yield* self.queryWithCache(query.sql, params, self.client.unsafe(query.sql, params).withoutTransform);
			return yield* self.queryWithCache(query.sql, params, client.unsafe(query.sql, params).values).pipe(Effect.map((rows) => {
				if (customResultMapper) return customResultMapper(rows);
				return rows.map((row) => mapResultRow(fields, row, joinsNotNullableMap));
			}));
		}).pipe(Effect.provideService(EffectLogger, self.logger));
	}`
);

await replaceTextInFile(
  drizzleEffectPostgresSessionJsPath,
  `\texecuteRqbV2(placeholderValues) {
		return Effect.gen(this, function* () {
			const { query, customResultMapper, client } = this;
			const params = fillPlaceholders(query.params, placeholderValues ?? {});
			yield* EffectLogger.logQuery(query.sql, params);
			return yield* client.unsafe(query.sql, params).withoutTransform.pipe(Effect.flatMap((v) => Effect.try(() => customResultMapper(v))), Effect.catchAll((e) => new EffectDrizzleQueryError({
				query: query.sql,
				params,
				cause: e
			})));
		}).pipe(Effect.provideService(EffectLogger, this.logger));
	}` ,
  `\texecuteRqbV2(placeholderValues) {
		const self = this;
		return Effect.gen(function* () {
			const { query, customResultMapper, client } = self;
			const params = fillPlaceholders(query.params, placeholderValues ?? {});
			yield* EffectLogger.logQuery(query.sql, params);
			return yield* client.unsafe(query.sql, params).withoutTransform.pipe(Effect.flatMap((v) => Effect.try(() => customResultMapper(v))), Effect.catch((e) => new EffectDrizzleQueryError({
				query: query.sql,
				params,
				cause: e
			})));
		}).pipe(Effect.provideService(EffectLogger, self.logger));
	}`
);

await replaceTextInFile(
  drizzleEffectPostgresSessionJsPath,
  `\tall(placeholderValues) {
		return Effect.gen(this, function* () {
			const { query, client } = this;
			const params = fillPlaceholders(query.params, placeholderValues ?? {});
			yield* EffectLogger.logQuery(query.sql, params);
			return yield* this.queryWithCache(query.sql, params, client.unsafe(query.sql, params).withoutTransform);
		}).pipe(Effect.provideService(EffectLogger, this.logger));
	}` ,
  `\tall(placeholderValues) {
		const self = this;
		return Effect.gen(function* () {
			const { query, client } = self;
			const params = fillPlaceholders(query.params, placeholderValues ?? {});
			yield* EffectLogger.logQuery(query.sql, params);
			return yield* self.queryWithCache(query.sql, params, client.unsafe(query.sql, params).withoutTransform);
		}).pipe(Effect.provideService(EffectLogger, self.logger));
	}`
);

await replaceTextInFile(
  drizzleEffectPostgresSessionJsPath,
  `\ttransaction(transaction) {
		const { dialect, relations, schema } = this;
		return this.client.withTransaction(Effect.gen(this, function* () {
			return yield* transaction(new EffectPgTransaction(dialect, this, relations, schema));
		}));
	}` ,
  `\ttransaction(transaction) {
		const self = this;
		const { dialect, relations, schema } = self;
		return self.client.withTransaction(Effect.gen(function* () {
			return yield* transaction(new EffectPgTransaction(dialect, self, relations, schema));
		}));
	}`
);

await replaceTextInFile(
  drizzleEffectPostgresSessionCjsPath,
  `\texecute(placeholderValues) {
		return effect_Effect.gen(this, function* () {
			if (this.isRqbV2Query) return yield* this.executeRqbV2(placeholderValues);
			const { query, customResultMapper, fields, joinsNotNullableMap, client } = this;
			const params = (0, __sql_sql_ts.fillPlaceholders)(query.params, placeholderValues ?? {});
			yield* __effect_core_logger_ts.EffectLogger.logQuery(query.sql, params);
			if (!fields && !customResultMapper) return yield* this.queryWithCache(query.sql, params, this.client.unsafe(query.sql, params).withoutTransform);
			return yield* this.queryWithCache(query.sql, params, client.unsafe(query.sql, params).values).pipe(effect_Effect.map((rows) => {
				if (customResultMapper) return customResultMapper(rows);
				return rows.map((row) => (0, __utils_ts.mapResultRow)(fields, row, joinsNotNullableMap));
			}));
		}).pipe(effect_Effect.provideService(__effect_core_logger_ts.EffectLogger, this.logger));
	}` ,
  `\texecute(placeholderValues) {
		const self = this;
		return effect_Effect.gen(function* () {
			if (self.isRqbV2Query) return yield* self.executeRqbV2(placeholderValues);
			const { query, customResultMapper, fields, joinsNotNullableMap, client } = self;
			const params = (0, __sql_sql_ts.fillPlaceholders)(query.params, placeholderValues ?? {});
			yield* __effect_core_logger_ts.EffectLogger.logQuery(query.sql, params);
			if (!fields && !customResultMapper) return yield* self.queryWithCache(query.sql, params, self.client.unsafe(query.sql, params).withoutTransform);
			return yield* self.queryWithCache(query.sql, params, client.unsafe(query.sql, params).values).pipe(effect_Effect.map((rows) => {
				if (customResultMapper) return customResultMapper(rows);
				return rows.map((row) => (0, __utils_ts.mapResultRow)(fields, row, joinsNotNullableMap));
			}));
		}).pipe(effect_Effect.provideService(__effect_core_logger_ts.EffectLogger, self.logger));
	}`
 );

await replaceTextInFile(
  drizzleEffectPostgresSessionCjsPath,
  `\texecuteRqbV2(placeholderValues) {
		return effect_Effect.gen(this, function* () {
			const { query, customResultMapper, client } = this;
			const params = (0, __sql_sql_ts.fillPlaceholders)(query.params, placeholderValues ?? {});
			yield* __effect_core_logger_ts.EffectLogger.logQuery(query.sql, params);
			return yield* client.unsafe(query.sql, params).withoutTransform.pipe(effect_Effect.flatMap((v) => effect_Effect.try(() => customResultMapper(v))), effect_Effect.catchAll((e) => new __effect_core_errors_ts.EffectDrizzleQueryError({
				query: query.sql,
				params,
				cause: e
			})));
		}).pipe(effect_Effect.provideService(__effect_core_logger_ts.EffectLogger, this.logger));
	}` ,
  `\texecuteRqbV2(placeholderValues) {
		const self = this;
		return effect_Effect.gen(function* () {
			const { query, customResultMapper, client } = self;
			const params = (0, __sql_sql_ts.fillPlaceholders)(query.params, placeholderValues ?? {});
			yield* __effect_core_logger_ts.EffectLogger.logQuery(query.sql, params);
			return yield* client.unsafe(query.sql, params).withoutTransform.pipe(effect_Effect.flatMap((v) => effect_Effect.try(() => customResultMapper(v))), effect_Effect.catch((e) => new __effect_core_errors_ts.EffectDrizzleQueryError({
				query: query.sql,
				params,
				cause: e
			})));
		}).pipe(effect_Effect.provideService(__effect_core_logger_ts.EffectLogger, self.logger));
	}`
 );

await replaceTextInFile(
  drizzleEffectPostgresSessionCjsPath,
  `\tall(placeholderValues) {
		return effect_Effect.gen(this, function* () {
			const { query, client } = this;
			const params = (0, __sql_sql_ts.fillPlaceholders)(query.params, placeholderValues ?? {});
			yield* __effect_core_logger_ts.EffectLogger.logQuery(query.sql, params);
			return yield* this.queryWithCache(query.sql, params, client.unsafe(query.sql, params).withoutTransform);
		}).pipe(effect_Effect.provideService(__effect_core_logger_ts.EffectLogger, this.logger));
	}` ,
  `\tall(placeholderValues) {
		const self = this;
		return effect_Effect.gen(function* () {
			const { query, client } = self;
			const params = (0, __sql_sql_ts.fillPlaceholders)(query.params, placeholderValues ?? {});
			yield* __effect_core_logger_ts.EffectLogger.logQuery(query.sql, params);
			return yield* self.queryWithCache(query.sql, params, client.unsafe(query.sql, params).withoutTransform);
		}).pipe(effect_Effect.provideService(__effect_core_logger_ts.EffectLogger, self.logger));
	}`
 );

await replaceTextInFile(
  drizzleEffectPostgresSessionCjsPath,
  `\ttransaction(transaction) {
		const { dialect, relations, schema } = this;
		return this.client.withTransaction(effect_Effect.gen(this, function* () {
			return yield* transaction(new EffectPgTransaction(dialect, this, relations, schema));
		}));
	}` ,
  `\ttransaction(transaction) {
		const self = this;
		const { dialect, relations, schema } = self;
		return self.client.withTransaction(effect_Effect.gen(function* () {
			return yield* transaction(new EffectPgTransaction(dialect, self, relations, schema));
		}));
	}`
 );

await replaceTextInFile(
  drizzlePgCoreSessionJsPath,
  `\tqueryWithCache(queryString, params, query) {
		return Effect.gen(this, function* () {
			const { cacheConfig, queryMetadata } = this;
			const cache = yield* EffectCache;
			const cacheStrat = cache && !is(cache.cache, NoopCache) ? yield* Effect.tryPromise(() => strategyFor(queryString, params, queryMetadata, cacheConfig)) : { type: "skip" };
			if (cacheStrat.type === "skip") return yield* query;
			if (cacheStrat.type === "invalidate") {
				const result = yield* query;
				yield* cache.onMutate({ tables: cacheStrat.tables });
				return result;
			}
			if (cacheStrat.type === "try") {
				const { tables, key, isTag, autoInvalidate, config } = cacheStrat;
				const fromCache = yield* cache.get(key, tables, isTag, autoInvalidate);
				if (typeof fromCache !== "undefined") return fromCache;
				const result = yield* query;
				yield* cache.put(key, result, autoInvalidate ? tables : [], isTag, config);
				return result;
			}
			assertUnreachable(cacheStrat);
		}).pipe(Effect.provideService(EffectCache, this.cache), Effect.catchAll((e) => {
			return new EffectDrizzleQueryError({
				query: queryString,
				params,
				cause: Cause.fail(e)
			});
		}));
	}` ,
  `\tqueryWithCache(queryString, params, query) {
		const self = this;
		return Effect.gen(function* () {
			const { cacheConfig, queryMetadata } = self;
			const cache = yield* EffectCache;
			const cacheStrat = cache && !is(cache.cache, NoopCache) ? yield* Effect.tryPromise(() => strategyFor(queryString, params, queryMetadata, cacheConfig)) : { type: "skip" };
			if (cacheStrat.type === "skip") return yield* query;
			if (cacheStrat.type === "invalidate") {
				const result = yield* query;
				yield* cache.onMutate({ tables: cacheStrat.tables });
				return result;
			}
			if (cacheStrat.type === "try") {
				const { tables, key, isTag, autoInvalidate, config } = cacheStrat;
				const fromCache = yield* cache.get(key, tables, isTag, autoInvalidate);
				if (typeof fromCache !== "undefined") return fromCache;
				const result = yield* query;
				yield* cache.put(key, result, autoInvalidate ? tables : [], isTag, config);
				return result;
			}
			assertUnreachable(cacheStrat);
		}).pipe(Effect.provideService(EffectCache, self.cache), Effect.catch((e) => {
			return new EffectDrizzleQueryError({
				query: queryString,
				params,
				cause: Cause.fail(e)
			});
		}));
	}`
 );

await replaceTextInFile(
  drizzlePgCoreSessionCjsPath,
  `\tqueryWithCache(queryString, params, query) {
		return effect_Effect.gen(this, function* () {
			const { cacheConfig, queryMetadata } = this;
			const cache = yield* __cache_core_cache_effect_ts.EffectCache;
			const cacheStrat = cache && !(0, __entity_ts.is)(cache.cache, __cache_core_cache_ts.NoopCache) ? yield* effect_Effect.tryPromise(() => (0, __cache_core_cache_ts.strategyFor)(queryString, params, queryMetadata, cacheConfig)) : { type: "skip" };
			if (cacheStrat.type === "skip") return yield* query;
			if (cacheStrat.type === "invalidate") {
				const result = yield* query;
				yield* cache.onMutate({ tables: cacheStrat.tables });
				return result;
			}
			if (cacheStrat.type === "try") {
				const { tables, key, isTag, autoInvalidate, config } = cacheStrat;
				const fromCache = yield* cache.get(key, tables, isTag, autoInvalidate);
				if (typeof fromCache !== "undefined") return fromCache;
				const result = yield* query;
				yield* cache.put(key, result, autoInvalidate ? tables : [], isTag, config);
				return result;
			}
			(0, __utils_ts.assertUnreachable)(cacheStrat);
		}).pipe(effect_Effect.provideService(__cache_core_cache_effect_ts.EffectCache, this.cache), effect_Effect.catchAll((e) => {
			return new __effect_core_errors_ts.EffectDrizzleQueryError({
				query: queryString,
				params,
				cause: effect_Cause.fail(e)
			});
		}));
	}` ,
  `\tqueryWithCache(queryString, params, query) {
		const self = this;
		return effect_Effect.gen(function* () {
			const { cacheConfig, queryMetadata } = self;
			const cache = yield* __cache_core_cache_effect_ts.EffectCache;
			const cacheStrat = cache && !(0, __entity_ts.is)(cache.cache, __cache_core_cache_ts.NoopCache) ? yield* effect_Effect.tryPromise(() => (0, __cache_core_cache_ts.strategyFor)(queryString, params, queryMetadata, cacheConfig)) : { type: "skip" };
			if (cacheStrat.type === "skip") return yield* query;
			if (cacheStrat.type === "invalidate") {
				const result = yield* query;
				yield* cache.onMutate({ tables: cacheStrat.tables });
				return result;
			}
			if (cacheStrat.type === "try") {
				const { tables, key, isTag, autoInvalidate, config } = cacheStrat;
				const fromCache = yield* cache.get(key, tables, isTag, autoInvalidate);
				if (typeof fromCache !== "undefined") return fromCache;
				const result = yield* query;
				yield* cache.put(key, result, autoInvalidate ? tables : [], isTag, config);
				return result;
			}
			(0, __utils_ts.assertUnreachable)(cacheStrat);
		}).pipe(effect_Effect.provideService(__cache_core_cache_effect_ts.EffectCache, self.cache), effect_Effect.catch((e) => {
			return new __effect_core_errors_ts.EffectDrizzleQueryError({
				query: queryString,
				params,
				cause: effect_Cause.fail(e)
			});
		}));
	}`
 );