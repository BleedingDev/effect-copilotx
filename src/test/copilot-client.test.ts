import { describe, expect, it } from "@effect-native/bun-test";

import { CopilotClient } from "#/services/copilot-client";

describe("CopilotClient stream timeouts", () => {
  it("fails fast when an upstream stream never opens", async () => {
    const neverOpens = Promise.withResolvers<Response>().promise;
    const client = new CopilotClient("token", {
      fetch: () => neverOpens,
      requestTimeoutMs: 1000,
      streamFirstChunkTimeoutMs: 5,
    });

    await expect(
      client.responsesStream({ input: "ok", model: "gpt-5.3-codex" })
    ).rejects.toThrow("upstream stream to open");
  });

  it("fails fast when an upstream stream opens but never yields data", async () => {
    const client = new CopilotClient("token", {
      fetch: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull() {
              // Keep the stream open without emitting chunks.
              return Promise.resolve();
            },
          }),
          { status: 200 }
        ),
      requestTimeoutMs: 1000,
      streamFirstChunkTimeoutMs: 5,
    });

    const events = await client.responsesStream({
      input: "ok",
      model: "gpt-5.3-codex",
    });

    await expect(events[Symbol.asyncIterator]().next()).rejects.toThrow(
      "produce its first chunk"
    );
  });
});
