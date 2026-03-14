import {
  COPILOT_API_BASE_FALLBACK,
  COPILOT_CHAT_COMPLETIONS_PATH,
  COPILOT_HEADERS,
  COPILOT_MODELS_PATH,
  COPILOT_RESPONSES_PATH,
  DEFAULT_MODEL_CACHE_TTL_SECONDS,
  DEFAULT_REQUEST_TIMEOUT_MS,
} from "#/config/copilot-constants";
import { UpstreamHttpError } from "#/http/upstream-compat";

type JsonRecord = Record<string, unknown>;
type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>;

export interface CopilotModelRecord extends JsonRecord {
  readonly copilotx_forced?: boolean;
  readonly id?: string;
  readonly model_picker_enabled?: boolean;
  readonly name?: string;
  readonly vendor?: string;
}

export interface CopilotClientOptions {
  readonly apiBaseUrl?: string;
  readonly fetch?: FetchLike;
  readonly forcedModelIds?: readonly string[];
  readonly modelCacheTtlSeconds?: number;
  readonly requestTimeoutMs?: number;
}

export interface CopilotRequestOptions {
  readonly signal?: AbortSignal;
}

export interface CopilotResponsesRequestOptions extends CopilotRequestOptions {
  readonly initiator?: string;
  readonly vision?: boolean;
}

const textEncoder = new TextEncoder();

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asJsonRecord = (value: unknown): JsonRecord | undefined =>
  isRecord(value) ? value : undefined;

const normalizeApiBase = (apiBaseUrl: string): string =>
  apiBaseUrl.trim().replace(/\/+$/u, "") || COPILOT_API_BASE_FALLBACK;

const normalizeForcedModelIds = (
  forcedModelIds: readonly string[] | undefined
): readonly string[] => {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const modelId of forcedModelIds ?? []) {
    const trimmed = modelId.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) {
      continue;
    }

    seen.add(trimmed);
    normalized.push(trimmed);
  }

  return normalized;
};

export const inferModelVendor = (modelId: string): string => {
  const modelLower = modelId.toLowerCase();
  if (modelLower.startsWith("claude-")) {
    return "Anthropic";
  }
  if (modelLower.startsWith("gemini-")) {
    return "Google";
  }
  if (modelLower.startsWith("grok-")) {
    return "xAI";
  }
  if (modelLower.startsWith("gpt-") || modelLower.includes("codex")) {
    return "OpenAI";
  }

  return "github-copilot";
};

export const mergeForcedModels = (
  models: readonly unknown[],
  forcedModelIds: readonly string[] = []
): readonly CopilotModelRecord[] => {
  const forcedIdSet = new Set(forcedModelIds);
  const mergedModels: CopilotModelRecord[] = [];
  const seenModelIds = new Set<string>();

  for (const model of models) {
    const modelRecord = asJsonRecord(model);
    if (modelRecord === undefined) {
      continue;
    }

    const modelId =
      typeof modelRecord.id === "string" ? modelRecord.id.trim() : "";
    if (modelId.length === 0 || seenModelIds.has(modelId)) {
      continue;
    }

    seenModelIds.add(modelId);
    mergedModels.push({
      ...modelRecord,
      ...(forcedIdSet.has(modelId) ? { copilotx_forced: true } : {}),
    });
  }

  for (const modelId of forcedModelIds) {
    if (seenModelIds.has(modelId)) {
      continue;
    }

    seenModelIds.add(modelId);
    mergedModels.push({
      copilotx_forced: true,
      id: modelId,
      model_picker_enabled: false,
      name: modelId,
      vendor: inferModelVendor(modelId),
    });
  }

  return mergedModels;
};

const mergeSignals = (
  signal: AbortSignal | undefined,
  timeoutMs: number
): AbortSignal | undefined => {
  const signals: AbortSignal[] = [];
  if (signal !== undefined) {
    signals.push(signal);
  }
  if (timeoutMs > 0) {
    signals.push(AbortSignal.timeout(timeoutMs));
  }

  if (signals.length === 0) {
    return undefined;
  }

  const [onlySignal] = signals;
  if (onlySignal !== undefined) {
    return onlySignal;
  }

  return AbortSignal.any(signals);
};

const withSignalOption = (signal: AbortSignal | undefined) =>
  signal === undefined ? {} : { signal };

const applyExtraHeaders = (
  headers: Headers,
  extraHeaders: HeadersInit | undefined
): void => {
  if (extraHeaders === undefined) {
    return;
  }

  if (extraHeaders instanceof Headers) {
    for (const [key, value] of extraHeaders) {
      headers.set(key, value);
    }
    return;
  }

  if (Array.isArray(extraHeaders)) {
    for (const [key, value] of extraHeaders) {
      headers.set(key, value);
    }
    return;
  }

  for (const [key, value] of Object.entries(extraHeaders)) {
    if (value !== undefined) {
      headers.set(key, value);
    }
  }
};

const buildJsonParseError = (
  method: string,
  url: string,
  responseText: string,
  cause: unknown
): Error =>
  new Error(
    `Expected JSON response from ${method.toUpperCase()} ${url}: ${responseText.slice(0, 500)}`,
    cause === undefined ? undefined : { cause }
  );

const tryParseJsonRecord = (responseText: string): JsonRecord => {
  if (responseText.length === 0) {
    return {};
  }

  try {
    return asJsonRecord(JSON.parse(responseText)) ?? {};
  } catch {
    return {};
  }
};

const parseJsonResponse = (
  method: string,
  url: string,
  responseText: string
): unknown => {
  try {
    const parsed = JSON.parse(responseText) as unknown;
    return parsed;
  } catch (error) {
    throw buildJsonParseError(method, url, responseText, error);
  }
};

const trimTrailingNewline = (line: string): string => line.replace(/\n$/u, "");

const emptyUint8Stream =
  async function* emptyUint8StreamGenerator(): AsyncIterable<Uint8Array> {
    yield* [];
  };

const streamResponseLines = async function* streamResponseLinesGenerator(
  body: ReadableStream<Uint8Array>
): AsyncIterable<Uint8Array> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      while (true) {
        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex === -1) {
          break;
        }

        const line = buffer.slice(0, newlineIndex).replace(/\r$/u, "");
        buffer = buffer.slice(newlineIndex + 1);
        yield textEncoder.encode(`${line}\n`);
      }
    }

    buffer += decoder.decode();
    if (buffer.length > 0) {
      yield textEncoder.encode(`${buffer.replace(/\r$/u, "")}\n`);
    }
  } finally {
    reader.releaseLock();
  }
};

const buildResponsesExtraHeaders = (
  vision: boolean,
  initiator: string
): HeadersInit => {
  const headers: Record<string, string> = {
    "X-Initiator": initiator,
  };

  if (vision) {
    headers["copilot-vision-request"] = "true";
  }

  return headers;
};

const prepareResponsesPayload = (
  payload: JsonRecord,
  stream: boolean
): JsonRecord => {
  const nextPayload: JsonRecord = {
    ...payload,
    ...(stream ? { stream: true } : {}),
  };
  delete nextPayload["service_tier"];
  return nextPayload;
};

const prepareChatCompletionsStreamPayload = (payload: JsonRecord): JsonRecord => {
  const streamOptions = asJsonRecord(payload.stream_options) ?? {};
  return {
    ...payload,
    stream: true,
    stream_options: { ...streamOptions, include_usage: true },
  };
};

export class CopilotClient {
  #apiBase: string;
  readonly #fetch: FetchLike;
  readonly #forcedModelIds: readonly string[];
  readonly #modelCacheTtlMs: number;
  #modelsCache: readonly CopilotModelRecord[] | null = null;
  #modelsCacheTime = 0;
  readonly #requestTimeoutMs: number;
  #token: string;

  constructor(copilotToken: string, options: CopilotClientOptions = {}) {
    this.#apiBase = normalizeApiBase(
      options.apiBaseUrl ?? COPILOT_API_BASE_FALLBACK
    );
    this.#fetch = options.fetch ?? fetch;
    this.#forcedModelIds = normalizeForcedModelIds(options.forcedModelIds);
    this.#modelCacheTtlMs =
      (options.modelCacheTtlSeconds ?? DEFAULT_MODEL_CACHE_TTL_SECONDS) * 1000;
    this.#requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.#token = copilotToken;
  }

  updateToken(token: string): void {
    this.#token = token;
  }

  updateApiBase(apiBaseUrl: string): void {
    if (apiBaseUrl.trim().length > 0) {
      this.#apiBase = normalizeApiBase(apiBaseUrl);
    }
  }

  async listModels(
    options: CopilotRequestOptions = {}
  ): Promise<readonly CopilotModelRecord[]> {
    const now = Date.now();
    if (
      this.#modelsCache !== null &&
      now - this.#modelsCacheTime < this.#modelCacheTtlMs
    ) {
      return this.#modelsCache;
    }

    const response = await this.#requestJson("GET", COPILOT_MODELS_PATH, {
      ...withSignalOption(options.signal),
    });
    const data = asJsonRecord(response) ?? {};
    let rawModels: readonly unknown[] = [];
    if (Array.isArray(data.data)) {
      rawModels = data.data;
    } else if (Array.isArray(data.models)) {
      rawModels = data.models;
    }

    const models = mergeForcedModels(rawModels, this.#forcedModelIds);
    this.#modelsCache = models;
    this.#modelsCacheTime = now;
    return models;
  }

  chatCompletions<TResponse = unknown>(
    payload: JsonRecord,
    options?: CopilotRequestOptions
  ): Promise<TResponse>;
  async chatCompletions(
    payload: JsonRecord,
    options: CopilotRequestOptions = {}
  ): Promise<unknown> {
    const response = await this.#requestJson(
      "POST",
      COPILOT_CHAT_COMPLETIONS_PATH,
      {
        ...withSignalOption(options.signal),
        body: payload,
      }
    );
    return response;
  }

  async chatCompletionsStream(
    payload: JsonRecord,
    options: CopilotRequestOptions = {}
  ): Promise<AsyncIterable<Uint8Array>> {
    const response = await this.#requestStream(
      "POST",
      COPILOT_CHAT_COMPLETIONS_PATH,
      {
        ...withSignalOption(options.signal),
        body: prepareChatCompletionsStreamPayload(payload),
      }
    );
    return response;
  }

  responses<TResponse = unknown>(
    payload: JsonRecord,
    options?: CopilotResponsesRequestOptions
  ): Promise<TResponse>;
  async responses(
    payload: JsonRecord,
    options: CopilotResponsesRequestOptions = {}
  ): Promise<unknown> {
    const response = await this.#requestJson("POST", COPILOT_RESPONSES_PATH, {
      ...withSignalOption(options.signal),
      body: prepareResponsesPayload(payload, false),
      headers: buildResponsesExtraHeaders(
        options.vision ?? false,
        options.initiator ?? "user"
      ),
    });
    return response;
  }

  async responsesStream(
    payload: JsonRecord,
    options: CopilotResponsesRequestOptions = {}
  ): Promise<AsyncIterable<Uint8Array>> {
    const response = await this.#requestStream("POST", COPILOT_RESPONSES_PATH, {
      ...withSignalOption(options.signal),
      body: prepareResponsesPayload(payload, true),
      headers: buildResponsesExtraHeaders(
        options.vision ?? false,
        options.initiator ?? "user"
      ),
    });
    return response;
  }

  #buildHeaders(extraHeaders?: HeadersInit): Headers {
    const headers = new Headers(COPILOT_HEADERS);
    headers.set("Authorization", `Bearer ${this.#token}`);
    headers.set("Content-Type", "application/json");
    applyExtraHeaders(headers, extraHeaders);
    return headers;
  }

  #buildUrl(path: string): string {
    return `${this.#apiBase}${path}`;
  }

  async #requestJson(
    method: string,
    path: string,
    options: {
      readonly body?: JsonRecord;
      readonly headers?: HeadersInit;
      readonly signal?: AbortSignal;
    }
  ): Promise<unknown> {
    const url = this.#buildUrl(path);
    const requestInit: RequestInit = {
      headers: this.#buildHeaders(options.headers),
      method,
    };

    if (options.body !== undefined) {
      requestInit.body = JSON.stringify(options.body);
    }

    const signal = mergeSignals(options.signal, this.#requestTimeoutMs);
    if (signal !== undefined) {
      requestInit.signal = signal;
    }

    const response = await this.#fetch(url, requestInit);

    const responseText = await response.text();
    const responseBody = tryParseJsonRecord(responseText);

    if (!response.ok) {
      throw new UpstreamHttpError({
        method,
        responseBody,
        responseText,
        statusCode: response.status,
        url,
      });
    }

    return parseJsonResponse(method, url, responseText);
  }

  async #requestStream(
    method: string,
    path: string,
    options: {
      readonly body: JsonRecord;
      readonly headers?: HeadersInit;
      readonly signal?: AbortSignal;
    }
  ): Promise<AsyncIterable<Uint8Array>> {
    const url = this.#buildUrl(path);
    const requestInit: RequestInit = {
      body: JSON.stringify(options.body),
      headers: this.#buildHeaders(options.headers),
      method,
    };

    const signal = mergeSignals(options.signal, this.#requestTimeoutMs);
    if (signal !== undefined) {
      requestInit.signal = signal;
    }

    const response = await this.#fetch(url, requestInit);

    if (!response.ok) {
      const responseText = await response.text();
      throw new UpstreamHttpError({
        method,
        responseBody: tryParseJsonRecord(responseText),
        responseText,
        statusCode: response.status,
        url,
      });
    }

    const { body } = response;
    if (body === null) {
      return emptyUint8Stream();
    }

    return streamResponseLines(body);
  }
}

export const decodeSseLine = (line: Uint8Array): string =>
  trimTrailingNewline(new TextDecoder().decode(line));
