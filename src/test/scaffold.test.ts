import { describe, expect, it } from "@effect-native/bun-test";
import * as Effect from "effect/Effect";

import {
  APP_NAME,
  APP_VERSION,
  DEFAULT_HOST,
  DEFAULT_PORT,
} from "#/app/app-info";

describe("scaffold", () => {
  it.effect("exposes the bootstrap application metadata", () =>
    Effect.sync(() => {
      expect(APP_NAME).toBe("CopilotX");
      expect(APP_VERSION).toBe("4.0.0-alpha.0");
      expect(DEFAULT_HOST).toBe("127.0.0.1");
      expect(DEFAULT_PORT).toBe(24_680);
    })
  );
});
