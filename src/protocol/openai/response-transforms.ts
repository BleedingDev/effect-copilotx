import type { JsonObject } from "#/protocol/shared/model-mapping";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const createId = (prefix: string): string =>
  `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;

const asText = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }

  if (value === undefined || value === null) {
    return "";
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (typeof value === "symbol") {
    return value.description ?? "";
  }

  return JSON.stringify(value);
};

const asInteger = (value: unknown): number => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
};

const currentUnixSeconds = (): number => Math.floor(Date.now() / 1000);

const tryParseJsonObject = (value: unknown): Record<string, unknown> => {
  if (isRecord(value)) {
    return value;
  }

  if (typeof value !== "string" || value.length === 0) {
    return {};
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

const toRecordArray = (value: unknown): Record<string, unknown>[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(isRecord);
};

const firstRecord = (value: unknown): Record<string, unknown> | null => {
  const [firstItem] = toRecordArray(value);
  return firstItem ?? null;
};

const openAiChatMessageText = (content: unknown): string => {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  const parts: string[] = [];
  for (const item of content) {
    if (typeof item === "string") {
      parts.push(item);
      continue;
    }

    if (isRecord(item) && item.type === "text") {
      parts.push(asText(item.text));
    }
  }

  return parts.join("");
};

const anthropicStopReasonFromChatFinishReason = (
  finishReason: string
): string => {
  if (finishReason === "length") {
    return "max_tokens";
  }

  if (finishReason === "tool_calls") {
    return "tool_use";
  }

  return "end_turn";
};

const responseEvent = (
  event: string,
  payload: Record<string, unknown>
): string => `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;

const chatEvent = (payload: Record<string, unknown>): string =>
  `data: ${JSON.stringify(payload)}\n\n`;

const anthropicEvent = (
  event: string,
  payload: Record<string, unknown>
): string => `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;

export const openAiChatToAnthropicResponse = (
  openAiResponse: JsonObject,
  model: string
): Record<string, unknown> => {
  const choices = Array.isArray(openAiResponse.choices)
    ? openAiResponse.choices
    : [{}];
  const textParts: string[] = [];
  const toolCalls: Record<string, unknown>[] = [];
  let finishReason = "end_turn";

  for (const rawChoice of choices) {
    if (!isRecord(rawChoice)) {
      continue;
    }

    const message = isRecord(rawChoice.message) ? rawChoice.message : {};
    const content = openAiChatMessageText(message.content);
    if (content.length > 0) {
      textParts.push(content);
    }

    if (Array.isArray(message.tool_calls)) {
      for (const toolCall of message.tool_calls) {
        if (isRecord(toolCall)) {
          toolCalls.push(toolCall);
        }
      }
    }

    const choiceFinishReason = asText(rawChoice.finish_reason);
    if (choiceFinishReason === "tool_calls") {
      finishReason = choiceFinishReason;
    } else if (choiceFinishReason.length > 0 && finishReason !== "tool_calls") {
      finishReason = choiceFinishReason;
    }
  }

  const contentBlocks: Record<string, unknown>[] = [];
  const combinedText = textParts.join("\n");
  if (combinedText.length > 0) {
    contentBlocks.push({ text: combinedText, type: "text" });
  }

  for (const toolCall of toolCalls) {
    const fn = isRecord(toolCall.function) ? toolCall.function : {};
    contentBlocks.push({
      id: asText(toolCall.id ?? createId("toolu")),
      input: tryParseJsonObject(fn.arguments),
      name: asText(fn.name),
      type: "tool_use",
    });
  }

  if (contentBlocks.length === 0) {
    contentBlocks.push({ text: "", type: "text" });
  }

  const usage = isRecord(openAiResponse.usage) ? openAiResponse.usage : {};
  return {
    content: contentBlocks,
    id: createId("msg"),
    model,
    role: "assistant",
    stop_reason: anthropicStopReasonFromChatFinishReason(finishReason),
    stop_sequence: null,
    type: "message",
    usage: {
      input_tokens: asInteger(usage.prompt_tokens),
      output_tokens: asInteger(usage.completion_tokens),
    },
  };
};

export const openAiResponsesToAnthropicResponse = (
  response: JsonObject,
  model: string
): Record<string, unknown> => {
  const contentBlocks: Record<string, unknown>[] = [];
  let stopReason = "end_turn";

  for (const rawItem of Array.isArray(response.output) ? response.output : []) {
    if (!isRecord(rawItem)) {
      continue;
    }

    if (rawItem.type === "message") {
      const textParts: string[] = [];
      for (const rawPart of Array.isArray(rawItem.content)
        ? rawItem.content
        : []) {
        if (!isRecord(rawPart)) {
          continue;
        }

        if (rawPart.type === "output_text" || rawPart.type === "text") {
          textParts.push(asText(rawPart.text));
        }
      }

      if (textParts.length > 0) {
        contentBlocks.push({ text: textParts.join(""), type: "text" });
      }
      continue;
    }

    if (rawItem.type === "function_call") {
      contentBlocks.push({
        id: asText(rawItem.call_id ?? rawItem.id ?? createId("toolu")),
        input: tryParseJsonObject(rawItem.arguments),
        name: asText(rawItem.name),
        type: "tool_use",
      });
      stopReason = "tool_use";
    }
  }

  if (contentBlocks.length === 0) {
    contentBlocks.push({ text: "", type: "text" });
  }

  const incompleteDetails = isRecord(response.incomplete_details)
    ? response.incomplete_details
    : {};
  if (
    stopReason !== "tool_use" &&
    incompleteDetails.reason === "max_output_tokens"
  ) {
    stopReason = "max_tokens";
  }

  const usage = isRecord(response.usage) ? response.usage : {};
  return {
    content: contentBlocks,
    id: createId("msg"),
    model,
    role: "assistant",
    stop_reason: stopReason,
    stop_sequence: null,
    type: "message",
    usage: {
      input_tokens: asInteger(usage.input_tokens),
      output_tokens: asInteger(usage.output_tokens),
    },
  };
};

const extractResponsesMessageText = (
  item: Record<string, unknown>
): string[] => {
  const textParts: string[] = [];
  for (const rawPart of toRecordArray(item.content)) {
    if (rawPart.type === "output_text" || rawPart.type === "text") {
      textParts.push(asText(rawPart.text));
    }
  }

  return textParts;
};

const responsesItemToChatToolCall = (
  item: Record<string, unknown>
): Record<string, unknown> | null => {
  if (item.type !== "function_call") {
    return null;
  }

  const callId = asText(item.call_id ?? item.id ?? createId("call"));
  return {
    function: {
      arguments: asText(item.arguments ?? "{}"),
      name: asText(item.name),
    },
    id: callId,
    type: "function",
  };
};

const extractResponsesChatState = (response: JsonObject) => {
  const textParts: string[] = [];
  const toolCalls: Record<string, unknown>[] = [];

  for (const rawItem of toRecordArray(response.output)) {
    if (rawItem.type === "message") {
      textParts.push(...extractResponsesMessageText(rawItem));
      continue;
    }

    const toolCall = responsesItemToChatToolCall(rawItem);
    if (toolCall !== null) {
      toolCalls.push(toolCall);
    }
  }

  return { textParts, toolCalls };
};

const responsesChatFinishReason = (
  response: JsonObject,
  toolCalls: readonly Record<string, unknown>[]
): string => {
  if (toolCalls.length > 0) {
    return "tool_calls";
  }

  const incompleteDetails = isRecord(response.incomplete_details)
    ? response.incomplete_details
    : {};
  return incompleteDetails.reason === "max_output_tokens" ? "length" : "stop";
};

export const openAiResponsesToChatResponse = (
  response: JsonObject
): Record<string, unknown> => {
  const { textParts, toolCalls } = extractResponsesChatState(response);
  const finishReason = responsesChatFinishReason(response, toolCalls);
  const message: Record<string, unknown> = {
    content: textParts.length > 0 ? textParts.join("") : null,
    role: "assistant",
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };

  const usage = isRecord(response.usage) ? response.usage : {};
  const inputTokens = asInteger(usage.input_tokens);
  const outputTokens = asInteger(usage.output_tokens);

  return {
    choices: [
      {
        finish_reason: finishReason,
        index: 0,
        message,
      },
    ],
    created: currentUnixSeconds(),
    id: asText(response.id ?? createId("chatcmpl")),
    model: asText(response.model),
    object: "chat.completion",
    usage: {
      completion_tokens: outputTokens,
      prompt_tokens: inputTokens,
      total_tokens: inputTokens + outputTokens,
    },
  };
};

const extractOpenAiChatChoiceState = (response: JsonObject) => {
  const textParts: string[] = [];
  const toolCalls: Record<string, unknown>[] = [];
  let finishReason = "stop";

  for (const rawChoice of Array.isArray(response.choices)
    ? response.choices
    : []) {
    if (!isRecord(rawChoice)) {
      continue;
    }

    const message = isRecord(rawChoice.message) ? rawChoice.message : {};
    const text = openAiChatMessageText(message.content);
    if (text.length > 0) {
      textParts.push(text);
    }

    if (Array.isArray(message.tool_calls)) {
      for (const rawToolCall of message.tool_calls) {
        if (isRecord(rawToolCall)) {
          toolCalls.push(rawToolCall);
        }
      }
    }

    const choiceFinishReason = asText(rawChoice.finish_reason);
    if (choiceFinishReason === "tool_calls") {
      finishReason = choiceFinishReason;
    } else if (choiceFinishReason.length > 0 && finishReason !== "tool_calls") {
      finishReason = choiceFinishReason;
    }
  }

  return { finishReason, textParts, toolCalls };
};

const buildResponsesOutput = (
  textParts: readonly string[],
  toolCalls: readonly Record<string, unknown>[]
): Record<string, unknown>[] => {
  const output: Record<string, unknown>[] = [];
  const joinedText = textParts.join("");

  if (joinedText.length > 0 || toolCalls.length === 0) {
    output.push({
      content: [
        {
          annotations: [],
          logprobs: [],
          text: joinedText,
          type: "output_text",
        },
      ],
      id: createId("msg"),
      role: "assistant",
      status: "completed",
      type: "message",
    });
  }

  for (const toolCall of toolCalls) {
    const fn = isRecord(toolCall.function) ? toolCall.function : {};
    const callId = asText(toolCall.id ?? createId("call"));
    output.push({
      arguments: asText(fn.arguments ?? "{}"),
      call_id: callId,
      id: callId,
      name: asText(fn.name),
      type: "function_call",
    });
  }

  return output;
};

export const openAiChatToResponsesResponse = (
  response: JsonObject,
  request: JsonObject
): Record<string, unknown> => {
  const { finishReason, textParts, toolCalls } =
    extractOpenAiChatChoiceState(response);
  const output = buildResponsesOutput(textParts, toolCalls);
  const usage = isRecord(response.usage) ? response.usage : {};
  const inputTokens = asInteger(usage.prompt_tokens);
  const outputTokens = asInteger(usage.completion_tokens);
  const textConfig = isRecord(request.text) ? request.text : {};

  const result: Record<string, unknown> = {
    created_at: asInteger(response.created ?? currentUnixSeconds()),
    id: asText(response.id ?? createId("resp")),
    incomplete_details:
      finishReason === "length" ? { reason: "max_output_tokens" } : null,
    model: asText(response.model ?? request.model),
    object: "response",
    output,
    parallel_tool_calls: request.parallel_tool_calls ?? toolCalls.length > 0,
    previous_response_id: request.previous_response_id ?? null,
    status: "completed",
    store: Boolean(request.store ?? false),
    text: {
      format: { type: "text" },
      verbosity: asText(textConfig.verbosity ?? "medium"),
    },
    tool_choice: request.tool_choice ?? "auto",
    tools: Array.isArray(request.tools) ? request.tools : [],
    usage: {
      input_tokens: inputTokens,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: outputTokens,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: inputTokens + outputTokens,
    },
  };

  if (request.prompt_cache_retention !== undefined) {
    result.prompt_cache_retention = request.prompt_cache_retention;
  }

  if (request.safety_identifier !== undefined) {
    result.safety_identifier = request.safety_identifier;
  }

  return result;
};

export const openAiChatToResponsesEvents =
  function* openAiChatToResponsesEvents(
    response: JsonObject,
    request: JsonObject
  ): Generator<string> {
    const completed = openAiChatToResponsesResponse(response, request);
    const inProgress = { ...completed, output: [], status: "in_progress" };
    let sequenceNumber = 0;

    yield responseEvent("response.created", {
      response: inProgress,
      sequence_number: sequenceNumber,
      type: "response.created",
    });
    sequenceNumber += 1;

    yield responseEvent("response.in_progress", {
      response: inProgress,
      sequence_number: sequenceNumber,
      type: "response.in_progress",
    });
    sequenceNumber += 1;

    const output = toRecordArray(completed.output);

    for (const [outputIndex, item] of output.entries()) {
      if (item.type === "message") {
        const messageItem = {
          content: [],
          id: item.id,
          phase: "final_answer",
          role: "assistant",
          status: "in_progress",
          type: "message",
        };

        yield responseEvent("response.output_item.added", {
          item: messageItem,
          output_index: outputIndex,
          sequence_number: sequenceNumber,
          type: "response.output_item.added",
        });
        sequenceNumber += 1;

        const part = {
          annotations: [],
          logprobs: [],
          text: "",
          type: "output_text",
        };

        yield responseEvent("response.content_part.added", {
          content_index: 0,
          item_id: item.id,
          output_index: outputIndex,
          part,
          sequence_number: sequenceNumber,
          type: "response.content_part.added",
        });
        sequenceNumber += 1;

        const content = Array.isArray(item.content) ? item.content : [];
        const text = isRecord(content[0]) ? asText(content[0].text) : "";
        if (text.length > 0) {
          yield responseEvent("response.output_text.delta", {
            content_index: 0,
            delta: text,
            item_id: item.id,
            output_index: outputIndex,
            sequence_number: sequenceNumber,
            type: "response.output_text.delta",
          });
          sequenceNumber += 1;

          yield responseEvent("response.output_text.done", {
            content_index: 0,
            item_id: item.id,
            output_index: outputIndex,
            sequence_number: sequenceNumber,
            text,
            type: "response.output_text.done",
          });
          sequenceNumber += 1;
        }

        yield responseEvent("response.content_part.done", {
          content_index: 0,
          item_id: item.id,
          output_index: outputIndex,
          part: { ...part, text },
          sequence_number: sequenceNumber,
          type: "response.content_part.done",
        });
        sequenceNumber += 1;

        yield responseEvent("response.output_item.done", {
          item,
          output_index: outputIndex,
          sequence_number: sequenceNumber,
          type: "response.output_item.done",
        });
        sequenceNumber += 1;
        continue;
      }

      yield responseEvent("response.output_item.added", {
        item,
        output_index: outputIndex,
        sequence_number: sequenceNumber,
        type: "response.output_item.added",
      });
      sequenceNumber += 1;

      yield responseEvent("response.output_item.done", {
        item,
        output_index: outputIndex,
        sequence_number: sequenceNumber,
        type: "response.output_item.done",
      });
      sequenceNumber += 1;
    }

    yield responseEvent("response.completed", {
      response: completed,
      sequence_number: sequenceNumber,
      type: "response.completed",
    });
  };

export const openAiResponsesToChatEvents =
  function* openAiResponsesToChatEvents(
    response: JsonObject
  ): Generator<string> {
    const chatResponse = openAiResponsesToChatResponse(response);
    const choice = firstRecord(chatResponse.choices) ?? {
      finish_reason: "stop",
      message: {},
    };
    const message = isRecord(choice.message) ? choice.message : {};
    const finishReason = asText(choice.finish_reason) || "stop";
    const chunkBase = {
      created: chatResponse.created,
      id: chatResponse.id,
      model: chatResponse.model,
      object: "chat.completion.chunk",
    };

    yield chatEvent({
      ...chunkBase,
      choices: [
        {
          delta: { role: "assistant" },
          finish_reason: null,
          index: 0,
        },
      ],
    });

    const content = asText(message.content);
    if (content.length > 0) {
      yield chatEvent({
        ...chunkBase,
        choices: [
          {
            delta: { content },
            finish_reason: null,
            index: 0,
          },
        ],
      });
    }

    const toolCalls = Array.isArray(message.tool_calls)
      ? message.tool_calls
      : [];
    for (const [index, rawToolCall] of toolCalls.entries()) {
      if (!isRecord(rawToolCall)) {
        continue;
      }

      yield chatEvent({
        ...chunkBase,
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  function: rawToolCall.function,
                  id: rawToolCall.id,
                  index,
                  type: "function",
                },
              ],
            },
            finish_reason: null,
            index: 0,
          },
        ],
      });
    }

    yield chatEvent({
      ...chunkBase,
      choices: [
        {
          delta: {},
          finish_reason: finishReason,
          index: 0,
        },
      ],
    });
    yield "data: [DONE]\n\n";
  };

export const openAiResponsesToAnthropicEvents =
  function* openAiResponsesToAnthropicEvents(
    response: JsonObject,
    model: string
  ): Generator<string> {
    const anthropicResponse = openAiResponsesToAnthropicResponse(
      response,
      model
    );
    const usage = isRecord(anthropicResponse.usage)
      ? anthropicResponse.usage
      : {};

    yield anthropicEvent("message_start", {
      message: {
        content: [],
        id: anthropicResponse.id,
        model: anthropicResponse.model,
        role: "assistant",
        stop_reason: null,
        stop_sequence: null,
        type: "message",
        usage: {
          input_tokens: asInteger(usage.input_tokens),
          output_tokens: 0,
        },
      },
      type: "message_start",
    });

    const contentBlocks = Array.isArray(anthropicResponse.content)
      ? anthropicResponse.content
      : [];

    for (const [index, rawBlock] of contentBlocks.entries()) {
      if (!isRecord(rawBlock)) {
        continue;
      }

      if (rawBlock.type === "text") {
        yield anthropicEvent("content_block_start", {
          content_block: { text: "", type: "text" },
          index,
          type: "content_block_start",
        });

        const text = asText(rawBlock.text);
        if (text.length > 0) {
          yield anthropicEvent("content_block_delta", {
            delta: { text, type: "text_delta" },
            index,
            type: "content_block_delta",
          });
        }

        yield anthropicEvent("content_block_stop", {
          index,
          type: "content_block_stop",
        });
        continue;
      }

      yield anthropicEvent("content_block_start", {
        content_block: {
          id: rawBlock.id,
          input: {},
          name: rawBlock.name,
          type: "tool_use",
        },
        index,
        type: "content_block_start",
      });

      const input = JSON.stringify(rawBlock.input ?? {});
      if (input !== "{}") {
        yield anthropicEvent("content_block_delta", {
          delta: { partial_json: input, type: "input_json_delta" },
          index,
          type: "content_block_delta",
        });
      }

      yield anthropicEvent("content_block_stop", {
        index,
        type: "content_block_stop",
      });
    }

    yield anthropicEvent("message_delta", {
      delta: {
        stop_reason: anthropicResponse.stop_reason,
        stop_sequence: null,
      },
      type: "message_delta",
      usage: {
        output_tokens: asInteger(usage.output_tokens),
      },
    });
    yield anthropicEvent("message_stop", { type: "message_stop" });
  };

export const openAiChatStreamToAnthropicEvents =
  async function* openAiChatStreamToAnthropicEvents(
    openAiChunks:
      | Iterable<string | Uint8Array>
      | AsyncIterable<string | Uint8Array>,
    model: string
  ): AsyncGenerator<string> {
    const messageId = createId("msg");
    let outputTokens = 0;
    let sentStart = false;
    let textBlockStarted = false;
    let textBlockClosed = false;
    let nextBlockIndex = 0;
    let textBlockIndex = 0;
    let finishReason = "end_turn";
    const toolCallTrackers = new Map<
      number,
      { blockIndex: number; id: string; name: string }
    >();

    const messageStartEvent = (): string =>
      anthropicEvent("message_start", {
        message: {
          content: [],
          id: messageId,
          model,
          role: "assistant",
          stop_reason: null,
          stop_sequence: null,
          type: "message",
          usage: { input_tokens: 0, output_tokens: 0 },
        },
        type: "message_start",
      });

    const applyFinishReason = (chunkFinishReason: string | null) => {
      if (chunkFinishReason === "tool_calls") {
        finishReason = "tool_use";
        return;
      }

      if (chunkFinishReason === "length") {
        finishReason = "max_tokens";
        return;
      }

      if (chunkFinishReason !== null) {
        finishReason = "end_turn";
      }
    };

    const extractChunkState = (chunk: Record<string, unknown>) => {
      let content: string | null = null;
      let toolCalls: Record<string, unknown>[] | null = null;
      let chunkFinishReason: string | null = null;

      for (const rawChoice of Array.isArray(chunk.choices)
        ? chunk.choices
        : []) {
        if (!isRecord(rawChoice)) {
          continue;
        }

        const delta = isRecord(rawChoice.delta) ? rawChoice.delta : {};
        const deltaContent = delta.content;
        if (typeof deltaContent === "string" && deltaContent.length > 0) {
          content = deltaContent;
        }

        if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
          toolCalls = delta.tool_calls.filter(isRecord);
        }

        const choiceFinishReason = asText(rawChoice.finish_reason);
        if (choiceFinishReason.length > 0) {
          chunkFinishReason = choiceFinishReason;
        }
      }

      const usage = isRecord(chunk.usage) ? chunk.usage : null;
      const completionTokens =
        usage === null
          ? null
          : asInteger(usage.completion_tokens ?? outputTokens);

      return {
        chunkFinishReason,
        completionTokens,
        content,
        toolCalls,
      };
    };

    const ensureMessageStart =
      function* ensureMessageStart(): Generator<string> {
        if (!sentStart) {
          sentStart = true;
          yield messageStartEvent();
        }
      };

    const handleContent = function* handleContent(
      content: string
    ): Generator<string> {
      if (!textBlockStarted) {
        textBlockIndex = nextBlockIndex;
        nextBlockIndex += 1;
        textBlockStarted = true;
        yield anthropicEvent("content_block_start", {
          content_block: { text: "", type: "text" },
          index: textBlockIndex,
          type: "content_block_start",
        });
      }

      yield anthropicEvent("content_block_delta", {
        delta: { text: content, type: "text_delta" },
        index: textBlockIndex,
        type: "content_block_delta",
      });
    };

    const handleToolCalls = function* handleToolCalls(
      toolCalls: readonly Record<string, unknown>[]
    ): Generator<string> {
      for (const toolCallDelta of toolCalls) {
        const toolCallIndex = asInteger(toolCallDelta.index);
        const fn = isRecord(toolCallDelta.function)
          ? toolCallDelta.function
          : {};
        const argumentDelta = asText(fn.arguments);

        let tracker = toolCallTrackers.get(toolCallIndex);
        if (tracker === undefined) {
          if (textBlockStarted && !textBlockClosed) {
            yield anthropicEvent("content_block_stop", {
              index: textBlockIndex,
              type: "content_block_stop",
            });
            textBlockClosed = true;
          }

          tracker = {
            blockIndex: nextBlockIndex,
            id: asText(toolCallDelta.id ?? createId("toolu")),
            name: asText(fn.name),
          };
          nextBlockIndex += 1;
          toolCallTrackers.set(toolCallIndex, tracker);

          yield anthropicEvent("content_block_start", {
            content_block: {
              id: tracker.id,
              input: {},
              name: tracker.name,
              type: "tool_use",
            },
            index: tracker.blockIndex,
            type: "content_block_start",
          });
        } else {
          if (tracker.id.length === 0 && typeof toolCallDelta.id === "string") {
            tracker.id = toolCallDelta.id;
          }
          if (tracker.name.length === 0 && typeof fn.name === "string") {
            tracker.name = fn.name;
          }
        }

        if (argumentDelta.length > 0) {
          yield anthropicEvent("content_block_delta", {
            delta: {
              partial_json: argumentDelta,
              type: "input_json_delta",
            },
            index: tracker.blockIndex,
            type: "content_block_delta",
          });
        }
      }
    };

    const processLine = (line: string): Generator<string> =>
      (function* processLineGenerator() {
        const trimmedLine = line.trim();
        if (trimmedLine.length === 0 || !trimmedLine.startsWith("data: ")) {
          return;
        }

        const data = trimmedLine.slice(6);
        if (data === "[DONE]") {
          return;
        }

        let chunk: unknown;
        try {
          chunk = JSON.parse(data) as unknown;
        } catch {
          return;
        }

        if (!isRecord(chunk)) {
          return;
        }

        yield* ensureMessageStart();

        const { chunkFinishReason, completionTokens, content, toolCalls } =
          extractChunkState(chunk);

        applyFinishReason(chunkFinishReason);

        if (content !== null) {
          yield* handleContent(content);
        }

        if (toolCalls !== null) {
          yield* handleToolCalls(toolCalls);
        }

        if (completionTokens !== null) {
          outputTokens = completionTokens;
        }
      })();

    let pending = "";
    for await (const rawChunk of openAiChunks) {
      pending +=
        typeof rawChunk === "string"
          ? rawChunk
          : new TextDecoder().decode(rawChunk);

      while (true) {
        const newlineIndex = pending.indexOf("\n");
        if (newlineIndex === -1) {
          break;
        }

        const line = pending.slice(0, newlineIndex).replace(/\r$/, "");
        pending = pending.slice(newlineIndex + 1);
        yield* processLine(line);
      }
    }

    if (pending.length > 0) {
      yield* processLine(pending.replace(/\r$/, ""));
    }

    if (!sentStart) {
      sentStart = true;
      yield messageStartEvent();
    }

    if (textBlockStarted && !textBlockClosed && toolCallTrackers.size === 0) {
      yield anthropicEvent("content_block_stop", {
        index: textBlockIndex,
        type: "content_block_stop",
      });
    }

    for (const tracker of [...toolCallTrackers.entries()].toSorted(
      (a, b) => a[0] - b[0]
    )) {
      yield anthropicEvent("content_block_stop", {
        index: tracker[1].blockIndex,
        type: "content_block_stop",
      });
    }

    yield anthropicEvent("message_delta", {
      delta: { stop_reason: finishReason, stop_sequence: null },
      type: "message_delta",
      usage: { output_tokens: outputTokens },
    });
    yield anthropicEvent("message_stop", { type: "message_stop" });
  };

export interface ResponseTransformApi {
  readonly openAiChatStreamToAnthropicEvents: typeof openAiChatStreamToAnthropicEvents;
  readonly openAiChatToAnthropicResponse: typeof openAiChatToAnthropicResponse;
  readonly openAiChatToResponsesEvents: typeof openAiChatToResponsesEvents;
  readonly openAiChatToResponsesResponse: typeof openAiChatToResponsesResponse;
  readonly openAiResponsesToAnthropicEvents: typeof openAiResponsesToAnthropicEvents;
  readonly openAiResponsesToAnthropicResponse: typeof openAiResponsesToAnthropicResponse;
  readonly openAiResponsesToChatEvents: typeof openAiResponsesToChatEvents;
  readonly openAiResponsesToChatResponse: typeof openAiResponsesToChatResponse;
}
