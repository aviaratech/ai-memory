import { normalizeOptionalText } from '../db/normalization.js';

interface RetentionConfig {
  auditDays: number;
  batchSize: number;
  expiredGraceDays: number;
  failureDays: number;
  sessionDays: number;
  sessionSummaryDays: number;
  supersededDays: number;
  /** Retention window for ai_tool_invocations rows (default: 90 days). Env: AI_MEMORY_RETENTION_TELEMETRY_DAYS */
  telemetryDays: number;
}

type RetentionConfigOverrides = Partial<RetentionConfig>;

const DEFAULT_SESSION_DAYS = 90;
const DEFAULT_FAILURE_DAYS = 30;
const DEFAULT_EXPIRED_GRACE_DAYS = 30;
const DEFAULT_SUPERSEDED_DAYS = 180;
const DEFAULT_SESSION_SUMMARY_DAYS = 14;
const DEFAULT_AUDIT_DAYS = 180;
const DEFAULT_BATCH_SIZE = 1000;
const DEFAULT_TELEMETRY_DAYS = 90;

function readEnvPositiveInt(envVar: string): number | undefined {
  const raw = normalizeOptionalText(process.env[envVar]);
  if (raw === undefined) {
    return undefined;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${envVar} must be a positive integer, got: ${raw}`);
  }

  return parsed;
}

function resolveRetentionConfig(overrides?: RetentionConfigOverrides): RetentionConfig {
  const config: RetentionConfig = {
    auditDays: overrides?.auditDays ?? readEnvPositiveInt('AI_MEMORY_RETENTION_AUDIT_DAYS') ?? DEFAULT_AUDIT_DAYS,
    batchSize: overrides?.batchSize ?? readEnvPositiveInt('AI_MEMORY_RETENTION_BATCH_SIZE') ?? DEFAULT_BATCH_SIZE,
    expiredGraceDays:
      overrides?.expiredGraceDays ??
      readEnvPositiveInt('AI_MEMORY_RETENTION_EXPIRED_GRACE_DAYS') ??
      DEFAULT_EXPIRED_GRACE_DAYS,
    failureDays:
      overrides?.failureDays ?? readEnvPositiveInt('AI_MEMORY_RETENTION_FAILURE_DAYS') ?? DEFAULT_FAILURE_DAYS,
    sessionDays:
      overrides?.sessionDays ?? readEnvPositiveInt('AI_MEMORY_RETENTION_SESSION_DAYS') ?? DEFAULT_SESSION_DAYS,
    sessionSummaryDays:
      overrides?.sessionSummaryDays ??
      readEnvPositiveInt('AI_MEMORY_RETENTION_SESSION_SUMMARY_DAYS') ??
      DEFAULT_SESSION_SUMMARY_DAYS,
    supersededDays:
      overrides?.supersededDays ?? readEnvPositiveInt('AI_MEMORY_RETENTION_SUPERSEDED_DAYS') ?? DEFAULT_SUPERSEDED_DAYS,
    telemetryDays:
      overrides?.telemetryDays ?? readEnvPositiveInt('AI_MEMORY_RETENTION_TELEMETRY_DAYS') ?? DEFAULT_TELEMETRY_DAYS,
  };

  return config;
}

export type { RetentionConfig };
export { resolveRetentionConfig };
