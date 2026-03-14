import { describe, expect, it } from "@effect-native/bun-test";
import * as Effect from "effect/Effect";

import {
  extractUsageDelta,
  trackChatCompletionsStreamUsage,
  trackResponsesStreamUsage,
} from "#/http/usage-tracking";

const textEncoder = new TextEncoder();

describe("usage tracking", () => {
  it.effect("extracts usage counters from normalized responses", () =>
    Effect.sync(() => {
      expect(
        extractUsageDelta({
          usage: { input_tokens: 11, output_tokens: 5, total_tokens: 16 },
        })
      ).toEqual({
        inputTokenCount: 11,
        outputTokenCount: 5,
        successfulRequestCount: 1,
        successfulStreamCount: 0,
      });

      expect(
        extractUsageDelta({
          usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
        })
      ).toEqual({
        inputTokenCount: 7,
        outputTokenCount: 3,
        successfulRequestCount: 1,
        successfulStreamCount: 0,
      });
    })
  );

  it.effect("tracks chat completion stream usage from final usage chunks", () =>
    Effect.tryPromise({
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      try: async () => {
        let observed = null as ReturnType<typeof extractUsageDelta> | null;
        const events = {
          async *[Symbol.asyncIterator]() {
            yield textEncoder.encode(
              'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}],"usage":{"prompt_tokens":9,"completion_tokens":4}}\n'
            );
            yield textEncoder.encode("data: [DONE]\n");
          },
        };

        for await (const _ of trackChatCompletionsStreamUsage(events, async (delta) => {
          observed = delta;
        })) {
          // drain stream
        }

        expect(observed).toEqual({
          inputTokenCount: 9,
          outputTokenCount: 4,
          successfulRequestCount: 0,
          successfulStreamCount: 1,
        });
      },
    })
  );

  it.effect("tracks responses stream usage from response.completed events", () =>
    Effect.tryPromise({
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      try: async () => {
        let observed = null as ReturnType<typeof extractUsageDelta> | null;
        const events = {
          async *[Symbol.asyncIterator]() {
            yield textEncoder.encode("event: response.completed\n");
            yield textEncoder.encode(
              'data: {"response":{"usage":{"input_tokens":13,"output_tokens":6,"total_tokens":19}},"type":"response.completed"}\n'
            );
            yield textEncoder.encode("\n");
          },
        };

        for await (const _ of trackResponsesStreamUsage(events, async (delta) => {
          observed = delta;
        })) {
          // drain stream
        }

        expect(observed).toEqual({
          inputTokenCount: 13,
          outputTokenCount: 6,
          successfulRequestCount: 0,
          successfulStreamCount: 1,
        });
      },
    })
  );
});
