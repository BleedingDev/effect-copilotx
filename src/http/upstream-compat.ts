type JsonRecord = Record<string, unknown>;

export interface UpstreamHttpErrorInit {
  readonly cause?: unknown;
  readonly method?: string;
  readonly responseBody?: unknown;
  readonly responseText: string;
  readonly statusCode: number;
  readonly url?: string;
}

export interface UpstreamErrorPayload {
  readonly payload: JsonRecord;
  readonly responseText: string;
  readonly statusCode: number | null;
}

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asJsonRecord = (value: unknown): JsonRecord | undefined =>
  isRecord(value) ? value : undefined;

const tryParseJsonRecord = (text: string): JsonRecord => {
  if (text.trim().length === 0) {
    return {};
  }

  try {
    return asJsonRecord(JSON.parse(text)) ?? {};
  } catch {
    return {};
  }
};

const extractStatusCode = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }

  return null;
};

const fallbackMessage = (statusCode: number, responseText: string) => {
  const preview = responseText.slice(0, 500);
  return preview.length > 0
    ? `HTTP ${statusCode}: ${preview}`
    : `HTTP ${statusCode}`;
};

export class UpstreamHttpError extends Error {
  readonly method: string | null;
  readonly responseBody: unknown;
  readonly responseText: string;
  readonly statusCode: number;
  readonly url: string | null;

  constructor({
    cause,
    method,
    responseBody,
    responseText,
    statusCode,
    url,
  }: UpstreamHttpErrorInit) {
    super(
      fallbackMessage(statusCode, responseText),
      cause === undefined ? undefined : { cause }
    );

    this.name = "UpstreamHttpError";
    const trimmedMethod = method?.trim() ?? "";
    const trimmedUrl = url?.trim() ?? "";
    this.method = trimmedMethod.length > 0 ? trimmedMethod : null;
    this.responseBody = responseBody;
    this.responseText = responseText;
    this.statusCode = statusCode;
    this.url = trimmedUrl.length > 0 ? trimmedUrl : null;
  }
}

export const extractUpstreamErrorPayload = (
  error: unknown
): UpstreamErrorPayload => {
  if (error instanceof UpstreamHttpError) {
    return {
      payload:
        asJsonRecord(error.responseBody) ??
        tryParseJsonRecord(error.responseText),
      responseText: error.responseText,
      statusCode: error.statusCode,
    };
  }

  const errorRecord = asJsonRecord(error);
  if (errorRecord === undefined) {
    return {
      payload: {},
      responseText: "",
      statusCode: null,
    };
  }

  const responseRecord = asJsonRecord(errorRecord.response);
  const { responseText: errorResponseText } = errorRecord;
  const responseRecordText = responseRecord?.text;
  let responseText = "";
  if (typeof errorResponseText === "string") {
    responseText = errorResponseText;
  } else if (typeof responseRecordText === "string") {
    responseText = responseRecordText;
  }

  return {
    payload:
      asJsonRecord(errorRecord.responseBody) ??
      asJsonRecord(responseRecord?.body) ??
      tryParseJsonRecord(responseText),
    responseText,
    statusCode:
      extractStatusCode(errorRecord.statusCode) ??
      extractStatusCode(responseRecord?.status) ??
      extractStatusCode(responseRecord?.statusCode),
  };
};

const unsupportedForModel = (
  error: unknown,
  expectedMessageFragment: string
): boolean => {
  const { payload, responseText, statusCode } =
    extractUpstreamErrorPayload(error);
  if (statusCode !== 400) {
    return false;
  }

  const errorBody = asJsonRecord(payload.error) ?? {};
  const code = typeof errorBody.code === "string" ? errorBody.code : "";
  const messageSource =
    typeof errorBody.message === "string" ? errorBody.message : responseText;
  const message = messageSource.toLowerCase();

  return (
    code === "unsupported_api_for_model" ||
    message.includes(expectedMessageFragment)
  );
};

export const isChatCompletionsUnsupportedForModel = (error: unknown): boolean =>
  unsupportedForModel(
    error,
    "not accessible via the /chat/completions endpoint"
  );

export const isResponsesUnsupportedForModel = (error: unknown): boolean =>
  unsupportedForModel(error, "does not support responses api");
