import {
  CHAT_COMPLETIONS_API,
  RESPONSES_API,
  UnsupportedApiSurfaceError,
} from "#/domain/models/runtime-types";
import type {
  ModelRoutingState,
  ProxyApiSurface,
  RuntimeModelDescriptor,
} from "#/domain/models/runtime-types";

interface MutableModelRoutingState {
  chatSupported: boolean | null;
  preferredApi: ProxyApiSurface | null;
  responsesSupported: boolean | null;
  vendor: string;
}

const CHAT_UNSUPPORTED_MESSAGE =
  "not accessible via the /chat/completions endpoint";
const RESPONSES_UNSUPPORTED_MESSAGE = "does not support responses api";
const UNSUPPORTED_API_FOR_MODEL_CODE = "unsupported_api_for_model";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asRecord = (value: unknown): Record<string, unknown> | null =>
  isRecord(value) ? value : null;

const readString = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

const readNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const firstRecord = (
  ...values: readonly unknown[]
): Record<string, unknown> | null => {
  for (const value of values) {
    const record = asRecord(value);
    if (record !== null) {
      return record;
    }
  }

  return null;
};

const firstString = (...values: readonly unknown[]): string | null => {
  for (const value of values) {
    const string = readString(value);
    if (string !== null) {
      return string;
    }
  }

  return null;
};

const firstNumber = (...values: readonly unknown[]): number | null => {
  for (const value of values) {
    const number = readNumber(value);
    if (number !== null) {
      return number;
    }
  }

  return null;
};

interface ErrorDetails {
  readonly code: string | null;
  readonly message: string;
  readonly statusCode: number | null;
}

const fallbackErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const errorCode = (
  root: Record<string, unknown> | null,
  nestedError: Record<string, unknown> | null,
  payload: Record<string, unknown> | null
): string | null => firstString(root?.code, nestedError?.code, payload?.code);

const errorMessage = (
  root: Record<string, unknown> | null,
  nestedError: Record<string, unknown> | null,
  payload: Record<string, unknown> | null,
  fallback: unknown
): string =>
  firstString(root?.message, nestedError?.message, payload?.message) ??
  fallbackErrorMessage(fallback);

const errorStatusCode = (
  root: Record<string, unknown> | null,
  response: Record<string, unknown> | null
): number | null =>
  firstNumber(
    root?.statusCode,
    root?.status,
    response?.statusCode,
    response?.status
  );

const unsupportedApiSurfaceDetails = (error: unknown): ErrorDetails => {
  const root = asRecord(error);
  return {
    code: readString(root?.upstreamCode),
    message: readString(root?.message) ?? fallbackErrorMessage(error),
    statusCode: readNumber(root?.statusCode) ?? 400,
  };
};

const fallbackErrorDetails = (error: unknown): ErrorDetails => {
  const root = asRecord(error);
  const response = asRecord(root?.response);
  const payload = firstRecord(
    root?.payload,
    root?.body,
    root?.data,
    response?.payload,
    response?.body,
    response?.data
  );
  const nestedError = firstRecord(root?.error, payload?.error);

  return {
    code: errorCode(root, nestedError, payload),
    message: errorMessage(root, nestedError, payload, error),
    statusCode: errorStatusCode(root, response),
  };
};

const errorDetails = (error: unknown): ErrorDetails =>
  error instanceof UnsupportedApiSurfaceError
    ? unsupportedApiSurfaceDetails(error)
    : fallbackErrorDetails(error);

const supportsApi = (
  state: MutableModelRoutingState,
  apiSurface: ProxyApiSurface
): boolean | null =>
  apiSurface === CHAT_COMPLETIONS_API
    ? state.chatSupported
    : state.responsesSupported;

const setApiSupport = (
  state: MutableModelRoutingState,
  apiSurface: ProxyApiSurface,
  supported: boolean
): void => {
  if (apiSurface === CHAT_COMPLETIONS_API) {
    state.chatSupported = supported;
    return;
  }

  state.responsesSupported = supported;
};

const normalizedModelId = (value: string | null | undefined): string | null => {
  const normalized = value?.trim() ?? "";
  return normalized.length > 0 ? normalized : null;
};

export const alternateApiSurface = (
  apiSurface: ProxyApiSurface
): ProxyApiSurface =>
  apiSurface === CHAT_COMPLETIONS_API ? RESPONSES_API : CHAT_COMPLETIONS_API;

export const inferPreferredApiSurface = (
  model: string,
  vendor = ""
): ProxyApiSurface | null => {
  const modelLower = model.toLowerCase();
  const vendorLower = vendor.toLowerCase();

  if (modelLower.startsWith("claude-") || modelLower.startsWith("gemini-")) {
    return CHAT_COMPLETIONS_API;
  }

  if (modelLower.startsWith("gpt-5") || modelLower.includes("codex")) {
    return RESPONSES_API;
  }

  if (
    vendorLower === "anthropic" ||
    vendorLower === "google" ||
    vendorLower === "google-deepmind"
  ) {
    return CHAT_COMPLETIONS_API;
  }

  if (
    vendorLower === "openai" &&
    (modelLower.startsWith("gpt-5") || modelLower.includes("codex"))
  ) {
    return RESPONSES_API;
  }

  return null;
};

export const isUnsupportedApiSurfaceError = (
  error: unknown,
  apiSurface: ProxyApiSurface
): boolean => {
  const details = errorDetails(error);
  if (details.statusCode !== 400) {
    return false;
  }

  const code = details.code?.toLowerCase() ?? "";
  const message = details.message.toLowerCase();
  if (code === UNSUPPORTED_API_FOR_MODEL_CODE) {
    return true;
  }

  return apiSurface === CHAT_COMPLETIONS_API
    ? message.includes(CHAT_UNSUPPORTED_MESSAGE)
    : message.includes(RESPONSES_UNSUPPORTED_MESSAGE);
};

export class ModelRoutingRegistry {
  readonly #states = new Map<string, MutableModelRoutingState>();

  observeModels(models: readonly RuntimeModelDescriptor[]): void {
    for (const model of models) {
      const modelId = model.id.trim();
      if (modelId.length === 0) {
        continue;
      }

      this.#stateFor(modelId, model.vendor?.trim() ?? "");
    }
  }

  preferredApi(
    model: string | null | undefined,
    requestedApi: ProxyApiSurface
  ): ProxyApiSurface {
    const normalizedModel = normalizedModelId(model);
    if (normalizedModel === null) {
      return requestedApi;
    }

    const state = this.#stateFor(normalizedModel);
    const alternateApi = alternateApiSurface(requestedApi);
    const requestedSupported = supportsApi(state, requestedApi);
    const alternateSupported = supportsApi(state, alternateApi);

    if (requestedSupported === true) {
      return requestedApi;
    }

    if (requestedSupported === false && alternateSupported !== false) {
      return alternateApi;
    }

    if (alternateSupported === true) {
      return alternateApi;
    }

    if (alternateSupported === false) {
      return requestedApi;
    }

    if (state.preferredApi === alternateApi) {
      return alternateApi;
    }

    return requestedApi;
  }

  markApiSuccess(
    model: string | null | undefined,
    apiSurface: ProxyApiSurface
  ): void {
    const normalizedModel = normalizedModelId(model);
    if (normalizedModel === null) {
      return;
    }

    setApiSupport(this.#stateFor(normalizedModel), apiSurface, true);
  }

  markApiUnsupported(
    model: string | null | undefined,
    apiSurface: ProxyApiSurface
  ): void {
    const normalizedModel = normalizedModelId(model);
    if (normalizedModel === null) {
      return;
    }

    setApiSupport(this.#stateFor(normalizedModel), apiSurface, false);
  }

  snapshot(model: string): ModelRoutingState {
    const state = this.#stateFor(model);
    return {
      chatSupported: state.chatSupported,
      preferredApi: state.preferredApi,
      responsesSupported: state.responsesSupported,
      vendor: state.vendor,
    };
  }

  #stateFor(model: string, vendor = ""): MutableModelRoutingState {
    const normalizedModel = model.trim();
    const state = this.#states.get(normalizedModel) ?? {
      chatSupported: null,
      preferredApi: null,
      responsesSupported: null,
      vendor: "",
    };

    if (vendor.length > 0 && state.vendor.length === 0) {
      state.vendor = vendor;
    }

    const preferredApi = inferPreferredApiSurface(
      normalizedModel,
      state.vendor || vendor
    );
    if (preferredApi !== null && state.preferredApi === null) {
      state.preferredApi = preferredApi;
    }

    this.#states.set(normalizedModel, state);
    return state;
  }
}
