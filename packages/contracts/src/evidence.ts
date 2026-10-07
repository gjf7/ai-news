import { z } from "zod";

/**
 * Content available for a piece of evidence. There is no `fulltext` scope:
 * insights only ever use what the source provided (title and RSS excerpt),
 * so the original article body is never fetched. See decisions.md D15.
 */
export const Evidence = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("headline"), title: z.string() }),
  z.object({ scope: z.literal("excerpt"), title: z.string(), excerpt: z.string() }),
]);

export type Evidence = z.infer<typeof Evidence>;

export const EvidenceScope = z.enum(["headline", "excerpt"]);
export type EvidenceScope = z.infer<typeof EvidenceScope>;
