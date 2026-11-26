import { Compass, Disc3, Layers, Search } from "lucide-react";
import Link from "next/link";

import { Cabinet } from "@/components/shelf/shelf-parts";
import { Button } from "@/components/ui/button";

import { ConsoleRow } from "./example-shelf";
import { GlowPanel } from "./home-parts";

/**
 * Home for a collector with no copies yet: one invitation, not a dashboard of zeros. The
 * consoles are examples of systems to collect for, not theirs.
 */
const STEPS = [
  { icon: Search, title: "Find a game", text: "Search hundreds of real games by title, alias or system." },
  { icon: Disc3, title: "Add your copy", text: "Choose its system and region; the rest can come later." },
  { icon: Layers, title: "See it on its shelf", text: "Each system you collect for gets its own shelf, here on Home." },
] as const;

export function FirstCollection() {
  return (
    <>
      <FirstCollectionPanel />
      <section aria-labelledby="home-steps" className="mt-6">
        <h2 id="home-steps" className="mb-3 text-lg font-semibold tracking-tight">
          How it works
        </h2>
        <ol className="grid gap-3 sm:grid-cols-3">
          {STEPS.map(({ icon: Icon, title, text }, i) => (
            <li key={title} className="flex gap-3 rounded-xl border border-white/[0.08] bg-white/[0.025] p-4">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-primary/30 bg-primary/10">
                <Icon aria-hidden="true" className="size-5 text-primary-text" />
              </span>
              <div>
                <h3 className="text-sm font-semibold">
                  <span className="text-muted-foreground">{i + 1}.</span> {title}
                </h3>
                <p className="mt-0.5 text-sm text-muted-foreground">{text}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>
    </>
  );
}

function FirstCollectionPanel() {
  return (
    <GlowPanel>
      <div className="grid items-center gap-6 p-5 sm:p-8 lg:grid-cols-[1fr_1.1fr] lg:gap-10 lg:p-10">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">Your collection starts here</h1>
          <p className="mt-3 max-w-md text-base text-pretty text-muted-foreground">
            Add your first physical game and start building your collection, one system at a time.
          </p>
          <div className="mt-6 flex flex-col gap-2.5 sm:flex-row">
            <Button asChild size="control">
              <Link href="/explore">
                <Search aria-hidden="true" data-icon="inline-start" />
                Find Your First Game
              </Link>
            </Button>
            <Button asChild size="control" variant="outline">
              <Link href="/explore">
                <Compass aria-hidden="true" data-icon="inline-start" />
                Explore Games
              </Link>
            </Button>
          </div>
        </div>
        <figure>
          <Cabinet>
            <ConsoleRow />
          </Cabinet>
          <figcaption className="mt-2 text-xs text-muted-foreground">
            Systems you could collect for. Each one you add a game for gets its own shelf.
          </figcaption>
        </figure>
      </div>
    </GlowPanel>
  );
}
