import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import type { AppConfigShape } from "#/services/app-config";
import {
  extractUpstreamErrorPayload,
  UpstreamHttpError,
} from "#/http/upstream-compat";

export type JsonRecord = Record<string, unknown>;

const API_KEY_HEADERS = ["authorization", "x-api-key", "api-key"] as const;
const LOCALHOST_ADDRESSES = new Set(["127.0.0.1", "::1", "localhost"]);
const SSE_HEADERS = {
  "cache-control": "no-cache",
  connection: "keep-alive",
  "x-accel-buffering": "no",
} as const;

export const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const describeError = (error: unknown) =>
  error instanceof Error ? error.message : `Unexpected error: ${String(error)}`;

export const currentUnixSeconds = (): number => Math.floor(Date.now() / 1000);

export const headerValue = (
  request: HttpServerRequest,
  name: string
): string | undefined => {
  const lowered = name.toLowerCase();
  for (const [key, value] of Object.entries(request.headers)) {
    if (key.toLowerCase() === lowered) {
      return value;
    }
  }

  return undefined;
};

const normalizeRemoteAddress = (remoteAddress: string | undefined) => {
  const trimmed = remoteAddress?.trim() ?? "";
  if (trimmed.length === 0) {
    return "";
  }

  if (trimmed.startsWith("::ffff:")) {
    return trimmed.slice(7);
  }

  return trimmed;
};

const extractPresentedApiKey = (request: HttpServerRequest): string => {
  const authorization = headerValue(request, "authorization") ?? "";
  if (authorization.startsWith("Bearer ")) {
    return authorization.slice(7);
  }
  if (authorization.startsWith("bearer ")) {
    return authorization.slice(7);
  }

  for (const header of API_KEY_HEADERS) {
    if (header === "authorization") {
      continue;
    }

    const value = headerValue(request, header);
    if (value !== undefined && value.length > 0) {
      return value;
    }
  }

  return "";
};

export const buildCorsHeaders = (
  request: HttpServerRequest,
  config: AppConfigShape
): Record<string, string> => {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers":
      "authorization, content-type, x-api-key, api-key",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Max-Age": "600",
  };

  const origin = headerValue(request, "origin");
  if (origin !== undefined && config.security.corsOrigins.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers.Vary = "Origin";
  }

  return headers;
};

export const authorizeRequest = (
  request: HttpServerRequest,
  config: AppConfigShape
): HttpServerResponse.HttpServerResponse | null => {
  const configuredApiKey = config.security.apiKey;
  if (configuredApiKey === undefined || configuredApiKey.length === 0) {
    return null;
  }

  const remoteAddress = normalizeRemoteAddress(request.remoteAddress);
  if (
    config.security.trustLocalhost &&
    LOCALHOST_ADDRESSES.has(remoteAddress.toLowerCase())
  ) {
    return null;
  }

  const presentedApiKey = extractPresentedApiKey(request);
  if (presentedApiKey === configuredApiKey) {
    return null;
  }

  return HttpServerResponse.jsonUnsafe(
    {
      error: {
        message:
          "Invalid or missing API key. Set Authorization: Bearer <your-key> header.",
        type: "authentication_error",
      },
    },
    {
      headers: buildCorsHeaders(request, config),
      status: 401,
    }
  );
};

export const authorizeImportRequest = (
  request: HttpServerRequest,
  config: AppConfigShape
): HttpServerResponse.HttpServerResponse | null => {
  const configuredImportApiKey = config.security.importApiKey;
  if (configuredImportApiKey === undefined || configuredImportApiKey.length === 0) {
    return HttpServerResponse.jsonUnsafe(
      {
        error: {
          message: "GitHub token import is disabled.",
          type: "not_found",
        },
      },
      {
        headers: buildCorsHeaders(request, config),
        status: 404,
      }
    );
  }

  const presentedApiKey = extractPresentedApiKey(request);
  if (presentedApiKey === configuredImportApiKey) {
    return null;
  }

  return HttpServerResponse.jsonUnsafe(
    {
      error: {
        message:
          "Invalid or missing import API key. Set Authorization: Bearer <your-import-key> header.",
        type: "authentication_error",
      },
    },
    {
      headers: buildCorsHeaders(request, config),
      status: 401,
    }
  );
};

export const jsonResponse = (
  request: HttpServerRequest,
  config: AppConfigShape,
  body: unknown,
  status = 200
) =>
  HttpServerResponse.jsonUnsafe(body, {
    headers: buildCorsHeaders(request, config),
    status,
  });

export const sseResponse = <E>(
  request: HttpServerRequest,
  config: AppConfigShape,
  body: Stream.Stream<Uint8Array, E>
) =>
  HttpServerResponse.stream(body, {
    contentType: "text/event-stream",
    headers: {
      ...buildCorsHeaders(request, config),
      ...SSE_HEADERS,
    },
    status: 200,
  });

export const preflightResponse = (
  request: HttpServerRequest,
  config: AppConfigShape
) =>
  HttpServerResponse.empty({
    headers: buildCorsHeaders(request, config),
    status: 204,
  });

export const openAiErrorResponse = (
  request: HttpServerRequest,
  config: AppConfigShape,
  error: unknown
) => {
  if (error instanceof UpstreamHttpError) {
    const payload =
      Object.keys(extractUpstreamErrorPayload(error).payload).length > 0
        ? extractUpstreamErrorPayload(error).payload
        : { error: { message: error.message } };
    return jsonResponse(
      request,
      config,
      payload,
      error.statusCode
    );
  }

  const extracted = extractUpstreamErrorPayload(error);
  if (extracted.statusCode !== null) {
    const payload =
      Object.keys(extracted.payload).length > 0
        ? extracted.payload
        : { error: { message: extracted.responseText || describeError(error) } };
    return jsonResponse(
      request,
      config,
      payload,
      extracted.statusCode
    );
  }

  return jsonResponse(
    request,
    config,
    { error: { message: describeError(error) } },
    500
  );
};

export const anthropicErrorResponse = (
  request: HttpServerRequest,
  config: AppConfigShape,
  error: unknown
) => {
  if (error instanceof UpstreamHttpError) {
    const payload = extractUpstreamErrorPayload(error);
    const message =
      typeof payload.payload.error === "object" &&
      payload.payload.error !== null &&
      typeof (payload.payload.error as Record<string, unknown>).message === "string"
        ? ((payload.payload.error as Record<string, unknown>).message as string)
        : error.message;

    return jsonResponse(
      request,
      config,
      { error: { message, type: "api_error" }, type: "error" },
      error.statusCode
    );
  }

  return jsonResponse(
    request,
    config,
    { error: { message: describeError(error), type: "api_error" }, type: "error" },
    500
  );
};

export const readJsonRecord = (request: HttpServerRequest) =>
  Effect.flatMap(request.json, (body) =>
    isRecord(body)
      ? Effect.succeed(body)
      : Effect.fail(new Error("Expected a JSON object request body."))
  );

export const textEventStream = (events: Iterable<string>) =>
  Stream.fromIterable(events).pipe(Stream.encodeText);

export const asyncTextEventStream = (events: AsyncIterable<string>) =>
  Stream.fromAsyncIterable(events, (error) => error).pipe(Stream.encodeText);

export const byteStream = (events: AsyncIterable<Uint8Array>) =>
  Stream.fromAsyncIterable(events, (error) => error);
