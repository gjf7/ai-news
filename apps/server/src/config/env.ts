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
  NOTIFY_MIN_IMPORTANCE: z.coerce.number().int().min(0).max(100).default(70),

  TELEGRAM_BOT_TOKEN: z.string().min(1).optional(),
  TELEGRAM_CHAT_ID: z.string().min(1).optional(),

  OPENAI_BASE_URL: z.string().url().default("https://api.deepseek.com"),
  OPENAI_API_KEY: z.string().min(1).optional(),
  MODEL_NAME: z.string().min(1).default("deepseek-chat"),
});

export type Env = z.infer<typeof EnvSchema>;

export type AppConfig = {
  nodeEnv: Env["NODE_ENV"];
  port: number;
  databasePath: string;
  backup: { directory?: string; keep: number };
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
    telegram: { botToken?: string; chatId?: string };
  };
  model: {
    baseUrl: string;
    apiKey?: string;
    name: string;
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
      telegram: {
        botToken: value.TELEGRAM_BOT_TOKEN,
        chatId: value.TELEGRAM_CHAT_ID,
      },
    },
    model: {
      baseUrl: value.OPENAI_BASE_URL,
      apiKey: value.OPENAI_API_KEY,
      name: value.MODEL_NAME,
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
    notify: {
      enabled: config.notify.enabled,
      maxItems: config.notify.maxItems,
      minImportance: config.notify.minImportance,
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
