"use client";

import { Tabs as TabsPrimitive } from "radix-ui";
import { type ReactNode, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { cn } from "@/lib/utils";

export type GameTab = { id: string; label: string; count?: number | null; content: ReactNode };

function subscribe(onChange: () => void) {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}
const readHash = () => window.location.hash.slice(1);
const noHash = () => "";

/** Bring the tabs into view and focus the panel (rendered by now), for a keyboard or screen reader. */
function showPanel(root: HTMLElement | null, id: string) {
  if (!root) return;
  root.scrollIntoView({ block: "start" });
  root.querySelector<HTMLElement>(`[data-panel="${CSS.escape(id)}"]`)?.focus({ preventScroll: true });
}

/**
 * M17b: the game page's content as real tabs (Radix: tablist, tab and tabpanel roles, the
 * arrow keys, Home and End). The address's hash names the tab ("#releases"), so a tab can
 * be linked, and back and forward move between them. Every panel is in the page's HTML,
 * only the chosen one shown, so links and find work; without JavaScript, Overview shows.
 *
 * Game Details 2.0, Phase 2: a link into a tab from elsewhere on the page (the hero's "Read
 * more", "Manage all copies", "See physical releases") brings the tabs into view and moves focus
 * to the panel, so a phone or a screen reader lands on what was asked for. On a narrow screen the
 * tab row scrolls sideways, its edge fading while more tabs lie beyond it.
 */
export function GameTabs({ tabs }: { tabs: GameTab[] }) {
  const hash = useSyncExternalStore(subscribe, readHash, noHash);
  const [chosen, setChosen] = useState<string | null>(null);
  const fromHash = tabs.some((t) => t.id === hash) ? hash : null;
  const value = fromHash ?? chosen ?? tabs[0].id;
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const internal = useRef(false);
  const [more, setMore] = useState({ before: false, after: false });

  const choose = useCallback((id: string) => {
    setChosen(id);
    internal.current = true;
    // The address follows the tab, without jumping the page to it.
    window.history.replaceState(window.history.state, "", `#${id}`);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  }, []);

  // A link into a tab ("#overview") from elsewhere on the page, even to the tab already chosen:
  // choose it, then (after it renders) show the tabs and focus its panel.
  const [reveal, setReveal] = useState<{ id: string; at: number } | null>(null);
  const ids = tabs.map((t) => t.id).join(" ");
  useEffect(() => {
    const known = new Set(ids.split(" "));
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = (event.target as Element | null)?.closest?.("a[href^='#']");
      const id = link?.getAttribute("href")?.slice(1) ?? "";
      if (!link || !known.has(id) || link.closest("[role=tablist]")) return;
      event.preventDefault();
      setChosen(id);
      if (window.location.hash.slice(1) !== id) {
        internal.current = true;
        window.history.pushState(window.history.state, "", `#${id}`);
        window.dispatchEvent(new HashChangeEvent("hashchange"));
      }
      setReveal({ id, at: Date.now() });
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [ids]);

  // A hash from outside (opening the page with "#releases", back and forward): the same.
  useEffect(() => {
    if (internal.current) {
      internal.current = false;
      return;
    }
    if (fromHash) showPanel(root.current, fromHash);
  }, [fromHash]);

  useEffect(() => {
    if (reveal) showPanel(root.current, reveal.id);
  }, [reveal]);

  useEffect(() => {
    const el = list.current;
    if (!el) return;
    const measure = () => setMore({ before: el.scrollLeft > 2, after: el.scrollLeft + el.clientWidth < el.scrollWidth - 2 });
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    window.addEventListener("resize", measure);
    return () => {
      el.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
    };
  }, []);

  return (
    <TabsPrimitive.Root ref={root} value={value} onValueChange={choose} className="min-w-0 scroll-mt-28" data-game-tabs="">
      <TabsPrimitive.List
        ref={list}
        aria-label="About this game"
        className={cn(
          "flex gap-1 overflow-x-auto border-b border-white/[0.08] [scrollbar-width:none]",
          more.after && more.before && "[mask-image:linear-gradient(to_right,transparent,black_2rem,black_calc(100%-3rem),transparent)]",
          more.after && !more.before && "[mask-image:linear-gradient(to_right,black_calc(100%-3rem),transparent)]",
          !more.after && more.before && "[mask-image:linear-gradient(to_right,transparent,black_2rem)]",
        )}
        data-more-tabs={more.after ? "after" : more.before ? "before" : undefined}
      >
        {tabs.map((tab) => (
          <TabsPrimitive.Trigger
            key={tab.id}
            value={tab.id}
            data-tab={tab.id}
            className={cn(
              "relative inline-flex h-12 shrink-0 items-center gap-1.5 rounded-t-lg px-3.5 text-sm font-medium whitespace-nowrap text-muted-foreground outline-none transition-colors hover:text-white focus-visible:ring-3 focus-visible:ring-ring focus-visible:ring-inset motion-reduce:transition-none sm:px-4",
              "data-[state=active]:bg-primary/15 data-[state=active]:text-white data-[state=active]:after:absolute data-[state=active]:after:inset-x-3 data-[state=active]:after:-bottom-px data-[state=active]:after:h-0.5 data-[state=active]:after:rounded-full data-[state=active]:after:bg-primary-text",
            )}
          >
            {tab.label}
            {typeof tab.count === "number" ? <span className="text-xs text-muted-foreground tabular-nums">({tab.count})</span> : null}
          </TabsPrimitive.Trigger>
        ))}
      </TabsPrimitive.List>
      {tabs.map((tab) => (
        <TabsPrimitive.Content
          key={tab.id}
          value={tab.id}
          data-panel={tab.id}
          forceMount
          className="scroll-mt-28 pt-5 outline-none focus-visible:ring-3 focus-visible:ring-ring data-[state=inactive]:hidden sm:pt-6"
        >
          {tab.content}
        </TabsPrimitive.Content>
      ))}
    </TabsPrimitive.Root>
  );
}
