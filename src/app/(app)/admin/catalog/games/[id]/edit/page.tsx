import { PlugZap } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { AdminFrame, AdminShell, linkClass, param } from "@/components/admin/admin-frame";
import { GameInputs } from "@/components/admin/edit-fields";
import { EditForm, ReasonField } from "@/components/admin/edit-form";
import { RecordSection, StatusBadge } from "@/components/admin/records";
import { editable, EditNotice, StepUpNotice } from "@/components/admin/review-panel";
import { Field, selectClassName } from "@/components/collection/copy-fields";
import { EmptyState } from "@/components/shared/empty-state";
import { Input } from "@/components/ui/input";
import { requireAdminSection } from "@/features/admin/queries";
import { aliasKindLabel, languageName } from "@/features/catalog/format";
import { UUID } from "@/features/collection/uuid";
import {
  addAlias,
  addAliasFromForm,
  addPlatform,
  addPlatformFromForm,
  editGame,
  editGameFromForm,
  removeAlias,
  removeAliasFromForm,
  setLock,
  setLockFromForm,
  setRelation,
  setRelationFromForm,
} from "@/features/editing/actions";
import { ALIAS_KINDS, LOCKABLE_FIELDS, needsRecentVerification, RELATIONS } from "@/features/editing/form";
import { getEditingOptions } from "@/features/editing/queries";
import { recordFieldLabel } from "@/features/records/form";
import { getGameRecord } from "@/features/records/queries";

export const metadata: Metadata = {
  title: "Edit game",
};

function Hidden({ id, revision }: { id: string; revision: number }) {
  return (
    <>
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="revision" value={revision} />
    </>
  );
}

async function EditGameView({ params, searchParams }: { params: PageProps<"/admin/catalog/games/[id]/edit">["params"]; searchParams: PageProps<"/admin/catalog/games/[id]/edit">["searchParams"] }) {
  const { id } = await params;
  const search = await searchParams;
  const path = UUID.test(id) ? `/admin/catalog/games/${id}/edit` : "/admin/catalog/search";
  const { access } = await requireAdminSection(path, "editor");
  const [outcome, options] = await Promise.all([getGameRecord(id), getEditingOptions()]);
  if (!outcome.ok || !options) {
    if (!outcome.ok && outcome.reason === "refused") notFound();
    return (
      <AdminFrame access={access} current="catalog" title="Edit game">
        <EmptyState icon={PlugZap} title="This record isn't available">
          It can&apos;t be loaded right now. Try again later.
        </EmptyState>
      </AdminFrame>
    );
  }
  const g = outcome.data;
  if (!g) notFound();
  const record = `/admin/catalog/games/${g.id}`;
  // D3: changing a published game needs a recent TOTP verification, asked for first.
  const gated = needsRecentVerification("edit", g.status) && !access.recentMfa;
  const unpaired = options.platforms.filter((p) => !g.platforms.some((x) => x.slug === p.slug));
  const locked = new Set(g.field_locks.map((l) => l.field));

  return (
    <AdminFrame access={access} current="catalog" title={`Edit ${g.title}`} titleId="edit-game-heading">
      <div className="flex flex-col gap-4">
        <p className="text-sm">
          <Link href={record} className={linkClass}>
            Back to the game record
          </Link>
        </p>
        <EditNotice notice={param(search.notice)} />
        <p className="flex flex-wrap items-center gap-2 text-sm">
          <StatusBadge status={g.status} />
          {g.status === "published"
            ? "Published: changes are public at once, and need a recent verification."
            : g.verified_at
              ? "Verified. Any change ends the verification, and the game is verified again as it then is."
              : "Not verified yet."}
        </p>

        {!editable(g.status) ? (
          <p className="rounded-lg border px-4 py-3 text-sm">A game in this state can&apos;t be changed.</p>
        ) : (
          <>
            <RecordSection id="edit-details" title="Details">
              {gated ? (
                <StepUpNotice path={path}>Changing a published game needs a recent verification.</StepUpNotice>
              ) : (
                <EditForm id="edit-game" recordId={g.id} action={editGame} plain={editGameFromForm} submit="Save the details" pending="Saving…">
                  <Hidden id={g.id} revision={g.revision} />
                  <GameInputs
                    id="edit-game"
                    game={{
                      title: g.title,
                      sort_title: g.sort_title,
                      kind: g.kind,
                      summary: g.summary,
                      first_release_year: g.first_release ? Number(g.first_release.value.slice(0, 4)) : null,
                    }}
                  />
                  <ReasonField id="edit-game" />
                </EditForm>
              )}
            </RecordSection>

            <RecordSection id="edit-titles" title="Other titles">
              {g.aliases.length ? (
                <ul className="mb-4 flex flex-col gap-1.5 text-sm">
                  {g.aliases.map((a) => (
                    <li key={a.id}>
                      {a.title}{" "}
                      <span className="text-muted-foreground">
                        · {[aliasKindLabel(a.kind), a.language_code ? languageName(a.language_code) : null, a.region_code].filter(Boolean).join(" · ")}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mb-4 text-sm text-muted-foreground">No other titles are recorded.</p>
              )}
              {gated ? (
                <StepUpNotice path={path}>A published game&apos;s other titles are public, so changing them needs a recent verification.</StepUpNotice>
              ) : (
                <div className="flex flex-col gap-6">
                  <EditForm id="add-alias" recordId={g.id} action={addAlias} plain={addAliasFromForm} submit="Add the title" pending="Adding…">
                    <Hidden id={g.id} revision={g.revision} />
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Field id="add-alias-title" label="Other title">
                        <Input id="add-alias-title" name="alias_title" required maxLength={200} autoComplete="off" className="h-10" />
                      </Field>
                      <Field id="add-alias-kind" label="What kind of title">
                        <select id="add-alias-kind" name="alias_kind" defaultValue="alternate" className={selectClassName}>
                          {ALIAS_KINDS.map((k) => (
                            <option key={k.value} value={k.value}>
                              {k.label}
                            </option>
                          ))}
                        </select>
                      </Field>
                      <Field id="add-alias-language" label="Language (optional)" hint="A code, such as ja or pt-br.">
                        <Input id="add-alias-language" name="alias_language" maxLength={20} autoComplete="off" aria-describedby="add-alias-language-hint" className="h-10" />
                      </Field>
                      <Field id="add-alias-region" label="Region (optional)">
                        <select id="add-alias-region" name="alias_region" defaultValue="" className={selectClassName}>
                          <option value="">Any region</option>
                          {options.regions
                            .filter((r) => r.code !== "unknown")
                            .map((r) => (
                              <option key={r.code} value={r.code}>
                                {r.label}
                              </option>
                            ))}
                        </select>
                      </Field>
                    </div>
                    <ReasonField id="add-alias" />
                  </EditForm>
                  {g.aliases.length ? (
                    <EditForm id="remove-alias" recordId={g.id} action={removeAlias} plain={removeAliasFromForm} submit="Remove the title" pending="Removing…">
                      <Hidden id={g.id} revision={g.revision} />
                      <Field id="remove-alias-id" label="Title to remove">
                        <select id="remove-alias-id" name="alias_id" className={selectClassName}>
                          {g.aliases.map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.title}
                            </option>
                          ))}
                        </select>
                      </Field>
                      <ReasonField id="remove-alias" />
                    </EditForm>
                  ) : null}
                </div>
              )}
            </RecordSection>

            <RecordSection id="edit-relations" title="Related games">
              {gated ? (
                <StepUpNotice path={path}>A relation between published games is public, so changing it needs a recent verification.</StepUpNotice>
              ) : (
                <EditForm id="set-relation" recordId={g.id} action={setRelation} plain={setRelationFromForm} submit="Save the relation" pending="Saving…">
                  <Hidden id={g.id} revision={g.revision} />
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field id="set-relation-relation" label={`${g.title}…`}>
                      <select id="set-relation-relation" name="relation" defaultValue="remake_of" className={selectClassName}>
                        {RELATIONS.map((r) => (
                          <option key={r.value} value={r.value}>
                            {r.label}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field id="set-relation-target" label="The other game's record id" hint="Shown at the end of the other game's record.">
                      <Input id="set-relation-target" name="target_id" required maxLength={36} autoComplete="off" spellCheck={false} aria-describedby="set-relation-target-hint" className="h-10 font-mono" />
                    </Field>
                    <Field id="set-relation-position" label="Position in the compilation (optional)">
                      <Input id="set-relation-position" name="position" inputMode="numeric" maxLength={3} autoComplete="off" className="h-10" />
                    </Field>
                    <Field id="set-relation-note" label="Note (optional)">
                      <Input id="set-relation-note" name="relation_note" maxLength={500} autoComplete="off" className="h-10" />
                    </Field>
                  </div>
                  <ReasonField id="set-relation" />
                </EditForm>
              )}
            </RecordSection>

            <RecordSection id="edit-platforms" title="Platforms">
              <ul className="mb-4 flex flex-col gap-1.5 text-sm">
                {g.platforms.length ? (
                  g.platforms.map((p) => (
                    <li key={p.slug} className="flex flex-wrap items-center gap-2">
                      {p.name} <StatusBadge status={p.status} />
                    </li>
                  ))
                ) : (
                  <li className="text-muted-foreground">It isn&apos;t paired with a platform yet.</li>
                )}
              </ul>
              {unpaired.length ? (
                <EditForm id="add-platform" recordId={g.id} action={addPlatform} plain={addPlatformFromForm} submit="Add the platform" pending="Adding…">
                  <Hidden id={g.id} revision={g.revision} />
                  <Field id="add-platform-platform" label="Platform" hint="It's in review until a release on it is published.">
                    <select id="add-platform-platform" name="platform" aria-describedby="add-platform-platform-hint" className={selectClassName}>
                      {unpaired.map((p) => (
                        <option key={p.slug} value={p.slug}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <ReasonField id="add-platform" />
                </EditForm>
              ) : null}
            </RecordSection>

            <RecordSection id="edit-locks" title="Locks against imports">
              <p className="mb-3 text-sm text-muted-foreground">
                {locked.size ? `Locked: ${[...locked].map(recordFieldLabel).join(", ")}.` : "No field is locked."} A locked field keeps its value when an import has another.
              </p>
              <EditForm id="set-lock" recordId={g.id} action={setLock} plain={setLockFromForm} submit="Save the lock" pending="Saving…">
                <Hidden id={g.id} revision={g.revision} />
                <input type="hidden" name="entity" value="game" />
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field id="set-lock-field" label="Field">
                    <select id="set-lock-field" name="field" className={selectClassName}>
                      {LOCKABLE_FIELDS.game.map((f) => (
                        <option key={f} value={f}>
                          {recordFieldLabel(f)}
                          {locked.has(f) ? " (locked)" : ""}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field id="set-lock-locked" label="Lock">
                    <select id="set-lock-locked" name="locked" defaultValue="yes" className={selectClassName}>
                      <option value="yes">Lock it</option>
                      <option value="no">Unlock it</option>
                    </select>
                  </Field>
                </div>
                <ReasonField id="set-lock" />
              </EditForm>
            </RecordSection>
          </>
        )}
      </div>
    </AdminFrame>
  );
}

export default function EditGamePage({ params, searchParams }: PageProps<"/admin/catalog/games/[id]/edit">) {
  return (
    <AdminShell>
      <EditGameView params={params} searchParams={searchParams} />
    </AdminShell>
  );
}
