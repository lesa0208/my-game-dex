import { type NextRequest, NextResponse } from "next/server";

import { createSupabaseServerClient } from "@/features/auth/server";
import { exportFilename } from "@/features/export/format";
import { ExportTooLarge, exportChunks } from "@/features/export/server";

/**
 * POST /settings/account/export (M11a-4a): the signed-in person's data as a JSON
 * download. A form post from /settings/account, so it works without JavaScript.
 *
 * - Same site only: the browser's Origin must be this app's (and Sec-Fetch-Site, when
 *   sent, same-origin). The auth cookies are SameSite=Lax, so a cross-site post carries
 *   none anyway.
 * - Who: the verified token's subject, never anything in the request. An account with an
 *   authenticator must have verified it (aal2), as for a password change. And Auth must
 *   still know the session: an access token from a session that was signed out
 *   everywhere, or ended by a reset, is refused here, though it hasn't expired.
 * - How often: three an hour per account (take_request_slot, in the database).
 * - The response is private and never stored or indexed. It's streamed a page at a time;
 *   a read that fails part way ends the download unfinished (no "complete": true).
 * Errors before the download starts send the person back with a fixed code.
 */

const ACCOUNT = "/settings/account";

/** A redirect to a path of this app. Relative, so it stays on the host the browser used. */
function to(path: string) {
  return new NextResponse(null, { status: 303, headers: { Location: path, "Cache-Control": "no-store" } });
}
const back = (code: string) => to(`${ACCOUNT}?error=${encodeURIComponent(code)}`);
const SIGN_IN = `/sign-in?next=${encodeURIComponent(ACCOUNT)}`;

function sameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (!origin || !host) return false;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  const site = request.headers.get("sec-fetch-site");
  return originHost === host && (site === null || site === "same-origin");
}

export async function POST(request: NextRequest) {
  if (!sameOrigin(request)) return new NextResponse("Forbidden", { status: 403, headers: { "Cache-Control": "no-store" } });

  const supabase = await createSupabaseServerClient();
  if (!supabase) return back("export_unavailable");
  const { data: auth } = await supabase.auth.getClaims();
  const userId = auth?.claims?.sub;
  if (typeof userId !== "string") return to(SIGN_IN);

  const { data: level } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (!level || (level.nextLevel === "aal2" && level.currentLevel !== "aal2")) {
    return to(`/settings/security/verify?next=${encodeURIComponent(ACCOUNT)}`);
  }

  // Asks Auth, which refuses a session that has ended even while its token is unexpired.
  const { data: live, error: liveError } = await supabase.auth.getUser();
  if (liveError || live.user?.id !== userId) return to(SIGN_IN);

  const slot = await supabase.rpc("take_request_slot", { p_kind: "data_export" });
  if (slot.error) return back("export_failed");
  if ((slot.data as { allowed?: boolean } | null)?.allowed !== true) return back("export_too_many");

  const handle = await supabase.rpc("get_my_account");
  const now = new Date();
  const filename = exportFilename(((handle.data as { handle?: string }[] | null)?.[0]?.handle as string | undefined) ?? null, now);

  const chunks = exportChunks(supabase, { id: userId, email: typeof auth?.claims?.email === "string" ? auth.claims.email : null }, now);
  // The first part is read before answering, so a failure there is still a page with a message.
  let firstChunk: IteratorResult<string>;
  try {
    firstChunk = await chunks.next();
  } catch (error) {
    return back(error instanceof ExportTooLarge ? "export_too_large" : "export_failed");
  }
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      if (!firstChunk.done) controller.enqueue(encoder.encode(firstChunk.value));
    },
    async pull(controller) {
      try {
        const next = await chunks.next();
        if (next.done) controller.close();
        else controller.enqueue(encoder.encode(next.value));
      } catch {
        // Ends the download unfinished, without "complete": true. Nothing about the failure is sent.
        console.error("export: a read failed part way; the download was ended unfinished");
        controller.error(new Error("export failed"));
      }
    },
    cancel() {
      void chunks.return(undefined);
    },
  });

  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "private, no-store, max-age=0",
      Pragma: "no-cache",
      Expires: "0",
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex, nofollow, noarchive",
      "Referrer-Policy": "no-referrer",
      Vary: "Cookie",
    },
  });
}
