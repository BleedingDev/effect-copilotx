import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/unstable/http/HttpRouter";

import { APP_NAME, APP_VERSION } from "#/app/app-info";
import {
  currentUnixSeconds,
  jsonResponse,
  preflightResponse,
} from "#/http/http-helpers";
import { AppConfig } from "#/services/app-config";
import { ProxyRuntimeService } from "#/services/proxy-runtime-service";

const optionsRoute = HttpRouter.add("OPTIONS", "*", (request) =>
  Effect.gen(function* optionsRoute() {
    const config = yield* AppConfig;
    return preflightResponse(request, config);
  })
);

const rootRoute = HttpRouter.add("GET", "/", (request) =>
  Effect.gen(function* rootRoute() {
    const config = yield* AppConfig;
    return jsonResponse(request, config, {
      name: APP_NAME,
      object: "service",
      started_at: currentUnixSeconds(),
      version: APP_VERSION,
    });
  })
);

const healthRoute = HttpRouter.add("GET", "/health", (request) =>
  Effect.gen(function* healthRoute() {
    const config = yield* AppConfig;
    return jsonResponse(request, config, {
      status: "ok",
      version: APP_VERSION,
    });
  })
);

const readyRoute = HttpRouter.add("GET", "/readyz", (request) =>
  Effect.gen(function* readyRoute() {
    const config = yield* AppConfig;
    const runtime = yield* ProxyRuntimeService;
    yield* runtime.startup();
    const snapshot = yield* runtime.healthSnapshot();
    const copilotReady = snapshot.authenticated && snapshot.accountsHealthy > 0;

    return jsonResponse(request, config, {
      accounts_healthy: snapshot.accountsHealthy,
      authenticated: snapshot.authenticated,
      copilot_ready: copilotReady,
      ready: true,
      status: copilotReady ? "ok" : "awaiting_authentication",
      version: APP_VERSION,
    });
  })
);

export const baseRoutes = [optionsRoute, rootRoute, healthRoute, readyRoute] as const;
