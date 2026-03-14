import * as Schema from "effect/Schema";

export class TokenCipherConfigurationError extends Schema.TaggedErrorClass<TokenCipherConfigurationError>()(
  "TokenCipherConfigurationError",
  {
    message: Schema.String,
  }
) {}
