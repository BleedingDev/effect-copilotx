ALTER TABLE "account_runtime_states"
  ADD COLUMN "input_token_count" integer NOT NULL DEFAULT 0,
  ADD COLUMN "output_token_count" integer NOT NULL DEFAULT 0,
  ADD COLUMN "successful_request_count" integer NOT NULL DEFAULT 0,
  ADD COLUMN "successful_stream_count" integer NOT NULL DEFAULT 0;
