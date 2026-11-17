import type { Metadata } from "next";
import Link from "next/link";

import { AdminFrame, AdminShell, linkClass } from "@/components/admin/admin-frame";
import { GameInputs } from "@/components/admin/edit-fields";
import { EditForm, ReasonField } from "@/components/admin/edit-form";
import { RecordSection } from "@/components/admin/records";
import { requireAdminSection } from "@/features/admin/queries";
import { createGame, createGameFromForm } from "@/features/editing/actions";

export const metadata: Metadata = {
  title: "New game",
};

/**
 * Adding a game to the catalog (M10c). It starts in review; whoever creates it can't
 * verify or publish it (D2). A game is published with its first published physical
 * release, which is added from the game's record.
 */
async function NewGameView() {
  const { access } = await requireAdminSection("/admin/catalog/games/new", "editor");
  return (
    <AdminFrame narrow access={access} current="catalog" title="New game" titleId="new-game-heading">
      <div className="flex flex-col gap-4">
        <p className="text-sm">
          <Link href="/admin/catalog/search" className={linkClass}>
            Catalog records
          </Link>
        </p>
        <p className="text-sm text-muted-foreground">
          A game is the work itself, on any platform. Its physical releases, and collectors&apos; copies of them, are recorded separately. Search the catalog first, so
          the game isn&apos;t added twice.
        </p>
        <RecordSection id="new-game-section" title="The game">
          <EditForm id="new-game" recordId="new" action={createGame} plain={createGameFromForm} submit="Add the game" pending="Adding…" variant="default">
            <GameInputs id="new-game" game={null} />
            <ReasonField id="new-game" />
          </EditForm>
        </RecordSection>
        <p className="text-sm text-muted-foreground">It starts in review. Another editor verifies it; you can&apos;t verify or publish a record you created.</p>
      </div>
    </AdminFrame>
  );
}

export default function NewGamePage() {
  return (
    <AdminShell>
      <NewGameView />
    </AdminShell>
  );
}
