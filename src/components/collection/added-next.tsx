"use client";

import { CircleCheck, Search } from "lucide-react";
import Form from "next/form";
import Link from "next/link";
import { useId } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * What an addition offers next (collector fast add): where the copy is now, and a search
 * for the next game on the same platform, so a collector adding a pile of games goes from
 * one to the next without hunting for the search box.
 */

export type AddedPlatform = { slug: string; name: string } | null;

/** "Added. You now have 3 copies of this release." The count is the owner's, after the addition. */
export function addedMessage(message: string | null, count: number | null, unit: "release" | "game") {
  if (message !== "Added to your collection." || !count || count < 2) return message;
  return `Added. You now have ${count.toLocaleString("en")} copies of this ${unit}.`;
}

/** The confirmation, with links to the platform's shelf and the collection. Goes in the form's status region. */
export function AddedConfirmation({ message, platform }: { message: string; platform: AddedPlatform }) {
  return (
    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-primary/40 bg-primary/10 px-3 py-2.5 text-sm">
      <CircleCheck aria-hidden="true" className="size-4 shrink-0 text-primary-text" />
      <span className="font-medium">{message}</span>
      {platform ? (
        <Link href={`/collection/systems/${platform.slug}`} className="text-primary-text underline underline-offset-4">
          Your {platform.name} shelf
        </Link>
      ) : null}
      <Link href="/collection" className="text-primary-text underline underline-offset-4">
        Your collection
      </Link>
    </p>
  );
}

/**
 * The next game's search, on the same platform. A plain GET form to /explore (next/form
 * navigates without a full load when JavaScript runs), placed after the add form, never
 * inside it.
 */
export function NextGameSearch({ platform }: { platform: AddedPlatform }) {
  const id = useId();
  const label = platform ? `Next game on ${platform.name}` : "Next game";
  return (
    <Form action="/explore" role="search" aria-label="Next game" className="flex gap-2">
      {platform ? <input type="hidden" name="platform" value={platform.slug} /> : null}
      <label htmlFor={`${id}-next`} className="sr-only">
        {label}
      </label>
      <div className="relative min-w-0 flex-1">
        <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input id={`${id}-next`} type="search" name="q" maxLength={100} required autoComplete="off" placeholder={label} className="h-10 bg-background pl-9" />
      </div>
      <Button type="submit" variant="secondary" size="lg" className="h-10 px-4">
        Find
      </Button>
    </Form>
  );
}
