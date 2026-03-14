import type { AccountUsageDelta } from "#/domain/accounts/account-types";
import { decodeSseLine } from "#/services/copilot-client";

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asInteger = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(Math.floor(value), 0) : 0;

const extractUsageRecord = (payload: JsonRecord): JsonRecord | null => {
  const usage = payload.usage;
  return isRecord(usage) ? usage : null;
};

const usageDeltaFromUsageRecord = (
  usage: JsonRecord,
  stream: boolean
): AccountUsageDelta => ({
  inputTokenCount: asInteger(usage.input_tokens ?? usage.prompt_tokens),
  outputTokenCount: asInteger(usage.output_tokens ?? usage.completion_tokens),
  successfulRequestCount: stream ? 0 : 1,
  successfulStreamCount: stream ? 1 : 0,
});

export const extractUsageDelta = (
  payload: JsonRecord,
  stream = false
): AccountUsageDelta => {
  const usage = extractUsageRecord(payload);
  if (usage === null) {
    return {
      successfulRequestCount: stream ? 0 : 1,
      successfulStreamCount: stream ? 1 : 0,
    };
  }

  return usageDeltaFromUsageRecord(usage, stream);
};

const decodeJsonData = (line: string): JsonRecord | null => {
  if (!line.startsWith("data: ")) {
    return null;
  }

  const data = line.slice(6).trim();
  if (data.length === 0 || data === "[DONE]") {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(data);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

export const trackChatCompletionsStreamUsage = (
  events: AsyncIterable<Uint8Array>,
  onComplete: (delta: AccountUsageDelta) => Promise<void>
): AsyncIterable<Uint8Array> => ({
  async *[Symbol.asyncIterator]() {
    let completionSeen = false;
    let inputTokenCount = 0;
    let outputTokenCount = 0;

    try {
      for await (const chunk of events) {
        const payload = decodeJsonData(decodeSseLine(chunk));
        if (payload !== null) {
          const usage = extractUsageRecord(payload);
          if (usage !== null) {
            completionSeen = true;
            inputTokenCount = asInteger(
              usage.input_tokens ?? usage.prompt_tokens ?? inputTokenCount
            );
            outputTokenCount = asInteger(
              usage.output_tokens ?? usage.completion_tokens ?? outputTokenCount
            );
          }
        }

        yield chunk;
      }
    } finally {
      if (completionSeen) {
        await onComplete({
          inputTokenCount,
          outputTokenCount,
          successfulRequestCount: 0,
          successfulStreamCount: 1,
        });
      }
    }
  },
});

export const trackResponsesStreamUsage = (
  events: AsyncIterable<Uint8Array>,
  onComplete: (delta: AccountUsageDelta) => Promise<void>
): AsyncIterable<Uint8Array> => ({
  async *[Symbol.asyncIterator]() {
    let completionSeen = false;
    let currentEvent = "";
    let inputTokenCount = 0;
    let outputTokenCount = 0;

    try {
      for await (const chunk of events) {
        const line = decodeSseLine(chunk);
        if (line.startsWith("event: ")) {
          currentEvent = line.slice(7).trim();
        } else if (line.length === 0) {
          currentEvent = "";
        } else {
          const payload = decodeJsonData(line);
          const payloadType = payload === null ? "" : String(payload.type ?? "");
          const eventType = currentEvent || payloadType;

          if (payload !== null && eventType === "response.completed") {
            const response = isRecord(payload.response) ? payload.response : null;
            const usage = response === null ? null : extractUsageRecord(response);
            if (usage !== null) {
              completionSeen = true;
              inputTokenCount = asInteger(usage.input_tokens ?? inputTokenCount);
              outputTokenCount = asInteger(usage.output_tokens ?? outputTokenCount);
            }
          }
        }

        yield chunk;
      }
    } finally {
      if (completionSeen) {
        await onComplete({
          inputTokenCount,
          outputTokenCount,
          successfulRequestCount: 0,
          successfulStreamCount: 1,
        });
      }
    }
  },
});
