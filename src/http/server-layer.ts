import { BunHttpServer } from "@effect/platform-bun";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/unstable/http/HttpRouter";

import { adminRoutes } from "#/http/routes/admin-routes";
import { anthropicRoutes } from "#/http/routes/anthropic-routes";
import { authRoutes } from "#/http/routes/auth-routes";
import { baseRoutes } from "#/http/routes/base-routes";
import { modelRoutes } from "#/http/routes/models-routes";
import { openAiRoutes } from "#/http/routes/openai-routes";
import { AccountRepository } from "#/services/account-repository";
import { AppConfig } from "#/services/app-config";
import { GitHubCopilotAuth } from "#/services/github-copilot-auth";
import { ProxyRuntimeService } from "#/services/proxy-runtime-service";

export interface ServerListenOptions {
  readonly host: string;
  readonly port: number;
  readonly portExplicit?: boolean;
}

const routeLayers = Layer.mergeAll(
  ...baseRoutes,
  ...adminRoutes,
  ...authRoutes,
  ...modelRoutes,
  ...openAiRoutes,
  ...anthropicRoutes
);

export const makeServerLayer = ({ host, port }: ServerListenOptions) =>
  HttpRouter.serve(routeLayers, {
    disableListenLog: false,
    disableLogger: false,
  }).pipe(
    Layer.provideMerge(AppConfig.Default),
    Layer.provideMerge(AccountRepository.Default),
    Layer.provideMerge(GitHubCopilotAuth.Default),
    Layer.provideMerge(ProxyRuntimeService.Default),
    Layer.provide(
      BunHttpServer.layer({
        hostname: host,
        idleTimeout: 0,
        port,
      })
    )
  );
