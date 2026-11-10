import { PlugZap } from "lucide-react";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";

import { gameHref, ReleasePickerSkeleton, ReleasePickerView } from "@/components/catalog/release-picker";
import { PageLayout } from "@/components/layout/page-layout";
import { EmptyState } from "@/components/shared/empty-state";
import { getReleasePicker } from "@/features/catalog/queries";

export const metadata: Metadata = {
  title: "Game",
};

function first(value: string | string[] | undefined) {
  return (Array.isArray(value) ? value[0] : value)?.trim() || null;
}

async function GameContent({ params, searchParams }: PageProps<"/games/[slug]">) {
  const { slug } = await params;
  const query = await searchParams;
  const selection = { platform: first(query.platform), region: first(query.region), release: first(query.release) };

  const outcome = await getReleasePicker(slug, selection.platform, selection.region, selection.release);
  if (!outcome.ok) {
    if (outcome.reason === "unavailable") {
      return (
        <EmptyState icon={PlugZap} title="The catalog isn't available">
          The game catalog isn&apos;t connected right now. Try again later.
        </EmptyState>
      );
    }
    throw new Error("The catalog refused the request.");
  }
  const picker = outcome.data;
  if (!picker) notFound();
  // A merged game, or a link by id, goes to the game's own address.
  if (picker.game.slug !== slug) redirect(gameHref(picker.game.slug, selection));

  return <ReleasePickerView picker={picker} />;
}

export default function GamePage(props: PageProps<"/games/[slug]">) {
  return (
    <PageLayout>
      <div className="p-4 md:p-0">
        <Suspense fallback={<ReleasePickerSkeleton />}>
          <GameContent {...props} />
        </Suspense>
      </div>
    </PageLayout>
  );
}
