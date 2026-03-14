export type JsonPrimitive = boolean | null | number | string;
export type JsonObject = Readonly<Record<string, unknown>>;
export type JsonArray = readonly unknown[];
export type JsonValue = JsonArray | JsonObject | JsonPrimitive;

export const ANTHROPIC_TO_COPILOT_MODEL_MAP: Readonly<Record<string, string>> =
  {
    "claude-3-5-sonnet": "claude-sonnet-4",
    "claude-3-5-sonnet-20240620": "claude-sonnet-4",
    "claude-3-5-sonnet-20241022": "claude-sonnet-4",
    "claude-3-haiku": "claude-haiku-4.5",
    "claude-3-haiku-20240307": "claude-haiku-4.5",
    "claude-3-opus": "claude-opus-41",
    "claude-3-opus-20240229": "claude-opus-41",
    "claude-3.0-haiku": "claude-haiku-4.5",
    "claude-3.0-opus": "claude-opus-41",
    "claude-3.5-sonnet": "claude-sonnet-4",
    "claude-4-5-haiku": "claude-haiku-4.5",
    "claude-4-5-opus": "claude-opus-4.5",
    "claude-4-5-sonnet": "claude-sonnet-4.5",
    "claude-4-6-opus": "claude-opus-4.6",
    "claude-4-opus": "claude-opus-41",
    "claude-4-sonnet": "claude-sonnet-4",
    "claude-4.5-haiku": "claude-haiku-4.5",
    "claude-4.5-opus": "claude-opus-4.5",
    "claude-4.5-sonnet": "claude-sonnet-4.5",
    "claude-4.6-opus": "claude-opus-4.6",
    "claude-haiku-4-5": "claude-haiku-4.5",
    "claude-haiku-4.5": "claude-haiku-4.5",
    "claude-opus-4": "claude-opus-41",
    "claude-opus-4-20250514": "claude-opus-41",
    "claude-opus-4-5-20250929": "claude-opus-4.5",
    "claude-opus-4-6": "claude-opus-4.6",
    "claude-opus-4.5-20250929": "claude-opus-4.5",
    "claude-opus-4.6": "claude-opus-4.6",
    "claude-sonnet-4": "claude-sonnet-4",
    "claude-sonnet-4-20250514": "claude-sonnet-4",
    "claude-sonnet-4-5-20250929": "claude-sonnet-4.5",
    "claude-sonnet-4.5-20250929": "claude-sonnet-4.5",
  };

export const mapAnthropicModelToCopilot = (model: string): string => {
  const mappedModel = ANTHROPIC_TO_COPILOT_MODEL_MAP[model];
  if (mappedModel !== undefined) {
    return mappedModel;
  }

  if (model.includes(".")) {
    return model;
  }

  const normalizedModel = model.toLowerCase();

  if (normalizedModel.includes("sonnet")) {
    if (normalizedModel.includes("4-5") || normalizedModel.includes("4.5")) {
      return "claude-sonnet-4.5";
    }

    return "claude-sonnet-4";
  }

  if (normalizedModel.includes("opus")) {
    if (normalizedModel.includes("4-6") || normalizedModel.includes("4.6")) {
      return "claude-opus-4.6";
    }

    if (normalizedModel.includes("4-5") || normalizedModel.includes("4.5")) {
      return "claude-opus-4.5";
    }

    return "claude-opus-41";
  }

  if (normalizedModel.includes("haiku")) {
    return "claude-haiku-4.5";
  }

  return model;
};
