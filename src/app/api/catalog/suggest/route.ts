import { type NextRequest, NextResponse } from "next/server";

import { suggestCatalog } from "@/features/catalog/queries";
import { suggestQuery } from "@/features/catalog/suggest";

/**
 * GET /api/catalog/suggest?q=… (M17a): search suggestions while typing, for the Explore
 * and header searches. Public catalog data only, read as anon and cached (see
 * suggestCatalog), so no session is read and nothing personal is returned.
 *
 * The browser waits for a pause in typing and cancels superseded requests. Behind that,
 * each client gets a few requests a second here, so a script can't drive the database
 * through this endpoint; cached answers make repeats cheap anyway.
 */

const WINDOW_MS = 10_000;
const PER_WINDOW = 40;
const recent = new Map<string, number[]>();

function allowed(client: string, now: number): boolean {
  const times = (recent.get(client) ?? []).filter((t) => now - t < WINDOW_MS);
  if (times.length >= PER_WINDOW) {
    recent.set(client, times);
    return false;
  }
  times.push(now);
  recent.set(client, times);
  // Forget idle clients now and then, so the map stays small.
  if (recent.size > 5000) for (const [key, value] of recent) if (!value.some((t) => now - t < WINDOW_MS)) recent.delete(key);
  return true;
}

export async function GET(request: NextRequest) {
  const query = suggestQuery(request.nextUrl.searchParams.get("q") ?? "");
  if (!query) return NextResponse.json({ suggestions: [] }, { headers: { "Cache-Control": "no-store" } });

  const client = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "local";
  if (!allowed(client, Date.now())) {
    return NextResponse.json({ error: "slow_down" }, { status: 429, headers: { "Retry-After": "5", "Cache-Control": "no-store" } });
  }

  try {
    const outcome = await suggestCatalog(query);
    if (!outcome.ok) return NextResponse.json({ suggestions: [] }, { status: outcome.reason === "unavailable" ? 503 : 200, headers: { "Cache-Control": "no-store" } });
    // Public and the same for everyone; a browser may reuse it briefly.
    return NextResponse.json({ suggestions: outcome.data }, { headers: { "Cache-Control": "public, max-age=60" } });
  } catch {
    return NextResponse.json({ suggestions: [] }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
