import { ArrowLeft, CircleCheck, Info, Lock, PlugZap, TriangleAlert, UserRoundX } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { packagingLabel } from "@/features/catalog/packaging";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { Suspense } from "react";

import { EditCopyForm } from "@/components/collection/edit-copy-form";
import { IdentityForm } from "@/components/collection/identity-form";
import { MoveCopySection } from "@/components/collection/move-copy-section";
import { RemoveCopyForm } from "@/components/collection/remove-copy-form";
import { RemovePieceRecordForm } from "@/components/collection/remove-piece-record-form";
import { CatalogCover } from "@/components/games/catalog-cover";
import { PageLayout } from "@/components/layout/page-layout";
import { EmptyState } from "@/components/shared/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { requireViewerWithHandle } from "@/features/account/queries";
import { CURRENCIES } from "@/features/collection/currencies";
import {
  claimEdition,
  claimLine,
  completenessLabel,
  conditionLabel,
  copyStatusLabel,
  formatDay,
  formatPrice,
  historyIdentityText,
  historySourceLabel,
  latestAcquisitionDate,
  mediumLabel,
  NOT_RECORDED,
  pieceFieldValue,
  pieceStateLabel,
  priceInput,
  releaseLine,
} from "@/features/collection/details";
import { collectionHref, type CollectionParams, collectionQuery, copyHref, readCollectionParams, readMoveParams } from "@/features/collection/list-params";
import { getMediaCategory, getMyCopy, getMyCopyHistory, getMyDefaultCurrency, getMyPreservedClaim, getMyReleaseCopies } from "@/features/collection/queries";
import { getMySubmissionForRelease, getPublishedGame, getSubmissionOptions } from "@/features/submissions/queries";
import { exclusionReasonLabel, withListedPieces } from "@/features/exclusion/form";
import { getMyPreservedRelease } from "@/features/exclusion/queries";
import type { CopyDetail } from "@/features/collection/types";
import { UUID } from "@/features/collection/uuid";
import { componentLabel, regionLabel } from "@/features/catalog/format";

export const metadata: Metadata = {
  title: "Copy details",
};

function Section({ id, title, icon, children }: { id: string; title: string; icon?: ReactNode; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="rounded-lg border bg-card p-4">
      <h2 id={id} className="mb-3 flex items-center gap-2 text-sm font-semibold">
        {icon}
        {title}
      </h2>
      {children}
    </section>
  );
}

/** Rows of a description list. A row with no value is left out unless `always`. */
function Facts({ rows }: { rows: { label: string; value: string | null; always?: boolean; multiline?: boolean }[] }) {
  const shown = rows.filter((r) => r.value !== null || r.always);
  return (
    <dl className="grid gap-x-4 gap-y-3 text-sm sm:grid-cols-[minmax(0,11rem)_minmax(0,1fr)] sm:gap-y-2">
      {shown.map((row) => (
        <div key={row.label} className="flex flex-col gap-0.5 sm:contents">
          <dt className="text-muted-foreground">{row.label}</dt>
          <dd className={row.multiline ? "break-words whitespace-pre-wrap" : "break-words"}>{row.value ?? NOT_RECORDED}</dd>
        </div>
      ))}
    </dl>
  );
}

function plural(label: string, count: number) {
  if (count === 1) return label.toLowerCase();
  return label === "Medium" ? "media" : `${label.toLowerCase()}s`;
}

async function CopyView({ params, searchParams }: { params: PageProps<"/collection/[itemId]">["params"]; searchParams: PageProps<"/collection/[itemId]">["searchParams"] }) {
  const { itemId } = await params;
  const search = await searchParams;
  const back: CollectionParams = readCollectionParams(search);
  const move = readMoveParams(search);
  const moved = search.notice === "moved";
  // M12b: after changing what the copy is (set_my_copy_identity).
  const identityNotice =
    search.notice === "identity" ? "Saved. Your copy's details are updated, and the change is in its history." : search.notice === "identity_same" ? "Nothing changed: your copy already says that." : null;
  const viewer = await requireViewerWithHandle(UUID.test(itemId) ? copyHref(itemId, back) : "/collection");

  const outcome = await getMyCopy(itemId);
  if (!outcome.ok) {
    return (
      <EmptyState icon={PlugZap} title="Your collection isn't available">
        It can&apos;t be loaded right now. Try again later.
      </EmptyState>
    );
  }
  // Someone else's copy reads exactly like one that doesn't exist.
  if (!outcome.data) notFound();
  const copy: CopyDetail = outcome.data;
  // A preserved copy's excluded release isn't readable through the catalog; its owner
  // reads a fixed set of its fields through get_my_preserved_release (M7b-2b, D3).
  // M12a: an unidentified copy names no release. One preserved by an exclusion of its
  // game is read the same way, through get_my_preserved_claim.
  const claim = copy.identity === "claim" ? copy.claim : null;
  const excluded = copy.status === "invalid" && !copy.release && !claim ? await getMyPreservedRelease(copy.id) : null;
  const preservedClaim = copy.status === "invalid" && claim ? await getMyPreservedClaim(copy.id) : null;
  const release = copy.release ?? excluded?.release ?? null;
  const { game } = copy;

  // M12b: a copy awaiting approval, or not approved, may be of a game the catalog doesn't
  // publish (a submitted new game). Only a published game can have copies without a
  // release (private.can_claim), so its identity can't be changed until it's moved.
  const awaiting = copy.status === "pending" || copy.status === "not_approved";
  const [category, siblings, defaultCurrency, submissionId, options, history, publishedGame] = await Promise.all([
    getMediaCategory(release?.format.code ?? null),
    release && copy.copies_of_release > 1 ? getMyReleaseCopies(release.id) : null,
    copy.price ? null : getMyDefaultCurrency(),
    release && copy.status !== "owned" ? getMySubmissionForRelease(release.id) : null,
    getSubmissionOptions(),
    getMyCopyHistory(copy.id),
    awaiting && game?.slug ? getPublishedGame(game.slug) : null,
  ]);
  const gameInCatalog = !awaiting || publishedGame?.id === game?.id;
  const medium = mediumLabel(category);
  // The number and the total both come from get_my_release_copies, one read, so they
  // agree. A copy older than the newest 100 isn't in it and gets no number.
  const number = siblings?.copies.find((c) => c.id === copy.id)?.number ?? null;
  const status = copyStatusLabel(copy.status);
  const title = game?.title ?? excluded?.game.title ?? preservedClaim?.game.title ?? "A release no longer in the catalog";
  const line = release ? releaseLine(release) : claim ? claimLine(claim) : null;
  const copyName = `${number ? `copy ${number} of ` : "this copy of "}${title}${line ? ` (${line})` : ""}`;

  // A preserved copy can't be changed (the M6 guards refuse it), only moved or removed.
  const preserved = copy.status === "invalid";
  const editable = viewer.isActive && !preserved;
  const pieces = excluded ? withListedPieces(copy.components, excluded.components) : copy.components;
  const listed = pieces.filter((p): p is typeof p & { label: string } => p.listed && p.label !== null);
  const unlisted = pieces.filter((p) => !p.listed && p.recorded);

  // M12b: what the owner can say the copy is. A claim's region and edition (not while
  // it's preserved: its game is out of the catalog), or, for a copy of a release, the
  // same without the release. Needs the game and the platform's id.
  const identityPlatform = (claim?.platform ?? release?.platform)?.slug ?? null;
  const platformId = identityPlatform ? (options?.platforms.find((p) => p.slug === identityPlatform)?.id ?? null) : null;
  const regionChoices = options?.regions.filter((r) => r.code !== "unknown") ?? [];
  const canIdentify = viewer.isActive && gameInCatalog && Boolean(game?.id) && Boolean(platformId) && !(claim && preserved);
  const regionLabels = new Map(options?.regions.map((r) => [r.code, r.label]) ?? []);
  const backFields = [...new URLSearchParams(collectionQuery(back)).entries()];

  return (
    <article aria-labelledby="copy-title" className="flex flex-col gap-4">
      <p>
        <Link href={collectionHref(back)} className="inline-flex min-h-10 items-center gap-1.5 rounded-lg text-sm text-primary-text underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring">
          <ArrowLeft aria-hidden="true" className="size-4" />
          Back to your collection
        </Link>
      </p>

      {identityNotice ? (
        <p role="status" className="flex items-center gap-2 rounded-lg border border-primary/40 bg-primary/10 px-3 py-2.5 text-sm font-medium">
          <CircleCheck aria-hidden="true" className="size-4 shrink-0 text-primary-text" />
          {identityNotice}
        </p>
      ) : null}

      {moved ? (
        <p role="status" className="flex items-center gap-2 rounded-lg border border-primary/40 bg-primary/10 px-3 py-2.5 text-sm font-medium">
          <CircleCheck aria-hidden="true" className="size-4 shrink-0 text-primary-text" />
          Moved. Your copy is now on this release, with everything you recorded.
        </p>
      ) : null}

      <header className="flex gap-4">
        <CatalogCover className="w-20" />
        <div className="min-w-0 flex-1">
          <h1 id="copy-title" className="text-xl font-semibold tracking-tight text-pretty">
            {title}
          </h1>
          {line ? <p className="text-sm text-muted-foreground">{line}</p> : null}
          {release?.local_title ? <p className="text-sm text-muted-foreground">{release.local_title}</p> : null}
          <p className="mt-1.5 text-sm">
            {number && siblings ? `Copy ${number} of ${siblings.count} of this release` : claim ? "Your copy" : "Your copy of this release"} · Added {formatDay(copy.added_at)}
          </p>
          {status ? <p className="mt-1.5 inline-flex rounded-md bg-secondary px-2 py-0.5 text-xs text-secondary-foreground">{status}</p> : null}
          {submissionId ? (
            <p className="mt-2 text-sm">
              <Link href={`/submissions/${submissionId}`} className="text-primary-text underline underline-offset-4">
                See your submission of this release
              </Link>
            </p>
          ) : null}
          {game && release && copy.status === "owned" ? (
            <p className="mt-2 text-sm">
              <Link href={`/games/${game.slug}?release=${release.id}`} className="text-primary-text underline underline-offset-4">
                See this release in the catalog
              </Link>
            </p>
          ) : null}
        </div>
      </header>

      {preserved ? (
        <section aria-labelledby="copy-preserved" className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4">
          <h2 id="copy-preserved" className="mb-1 flex items-center gap-2 text-sm font-semibold">
            <TriangleAlert aria-hidden="true" className="size-4" />
            This copy is kept privately
          </h2>
          {(excluded ?? preservedClaim)?.exclusion ? (
            <p className="mb-2 text-sm">
              <span className="font-medium">Removed from the catalog:</span> {exclusionReasonLabel((excluded ?? preservedClaim)!.exclusion!.reason_code)}.
              {(excluded ?? preservedClaim)!.exclusion!.note ? (
                <span className="mt-1 block break-words whitespace-pre-wrap">“{(excluded ?? preservedClaim)!.exclusion!.note}”</span>
              ) : null}
            </p>
          ) : null}
          <p className="text-sm">
            {claim ? "Its game is no longer in the catalog" : "Its release is no longer in the catalog"}, so the copy isn&apos;t counted as owned. Everything you recorded is kept, but it can&apos;t be edited until
            it&apos;s on a release in the catalog.
            {viewer.isActive ? (
              <>
                {" "}
                To recover it,{" "}
                <a href="#move" className="text-primary-text underline underline-offset-4">
                  move it to the release you own
                </a>
                ; then you can edit it again. You can also remove it.
              </>
            ) : (
              " You can still remove it."
            )}
          </p>
        </section>
      ) : null}

      <Section id="copy-condition" title="This copy">
        <Facts
          rows={[
            { label: "Completeness", value: copy.completeness ? completenessLabel(copy.completeness) : null, always: true },
            { label: `${medium} condition`, value: copy.conditions.media ? conditionLabel(copy.conditions.media) : null, always: true },
            { label: "Box or case", value: copy.conditions.box ? conditionLabel(copy.conditions.box) : null, always: true },
            { label: "Manual", value: copy.conditions.manual ? conditionLabel(copy.conditions.manual) : null, always: true },
            { label: "Overall condition", value: copy.conditions.overall ? conditionLabel(copy.conditions.overall) : null, always: true },
            { label: "Added", value: formatDay(copy.added_at) },
          ]}
        />
      </Section>

      {listed.length || unlisted.length ? (
        <Section id="copy-pieces" title={listed.length ? "Pieces listed for this release" : "Pieces"}>
          {listed.length ? (
            <Facts rows={listed.map((p) => ({ label: componentLabel({ kind: p.kind, label: p.label, quantity: p.quantity ?? 1 }), value: pieceStateLabel(p) }))} />
          ) : null}
          {unlisted.length ? (
            <div className={listed.length ? "mt-4 border-t pt-4" : undefined}>
              <h3 className="text-sm font-medium">No longer listed for this release</h3>
              <p className="mt-0.5 text-xs text-muted-foreground">The catalog changed this release&apos;s pieces. What you recorded is kept until you remove it.</p>
              <ul className="mt-3 flex flex-col gap-3">
                {unlisted.map((p) => {
                  const name = p.label ?? p.kind;
                  return (
                    <li key={`${p.kind}-${name}`} className="flex flex-col gap-1 text-sm sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                      <div>
                        <p>{name}</p>
                        <p className="text-muted-foreground">{pieceStateLabel(p)}</p>
                      </div>
                      {editable && p.label ? <RemovePieceRecordForm itemId={copy.id} kind={p.kind} label={p.label} name={name} /> : null}
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}
        </Section>
      ) : null}

      <Section id="copy-private" title="Only you can see these" icon={<Lock aria-hidden="true" className="size-4 text-muted-foreground" />}>
        <Facts
          rows={[
            { label: "Acquired on", value: copy.acquired_on ? formatDay(copy.acquired_on) : null, always: true },
            { label: "Price paid", value: copy.price ? formatPrice(copy.price) : null, always: true },
            { label: "Storage location", value: copy.storage_location, always: true },
            { label: "Notes", value: copy.notes, always: true, multiline: true },
          ]}
        />
      </Section>

      {release ? (
        <Section id="copy-release" title={excluded ? "Release, no longer in the catalog" : "Release"}>
          <Facts
            rows={[
              { label: "Platform", value: release.platform.name },
              { label: "Region", value: release.region.label ? regionLabel({ code: release.region.code, label: release.region.label }) : null },
              { label: "Edition", value: release.edition_name },
              { label: "Variant", value: release.variant_name },
              { label: "Local title", value: release.local_title },
              {
                label: "Format",
                value: release.format.name ? `${release.format.name}${release.media_count && release.media_count > 1 ? ` · ${release.media_count} ${plural(medium, release.media_count)}` : ""}` : null,
              },
              { label: "Packaging", value: packagingLabel(release.packaging_code, release.packaging) },
              { label: "Product code", value: release.identifiers.product_code },
              { label: "Barcode", value: release.identifiers.barcode },
            ]}
          />
        </Section>
      ) : null}

      {claim ? (
        <Section id="copy-claim" title="What you own">
          <p className="mb-2 text-sm text-muted-foreground">
            This copy isn&apos;t linked to a release in the catalog. These are the details you recorded, not a verified release.
            {claim.catalog_pairing ? null : ` The catalog doesn't list this game on ${claim.platform.name}.`}
          </p>
          <Facts
            rows={[
              { label: "Platform", value: claim.platform.name },
              { label: "Region", value: claim.region?.label ?? "Not sure", always: true },
              { label: "Edition", value: claimEdition(claim) ?? "Not sure", always: true },
            ]}
          />
        </Section>
      ) : null}

      {canIdentify ? (
        <details id="identity" className="rounded-lg border bg-card">
          <summary className="flex min-h-11 cursor-pointer items-center rounded-lg px-4 text-sm font-semibold outline-none select-none focus-visible:ring-3 focus-visible:ring-ring">
            {claim ? "Change the region or edition" : "Not sure it's this release?"}
          </summary>
          <div className="flex flex-col gap-3 border-t p-4">
            <p className="text-sm text-muted-foreground">
              {claim
                ? "Say what you know about your copy, and choose Not sure where you aren't."
                : "Keep your copy without a release, with the region and edition you know, until you find the right one. It's your own record, not a release in the catalog."}
            </p>
            <IdentityForm
              itemId={copy.id}
              gameId={game!.id}
              platformId={platformId!}
              regions={regionChoices}
              values={
                claim
                  ? { region: claim.region?.code ?? null, editionKind: claim.edition_kind, editionName: claim.edition_name }
                  : { region: release && release.region.code !== "unknown" ? release.region.code : null, editionKind: null, editionName: release?.edition_name ?? null }
              }
              unlink={!claim}
              back={backFields}
            />
            {claim ? (
              <p className="text-sm">
                Found it in the catalog?{" "}
                <a href="#move" className="text-primary-text underline underline-offset-4">
                  Link it to its release
                </a>
                .
              </p>
            ) : null}
          </div>
        </details>
      ) : null}

      {viewer.isActive && !gameInCatalog && release ? (
        <p id="identity" className="flex gap-2 rounded-lg border p-3 text-sm text-muted-foreground">
          <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          {copy.status === "not_approved"
            ? "This game wasn't approved for the catalog, so your copy stays here as not approved. It can't be kept without a release of a game the catalog doesn't have. If the catalog has your game under another title, move your copy to that release below."
            : "This game is waiting for catalog approval, so your copy stays with your submission while it's reviewed. If the catalog already has your game, move your copy to that release below."}
        </p>
      ) : null}

      {history && history.length ? (
        <details id="history" className="rounded-lg border bg-card">
          <summary className="flex min-h-11 cursor-pointer items-center rounded-lg px-4 text-sm font-semibold outline-none select-none focus-visible:ring-3 focus-visible:ring-ring">
            <Lock aria-hidden="true" className="mr-2 size-4 text-muted-foreground" />
            What this copy was ({history.length} {history.length === 1 ? "change" : "changes"})
          </summary>
          <ol aria-label="Changes, newest first" className="flex flex-col gap-3 border-t p-4 text-sm">
            {history.map((entry, index) => (
              <li key={`${entry.changed_at}-${index}`} className="flex flex-col gap-0.5">
                <p className="font-medium">
                  {formatDay(entry.changed_at)} · {historySourceLabel(entry.source)}
                </p>
                <p className="text-muted-foreground">From: {historyIdentityText(entry.previous, regionLabels)}</p>
                <p className="text-muted-foreground">To: {historyIdentityText(entry.current, regionLabels)}</p>
              </li>
            ))}
          </ol>
        </details>
      ) : null}

      {siblings && siblings.count > 1 ? (
        <Section id="copy-siblings" title={`Your ${siblings.count} copies of this release`}>
          <ol className="flex flex-col gap-1 text-sm">
            {siblings.copies.map((sibling) => {
              const current = sibling.id === copy.id;
              const facts = [`Copy ${sibling.number}`, sibling.completeness ? completenessLabel(sibling.completeness) : null, `added ${formatDay(sibling.added_at)}`]
                .filter(Boolean)
                .join(" · ");
              return (
                <li key={sibling.id}>
                  {current ? (
                    <span aria-current="true" className="flex min-h-10 items-center rounded-lg bg-primary/10 px-3 font-medium">
                      {facts} (this copy)
                    </span>
                  ) : (
                    <Link href={copyHref(sibling.id, back)} className="flex min-h-10 items-center rounded-lg px-3 outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring">
                      {facts}
                    </Link>
                  )}
                </li>
              );
            })}
          </ol>
        </Section>
      ) : null}

      {preserved ? null : viewer.isActive ? (
        <details className="rounded-lg border bg-card">
          <summary className="flex min-h-11 cursor-pointer items-center rounded-lg px-4 text-sm font-semibold outline-none select-none focus-visible:ring-3 focus-visible:ring-ring">
            Edit this copy
          </summary>
          <div className="border-t p-4">
            <EditCopyForm
              itemId={copy.id}
              values={{
                completeness: copy.completeness,
                media_condition: copy.conditions.media,
                box_condition: copy.conditions.box,
                manual_condition: copy.conditions.manual,
                overall_condition: copy.conditions.overall,
                acquired_on: copy.acquired_on,
                storage_location: copy.storage_location,
                purchase_price: copy.price ? priceInput(copy.price.amount) : null,
                currency: copy.price?.currency ?? defaultCurrency,
                notes: copy.notes,
              }}
              pieces={listed.map((p) => ({ kind: p.kind, label: p.label, quantity: p.quantity, value: pieceFieldValue(p) }))}
              unlistedPieces={unlisted.map((p) => p.label ?? p.kind)}
              mediumLabel={medium}
              currencies={CURRENCIES}
              maxDate={latestAcquisitionDate()}
            />
          </div>
        </details>
      ) : (
        <p className="flex gap-2 rounded-lg border px-4 py-3 text-sm text-muted-foreground">
          <UserRoundX aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          Your account can&apos;t edit copies right now. You can still view and remove them.
        </p>
      )}

      {viewer.isActive ? <MoveCopySection copy={{ ...copy, release }} known={excluded?.game ?? null} back={back} move={move} open={Boolean(move.query || move.game || move.release) || preserved} /> : null}

      <RemoveCopyForm itemId={copy.id} name={copyName} added={formatDay(copy.added_at)} back={back} />
    </article>
  );
}

function CopySkeleton() {
  return (
    <div aria-hidden="true" className="flex flex-col gap-4">
      <Skeleton className="h-6 w-48" />
      <div className="flex gap-4">
        <Skeleton className="aspect-3/4 w-20" />
        <div className="flex flex-1 flex-col gap-2 pt-1">
          <Skeleton className="h-6 w-2/3" />
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      </div>
      <Skeleton className="h-48 w-full" />
      <Skeleton className="h-36 w-full" />
    </div>
  );
}

export default function CopyPage({ params, searchParams }: PageProps<"/collection/[itemId]">) {
  return (
    <PageLayout>
      <div className="p-4 md:p-0">
        <Suspense fallback={<CopySkeleton />}>
          <CopyView params={params} searchParams={searchParams} />
        </Suspense>
      </div>
    </PageLayout>
  );
}
