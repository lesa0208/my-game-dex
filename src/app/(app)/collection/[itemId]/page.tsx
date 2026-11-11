import { ArrowLeft, Lock, PlugZap, UserRoundX } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { Suspense } from "react";

import { EditCopyForm } from "@/components/collection/edit-copy-form";
import { RemoveCopyForm } from "@/components/collection/remove-copy-form";
import { RemovePieceRecordForm } from "@/components/collection/remove-piece-record-form";
import { CatalogCover } from "@/components/games/catalog-cover";
import { PageLayout } from "@/components/layout/page-layout";
import { EmptyState } from "@/components/shared/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { requireViewerWithHandle } from "@/features/account/queries";
import { CURRENCIES } from "@/features/collection/currencies";
import {
  completenessLabel,
  conditionLabel,
  copyStatusLabel,
  formatDay,
  formatPrice,
  latestAcquisitionDate,
  mediumLabel,
  NOT_RECORDED,
  pieceFieldValue,
  pieceStateLabel,
  priceInput,
  releaseLine,
} from "@/features/collection/details";
import { collectionHref, type CollectionParams, copyHref, readCollectionParams } from "@/features/collection/list-params";
import { getMediaCategory, getMyCopy, getMyDefaultCurrency, getMyReleaseCopies } from "@/features/collection/queries";
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
  const back: CollectionParams = readCollectionParams(await searchParams);
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
  const { release, game } = copy;

  const [category, siblings, defaultCurrency] = await Promise.all([
    getMediaCategory(release?.format.code ?? null),
    release && copy.copies_of_release > 1 ? getMyReleaseCopies(release.id) : null,
    copy.price ? null : getMyDefaultCurrency(),
  ]);
  const medium = mediumLabel(category);
  // The number and the total both come from get_my_release_copies, one read, so they
  // agree. A copy older than the newest 100 isn't in it and gets no number.
  const number = siblings?.copies.find((c) => c.id === copy.id)?.number ?? null;
  const status = copyStatusLabel(copy.status);
  const title = game?.title ?? "A release no longer in the catalog";
  const line = release ? releaseLine(release) : null;
  const copyName = `${number ? `copy ${number} of ` : "this copy of "}${title}${line ? ` (${line})` : ""}`;

  const listed = copy.components.filter((p): p is typeof p & { label: string } => p.listed && p.label !== null);
  const unlisted = copy.components.filter((p) => !p.listed && p.recorded);

  return (
    <article aria-labelledby="copy-title" className="flex flex-col gap-4">
      <p>
        <Link href={collectionHref(back)} className="inline-flex min-h-10 items-center gap-1.5 rounded-lg text-sm text-primary-text underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring">
          <ArrowLeft aria-hidden="true" className="size-4" />
          Back to your collection
        </Link>
      </p>

      <header className="flex gap-4">
        <CatalogCover className="w-20" />
        <div className="min-w-0 flex-1">
          <h1 id="copy-title" className="text-xl font-semibold tracking-tight text-pretty">
            {title}
          </h1>
          {line ? <p className="text-sm text-muted-foreground">{line}</p> : null}
          {release?.local_title ? <p className="text-sm text-muted-foreground">{release.local_title}</p> : null}
          <p className="mt-1.5 text-sm">
            {number && siblings ? `Copy ${number} of ${siblings.count} of this release` : "Your copy of this release"} · Added {formatDay(copy.added_at)}
          </p>
          {status ? <p className="mt-1.5 inline-flex rounded-md bg-secondary px-2 py-0.5 text-xs text-secondary-foreground">{status}</p> : null}
          {game && release && copy.status === "owned" ? (
            <p className="mt-2 text-sm">
              <Link href={`/games/${game.slug}?release=${release.id}`} className="text-primary-text underline underline-offset-4">
                See this release in the catalog
              </Link>
            </p>
          ) : null}
        </div>
      </header>

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
                      {viewer.isActive && p.label ? <RemovePieceRecordForm itemId={copy.id} kind={p.kind} label={p.label} name={name} /> : null}
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
        <Section id="copy-release" title="Release">
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
              { label: "Packaging", value: release.packaging },
              { label: "Product code", value: release.identifiers.product_code },
              { label: "Barcode", value: release.identifiers.barcode },
            ]}
          />
        </Section>
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

      {viewer.isActive ? (
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
