import {
  anthropicToOpenAiChatRequest as anthropicToOpenAiChatRequestImpl,
  anthropicToOpenAiResponsesRequest as anthropicToOpenAiResponsesRequestImpl,
} from "#/protocol/openai/request-transforms";
import {
  openAiChatStreamToAnthropicEvents as openAiChatStreamToAnthropicEventsImpl,
  openAiChatToAnthropicResponse as openAiChatToAnthropicResponseImpl,
  openAiResponsesToAnthropicEvents as openAiResponsesToAnthropicEventsImpl,
  openAiResponsesToAnthropicResponse as openAiResponsesToAnthropicResponseImpl,
} from "#/protocol/openai/response-transforms";

export {
  anthropicToOpenAiChatRequestImpl as anthropicToOpenAiChatRequest,
  anthropicToOpenAiResponsesRequestImpl as anthropicToOpenAiResponsesRequest,
};

export {
  openAiChatStreamToAnthropicEventsImpl as openAiChatStreamToAnthropicEvents,
  openAiChatToAnthropicResponseImpl as openAiChatToAnthropicResponse,
  openAiResponsesToAnthropicEventsImpl as openAiResponsesToAnthropicEvents,
  openAiResponsesToAnthropicResponseImpl as openAiResponsesToAnthropicResponse,
};

export {
  ANTHROPIC_TO_COPILOT_MODEL_MAP,
  mapAnthropicModelToCopilot,
  type JsonArray,
  type JsonObject,
  type JsonPrimitive,
  type JsonValue,
} from "#/protocol/shared/model-mapping";

export interface AnthropicTranslatorApi {
  readonly anthropicToOpenAiChatRequest: typeof anthropicToOpenAiChatRequestImpl;
  readonly anthropicToOpenAiResponsesRequest: typeof anthropicToOpenAiResponsesRequestImpl;
  readonly openAiChatStreamToAnthropicEvents: typeof openAiChatStreamToAnthropicEventsImpl;
  readonly openAiChatToAnthropicResponse: typeof openAiChatToAnthropicResponseImpl;
  readonly openAiResponsesToAnthropicEvents: typeof openAiResponsesToAnthropicEventsImpl;
  readonly openAiResponsesToAnthropicResponse: typeof openAiResponsesToAnthropicResponseImpl;
}
