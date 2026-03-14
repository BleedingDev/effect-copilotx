import {
  DEFAULT_ROTATION_STRATEGY,
  ROTATION_STRATEGIES,
} from "#/config/copilot-constants";

export type RotationStrategy = (typeof ROTATION_STRATEGIES)[number];
export const rotationStrategies = ROTATION_STRATEGIES;
export const defaultRotationStrategy = DEFAULT_ROTATION_STRATEGY;

export interface ModelCatalogEntry {
  readonly hidden: boolean;
  readonly modelId: string;
  readonly vendor: string;
}

export interface AccountObservedUsage {
  readonly inputTokenCount: number;
  readonly outputTokenCount: number;
  readonly successfulRequestCount: number;
  readonly successfulStreamCount: number;
}

export interface AccountRecord extends AccountObservedUsage {
  readonly accountId: string;
  readonly apiBaseUrl: string;
  readonly cooldownUntil: Date | null;
  readonly copilotToken: string;
  readonly copilotTokenExpiresAt: Date | null;
  readonly createdAt: Date;
  readonly enabled: boolean;
  readonly errorStreak: number;
  readonly githubLogin: string;
  readonly githubToken: string;
  readonly githubUserId: string;
  readonly label: string;
  readonly lastError: string;
  readonly lastErrorAt: Date | null;
  readonly lastRateLimitedAt: Date | null;
  readonly lastUsedAt: Date | null;
  readonly modelCatalog: readonly ModelCatalogEntry[];
  readonly modelIds: readonly string[];
  readonly priority: number;
  readonly reauthRequired: boolean;
  readonly updatedAt: Date;
}

export interface AccountSummary extends AccountObservedUsage {
  readonly accountId: string;
  readonly cooldownUntil: Date | null;
  readonly copilotTokenExpiresAt: Date | null;
  readonly createdAt: Date;
  readonly enabled: boolean;
  readonly errorStreak: number;
  readonly githubLogin: string;
  readonly githubUserId: string;
  readonly label: string;
  readonly lastError: string;
  readonly lastErrorAt: Date | null;
  readonly lastRateLimitedAt: Date | null;
  readonly lastUsedAt: Date | null;
  readonly modelCatalog: readonly ModelCatalogEntry[];
  readonly modelIds: readonly string[];
  readonly priority: number;
  readonly reauthRequired: boolean;
  readonly updatedAt: Date;
}

export interface UpsertAccountInput {
  readonly accountId: string;
  readonly apiBaseUrl: string;
  readonly copilotToken: string;
  readonly copilotTokenExpiresAt: Date | null;
  readonly enabled: boolean;
  readonly githubLogin: string;
  readonly githubToken: string;
  readonly githubUserId: string;
  readonly label: string;
  readonly modelCatalog: readonly ModelCatalogEntry[];
  readonly priority?: number;
  readonly reauthRequired: boolean;
}

export interface AccountRuntimePatch {
  readonly cooldownUntil?: Date | null;
  readonly errorStreak?: number;
  readonly lastError?: string;
  readonly lastErrorAt?: Date | null;
  readonly lastRateLimitedAt?: Date | null;
  readonly lastUsedAt?: Date | null;
  readonly reauthRequired?: boolean;
}

export interface AccountUsageDelta {
  readonly inputTokenCount?: number;
  readonly outputTokenCount?: number;
  readonly successfulRequestCount?: number;
  readonly successfulStreamCount?: number;
}

export interface RuntimeSettingsRecord {
  readonly defaultAccountId: string | null;
  readonly id: string;
  readonly rotationStrategy: RotationStrategy;
  readonly roundRobinCursor: number;
  readonly updatedAt: Date;
}
