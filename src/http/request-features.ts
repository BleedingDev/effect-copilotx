type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asJsonRecord = (value: unknown): JsonRecord | undefined =>
  isRecord(value) ? value : undefined;

const asJsonRecordArray = (
  value: unknown
): readonly JsonRecord[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value.flatMap((item) => {
    const record = asJsonRecord(item);
    return record === undefined ? [] : [record];
  });
};

const IMAGE_INPUT_TYPES = new Set(["input_image", "image", "image_url"]);
const AGENT_ITEM_TYPES = new Set([
  "function_call",
  "function_call_output",
  "reasoning",
]);

export const responsesRequestHasVisionInput = (body: unknown): boolean => {
  const requestBody = asJsonRecord(body);
  const inputItems = asJsonRecordArray(requestBody?.input);
  if (inputItems === undefined) {
    return false;
  }

  return inputItems.some((item) => {
    const contentItems = asJsonRecordArray(item.content);
    if (contentItems === undefined) {
      return false;
    }

    return contentItems.some((part) => {
      const partType = typeof part.type === "string" ? part.type : "";
      return IMAGE_INPUT_TYPES.has(partType);
    });
  });
};

export const responsesRequestInitiator = (body: unknown): "agent" | "user" => {
  const requestBody = asJsonRecord(body);
  const inputItems = asJsonRecordArray(requestBody?.input);
  if (inputItems === undefined || inputItems.length === 0) {
    return "user";
  }

  const lastItem = inputItems.at(-1);
  if (lastItem === undefined) {
    return "user";
  }

  const role =
    typeof lastItem.role === "string" ? lastItem.role.toLowerCase() : "";
  const itemType =
    typeof lastItem.type === "string" ? lastItem.type.toLowerCase() : "";

  if (role === "assistant") {
    return "agent";
  }

  return AGENT_ITEM_TYPES.has(itemType) ? "agent" : "user";
};
