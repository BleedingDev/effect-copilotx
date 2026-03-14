type JsonRecord = Record<string, unknown>;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const RESPONSE_EVENT_TYPES = [
  "response.output_item.added",
  "response.output_item.done",
  "response.output_text.delta",
  "response.output_text.done",
  "response.function_call_arguments.delta",
  "response.function_call_arguments.done",
  "response.reasoning_summary_text.delta",
  "response.reasoning_summary_text.done",
  "response.created",
  "response.completed",
  "response.incomplete",
  "response.failed",
  "error",
] as const;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asJsonRecord = (value: unknown): JsonRecord | undefined =>
  isRecord(value) ? value : undefined;

const parseJsonRecord = (value: string): JsonRecord | undefined => {
  try {
    return asJsonRecord(JSON.parse(value));
  } catch {
    return undefined;
  }
};

const readOutputIndex = (payload: JsonRecord): number | undefined => {
  const outputIndex = payload.output_index;
  if (typeof outputIndex !== "number" || !Number.isInteger(outputIndex)) {
    return undefined;
  }

  return outputIndex;
};

const toItemRecord = (payload: JsonRecord): JsonRecord => {
  const item = asJsonRecord(payload.item);
  return item === undefined ? {} : { ...item };
};

const generateTrackedItemId = (
  outputIndex: number,
  counter: number
): string => {
  const micros =
    BigInt(Date.now()) * 1000n +
    BigInt(Math.trunc(performance.now() * 1000) % 1000);

  return `oi_${outputIndex}_${micros.toString(16)}${counter
    .toString(16)
    .padStart(4, "0")}`;
};

export class ResponsesStreamIdTracker {
  readonly #outputItems = new Map<number, string>();
  #idCounter = 0;

  fixStreamData(dataString: string, eventType?: string | null): string {
    if (dataString.length === 0) {
      return dataString;
    }

    switch (eventType) {
      case "response.output_item.added": {
        return this.#handleAdded(dataString);
      }
      case "response.output_item.done": {
        return this.#handleDone(dataString);
      }
      case undefined:
      case null: {
        // Upstream emits additional event types we do not need to rewrite.
        return dataString;
      }
      default: {
        return this.#handleOther(dataString);
      }
    }
  }

  #nextItemId(outputIndex: number): string {
    this.#idCounter += 1;
    return generateTrackedItemId(outputIndex, this.#idCounter);
  }

  #handleAdded(dataString: string): string {
    const payload = parseJsonRecord(dataString);
    if (payload === undefined) {
      return dataString;
    }

    const outputIndex = readOutputIndex(payload);
    if (outputIndex === undefined) {
      return dataString;
    }

    const item = toItemRecord(payload);
    let itemId = typeof item.id === "string" ? item.id : "";
    if (itemId.length === 0) {
      itemId = this.#nextItemId(outputIndex);
      item.id = itemId;
    }

    this.#outputItems.set(outputIndex, itemId);
    return JSON.stringify({ ...payload, item });
  }

  #handleDone(dataString: string): string {
    const payload = parseJsonRecord(dataString);
    if (payload === undefined) {
      return dataString;
    }

    const outputIndex = readOutputIndex(payload);
    if (outputIndex === undefined) {
      return dataString;
    }

    const originalId = this.#outputItems.get(outputIndex);
    if (originalId === undefined) {
      return JSON.stringify(payload);
    }

    const item = toItemRecord(payload);
    item.id = originalId;
    return JSON.stringify({ ...payload, item });
  }

  #handleOther(dataString: string): string {
    const payload = parseJsonRecord(dataString);
    if (payload === undefined) {
      return dataString;
    }

    const outputIndex = readOutputIndex(payload);
    if (outputIndex === undefined) {
      return dataString;
    }

    const originalId = this.#outputItems.get(outputIndex);
    if (originalId === undefined) {
      return dataString;
    }

    return JSON.stringify({ ...payload, item_id: originalId });
  }
}

export const extractResponsesEventType = (
  dataString: string
): (typeof RESPONSE_EVENT_TYPES)[number] | undefined =>
  RESPONSE_EVENT_TYPES.find((eventType) =>
    dataString.includes(`"type":"${eventType}"`)
  );

export const fixResponsesStream = async function* fixResponsesStreamGenerator(
  rawLines: AsyncIterable<Uint8Array>
): AsyncIterable<Uint8Array> {
  const tracker = new ResponsesStreamIdTracker();

  for await (const rawLine of rawLines) {
    const line = textDecoder.decode(rawLine).replace(/\n$/u, "");

    if (line.length === 0) {
      yield textEncoder.encode("\n");
      continue;
    }

    if (!line.startsWith("data: ")) {
      yield textEncoder.encode(`${line}\n`);
      continue;
    }

    const dataString = line.slice(6);
    if (dataString === "[DONE]") {
      yield rawLine;
      continue;
    }

    const eventType = extractResponsesEventType(dataString);
    const fixedData = tracker.fixStreamData(dataString, eventType);
    yield textEncoder.encode(`data: ${fixedData}\n`);
  }

  yield textEncoder.encode("\n");
};
