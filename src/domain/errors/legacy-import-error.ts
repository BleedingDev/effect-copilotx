import * as Schema from "effect/Schema";

export class LegacyImportError extends Schema.TaggedErrorClass<LegacyImportError>()(
  "LegacyImportError",
  {
    message: Schema.String,
    operation: Schema.String,
  }
) {}
