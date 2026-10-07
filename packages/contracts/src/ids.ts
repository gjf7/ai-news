import { z } from "zod";

/**
 * Branded identifiers. The brand is compile-time only: at runtime these are
 * plain strings, so a raw string can never be passed where a specific id is
 * expected by accident.
 */
export const EventId = z.string().min(1).brand<"EventId">();
export const ArticleId = z.string().min(1).brand<"ArticleId">();
export const RunId = z.string().min(1).brand<"RunId">();
export const SourceId = z.string().min(1).brand<"SourceId">();
export const InsightId = z.string().min(1).brand<"InsightId">();
export const DeliveryId = z.string().min(1).brand<"DeliveryId">();

export type EventId = z.infer<typeof EventId>;
export type ArticleId = z.infer<typeof ArticleId>;
export type RunId = z.infer<typeof RunId>;
export type SourceId = z.infer<typeof SourceId>;
export type InsightId = z.infer<typeof InsightId>;
export type DeliveryId = z.infer<typeof DeliveryId>;
