import {
  boolean,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const rotationStrategyEnum = pgEnum("rotation_strategy", [
  "fill-first",
  "round-robin",
]);

export const accounts = pgTable(
  "accounts",
  {
    accountId: text("account_id").primaryKey(),
    apiBaseUrl: text("api_base_url").notNull().default(""),
    copilotTokenCiphertext: text("copilot_token_ciphertext"),
    copilotTokenExpiresAt: timestamp("copilot_token_expires_at", {
      mode: "date",
      withTimezone: true,
    }),
    copilotTokenKeyId: text("copilot_token_key_id"),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    enabled: boolean("enabled").notNull().default(true),
    githubLogin: text("github_login").notNull(),
    githubTokenCiphertext: text("github_token_ciphertext").notNull(),
    githubTokenKeyId: text("github_token_key_id").notNull(),
    githubUserId: text("github_user_id").notNull(),
    label: text("label").notNull(),
    lastUsedAt: timestamp("last_used_at", { mode: "date", withTimezone: true }),
    priority: integer("priority").notNull().default(0),
    reauthRequired: boolean("reauth_required").notNull().default(false),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("accounts_label_unique").on(table.label),
    uniqueIndex("accounts_github_user_id_unique").on(table.githubUserId),
    index("accounts_enabled_priority_idx").on(
      table.enabled,
      table.priority,
      table.createdAt
    ),
  ]
);

export const accountModels = pgTable(
  "account_models",
  {
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.accountId, { onDelete: "cascade" }),
    discoveredAt: timestamp("discovered_at", {
      mode: "date",
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
    hidden: boolean("hidden").notNull().default(false),
    modelId: text("model_id").notNull(),
    vendor: text("vendor").notNull().default("github-copilot"),
  },
  (table) => [
    primaryKey({
      columns: [table.accountId, table.modelId],
      name: "account_models_pk",
    }),
    index("account_models_account_idx").on(table.accountId),
  ]
);

export const accountRuntimeStates = pgTable("account_runtime_states", {
  accountId: text("account_id")
    .primaryKey()
    .references(() => accounts.accountId, { onDelete: "cascade" }),
  cooldownUntil: timestamp("cooldown_until", {
    mode: "date",
    withTimezone: true,
  }),
  errorStreak: integer("error_streak").notNull().default(0),
  inputTokenCount: integer("input_token_count").notNull().default(0),
  lastError: text("last_error").notNull().default(""),
  lastErrorAt: timestamp("last_error_at", { mode: "date", withTimezone: true }),
  lastRateLimitedAt: timestamp("last_rate_limited_at", {
    mode: "date",
    withTimezone: true,
  }),
  outputTokenCount: integer("output_token_count").notNull().default(0),
  successfulRequestCount: integer("successful_request_count")
    .notNull()
    .default(0),
  successfulStreamCount: integer("successful_stream_count")
    .notNull()
    .default(0),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const runtimeSettings = pgTable("runtime_settings", {
  defaultAccountId: text("default_account_id").references(
    () => accounts.accountId,
    { onDelete: "set null" }
  ),
  id: text("id").primaryKey(),
  rotationStrategy: rotationStrategyEnum("rotation_strategy")
    .notNull()
    .default("fill-first"),
  roundRobinCursor: integer("round_robin_cursor").notNull().default(0),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const DEFAULT_RUNTIME_SETTINGS_ID = "default";
