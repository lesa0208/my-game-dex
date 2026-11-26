"use client";

import { Tabs as TabsPrimitive } from "radix-ui";
import { type ReactNode, useCallback, useState, useSyncExternalStore } from "react";

import { cn } from "@/lib/utils";

export type GameTab = { id: string; label: string; count?: number | null; content: ReactNode };

function subscribe(onChange: () => void) {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}
const readHash = () => window.location.hash.slice(1);
const noHash = () => "";

/**
 * M17b: the game page's content as real tabs (Radix: tablist, tab and tabpanel roles, the
 * arrow keys, Home and End). The address's hash names the tab ("#releases"), so a tab can
 * be linked, and back and forward move between them. Every panel is in the page's HTML,
 * only the chosen one shown, so links and find work; without JavaScript, Overview shows.
 */
export function GameTabs({ tabs }: { tabs: GameTab[] }) {
  const hash = useSyncExternalStore(subscribe, readHash, noHash);
  const [chosen, setChosen] = useState<string | null>(null);
  const fromHash = tabs.some((t) => t.id === hash) ? hash : null;
  const value = fromHash ?? chosen ?? tabs[0].id;

  const choose = useCallback((id: string) => {
    setChosen(id);
    // The address follows the tab, without jumping the page to it.
    window.history.replaceState(window.history.state, "", `#${id}`);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  }, []);

  return (
    <TabsPrimitive.Root value={value} onValueChange={choose} className="min-w-0" data-game-tabs="">
      <TabsPrimitive.List aria-label="About this game" className="flex gap-1 overflow-x-auto border-b border-white/[0.08] [scrollbar-width:none]">
        {tabs.map((tab) => (
          <TabsPrimitive.Trigger
            key={tab.id}
            value={tab.id}
            data-tab={tab.id}
            className={cn(
              "relative inline-flex h-12 shrink-0 items-center gap-1.5 rounded-t-lg px-4 text-sm font-medium whitespace-nowrap text-muted-foreground outline-none transition-colors hover:text-white focus-visible:ring-3 focus-visible:ring-ring focus-visible:ring-inset motion-reduce:transition-none",
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
          className="pt-6 outline-none focus-visible:ring-3 focus-visible:ring-ring data-[state=inactive]:hidden"
        >
          {tab.content}
        </TabsPrimitive.Content>
      ))}
    </TabsPrimitive.Root>
  );
}
