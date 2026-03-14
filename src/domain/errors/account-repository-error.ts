import * as Schema from "effect/Schema";

export class AccountRepositoryError extends Schema.TaggedErrorClass<AccountRepositoryError>()(
  "AccountRepositoryError",
  {
    message: Schema.String,
    operation: Schema.String,
  }
) {}
