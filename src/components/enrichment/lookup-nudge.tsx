"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";

/**
 * Asks the server, once, to run a lookup that is due (M15 submission enrichment): one that failed
 * or never ran. The lookup runs in a server action's after(), which completes reliably; a page
 * render's after() does not. When `refreshAfterMs` is set, the page reloads its data once, to
 * show the answer. Renders nothing. Without JavaScript nothing happens here, and editors still
 * have "Look up again".
 */
export function LookupNudge({ run, refreshAfterMs }: { run: () => Promise<void>; refreshAfterMs?: number }) {
  const router = useRouter();
  const sent = useRef(false);
  useEffect(() => {
    if (sent.current) return;
    sent.current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    run()
      .then(() => {
        if (refreshAfterMs) timer = setTimeout(() => router.refresh(), refreshAfterMs);
      })
      .catch(() => undefined);
    return () => clearTimeout(timer);
  }, [run, refreshAfterMs, router]);
  return null;
}
