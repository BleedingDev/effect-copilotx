import { mapAnthropicModelToCopilot } from "#/protocol/shared/model-mapping";
import type { JsonObject } from "#/protocol/shared/model-mapping";

const DEFAULT_PARAMETERS = { properties: {}, type: "object" } as const;
const BUILTIN_ANTHROPIC_TOOL_TYPES = new Set([
  "computer_20241022",
  "bash_20241022",
  "text_editor_20241022",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const cloneJson = <T extends JsonObject>(value: T): T => structuredClone(value);

const createId = (prefix: string): string =>
  `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;

const stringifyJson = (value: unknown, fallback = "{}"): string => {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value ?? {});
  } catch {
    return fallback;
  }
};

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

  return stringifyJson(value, "");
};

const flattenTextBlocks = (content: unknown): string => {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return asText(content);
  }

  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      parts.push(block);
      continue;
    }

    if (isRecord(block) && block.type === "text") {
      parts.push(asText(block.text));
    }
  }

  return parts.filter(Boolean).join("\n");
};

const anthropicBlockToChatPart = (
  block: unknown
): Record<string, unknown> | null => {
  if (typeof block === "string") {
    return { text: block, type: "text" };
  }

  if (!isRecord(block)) {
    return null;
  }

  if (block.type === "text") {
    return { text: asText(block.text), type: "text" };
  }

  if (block.type !== "image" || !isRecord(block.source)) {
    return null;
  }

  if (block.source.type === "base64") {
    const mediaType = asText(block.source.media_type ?? "image/png");
    const data = asText(block.source.data);
    return {
      image_url: { url: `data:${mediaType};base64,${data}` },
      type: "image_url",
    };
  }

  if (block.source.type === "url") {
    return {
      image_url: { url: asText(block.source.url) },
      type: "image_url",
    };
  }

  return null;
};

const responsesInputPartToChatPart = (
  part: unknown
): Record<string, unknown> | null => {
  if (!isRecord(part)) {
    return null;
  }

  if (part.type === "input_text") {
    return { text: asText(part.text), type: "text" };
  }

  if (
    part.type === "input_image" ||
    part.type === "image" ||
    part.type === "image_url"
  ) {
    const imageUrl = isRecord(part.image_url)
      ? asText(part.image_url.url)
      : asText(part.image_url ?? part.url ?? part.image);

    if (imageUrl.length > 0) {
      return { image_url: { url: imageUrl }, type: "image_url" };
    }
  }

  return null;
};

const responsesInputItemToChatContent = (
  item: Record<string, unknown>
): unknown => {
  const { content } = item;
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  const chatParts: Record<string, unknown>[] = [];
  for (const part of content) {
    const converted = responsesInputPartToChatPart(part);
    if (converted !== null) {
      chatParts.push(converted);
    }
  }

  if (chatParts.length === 0) {
    return "";
  }

  if (chatParts.length === 1 && chatParts[0]?.type === "text") {
    return chatParts[0].text;
  }

  return chatParts;
};

const openAiChatContentToResponsesParts = (
  content: unknown
): Record<string, unknown>[] => {
  if (typeof content === "string") {
    return [{ text: content, type: "input_text" }];
  }

  if (!Array.isArray(content)) {
    return [];
  }

  const parts: Record<string, unknown>[] = [];
  for (const item of content) {
    if (typeof item === "string") {
      parts.push({ text: item, type: "input_text" });
      continue;
    }

    if (!isRecord(item)) {
      continue;
    }

    if (item.type === "text") {
      parts.push({ text: asText(item.text), type: "input_text" });
      continue;
    }

    if (item.type === "image_url") {
      const imageUrl = isRecord(item.image_url)
        ? asText(item.image_url.url)
        : asText(item.image_url);
      if (imageUrl.length > 0) {
        parts.push({ image_url: imageUrl, type: "input_image" });
      }
    }
  }

  return parts;
};

const openAiChatToolResultToOutputText = (content: unknown): string => {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return asText(content);
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

  return parts.filter(Boolean).join("\n");
};

const chatContentFromParts = (
  parts: readonly Record<string, unknown>[]
): unknown => {
  if (parts.length === 0) {
    return "";
  }

  if (parts.length === 1 && parts[0]?.type === "text") {
    return parts[0].text;
  }

  return [...parts];
};

const convertAnthropicToolsToOpenAi = (
  tools: readonly unknown[]
): Record<string, unknown>[] => {
  const openAiTools: Record<string, unknown>[] = [];

  for (const tool of tools) {
    if (!isRecord(tool)) {
      continue;
    }

    const toolType = typeof tool.type === "string" ? tool.type : "custom";
    const functionDefinition: Record<string, unknown> = {
      name: asText(tool.name ?? toolType),
      parameters: isRecord(tool.input_schema)
        ? tool.input_schema
        : DEFAULT_PARAMETERS,
    };

    if (typeof tool.description === "string") {
      functionDefinition.description = tool.description;
    } else if (BUILTIN_ANTHROPIC_TOOL_TYPES.has(toolType)) {
      functionDefinition.description = `Anthropic ${toolType} tool`;
    }

    openAiTools.push({ function: functionDefinition, type: "function" });
  }

  return openAiTools;
};

const convertAnthropicToolChoiceToOpenAi = (toolChoice: unknown): unknown => {
  if (typeof toolChoice === "string") {
    return toolChoice === "any" ? "required" : toolChoice;
  }

  if (!isRecord(toolChoice)) {
    return "auto";
  }

  const type = typeof toolChoice.type === "string" ? toolChoice.type : "auto";
  if (type === "auto") {
    return "auto";
  }

  if (type === "any") {
    return "required";
  }

  if (type === "none") {
    return "none";
  }

  if (type === "tool") {
    return { function: { name: asText(toolChoice.name) }, type: "function" };
  }

  return "auto";
};

const convertAnthropicToolsToResponses = (
  tools: readonly unknown[]
): Record<string, unknown>[] => {
  const responseTools: Record<string, unknown>[] = [];

  for (const tool of tools) {
    if (!isRecord(tool)) {
      continue;
    }

    const toolType = typeof tool.type === "string" ? tool.type : "custom";
    const responseTool: Record<string, unknown> = {
      description:
        typeof tool.description === "string"
          ? tool.description
          : `Anthropic ${toolType} tool`,
      name: asText(tool.name ?? toolType),
      parameters: isRecord(tool.input_schema)
        ? tool.input_schema
        : DEFAULT_PARAMETERS,
      type: "function",
    };

    responseTools.push(responseTool);
  }

  return responseTools;
};

const convertAnthropicToolChoiceToResponses = (
  toolChoice: unknown
): unknown => {
  if (typeof toolChoice === "string") {
    return toolChoice === "any" ? "required" : toolChoice;
  }

  if (!isRecord(toolChoice)) {
    return "auto";
  }

  const type = typeof toolChoice.type === "string" ? toolChoice.type : "auto";
  if (type === "auto") {
    return "auto";
  }

  if (type === "any") {
    return "required";
  }

  if (type === "none") {
    return "none";
  }

  if (type === "tool") {
    return { name: asText(toolChoice.name), type: "function" };
  }

  return "auto";
};

const convertOpenAiChatToolsToResponses = (
  tools: readonly unknown[]
): Record<string, unknown>[] => {
  const responsesTools: Record<string, unknown>[] = [];

  for (const tool of tools) {
    if (!isRecord(tool)) {
      continue;
    }

    if (tool.type === "custom") {
      const responseTool: Record<string, unknown> = {
        name: asText(tool.name),
        parameters: isRecord(tool.parameters)
          ? tool.parameters
          : DEFAULT_PARAMETERS,
        type: "function",
      };

      if (typeof tool.description === "string") {
        responseTool.description = tool.description;
      }

      responsesTools.push(responseTool);
      continue;
    }

    const fn =
      tool.type === "function" && isRecord(tool.function)
        ? tool.function
        : null;
    if (fn === null) {
      continue;
    }

    const responseTool: Record<string, unknown> = {
      name: asText(fn.name),
      parameters: isRecord(fn.parameters) ? fn.parameters : DEFAULT_PARAMETERS,
      type: "function",
    };

    if (typeof fn.description === "string") {
      responseTool.description = fn.description;
    }

    responsesTools.push(responseTool);
  }

  return responsesTools;
};

const convertOpenAiChatToolChoiceToResponses = (
  toolChoice: unknown
): unknown => {
  if (typeof toolChoice === "string") {
    return toolChoice;
  }

  if (
    isRecord(toolChoice) &&
    toolChoice.type === "function" &&
    isRecord(toolChoice.function)
  ) {
    return { name: asText(toolChoice.function.name), type: "function" };
  }

  return toolChoice;
};

const convertResponsesToolsToOpenAiChat = (
  tools: readonly unknown[]
): Record<string, unknown>[] => {
  const chatTools: Record<string, unknown>[] = [];

  for (const tool of tools) {
    if (!isRecord(tool) || tool.type !== "function") {
      continue;
    }

    const functionDefinition: Record<string, unknown> = {
      name: asText(tool.name),
      parameters: isRecord(tool.parameters)
        ? tool.parameters
        : DEFAULT_PARAMETERS,
    };

    if (typeof tool.description === "string") {
      functionDefinition.description = tool.description;
    }

    chatTools.push({ function: functionDefinition, type: "function" });
  }

  return chatTools;
};

const convertResponsesToolChoiceToOpenAiChat = (
  toolChoice: unknown
): unknown => {
  if (typeof toolChoice === "string") {
    return toolChoice;
  }

  if (isRecord(toolChoice) && toolChoice.type === "function") {
    return { function: { name: asText(toolChoice.name) }, type: "function" };
  }

  return toolChoice;
};

const responsesInstructionsToChatMessage = (
  instructions: unknown
): Record<string, unknown> | null => {
  if (instructions === undefined || instructions === null) {
    return null;
  }

  if (typeof instructions === "string") {
    return instructions.length > 0
      ? { content: instructions, role: "system" }
      : null;
  }

  if (!Array.isArray(instructions)) {
    const content = asText(instructions);
    return content.length > 0 ? { content, role: "system" } : null;
  }

  const parts: string[] = [];
  for (const item of instructions) {
    if (typeof item === "string") {
      parts.push(item);
      continue;
    }

    if (
      isRecord(item) &&
      (item.type === "input_text" ||
        item.type === "output_text" ||
        item.type === "text")
    ) {
      parts.push(asText(item.text));
    }
  }

  const content = parts.filter(Boolean).join("\n");
  return content.length > 0 ? { content, role: "system" } : null;
};

export const patchApplyPatchTool = <T extends JsonObject>(body: T): T => {
  const { tools } = body;
  if (!Array.isArray(tools)) {
    return body;
  }

  for (const tool of tools) {
    if (!isRecord(tool)) {
      continue;
    }

    if (tool.type === "custom" && tool.name === "apply_patch") {
      tool.type = "function";
      tool.description = "Use the `apply_patch` tool to edit files";
      tool.parameters = {
        properties: {
          input: {
            description: "The entire contents of the apply_patch command",
            type: "string",
          },
        },
        required: ["input"],
        type: "object",
      };
      tool.strict = false;
    }
  }

  return body;
};

export const normalizeResponsesRequest = <T extends JsonObject>(body: T): T => {
  const { input } = body;
  if (!Array.isArray(input)) {
    return body;
  }

  for (const item of input) {
    if (isRecord(item)) {
      delete item.phase;
    }
  }

  return body;
};

const appendAnthropicAssistantMessage = (
  messages: Record<string, unknown>[],
  content: readonly unknown[]
): void => {
  const parts: Record<string, unknown>[] = [];
  const toolCalls: Record<string, unknown>[] = [];

  for (const block of content) {
    if (isRecord(block) && block.type === "tool_use") {
      toolCalls.push({
        function: {
          arguments: stringifyJson(block.input),
          name: asText(block.name),
        },
        id: asText(block.id ?? createId("call")),
        type: "function",
      });
      continue;
    }

    const part = anthropicBlockToChatPart(block);
    if (part !== null) {
      parts.push(part);
    }
  }

  if (toolCalls.length > 0) {
    messages.push({
      content: parts.length > 0 ? chatContentFromParts(parts) : null,
      role: "assistant",
      tool_calls: toolCalls,
    });
    return;
  }

  if (parts.length > 0) {
    messages.push({
      content: chatContentFromParts(parts),
      role: "assistant",
    });
  }
};

const appendAnthropicMessageContent = (
  messages: Record<string, unknown>[],
  role: string,
  content: readonly unknown[]
): void => {
  const pendingParts: Record<string, unknown>[] = [];
  const flushPendingParts = (): void => {
    if (pendingParts.length === 0) {
      return;
    }

    messages.push({ content: chatContentFromParts(pendingParts), role });
    pendingParts.length = 0;
  };

  for (const block of content) {
    if (isRecord(block) && block.type === "tool_result") {
      flushPendingParts();
      const toolContent = flattenTextBlocks(block.content);
      messages.push({
        content:
          block.is_error === true ? `[ERROR] ${toolContent}` : toolContent,
        role: "tool",
        tool_call_id: asText(block.tool_use_id),
      });
      continue;
    }

    const part = anthropicBlockToChatPart(block);
    if (part !== null) {
      pendingParts.push(part);
    }
  }

  flushPendingParts();
};

const buildAnthropicChatMessages = (
  body: JsonObject
): Record<string, unknown>[] => {
  const messages: Record<string, unknown>[] = [];
  const { system } = body;

  if (typeof system === "string" && system.length > 0) {
    messages.push({ content: system, role: "system" });
  } else if (Array.isArray(system)) {
    const textParts = system
      .filter(isRecord)
      .filter((block) => block.type === "text")
      .map((block) => asText(block.text))
      .filter(Boolean);

    if (textParts.length > 0) {
      messages.push({ content: textParts.join("\n"), role: "system" });
    }
  }

  for (const rawMessage of Array.isArray(body.messages) ? body.messages : []) {
    if (!isRecord(rawMessage)) {
      continue;
    }

    const role = asText(rawMessage.role ?? "user");
    const { content } = rawMessage;

    if (typeof content === "string") {
      messages.push({ content, role });
      continue;
    }

    if (!Array.isArray(content)) {
      messages.push({ content: asText(content), role });
      continue;
    }

    if (role === "assistant") {
      appendAnthropicAssistantMessage(messages, content);
      continue;
    }

    appendAnthropicMessageContent(messages, role, content);
  }

  return messages;
};

export const anthropicToOpenAiChatRequest = (
  body: JsonObject
): Record<string, unknown> => {
  const request: Record<string, unknown> = {
    messages: buildAnthropicChatMessages(body),
    model: mapAnthropicModelToCopilot(asText(body.model ?? "gpt-4o")),
  };

  if (body.max_tokens !== undefined) {
    request.max_tokens = body.max_tokens;
  }

  if (body.temperature !== undefined) {
    request.temperature = body.temperature;
  }

  if (body.top_p !== undefined) {
    request.top_p = body.top_p;
  }

  if (Array.isArray(body.stop_sequences)) {
    request.stop = body.stop_sequences;
  }

  if (body.stream !== undefined) {
    request.stream = body.stream;
  }

  if (Array.isArray(body.tools)) {
    request.tools = convertAnthropicToolsToOpenAi(body.tools);
  }

  if (body.tool_choice !== undefined) {
    request.tool_choice = convertAnthropicToolChoiceToOpenAi(body.tool_choice);
  }

  return request;
};

const buildAnthropicResponsesInputItems = (
  body: JsonObject
): Record<string, unknown>[] => {
  const inputItems: Record<string, unknown>[] = [];
  const { system } = body;

  if (typeof system === "string" && system.length > 0) {
    inputItems.push({
      content: [{ text: system, type: "input_text" }],
      role: "system",
    });
  } else if (Array.isArray(system)) {
    const textParts = system
      .filter(isRecord)
      .filter((block) => block.type === "text")
      .map((block) => asText(block.text))
      .filter(Boolean);

    if (textParts.length > 0) {
      inputItems.push({
        content: [{ text: textParts.join("\n"), type: "input_text" }],
        role: "system",
      });
    }
  }

  const appendMessageContent = (
    role: string,
    contentBlocks: readonly unknown[]
  ): void => {
    const pendingContent: Record<string, unknown>[] = [];
    const flushPendingContent = (): void => {
      if (pendingContent.length === 0) {
        return;
      }

      inputItems.push({ content: [...pendingContent], role });
      pendingContent.length = 0;
    };

    for (const block of contentBlocks) {
      if (typeof block === "string") {
        pendingContent.push({ text: block, type: "input_text" });
        continue;
      }

      if (!isRecord(block)) {
        continue;
      }

      if (block.type === "text") {
        pendingContent.push({ text: asText(block.text), type: "input_text" });
        continue;
      }

      if (block.type === "image" && isRecord(block.source)) {
        if (block.source.type === "base64") {
          const mediaType = asText(block.source.media_type ?? "image/png");
          const data = asText(block.source.data);
          pendingContent.push({
            image_url: `data:${mediaType};base64,${data}`,
            type: "input_image",
          });
          continue;
        }

        if (block.source.type === "url") {
          pendingContent.push({
            image_url: asText(block.source.url),
            type: "input_image",
          });
          continue;
        }
      }

      if (block.type === "tool_use" && role === "assistant") {
        flushPendingContent();
        inputItems.push({
          arguments: stringifyJson(block.input),
          call_id: asText(block.id ?? createId("call")),
          name: asText(block.name),
          type: "function_call",
        });
        continue;
      }

      if (block.type === "tool_result" && role === "user") {
        flushPendingContent();
        inputItems.push({
          call_id: asText(block.tool_use_id),
          output: flattenTextBlocks(block.content),
          type: "function_call_output",
        });
      }
    }

    flushPendingContent();
  };

  for (const rawMessage of Array.isArray(body.messages) ? body.messages : []) {
    if (!isRecord(rawMessage)) {
      continue;
    }

    const role = asText(rawMessage.role ?? "user");
    const { content } = rawMessage;

    if (typeof content === "string") {
      inputItems.push({
        content: [{ text: content, type: "input_text" }],
        role,
      });
      continue;
    }

    if (!Array.isArray(content)) {
      continue;
    }

    appendMessageContent(role, content);
  }

  return inputItems;
};

export const anthropicToOpenAiResponsesRequest = (
  body: JsonObject
): Record<string, unknown> => {
  const request: Record<string, unknown> = {
    input: buildAnthropicResponsesInputItems(body),
    model: mapAnthropicModelToCopilot(asText(body.model ?? "gpt-4o")),
  };

  if (body.max_tokens !== undefined) {
    request.max_output_tokens = body.max_tokens;
  }

  if (body.temperature !== undefined) {
    request.temperature = body.temperature;
  }

  if (body.top_p !== undefined) {
    request.top_p = body.top_p;
  }

  if (body.stream !== undefined) {
    request.stream = body.stream;
  }

  if (Array.isArray(body.tools)) {
    request.tools = convertAnthropicToolsToResponses(body.tools);
  }

  if (body.tool_choice !== undefined) {
    request.tool_choice = convertAnthropicToolChoiceToResponses(
      body.tool_choice
    );
  }

  return request;
};

const normalizeResponsesInputItems = (input: unknown): readonly unknown[] => {
  if (typeof input === "string") {
    return [{ content: input, role: "user" }];
  }

  if (isRecord(input)) {
    return [input];
  }

  return Array.isArray(input) ? input : [];
};

const buildChatMessagesFromResponsesInput = (
  normalized: JsonObject
): Record<string, unknown>[] => {
  const messages: Record<string, unknown>[] = [];
  const pendingToolCalls: Record<string, unknown>[] = [];

  const flushToolCalls = (): void => {
    if (pendingToolCalls.length === 0) {
      return;
    }

    messages.push({
      content: null,
      role: "assistant",
      tool_calls: [...pendingToolCalls],
    });
    pendingToolCalls.length = 0;
  };

  const instructionsMessage = responsesInstructionsToChatMessage(
    normalized.instructions
  );
  if (instructionsMessage !== null) {
    messages.push(instructionsMessage);
  }

  const { input } = normalized;
  const inputItems = normalizeResponsesInputItems(input);

  for (const item of inputItems) {
    if (!isRecord(item)) {
      continue;
    }

    if (item.type === "function_call") {
      pendingToolCalls.push({
        function: {
          arguments: asText(item.arguments ?? "{}"),
          name: asText(item.name),
        },
        id: asText(item.call_id ?? item.id ?? createId("call")),
        type: "function",
      });
      continue;
    }

    if (item.type === "function_call_output") {
      flushToolCalls();
      messages.push({
        content: asText(item.output),
        role: "tool",
        tool_call_id: asText(item.call_id),
      });
      continue;
    }

    flushToolCalls();
    if (typeof item.role !== "string" || item.role.length === 0) {
      continue;
    }

    messages.push({
      content: responsesInputItemToChatContent(item),
      role: item.role,
    });
  }

  flushToolCalls();
  return messages;
};

export const openAiResponsesToChatRequest = (
  body: JsonObject
): Record<string, unknown> => {
  const normalized = patchApplyPatchTool(
    normalizeResponsesRequest(cloneJson(body))
  );
  const messages = buildChatMessagesFromResponsesInput(normalized);

  const request: Record<string, unknown> = {
    messages: messages.length > 0 ? messages : [{ content: "", role: "user" }],
    model: asText(normalized.model ?? "gpt-4o"),
  };

  if (normalized.temperature !== undefined) {
    request.temperature = normalized.temperature;
  }

  if (normalized.top_p !== undefined) {
    request.top_p = normalized.top_p;
  }

  if (normalized.max_output_tokens !== undefined) {
    request.max_completion_tokens = normalized.max_output_tokens;
  }

  if (Array.isArray(normalized.tools)) {
    request.tools = convertResponsesToolsToOpenAiChat(normalized.tools);
  }

  if (normalized.tool_choice !== undefined) {
    request.tool_choice = convertResponsesToolChoiceToOpenAiChat(
      normalized.tool_choice
    );
  }

  if (normalized.parallel_tool_calls !== undefined) {
    request.parallel_tool_calls = normalized.parallel_tool_calls;
  }

  return request;
};

const buildResponsesInputItemsFromChat = (
  body: JsonObject
): Record<string, unknown>[] => {
  const inputItems: Record<string, unknown>[] = [];

  for (const rawMessage of Array.isArray(body.messages) ? body.messages : []) {
    if (!isRecord(rawMessage)) {
      continue;
    }

    const role = asText(rawMessage.role ?? "user");
    const { content } = rawMessage;

    if (role === "tool") {
      inputItems.push({
        call_id: asText(rawMessage.tool_call_id),
        output: openAiChatToolResultToOutputText(content),
        type: "function_call_output",
      });
      continue;
    }

    const messageContent = openAiChatContentToResponsesParts(content);
    if (messageContent.length > 0) {
      inputItems.push({ content: messageContent, role });
    }

    if (role !== "assistant" || !Array.isArray(rawMessage.tool_calls)) {
      continue;
    }

    for (const rawToolCall of rawMessage.tool_calls) {
      if (!isRecord(rawToolCall)) {
        continue;
      }

      const fn = isRecord(rawToolCall.function) ? rawToolCall.function : {};
      inputItems.push({
        arguments: asText(fn.arguments ?? "{}"),
        call_id: asText(rawToolCall.id ?? createId("call")),
        name: asText(fn.name),
        type: "function_call",
      });
    }
  }

  return inputItems;
};

export const openAiChatToResponsesRequest = (
  body: JsonObject
): Record<string, unknown> => {
  const request: Record<string, unknown> = {
    input: buildResponsesInputItemsFromChat(body),
    model: asText(body.model ?? "gpt-4o"),
  };

  if (body.temperature !== undefined) {
    request.temperature = body.temperature;
  }

  if (body.top_p !== undefined) {
    request.top_p = body.top_p;
  }

  if (body.stream !== undefined) {
    request.stream = body.stream;
  }

  if (body.max_completion_tokens !== undefined) {
    request.max_output_tokens = body.max_completion_tokens;
  } else if (body.max_tokens !== undefined) {
    request.max_output_tokens = body.max_tokens;
  }

  if (Array.isArray(body.tools)) {
    request.tools = convertOpenAiChatToolsToResponses(body.tools);
  }

  if (body.tool_choice !== undefined) {
    request.tool_choice = convertOpenAiChatToolChoiceToResponses(
      body.tool_choice
    );
  }

  if (body.parallel_tool_calls !== undefined) {
    request.parallel_tool_calls = body.parallel_tool_calls;
  }

  return request;
};

export interface RequestTransformApi {
  readonly anthropicToOpenAiChatRequest: typeof anthropicToOpenAiChatRequest;
  readonly anthropicToOpenAiResponsesRequest: typeof anthropicToOpenAiResponsesRequest;
  readonly normalizeResponsesRequest: typeof normalizeResponsesRequest;
  readonly openAiChatToResponsesRequest: typeof openAiChatToResponsesRequest;
  readonly openAiResponsesToChatRequest: typeof openAiResponsesToChatRequest;
  readonly patchApplyPatchTool: typeof patchApplyPatchTool;
}
