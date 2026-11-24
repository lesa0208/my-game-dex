"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore, useTransition, type FormEvent, type ReactNode } from "react";

import { LIVE_SEARCH_DELAY_MS, liveSearchHref, tooShortToSearch } from "@/features/records/live-search";
import { cn } from "@/lib/utils";

/**
 * A GET search form that follows what is typed (M15 catalog UX). Without JavaScript it is the
 * plain form it wraps, submitted with its button. With JavaScript:
 *   - typing updates the results after a short pause, and a filter change at once;
 *   - Enter searches at once; the button is hidden, since it isn't needed;
 *   - only the latest request counts: a navigation started later replaces an earlier one, and the
 *     same address is never requested twice in a row;
 *   - "Searching…" is announced politely while results load, and focus stays where it is.
 * The server still runs every search, with every permission check: this only changes the URL.
 */
const noSubscription = () => () => {};

export function LiveSearchForm({
  action,
  className,
  queryName = "q",
  children,
}: {
  action: string;
  className?: string;
  queryName?: string;
  children: ReactNode;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // True once hydrated in a browser (JavaScript on); false on the server and without JavaScript.
  const enhanced = useSyncExternalStore(noSubscription, () => true, () => false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const last = useRef<string | null>(null);
  // A one-letter query isn't searched: say so, so the results shown aren't taken for its matches.
  const [tooShort, setTooShort] = useState(false);

  useEffect(() => {
    last.current = `${window.location.pathname}${window.location.search}`;
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  function follow(form: HTMLFormElement, delay: number) {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const data = new FormData(form);
      const short = tooShortToSearch(data.get(queryName) as string | null);
      setTooShort(short);
      if (short) return;
      const href = liveSearchHref(action, data.entries());
      if (href === last.current) return;
      last.current = href;
      startTransition(() => router.replace(href, { scroll: false }));
    }, delay);
  }

  const onInput = (event: FormEvent<HTMLFormElement>) => {
    const target = event.target as HTMLInputElement;
    const typed = target.tagName === "INPUT" && ["search", "text"].includes(target.type);
    follow(event.currentTarget, typed ? LIVE_SEARCH_DELAY_MS : 0);
  };

  return (
    <form
      method="get"
      action={action}
      className={cn("group/live", className)}
      data-live={enhanced ? "on" : undefined}
      aria-busy={pending || undefined}
      onInput={onInput}
      onSubmit={(event) => {
        event.preventDefault();
        follow(event.currentTarget, 0);
      }}
    >
      {children}
      <p role="status" aria-live="polite" className="min-h-5 text-sm text-muted-foreground">
        {pending ? "Searching…" : tooShort ? "Type at least two letters to search. The results below are still for your previous search." : ""}
      </p>
    </form>
  );
}

/** Class for the form's own submit button: shown without JavaScript, hidden once search follows typing. */
export const liveSearchSubmitClass = "group-data-[live=on]/live:hidden";
