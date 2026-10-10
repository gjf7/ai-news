import { resolve } from "node:path";
import { createDb } from "../src/db/connection.ts";
import { migrate } from "../src/db/migrate.ts";
import { digestCandidates, renderDigest } from "../src/notifications/digest.ts";

/**
 * Prints the exact text a daily digest would send, without creating a delivery
 * or calling Telegram. Rendering goes through the same functions the sender
 * uses, so this cannot drift from what is actually sent.
 *
 * Usage:
 *   vp run server#preview-digest                 # last 24h (the real window)
 *   DIGEST_PREVIEW_HOURS=720 vp run server#preview-digest
 *   DIGEST_MIN_IMPORTANCE=70 DIGEST_MAX_ITEMS=5 vp run server#preview-digest
 */

const hours = Number(process.env.DIGEST_PREVIEW_HOURS ?? 24);
const minImportance = Number(process.env.DIGEST_MIN_IMPORTANCE ?? 50);
const maxItems = Number(process.env.DIGEST_MAX_ITEMS ?? 10);

const databasePath = resolve(process.env.DATABASE_PATH ?? "./data/app.db");
const handle = createDb(databasePath);
migrate(handle.sqlite);

const since = new Date(Date.now() - hours * 60 * 60 * 1000);
const selected = digestCandidates(handle, { since, minImportance, maxItems });

console.log(
  `database: ${databasePath}\nwindow:   last ${hours}h (since ${since.toISOString()})\n` +
    `filter:   importance >= ${minImportance}, max ${maxItems}\n` +
    `matched:  ${selected.length}\n`,
);

if (selected.length === 0) {
  console.log("(no candidates - nothing would be sent; the delivery stays due)");
} else {
  console.log("──────────── message ────────────");
  console.log(renderDigest(handle, selected));
  console.log("─────────────────────────────────");
}

handle.close();
