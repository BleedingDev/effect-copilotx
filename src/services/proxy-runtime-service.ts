import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ServiceMap from "effect/ServiceMap";

import type {
  ProxyRuntime,
  RuntimeModelDescriptor,
} from "#/domain/models/runtime-types";
import { AccountRepository } from "#/services/account-repository";
import { AppConfig } from "#/services/app-config";
import { CopilotClient } from "#/services/copilot-client";
import { GitHubCopilotAuth } from "#/services/github-copilot-auth";
import { makeProxyRuntime } from "#/services/proxy-runtime";

const describeError = (error: unknown) =>
  error instanceof Error ? error.message : `Unexpected error: ${String(error)}`;

const toRuntimeModelDescriptors = (
  models: readonly {
    readonly id?: string;
    readonly model_picker_enabled?: boolean;
    readonly vendor?: string;
  }[]
): readonly RuntimeModelDescriptor[] =>
  models.flatMap((model) => {
    const modelId = typeof model.id === "string" ? model.id.trim() : "";
    if (modelId.length === 0) {
      return [];
    }

    return [
      {
        hidden: model.model_picker_enabled === false,
        id: modelId,
        vendor: typeof model.vendor === "string" ? model.vendor : "",
      },
    ];
  });

export class ProxyRuntimeService extends ServiceMap.Service<
  ProxyRuntimeService,
  ProxyRuntime
>()("copilotx/ProxyRuntimeService", {
  make: Effect.gen(function* makeProxyRuntimeService() {
    const accountRepository = yield* AccountRepository;
    const appConfig = yield* AppConfig;
    const auth = yield* GitHubCopilotAuth;

    const createClient = (copilotToken: string, apiBaseUrl: string) =>
      new CopilotClient(copilotToken, {
        apiBaseUrl,
        forcedModelIds: appConfig.security.forceModels,
        modelCacheTtlSeconds: appConfig.upstream.modelCacheTtlSeconds,
        requestTimeoutMs: appConfig.runtime.requestTimeoutMs,
      });

    return makeProxyRuntime({
      hooks: {
        listAccountModels: ({ account }) =>
          Effect.tryPromise({
            catch: (error) => new Error(describeError(error), { cause: error }),
            try: async () => {
              const client = createClient(
                account.copilotToken,
                account.apiBaseUrl
              );
              const models = await client.listModels();
              return toRuntimeModelDescriptors(models);
            },
          }),
        refreshAccount: ({ account }) =>
          auth.fetchCopilotToken(account.githubToken),
      },
      repository: accountRepository,
      scheduler: {
        tokenRefreshBufferSeconds: appConfig.upstream.tokenRefreshBufferSeconds,
      },
    });
  }),
}) {
  static readonly Default = Layer.effect(this, this.make).pipe(
    Layer.provideMerge(AccountRepository.Default),
    Layer.provideMerge(AppConfig.Default),
    Layer.provideMerge(GitHubCopilotAuth.Default)
  );
}
