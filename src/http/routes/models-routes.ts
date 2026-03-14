import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/unstable/http/HttpRouter";

import {
  authorizeRequest,
  currentUnixSeconds,
  jsonResponse,
  openAiErrorResponse,
} from "#/http/http-helpers";
import { AppConfig } from "#/services/app-config";
import { ProxyRuntimeService } from "#/services/proxy-runtime-service";

const listModelsRoute = HttpRouter.add("GET", "/v1/models", (request) =>
  Effect.gen(function* listModelsRoute() {
    const config = yield* AppConfig;
    const unauthorized = authorizeRequest(request, config);
    if (unauthorized !== null) {
      return unauthorized;
    }

    const runtime = yield* ProxyRuntimeService;

    return yield* runtime.listModels().pipe(
      Effect.map((models) =>
        jsonResponse(request, config, {
          object: "list",
          data: models.map((model) => ({
            created: currentUnixSeconds(),
            id: model.id,
            object: "model",
            owned_by: model.vendor?.trim() || "github-copilot",
          })),
        })
      ),
      Effect.catch((error) =>
        Effect.succeed(openAiErrorResponse(request, config, error)))
    );
  })
);

export const modelRoutes = [listModelsRoute] as const;
