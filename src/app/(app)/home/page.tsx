import { PlugZap } from "lucide-react";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";

import { CollectionHome } from "@/components/home/collection-home";
import { FirstCollection } from "@/components/home/first-collection";
import { HomeContainer } from "@/components/home/home-parts";
import { HomeLanding } from "@/components/home/home-landing";
import { EmptyState } from "@/components/shared/empty-state";
import { getCurrentViewer } from "@/features/account/queries";
import { welcomeHref } from "@/features/auth/redirect";
import { selfRegistrationOpen } from "@/features/auth/registration";
import { getHomeCollection } from "@/features/home/queries";

export const metadata: Metadata = {
  title: "Home",
};

/**
 * M16: Home is the collector's own collection, read with their session (their systems,
 * counts and newest copies), an invitation to start one when they have no copies, or,
 * signed out, what My Game Dex is for. The social feed isn't shown here.
 */
async function HomeView() {
  await connection();
  const viewer = await getCurrentViewer().catch(() => undefined);
  if (viewer === undefined) return <Unavailable />;
  if (!viewer) return <HomeLanding canSignUp={selfRegistrationOpen()} />;
  if (!viewer.handle) redirect(welcomeHref("/home"));

  const home = await getHomeCollection();
  // A collection that can't be read is said so, never shown as an empty one.
  if (!home.ok) return <Unavailable />;
  if (home.data.copies === 0) return <FirstCollection />;
  return <CollectionHome data={home.data} />;
}

function Unavailable() {
  return (
    <>
      <h1 className="sr-only">Home</h1>
      <EmptyState icon={PlugZap} title="Your collection isn't available">
        It can&apos;t be loaded right now. Nothing in it has changed; try again in a moment.
      </EmptyState>
    </>
  );
}

function HomeSkeleton() {
  return (
    <div aria-hidden="true" className="animate-pulse motion-reduce:animate-none">
      <div className="h-36 rounded-2xl bg-secondary/70" />
      <div className="mt-6 h-6 w-40 rounded bg-secondary" />
      <div className="mt-3 h-80 rounded-xl bg-secondary/50" />
    </div>
  );
}

export default function HomePage() {
  return (
    <HomeContainer>
      <Suspense fallback={<HomeSkeleton />}>
        <HomeView />
      </Suspense>
    </HomeContainer>
  );
}
