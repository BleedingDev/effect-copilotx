import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as Stream from "effect/Stream";

import type { AccountRecord, AccountUsageDelta } from "#/domain/accounts/account-types";
import {
  CHAT_COMPLETIONS_API,
  RESPONSES_API,
} from "#/domain/models/runtime-types";
import type { AppConfigShape } from "#/services/app-config";
import {
  byteStream,
  describeError,
  jsonResponse,
  openAiErrorResponse,
  readJsonRecord,
  sseResponse,
  textEventStream,
} from "#/http/http-helpers";
import {
  extractUsageDelta,
  trackChatCompletionsStreamUsage,
  trackResponsesStreamUsage,
} from "#/http/usage-tracking";
import {
  responsesRequestHasVisionInput,
  responsesRequestInitiator,
} from "#/http/request-features";
import { fixResponsesStream } from "#/http/responses-stream";
import {
  openAiChatToResponsesRequest,
  openAiResponsesToChatRequest,
} from "#/protocol/openai/request-transforms";
import {
  openAiChatToResponsesEvents,
  openAiChatToResponsesResponse,
  openAiResponsesToChatEvents,
  openAiResponsesToChatResponse,
} from "#/protocol/openai/response-transforms";
import { authorizeRequest } from "#/http/http-helpers";
import { AccountRepository } from "#/services/account-repository";
import { AppConfig } from "#/services/app-config";
import { CopilotClient } from "#/services/copilot-client";
import { ProxyRuntimeService } from "#/services/proxy-runtime-service";

const asModel = (body: Record<string, unknown>): string | null => {
  const value = body.model;
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const createClient = (config: AppConfigShape, account: AccountRecord) =>
  new CopilotClient(account.copilotToken, {
    apiBaseUrl: account.apiBaseUrl,
    forcedModelIds: config.security.forceModels,
    modelCacheTtlSeconds: config.upstream.modelCacheTtlSeconds,
    requestTimeoutMs: config.runtime.requestTimeoutMs,
  });

const prepareFailFastStream = <A>(stream: Stream.Stream<A, unknown>) =>
  Effect.gen(function* prepareFailFastStream() {
    const iterable = yield* Stream.toAsyncIterableEffect(stream);
    const iterator = iterable[Symbol.asyncIterator]();
    const first = yield* Effect.tryPromise({
      try: async () => iterator.next(),
      catch: (error) => new Error(describeError(error), { cause: error }),
    });

    if (first.done) {
      return Stream.empty as Stream.Stream<A, unknown>;
    }

    const firstValue = first.value;
    const wrapped: AsyncIterable<A> = {
      async *[Symbol.asyncIterator]() {
        yield firstValue;
        while (true) {
          const next = await iterator.next();
          if (next.done) {
            return;
          }

          yield next.value;
        }
      },
    };

    return Stream.fromAsyncIterable(wrapped, (error) => error);
  });

const toUnknownError = (error: unknown) => new Error(describeError(error), { cause: error });

const persistUsageEffect = (
  repository: {
    readonly recordUsage: (
      accountId: string,
      delta: AccountUsageDelta
    ) => Effect.Effect<void, unknown, never>;
  },
  accountId: string,
  payload: Record<string, unknown>,
  stream: boolean
) => repository.recordUsage(accountId, extractUsageDelta(payload, stream));

const persistUsagePromise = async (
  repository: {
    readonly recordUsage: (
      accountId: string,
      delta: AccountUsageDelta
    ) => Effect.Effect<void, unknown, never>;
  },
  accountId: string,
  delta: AccountUsageDelta
): Promise<void> => {
  await Effect.runPromise(repository.recordUsage(accountId, delta));
};

const chatCompletionsRoute = HttpRouter.add(
  "POST",
  "/v1/chat/completions",
  (request) =>
    Effect.gen(function* chatCompletionsRoute() {
      const config = yield* AppConfig;
      const unauthorized = authorizeRequest(request, config);
      if (unauthorized !== null) {
        return unauthorized;
      }

      const body = yield* readJsonRecord(request);
      const repository = yield* AccountRepository;
      const runtime = yield* ProxyRuntimeService;
      const model = asModel(body);

      if (body.stream === true) {
        const stream = yield* prepareFailFastStream(
          runtime.stream({
            allowUnsupportedSurfaceFallback: true,
            model,
            operation: ({ account, apiSurface }) => {
              const client = createClient(config, account);
              if (apiSurface === RESPONSES_API) {
                const responsesRequest = openAiChatToResponsesRequest(body);
                return Stream.unwrap(
                  Effect.tryPromise({
                    try: async () =>
                      client.responses<Record<string, unknown>>(responsesRequest, {
                        initiator: responsesRequestInitiator(responsesRequest),
                        vision: responsesRequestHasVisionInput(responsesRequest),
                      }),
                    catch: toUnknownError,
                  }).pipe(
                    Effect.tap((response) =>
                      persistUsageEffect(
                        repository,
                        account.accountId,
                        response,
                        true
                      )
                    ),
                    Effect.map((response) =>
                      textEventStream(openAiResponsesToChatEvents(response))
                    )
                  )
                );
              }

              return Stream.unwrap(
                Effect.tryPromise({
                  try: async () => client.chatCompletionsStream(body),
                  catch: toUnknownError,
                }).pipe(
                  Effect.map((events) =>
                    byteStream(
                      trackChatCompletionsStreamUsage(events, (delta) =>
                        persistUsagePromise(repository, account.accountId, delta)
                      )
                    )
                  )
                )
              );
            },
            requestedApi: CHAT_COMPLETIONS_API,
          })
        );

        return sseResponse(request, config, stream);
      }

      return yield* runtime.execute({
        allowUnsupportedSurfaceFallback: true,
        model,
        operation: ({ account, apiSurface }) =>
          Effect.tryPromise({
            try: async () => {
              const client = createClient(config, account);
              if (apiSurface === RESPONSES_API) {
                const responsesRequest = openAiChatToResponsesRequest(body);
                const result = await client.responses<Record<string, unknown>>(
                  responsesRequest,
                  {
                    initiator: responsesRequestInitiator(responsesRequest),
                    vision: responsesRequestHasVisionInput(responsesRequest),
                  }
                );
                return openAiResponsesToChatResponse(result);
              }

              return await client.chatCompletions<Record<string, unknown>>(body);
            },
            catch: toUnknownError,
          }).pipe(
            Effect.tap((response) =>
              persistUsageEffect(repository, account.accountId, response, false)
            )
          ),
        requestedApi: CHAT_COMPLETIONS_API,
      }).pipe(
        Effect.map((response) => jsonResponse(request, config, response)),
        Effect.catch((error) =>
          Effect.succeed(openAiErrorResponse(request, config, error)))
      );
    })
);

const responsesRoute = HttpRouter.add("POST", "/v1/responses", (request) =>
  Effect.gen(function* responsesRoute() {
    const config = yield* AppConfig;
    const unauthorized = authorizeRequest(request, config);
    if (unauthorized !== null) {
      return unauthorized;
    }

    const body = yield* readJsonRecord(request);
    const repository = yield* AccountRepository;
    const runtime = yield* ProxyRuntimeService;
    const model = asModel(body);

    if (body.stream === true) {
      const stream = yield* prepareFailFastStream(
        runtime.stream({
          allowUnsupportedSurfaceFallback: true,
          model,
          operation: ({ account, apiSurface }) => {
            const client = createClient(config, account);
            if (apiSurface === CHAT_COMPLETIONS_API) {
              return Stream.unwrap(
                Effect.tryPromise({
                  try: async () => {
                    const chatRequest = openAiResponsesToChatRequest(body);
                    return client.chatCompletions<Record<string, unknown>>(chatRequest);
                  },
                  catch: toUnknownError,
                }).pipe(
                  Effect.tap((response) =>
                    persistUsageEffect(
                      repository,
                      account.accountId,
                      response,
                      true
                    )
                  ),
                  Effect.map((response) =>
                    textEventStream(openAiChatToResponsesEvents(response, body))
                  )
                )
              );
            }

            return Stream.unwrap(
              Effect.tryPromise({
                try: async () =>
                  client.responsesStream(body, {
                    initiator: responsesRequestInitiator(body),
                    vision: responsesRequestHasVisionInput(body),
                  }),
                catch: toUnknownError,
              }).pipe(
                Effect.map((events) =>
                  byteStream(
                    fixResponsesStream(
                      trackResponsesStreamUsage(events, (delta) =>
                        persistUsagePromise(repository, account.accountId, delta)
                      )
                    )
                  )
                )
              )
            );
          },
          requestedApi: RESPONSES_API,
        })
      );

      return sseResponse(request, config, stream);
    }

    return yield* runtime.execute({
      allowUnsupportedSurfaceFallback: true,
      model,
      operation: ({ account, apiSurface }) =>
        Effect.tryPromise({
          try: async () => {
            const client = createClient(config, account);
            if (apiSurface === CHAT_COMPLETIONS_API) {
              const chatRequest = openAiResponsesToChatRequest(body);
              const result = await client.chatCompletions<Record<string, unknown>>(
                chatRequest
              );
              return openAiChatToResponsesResponse(result, body);
            }

            return await client.responses<Record<string, unknown>>(body, {
              initiator: responsesRequestInitiator(body),
              vision: responsesRequestHasVisionInput(body),
            });
          },
          catch: toUnknownError,
        }).pipe(
          Effect.tap((response) =>
            persistUsageEffect(repository, account.accountId, response, false)
          )
        ),
      requestedApi: RESPONSES_API,
    }).pipe(
      Effect.map((response) => jsonResponse(request, config, response)),
      Effect.catch((error) =>
        Effect.succeed(openAiErrorResponse(request, config, error)))
    );
  })
);

export const openAiRoutes = [chatCompletionsRoute, responsesRoute] as const;
