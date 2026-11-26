"use client";

import { Heart, ListChecks, MoreHorizontal } from "lucide-react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

/**
 * M17b: the hero's "More" menu. "Wishlist options…" opens the My Copies tab at the
 * wishlist panel (a platform, a region or one release, priority and note), on demand
 * rather than as a form beside the game; "Add step by step" opens the step-by-step add.
 * Nothing here adds or wishes by itself.
 */
export function HeroMore({ stepByStepHref, title }: { stepByStepHref: string; title: string }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="secondary" size="icon" className="size-10 shrink-0" aria-label={`More for ${title}`} data-action="more">
          <MoreHorizontal aria-hidden="true" className="size-5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuItem
          onSelect={() => {
            window.location.hash = "my-copies";
            // After the tab shows, bring the wishlist panel into view and focus its heading area.
            requestAnimationFrame(() => requestAnimationFrame(() => document.getElementById("game-wishlist")?.scrollIntoView({ block: "start", behavior: "smooth" })));
          }}
        >
          <Heart aria-hidden="true" />
          Wishlist options…
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href={stepByStepHref}>
            <ListChecks aria-hidden="true" />
            Add step by step
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
