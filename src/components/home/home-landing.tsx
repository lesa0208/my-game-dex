import { Compass, Disc3, Layers, Library, UserPlus } from "lucide-react";
import Link from "next/link";

import { Button } from "@/components/ui/button";

import { ExampleShelf } from "./example-shelf";
import { GlowPanel } from "./home-parts";

const BENEFITS = [
  { icon: Layers, title: "Organize by System", text: "Every system you collect for gets its own shelf." },
  { icon: Disc3, title: "Track Physical Copies", text: "Region, completeness and condition, copy by copy." },
  { icon: Library, title: "Build Your Collection", text: "Find games in the catalog and add them in a few clicks." },
] as const;

/**
 * Home for a signed-out visitor: what My Game Dex is for, with an example shelf. "Create
 * Account" only where this server lets people register (M16); elsewhere accounts are by
 * invitation and the way in is signing in.
 */
export function HomeLanding({ canSignUp }: { canSignUp: boolean }) {
  return (
    <>
      <GlowPanel>
        <div className="grid items-center gap-8 p-5 sm:p-8 lg:grid-cols-[1fr_1.15fr] lg:gap-12 lg:p-12">
          <div>
            <h1 className="text-3xl leading-[1.1] font-semibold tracking-tight text-balance sm:text-5xl">Your Physical Game Collection, Beautifully Organized.</h1>
            <p className="mt-4 max-w-lg text-base text-pretty text-muted-foreground sm:text-lg">
              Track your games, explore your favorite systems, and build a collection that&apos;s uniquely yours.
            </p>
            <div className="mt-7 flex flex-col gap-2.5 sm:flex-row">
              {canSignUp ? (
                <Button asChild size="control">
                  <Link href="/sign-up">
                    <UserPlus aria-hidden="true" data-icon="inline-start" />
                    Create Account
                  </Link>
                </Button>
              ) : null}
              <Button asChild size="control" variant={canSignUp ? "outline" : "default"}>
                <Link href="/explore">
                  <Compass aria-hidden="true" data-icon="inline-start" />
                  Explore Games
                </Link>
              </Button>
              {canSignUp ? null : (
                <Button asChild size="control" variant="outline">
                  <Link href="/sign-in">Sign In</Link>
                </Button>
              )}
            </div>
            <p className="mt-4 text-sm text-muted-foreground">
              {canSignUp ? (
                <>
                  Already have an account?{" "}
                  <Link href="/sign-in" className="font-medium text-primary-text underline-offset-4 hover:underline">
                    Sign in
                  </Link>
                </>
              ) : (
                "Accounts are by invitation for now."
              )}
            </p>
          </div>
          <ExampleShelf />
        </div>
      </GlowPanel>

      <section aria-labelledby="home-benefits" className="mt-6">
        <h2 id="home-benefits" className="sr-only">
          What you can do
        </h2>
        <ul className="grid gap-3 sm:grid-cols-3">
          {BENEFITS.map(({ icon: Icon, title, text }) => (
            <li key={title} className="flex gap-3 rounded-xl border border-white/[0.08] bg-white/[0.025] p-4">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-primary/30 bg-primary/10">
                <Icon aria-hidden="true" className="size-5 text-primary-text" />
              </span>
              <div>
                <h3 className="text-sm font-semibold">{title}</h3>
                <p className="mt-0.5 text-sm text-muted-foreground">{text}</p>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
