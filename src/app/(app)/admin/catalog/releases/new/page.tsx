import { PlugZap } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { AdminFrame, AdminShell, linkClass, param } from "@/components/admin/admin-frame";
import { PlatformInputs, ReleaseInputs } from "@/components/admin/edit-fields";
import { EditForm, ReasonField } from "@/components/admin/edit-form";
import { RecordSection } from "@/components/admin/records";
import { editable } from "@/components/admin/review-panel";
import { EmptyState } from "@/components/shared/empty-state";
import { requireAdminSection } from "@/features/admin/queries";
import { UUID } from "@/features/collection/uuid";
import { createRelease, createReleaseFromForm } from "@/features/editing/actions";
import { getEditingOptions } from "@/features/editing/queries";
import { getGameRecord } from "@/features/records/queries";

export const metadata: Metadata = {
  title: "New physical release",
};

/**
 * Adding a physical release of a game (M10c): one product, on one platform and in one
 * region, that collectors own copies of. It starts in review; whoever creates it can't
 * verify or publish it (D2).
 */
async function NewReleaseView({ searchParams }: { searchParams: PageProps<"/admin/catalog/releases/new">["searchParams"] }) {
  const search = await searchParams;
  const game = param(search.game);
  const path = game && UUID.test(game) ? `/admin/catalog/releases/new?game=${game}` : "/admin/catalog/search";
  const { access } = await requireAdminSection(path, "editor");
  if (!game || !UUID.test(game)) notFound();
  const [outcome, options] = await Promise.all([getGameRecord(game), getEditingOptions()]);
  if (!outcome.ok || !options) {
    if (!outcome.ok && outcome.reason === "refused") notFound();
    return (
      <AdminFrame narrow access={access} current="catalog" title="New physical release">
        <EmptyState icon={PlugZap} title="This page isn't available">
          It can&apos;t be loaded right now. Try again later.
        </EmptyState>
      </AdminFrame>
    );
  }
  const g = outcome.data;
  if (!g) notFound();

  return (
    <AdminFrame narrow access={access} current="catalog" title={`New release of ${g.title}`} titleId="new-release-heading">
      <div className="flex flex-col gap-4">
        <p className="text-sm">
          <Link href={`/admin/catalog/games/${g.id}`} className={linkClass}>
            Back to the game record
          </Link>
        </p>
        {!editable(g.status) ? (
          <p className="rounded-lg border px-4 py-3 text-sm">A game in this state can&apos;t have new releases.</p>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              A physical release is one product: a platform, a region, an edition. Collectors own copies of it. Check its releases first, so it isn&apos;t added twice.
            </p>
            <RecordSection id="new-release-section" title="The physical release">
              <EditForm id="new-release" recordId={g.id} action={createRelease} plain={createReleaseFromForm} submit="Add the release" pending="Adding…" variant="default">
                <input type="hidden" name="game_id" value={g.id} />
                <PlatformInputs id="new-release" platforms={options.platforms} formats={options.formats} />
                <ReleaseInputs id="new-release" release={null} regions={options.regions} />
                <ReasonField id="new-release" />
              </EditForm>
            </RecordSection>
            <p className="text-sm text-muted-foreground">It starts in review. Another editor verifies and publishes it; you can&apos;t do either for a record you created.</p>
          </>
        )}
      </div>
    </AdminFrame>
  );
}

export default function NewReleasePage({ searchParams }: PageProps<"/admin/catalog/releases/new">) {
  return (
    <AdminShell>
      <NewReleaseView searchParams={searchParams} />
    </AdminShell>
  );
}
