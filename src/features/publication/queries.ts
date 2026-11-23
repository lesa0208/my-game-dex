import "server-only";

import { createSupabaseServerClient } from "@/features/auth/server";
import type { Person } from "@/features/batches/queries";
import { UUID } from "@/features/collection/uuid";

import type { QueueState } from "./form";

/**
 * The publication queue (M14c-3), read with the staff member's own session through
 * list_publication_queue, which checks the caller itself. Bounded pages, never cached.
 */

type Loaded<T> = { ok: true; data: T } | { ok: false; reason: "unavailable" | "refused" };

export type QueueItem = {
  game: { id: string; title: string; status: string; revision: number; slug: string | null };
  platform: { id: string; slug: string; name: string; short_name: string };
  pairing_status: string;
  state: Exclude<QueueState, "all">;
  reason: string | null;
  at: string;
  physical: {
    source: string | null;
    reference: string | null;
    note: string | null;
    batch_id: string | null;
    verified_at: string;
    current: boolean;
    verifier: Person;
  } | null;
  releases: { total: number; published: number };
  you: "you_confirmed" | "you_created" | null;
};

export type QueueCursor = { at: string; game: string; platform: string };

export type PublicationQueue = {
  status: "ok" | "unknown_platform";
  counts: Partial<Record<Exclude<QueueState, "all">, number>>;
  items: QueueItem[];
  next_after: QueueCursor | null;
};

export const QUEUE_PAGE_SIZE = 25;

/** A cursor from the URL: all three parts of a fixed shape, or none. */
export function readCursor(at: string | null, game: string | null, platform: string | null): QueueCursor | null {
  if (!at || !game || !platform) return null;
  if (!UUID.test(game) || !UUID.test(platform) || at.length > 40 || Number.isNaN(Date.parse(at))) return null;
  return { at, game, platform };
}

export async function listPublicationQueue(state: QueueState, platform: string | null, after: QueueCursor | null): Promise<Loaded<PublicationQueue | null>> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { ok: false, reason: "unavailable" };
  const { data, error } = await supabase.rpc("list_publication_queue", {
    p_state: state === "all" ? null : state,
    p_platform: platform,
    p_after_at: after?.at ?? null,
    p_after_game: after?.game ?? null,
    p_after_platform: after?.platform ?? null,
    p_limit: QUEUE_PAGE_SIZE,
  });
  if (error) return error.code === "P0001" || error.code === "42501" || error.code === "22023" ? { ok: false, reason: "refused" } : { ok: false, reason: "unavailable" };
  return { ok: true, data: typeof data === "object" && data !== null ? (data as PublicationQueue) : null };
}
