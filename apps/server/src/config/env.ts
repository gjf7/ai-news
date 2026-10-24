import { z } from "zod";

/**
 * All runtime configuration comes from environment variables and is validated
 * once at startup. The process exits on invalid config rather than limping
 * along with a partially applied configuration.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),

  DATABASE_PATH: z.string().min(1).default("./data/app.db"),
  BACKUP_DIR: z.string().min(1).optional(),
  BACKUP_KEEP: z.coerce.number().int().positive().default(14),

  /** Session signing / token derivation secret. */
  SESSION_SECRET: z.string().min(16),
  /** scrypt hash of the single user's password, produced by `vp run server#hash-password`. */
  LOGIN_PASSWORD_HASH: z.string().min(1),
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(720),

  REFRESH_INTERVAL_MINUTES: z.coerce.number().int().positive().default(30),
  /** Overall deadline for one refresh run, in minutes. */
  RUN_TIMEOUT_MINUTES: z.coerce.number().int().positive().default(20),
  /**
   * Per-run caps. These bound model cost and the run's duration; the design
   * calls them tunable product parameters. Measured against live sources:
   * an initial burst is ~600 events, steady state far less, so a run works
   * through a burst over several intervals by design.
   */
  ANALYZE_MAX_EVENTS: z.coerce.number().int().positive().default(40),
  FILTER_MAX_BATCHES: z.coerce.number().int().positive().default(8),
  CLUSTER_MAX_BATCHES: z.coerce.number().int().positive().default(4),

  NOTIFY_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  NOTIFY_MAX_ITEMS: z.coerce.number().int().positive().default(5),
  /**
   * Push threshold. Measured against a week of live data: 70 sends ~24 pushes a
   * day, 78 sends ~13, and 80 sends ~10. 78 is the point where the volume
   * becomes readable without dropping the export-control, earnings and
   * capacity stories that the model scores in the high 70s.
   */
  NOTIFY_MIN_IMPORTANCE: z.coerce.number().int().min(0).max(100).default(78),

  /**
   * Daily digest: one summary of the last 24 hours at a fixed UTC hour. Off by
   * default so enabling it is a deliberate choice (it is a new outbound message
   * on a fixed schedule). Its threshold is lower than the per-run push so it can
   * surface the day's notable-but-not-urgent items.
   */
  DIGEST_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  DIGEST_HOUR_UTC: z.coerce.number().int().min(0).max(23).default(0),
  DIGEST_MAX_ITEMS: z.coerce.number().int().positive().default(10),
  DIGEST_MIN_IMPORTANCE: z.coerce.number().int().min(0).max(100).default(50),

  /**
   * Retention: delete events (and their insights) and orphaned articles older
   * than this many days, plus terminal deliveries. 0 disables pruning. The
   * daily snapshot is the safety net.
   */
  RETENTION_DAYS: z.coerce.number().int().min(0).default(180),

  /**
   * Collection-outage alert. Off-switch plus a streak length; it reuses the
   * Telegram credentials above. The default fires after three consecutive
   * runs (90 minutes at the default interval) collected nothing, which is
   * long enough to ignore a transient blip and short enough to notice the same
   * day.
   */
  ALERT_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  ALERT_AFTER_FAILED_RUNS: z.coerce.number().int().positive().default(3),

  TELEGRAM_BOT_TOKEN: z.string().min(1).optional(),
  TELEGRAM_CHAT_ID: z.string().min(1).optional(),

  OPENAI_BASE_URL: z.string().url().default("https://api.deepseek.com"),
  OPENAI_API_KEY: z.string().min(1).optional(),
  MODEL_NAME: z.string().min(1).default("deepseek-flash"),
  /**
   * DeepSeek's unified models think by default and bill reasoning tokens at the
   * output rate. `auto` lets each call site decide (mechanical calls turn it
   * off) and only sends the field to DeepSeek; `enabled`/`disabled` force it
   * everywhere, e.g. when the same API is reached through a proxy.
   */
  MODEL_THINKING: z.enum(["auto", "enabled", "disabled"]).default("auto"),
  /**
   * Thinking budget for the calls that keep thinking on (currently only the
   * insight). DeepSeek defaults to `high`; `low` is enough for summarising a
   * handful of headlines and scoring importance, and reasoning tokens are
   * billed at the output rate.
   */
  MODEL_REASONING_EFFORT: z.enum(["low", "high", "max"]).default("low"),
});

export type Env = z.infer<typeof EnvSchema>;

export type AppConfig = {
  nodeEnv: Env["NODE_ENV"];
  port: number;
  databasePath: string;
  backup: { directory?: string; keep: number };
  /** Age at which events/articles are pruned; 0 disables pruning. */
  retention: { days: number };
  session: {
    secret: string;
    ttlHours: number;
    passwordHash: string;
    secureCookie: boolean;
  };
  refresh: {
    intervalMinutes: number;
    runTimeoutMinutes: number;
    analyzeMaxEvents: number;
    filterMaxBatches: number;
    clusterMaxBatches: number;
  };
  notify: {
    enabled: boolean;
    maxItems: number;
    minImportance: number;
    digest: {
      enabled: boolean;
      hourUtc: number;
      maxItems: number;
      minImportance: number;
    };
    /** Collection-outage alert, sent when runs keep collecting nothing. */
    alert: { enabled: boolean; afterFailedRuns: number };
    telegram: { botToken?: string; chatId?: string };
  };
  model: {
    baseUrl: string;
    apiKey?: string;
    name: string;
    /** Undefined is treated as "auto". */
    thinking?: "auto" | "enabled" | "disabled";
    /** Thinking budget for calls that keep thinking on; undefined means the provider default. */
    reasoningEffort?: "low" | "high" | "max";
  };
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const value = parsed.data;

  return {
    nodeEnv: value.NODE_ENV,
    port: value.PORT,
    databasePath: value.DATABASE_PATH,
    backup: { directory: value.BACKUP_DIR, keep: value.BACKUP_KEEP },
    retention: { days: value.RETENTION_DAYS },
    session: {
      secret: value.SESSION_SECRET,
      ttlHours: value.SESSION_TTL_HOURS,
      passwordHash: value.LOGIN_PASSWORD_HASH,
      secureCookie: value.NODE_ENV === "production",
    },
    refresh: {
      intervalMinutes: value.REFRESH_INTERVAL_MINUTES,
      runTimeoutMinutes: value.RUN_TIMEOUT_MINUTES,
      analyzeMaxEvents: value.ANALYZE_MAX_EVENTS,
      filterMaxBatches: value.FILTER_MAX_BATCHES,
      clusterMaxBatches: value.CLUSTER_MAX_BATCHES,
    },
    notify: {
      enabled: value.NOTIFY_ENABLED,
      maxItems: value.NOTIFY_MAX_ITEMS,
      minImportance: value.NOTIFY_MIN_IMPORTANCE,
      digest: {
        enabled: value.DIGEST_ENABLED,
        hourUtc: value.DIGEST_HOUR_UTC,
        maxItems: value.DIGEST_MAX_ITEMS,
        minImportance: value.DIGEST_MIN_IMPORTANCE,
      },
      alert: {
        enabled: value.ALERT_ENABLED,
        afterFailedRuns: value.ALERT_AFTER_FAILED_RUNS,
      },
      telegram: {
        botToken: value.TELEGRAM_BOT_TOKEN,
        chatId: value.TELEGRAM_CHAT_ID,
      },
    },
    model: {
      baseUrl: value.OPENAI_BASE_URL,
      apiKey: value.OPENAI_API_KEY,
      name: value.MODEL_NAME,
      thinking: value.MODEL_THINKING,
      reasoningEffort: value.MODEL_REASONING_EFFORT,
    },
  };
}

/**
 * The read-only view of configuration exposed to the web UI. Secrets are
 * replaced by a boolean "is it configured" flag and never returned.
 */
export function publicConfig(config: AppConfig) {
  return {
    nodeEnv: config.nodeEnv,
    refreshIntervalMinutes: config.refresh.intervalMinutes,
    retentionDays: config.retention.days,
    notify: {
      enabled: config.notify.enabled,
      maxItems: config.notify.maxItems,
      minImportance: config.notify.minImportance,
      digest: {
        enabled: config.notify.digest.enabled,
        hourUtc: config.notify.digest.hourUtc,
        maxItems: config.notify.digest.maxItems,
        minImportance: config.notify.digest.minImportance,
      },
      alert: {
        enabled: config.notify.alert.enabled,
        afterFailedRuns: config.notify.alert.afterFailedRuns,
      },
    },
    model: {
      baseUrl: config.model.baseUrl,
      name: config.model.name,
    },
    configured: {
      modelApiKey: Boolean(config.model.apiKey),
      telegram: Boolean(config.notify.telegram.botToken && config.notify.telegram.chatId),
    },
  };
}

export type PublicConfig = ReturnType<typeof publicConfig>;
