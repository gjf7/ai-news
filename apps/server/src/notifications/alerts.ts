import { and, eq, inArray } from "drizzle-orm";
import type { DbHandle } from "../db/connection.ts";
import { newId } from "../db/ids.ts";
import { deliveries } from "../db/schema.ts";

/**
 * Collection-outage alert.
 *
 * A run can finish "partial" and still collect nothing at all: if every source
 * fails and the one source without a network dependency returns an empty feed,
 * `computeRunState` sees one success and reports partial. The process stays
 * healthy, `/api/health` keeps answering 200, and the only visible symptom is
 * that messages stop arriving. This module turns that silence into a Telegram
 * message.
 *
 * The trigger is deliberately about collected articles rather than run state:
 * a run that fetched zero articles from every source collected nothing,
 * whatever it is called.
 *
 * One alert per outage: an outage is a contiguous streak of finished runs that
 * collected nothing. A run that collects anything ends the streak, so a later
 * outage alerts again. Deduplication is a query against the deliveries table
 * instead of a new state table, so a restart cannot resend and there is nothing
 * extra to migrate.
 */

export type AlertConfig = {
  enabled: boolean;
  /** Consecutive runs with no collected articles before an alert is sent. */
  afterFailedRuns: number;
};

export type AlertDeps = {
  config: AlertConfig;
  chatId?: string;
  botToken?: string;
  now?: Date;
};

export type RunHealth = {
  id: string;
  state: string;
  finishedAt: Date;
  sourcesTotal: number;
  failedSources: number;
  fetched: number;
};

export type Outage = {
  /** Consecutive finished runs that collected nothing, newest first. */
  runs: RunHealth[];
  /** When collection last produced articles, or null if it never has. */
  lastCollectedAt: Date | null;
};

export type AlertResult = {
  created: boolean;
  deliveryId?: string;
  reason?: string;
};

/** The trailing streak of finished runs that collected nothing. */
export function detectOutage(handle: DbHandle, limit = 50): Outage {
  const rows = handle.sqlite
    .prepare(
      `SELECT r.id AS id, r.state AS state, r.finished_at AS finishedAt,
              (SELECT count(*) FROM source_runs sr WHERE sr.run_id = r.id) AS sourcesTotal,
              (SELECT count(*) FROM source_runs sr
                 WHERE sr.run_id = r.id AND sr.state = 'failed') AS failedSources,
              (SELECT coalesce(sum(sr.fetched), 0) FROM source_runs sr
                 WHERE sr.run_id = r.id) AS fetched
         FROM refresh_runs r
        WHERE r.state IN ('succeeded','partial','failed') AND r.finished_at IS NOT NULL
        ORDER BY r.finished_at DESC
        LIMIT ?`,
    )
    .all(limit) as {
    id: string;
    state: string;
    finishedAt: number;
    sourcesTotal: number;
    failedSources: number;
    fetched: number;
  }[];

  const runs: RunHealth[] = [];
  let lastCollectedAt: Date | null = null;
  for (const row of rows) {
    if (row.fetched > 0) {
      lastCollectedAt = new Date(Number(row.finishedAt));
      break;
    }
    runs.push({
      id: row.id,
      state: row.state,
      finishedAt: new Date(Number(row.finishedAt)),
      sourcesTotal: row.sourcesTotal,
      failedSources: row.failedSources,
      fetched: row.fetched,
    });
  }

  return { runs, lastCollectedAt };
}

/**
 * Creates a pending alert delivery when an outage has lasted long enough and
 * this outage has not been reported yet. Delivery, retry and at-least-once
 * semantics are the shared ones in `deliverDue`.
 */
export function runAlertIfNeeded(handle: DbHandle, deps: AlertDeps): AlertResult {
  const { config } = deps;
  if (!config.enabled) return { created: false, reason: "alerts disabled" };
  if (!deps.chatId || !deps.botToken) {
    return { created: false, reason: "telegram credentials not configured" };
  }

  const outage = detectOutage(handle);
  if (outage.runs.length < config.afterFailedRuns) {
    return { created: false, reason: "not enough consecutive empty runs" };
  }

  // An alert is tied to the newest run of the outage it reported. If any run of
  // this streak already has one, the streak has been reported; a later outage
  // consists of different runs, so it alerts again. Using run ids instead of
  // timestamps keeps this correct even if the two clocks disagree.
  const streakRunIds = outage.runs.map((run) => run.id);
  const existing = handle.db
    .select({ id: deliveries.id })
    .from(deliveries)
    .where(and(eq(deliveries.kind, "alert"), inArray(deliveries.runId, streakRunIds)))
    .limit(1)
    .get();
  if (existing) return { created: false, reason: "already alerted" };

  const newest = outage.runs[0]!;
  const now = deps.now ?? new Date();
  const deliveryId = newId();

  handle.db
    .insert(deliveries)
    .values({
      id: deliveryId,
      runId: newest.id,
      chatId: deps.chatId,
      kind: "alert",
      items: [] as never,
      text: renderOutageAlert(handle, outage),
      state: "pending",
      attempts: 0,
      nextAttemptAt: now,
      createdAt: now,
    })
    .run();

  return { created: true, deliveryId };
}

const SHOWN_SOURCES = 5;

/** Human-readable summary of the outage; the newest run carries the detail. */
export function renderOutageAlert(handle: DbHandle, outage: Outage): string {
  const newest = outage.runs[0]!;
  const failed = handle.sqlite
    .prepare(
      `SELECT s.key AS key, sr.error AS error
         FROM source_runs sr JOIN sources s ON s.id = sr.source_id
        WHERE sr.run_id = ? AND sr.state = 'failed'
        ORDER BY s.key
        LIMIT ?`,
    )
    .all(newest.id, SHOWN_SOURCES) as { key: string; error: string | null }[];

  const lines = [
    `⚠️ 采集已连续 ${outage.runs.length} 轮没有抓到任何文章`,
    "",
    `最近一轮：${formatUtc(newest.finishedAt)}`,
    `来源：${newest.sourcesTotal} 个中 ${newest.failedSources} 个失败`,
    outage.lastCollectedAt
      ? `最近一次成功采集：${formatUtc(outage.lastCollectedAt)}`
      : "最近一次成功采集：没有记录",
  ];

  if (failed.length > 0) {
    lines.push("", "失败来源：");
    for (const row of failed) {
      const error = row.error ? ` — ${row.error.slice(0, 90)}` : "";
      lines.push(`${row.key}${error}`);
    }
    if (newest.failedSources > failed.length) {
      lines.push(`…等 ${newest.failedSources} 个`);
    }
  }

  lines.push("", "进程本身仍是健康的，请检查服务器的出网与 DNS。");
  return lines.join("\n");
}

function formatUtc(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`,
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`,
  ].join(" ");
}
