import { and, desc, eq, gte, or } from "drizzle-orm";
import { z } from "zod";
import type { DbHandle } from "../db/connection.ts";
import { deliveries, insights } from "../db/schema.ts";
import type { ModelClient } from "../insights/model.ts";
import { createRecallIndex, RECALL_MIN_RATIO } from "../news/recall.ts";
import { bumpedNotificationCandidates, type Candidate, type NotifyConfig } from "./telegram.ts";

/**
 * Cross-event duplicate suppression for notifications.
 *
 * Clustering merges articles that cover the same event, but a paraphrase can
 * still start a second event (one publisher's headline shares few words with
 * another's). This guard sits just before the delivery is frozen and asks the
 * model whether a candidate merely re-reports something the chat recently
 * received, dropping it when so.
 *
 * Candidate recall uses the same FTS5 index as clustering (recall.ts), so word
 * forms do not need a synonym table.
 *
 * Bias: fail open. A model error, an unusable answer, an exhausted budget or an
 * aborted run all keep the item, because sending a duplicate is a much smaller
 * mistake than silently withholding news. Suppressed events still have their
 * revision advanced by the freeze, so they never accumulate.
 */

const WINDOW_HOURS = 72;
/** Consider more candidates than a batch can hold so a drop can be backfilled. */
const LOOKAHEAD_FACTOR = 2;
const MAX_REFERENCES = 6;
const MAX_MODEL_CALLS = 8;

const outputSchema = z.array(
  z.object({ title: z.string(), excerpt: z.string().nullable() }).passthrough(),
);
const factsSchema = z.object({
  title: z.string().optional(),
  facts: z.array(z.object({ text: z.string() })).optional(),
});
const itemsSchema = z.array(z.object({ insightId: z.string().nullable() }));

const decisionSchema = z.object({ duplicate: z.boolean() });

const DEDUP_SYSTEM = `You decide whether a news item is already covered by items the reader recently received.
The reader wants each distinct development once, but must never miss a genuinely new development.
"duplicate" means the same concrete development, announcement or report, with no materially new facts,
even when written by a different publisher or phrased differently.
NOT a duplicate when it adds new information: a new figure or amount, a new outcome, a new official action,
a new consequence (for example a market or credit reaction), a new participant, or a different subject.
The same company, the same topic, or similar wording alone is NOT a duplicate.
Examples:
- "SpaceX in talks to borrow $40 billion to buy Nvidia chips" against an already received
  "SpaceX seeks $40bn to buy Nvidia chips" is a duplicate.
- "SpaceX credit risk jumps on worries over its borrowing spree" against that same item is NOT a duplicate,
  because the credit reaction is new information.
Answer with JSON only: {"duplicate": true|false}.`;

/** The compact comparison form of one notifiable item. */
type Reference = {
  id: string;
  /** Titles used for lexical recall: insight title first, then article titles. */
  titles: string[];
  /** Chinese fact lines, for the model to judge novelty against. */
  facts: string[];
};

export type SuppressDeps = {
  handle: DbHandle;
  model: ModelClient;
  signal: AbortSignal;
  runId: string;
  config: NotifyConfig;
  firstRun: boolean;
  now?: Date;
};

/**
 * Returns the event ids whose delivery would only repeat recent news, or
 * undefined when suppression does not apply (first run, notifications off, no
 * credentials). Callers pass the result to `runNotificationFreeze`.
 */
export async function suppressDuplicateNotifications({
  handle,
  model,
  signal,
  runId,
  config,
  firstRun,
  now = new Date(),
}: SuppressDeps): Promise<ReadonlySet<string> | undefined> {
  if (firstRun || !config.enabled || !config.chatId || !config.botToken) return undefined;

  const candidates = bumpedNotificationCandidates(handle, runId)
    .filter((event) => (event.importance ?? 0) >= config.minImportance)
    .sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0) || b.hotScore - a.hotScore)
    .slice(0, Math.max(1, config.maxItems) * LOOKAHEAD_FACTOR);

  if (candidates.length === 0) return new Set();

  const recent = recentReferences(handle, config.chatId, now);
  const index = createRecallIndex(recent.map((entry) => ({ id: entry.id, titles: entry.titles })));
  const byId = new Map(recent.map((entry) => [entry.id, entry]));

  const suppressed = new Set<string>();
  let calls = 0;

  const keep = (reference: Reference) => {
    index.add({ id: reference.id, titles: reference.titles });
    byId.set(reference.id, reference);
  };

  try {
    for (const candidate of candidates) {
      if (signal.aborted || !model.available) break;

      const reference = candidateReference(handle, candidate);
      const similar = index
        .rankAny(reference.titles, { limit: MAX_REFERENCES, minRatio: RECALL_MIN_RATIO })
        .map((hit) => byId.get(hit.id))
        .filter((entry): entry is Reference => entry !== undefined);

      // Nothing lexically close: no reason to spend a call, keep the item.
      if (similar.length === 0 || calls >= MAX_MODEL_CALLS) {
        keep(reference);
        continue;
      }

      calls += 1;
      if (await isDuplicate(model, signal, reference, similar)) {
        suppressed.add(candidate.id);
      } else {
        keep(reference);
      }
    }

    return suppressed;
  } finally {
    index.close();
  }
}

async function isDuplicate(
  model: ModelClient,
  signal: AbortSignal,
  candidate: Reference,
  references: Reference[],
): Promise<boolean> {
  try {
    const content = await model.complete({
      signal,
      temperature: 0,
      maxTokens: 1500,
      messages: [
        { role: "system", content: DEDUP_SYSTEM },
        {
          role: "user",
          content: JSON.stringify({
            candidate: { title: candidate.titles[0] ?? "", facts: candidate.facts },
            recentlyReceived: references.map((entry) => ({
              title: entry.titles[0] ?? "",
              facts: entry.facts,
            })),
          }),
        },
      ],
    });
    const parsed = decisionSchema.safeParse(extractJson(content));
    return parsed.success && parsed.data.duplicate === true;
  } catch {
    // Fail open: an unreadable decision must not withhold the news.
    return false;
  }
}

/** Frozen items of recent deliveries for this chat, newest first. */
function recentReferences(handle: DbHandle, chatId: string, now: Date): Reference[] {
  const since = new Date(now.getTime() - WINDOW_HOURS * 60 * 60 * 1000);
  const rows = handle.db
    .select()
    .from(deliveries)
    .where(
      and(
        eq(deliveries.chatId, chatId),
        or(
          eq(deliveries.state, "pending"),
          and(eq(deliveries.state, "sent"), gte(deliveries.sentAt, since)),
        ),
      ),
    )
    .orderBy(desc(deliveries.createdAt))
    .all();

  const seen = new Set<string>();
  const references: Reference[] = [];
  for (const row of rows) {
    const items = itemsSchema.safeParse(row.items);
    if (!items.success) continue;
    for (const [position, item] of items.data.entries()) {
      const id = `${row.id}:${position}`;
      if (seen.has(id)) continue;
      seen.add(id);
      references.push(referenceFromInsight(handle, item.insightId, id));
    }
  }
  return references;
}

function candidateReference(handle: DbHandle, candidate: Candidate): Reference {
  const reference = referenceFromInsight(handle, candidate.latestInsightId, candidate.id);
  return reference.titles.length > 0
    ? reference
    : { id: candidate.id, titles: [candidate.title], facts: [] };
}

/** Reads the frozen insight so an event's newer, unsent insight never leaks in. */
function referenceFromInsight(handle: DbHandle, insightId: string | null, key: string): Reference {
  const row = insightId
    ? handle.db.select().from(insights).where(eq(insights.id, insightId)).get()
    : undefined;
  if (!row) return { id: key, titles: [], facts: [] };

  const output = factsSchema.safeParse(row.output);
  const evidence = outputSchema.safeParse(row.evidence);
  const titles: string[] = [];
  if (output.success && output.data.title) titles.push(output.data.title);
  if (evidence.success) {
    for (const article of evidence.data.slice(0, 6)) titles.push(article.title);
  }
  const facts = output.success
    ? (output.data.facts ?? []).map((fact) => fact.text).slice(0, 4)
    : [];
  return { id: key, titles, facts };
}

function extractJson(content: string): unknown {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(content.slice(start, end + 1));
  } catch {
    return null;
  }
}
