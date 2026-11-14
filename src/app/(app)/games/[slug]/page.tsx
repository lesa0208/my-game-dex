import { PlugZap } from "lucide-react";
import type { Metadata } from "next";
import { notFound, permanentRedirect, redirect } from "next/navigation";
import { Suspense } from "react";

import { gameHref, ReleasePickerSkeleton, ReleasePickerView } from "@/components/catalog/release-picker";
import { AddToCollection, AddToCollectionSkeleton } from "@/components/collection/add-to-collection";
import { ExcludeReleaseLink } from "@/components/exclusion/exclude-release-link";
import { PageLayout } from "@/components/layout/page-layout";
import { MergeReleaseLink } from "@/components/merge/merge-release-link";
import { EmptyState } from "@/components/shared/empty-state";
import { getReleasePicker, resolveMergedRelease } from "@/features/catalog/queries";

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
  // A link to a release merged while published goes to the release it was merged into
  // (M7b-2c D14). Checked only when the release asked for isn't shown, and uncached, so
  // it answers as of now. Any other id, a release merged while unpublished included,
  // gets the same page as an unknown one. Inside this streamed boundary the redirect is
  // sent as the client-side redirect Next.js emits there, as for a merged game.
  if (selection.release && !picker.selection.releaseId) {
    const merged = await resolveMergedRelease(selection.release);
    if (merged) permanentRedirect(gameHref(merged.gameSlug, { platform: null, region: null, release: merged.releaseId }));
  }
  // A merged game, or a link by id, goes to the game's own address.
  if (picker.game.slug !== slug) redirect(gameHref(picker.game.slug, selection));

  // The catalog above is public and cached. Adding reads the session, so it streams in
  // on its own, and returns here after signing in.
  return (
    <ReleasePickerView
      picker={picker}
      requestedRelease={selection.release !== null}
      renderAdd={(release) => (
        <>
          <Suspense fallback={<AddToCollectionSkeleton />}>
            <AddToCollection release={release} returnPath={gameHref(picker.game.slug, { ...selection, release: release.id })} />
          </Suspense>
          <Suspense fallback={null}>
            <ExcludeReleaseLink releaseId={release.id} />
          </Suspense>
          <Suspense fallback={null}>
            <MergeReleaseLink releaseId={release.id} />
          </Suspense>
        </>
      )}
    />
  );
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
