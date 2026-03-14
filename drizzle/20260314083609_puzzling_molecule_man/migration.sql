CREATE TYPE "rotation_strategy" AS ENUM('fill-first', 'round-robin');--> statement-breakpoint
CREATE TABLE "account_models" (
	"account_id" text,
	"discovered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"hidden" boolean DEFAULT false NOT NULL,
	"model_id" text,
	"vendor" text DEFAULT 'github-copilot' NOT NULL,
	CONSTRAINT "account_models_pk" PRIMARY KEY("account_id","model_id")
);
--> statement-breakpoint
CREATE TABLE "account_runtime_states" (
	"account_id" text PRIMARY KEY,
	"cooldown_until" timestamp with time zone,
	"error_streak" integer DEFAULT 0 NOT NULL,
	"last_error" text DEFAULT '' NOT NULL,
	"last_error_at" timestamp with time zone,
	"last_rate_limited_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "accounts" (
	"account_id" text PRIMARY KEY,
	"api_base_url" text DEFAULT '' NOT NULL,
	"copilot_token_ciphertext" text,
	"copilot_token_expires_at" timestamp with time zone,
	"copilot_token_key_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"github_login" text NOT NULL,
	"github_token_ciphertext" text NOT NULL,
	"github_token_key_id" text NOT NULL,
	"github_user_id" text NOT NULL,
	"label" text NOT NULL,
	"last_used_at" timestamp with time zone,
	"priority" integer DEFAULT 0 NOT NULL,
	"reauth_required" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runtime_settings" (
	"default_account_id" text,
	"id" text PRIMARY KEY,
	"rotation_strategy" "rotation_strategy" DEFAULT 'fill-first'::"rotation_strategy" NOT NULL,
	"round_robin_cursor" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "account_models_account_idx" ON "account_models" ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_label_unique" ON "accounts" ("label");--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_github_user_id_unique" ON "accounts" ("github_user_id");--> statement-breakpoint
CREATE INDEX "accounts_enabled_priority_idx" ON "accounts" ("enabled","priority","created_at");--> statement-breakpoint
ALTER TABLE "account_models" ADD CONSTRAINT "account_models_account_id_accounts_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("account_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "account_runtime_states" ADD CONSTRAINT "account_runtime_states_account_id_accounts_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("account_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "runtime_settings" ADD CONSTRAINT "runtime_settings_default_account_id_accounts_account_id_fkey" FOREIGN KEY ("default_account_id") REFERENCES "accounts"("account_id") ON DELETE SET NULL;