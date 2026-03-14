import * as Schema from "effect/Schema";

export class TokenCipherError extends Schema.TaggedErrorClass<TokenCipherError>()(
  "TokenCipherError",
  {
    message: Schema.String,
    operation: Schema.String,
  }
) {}
