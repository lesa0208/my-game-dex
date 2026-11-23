import { ClipboardList, PlugZap } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { AdminFrame, AdminShell, linkClass, param } from "@/components/admin/admin-frame";
import { Callout, FilterLinks, Pager, personText } from "@/components/admin/batch-review";
import { StatusPill } from "@/components/admin/data-table";
import { EmptyState } from "@/components/shared/empty-state";
import { requireAdminSection } from "@/features/admin/queries";
import { BLOCK_LABELS, QUEUE_STATES, queueState, type QueueState, STATE_DETAILS, YOU_LABELS } from "@/features/publication/form";
import { listPublicationQueue, type QueueCursor, type QueueItem, readCursor } from "@/features/publication/queries";
import { formatWhen } from "@/features/submissions/display";

export const metadata: Metadata = {
  title: "Publication queue",
};

const PLATFORM = /^[a-z0-9-]{1,40}$/;

function href(state: QueueState, platform: string | null, after?: QueueCursor | null) {
  const q = new URLSearchParams();
  if (state !== "ready") q.set("state", state);
  if (platform) q.set("platform", platform);
  if (after) {
    q.set("at", after.at);
    q.set("game", after.game);
    q.set("platform_id", after.platform);
  }
  const s = q.toString();
  return `/admin/catalog/publication${s ? `?${s}` : ""}`;
}

const TONES: Record<QueueItem["state"], "good" | "warning" | "problem" | "neutral"> = {
  ready: "good",
  awaiting_evidence: "warning",
  evidence_outdated: "warning",
  verifier_gone: "warning",
  blocked: "problem",
  published: "neutral",
};

function Item({ item }: { item: QueueItem }) {
  const label = QUEUE_STATES.find((s) => s.value === item.state)?.label ?? item.state;
  return (
    <li>
      <article aria-labelledby={`q-${item.game.id}-${item.platform.slug}`} className="flex flex-col gap-2 rounded-xl border bg-card p-4">
        <header className="flex flex-wrap items-start justify-between gap-2">
          <h3 id={`q-${item.game.id}-${item.platform.slug}`} className="text-sm font-semibold text-pretty">
            <Link href={`/admin/catalog/games/${item.game.id}#identity-publication`} className="rounded-sm outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring">
              {item.game.title} · {item.platform.name}
            </Link>
          </h3>
          <StatusPill tone={TONES[item.state]}>{label}</StatusPill>
        </header>
        {item.physical ? (
          <p className="text-xs text-muted-foreground">
            Confirmed by {item.physical.verifier ? personText(item.physical.verifier) : "a former staff member"}, {formatWhen(item.physical.verified_at)}
            {item.physical.source ? ` · ${item.physical.source}${item.physical.reference ? ` ${item.physical.reference}` : ""}` : ""}
            {item.physical.note ? <span className="mt-1 line-clamp-2 block whitespace-pre-line text-foreground/90">“{item.physical.note}”</span> : null}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">Identity verified {formatWhen(item.at)}; physical existence not confirmed.</p>
        )}
        <p className="text-xs">
          {item.state === "ready"
            ? item.you
              ? YOU_LABELS[item.you]
              : "You may publish it."
            : item.state === "published"
              ? "Public as an identity."
              : (item.reason && BLOCK_LABELS[item.reason]) ?? STATE_DETAILS[item.state]}
          {" "}
          <span className="text-muted-foreground">
            Releases: {item.releases.total ? `${item.releases.total} recorded, ${item.releases.published} verified and published` : "none recorded"}.
          </span>
        </p>
      </article>
    </li>
  );
}

async function QueueView({ searchParams }: { searchParams: PageProps<"/admin/catalog/publication">["searchParams"] }) {
  const search = await searchParams;
  const state = queueState(param(search.state));
  const rawPlatform = param(search.platform);
  const platform = rawPlatform && PLATFORM.test(rawPlatform) ? rawPlatform : null;
  const after = readCursor(param(search.at), param(search.game), param(search.platform_id));
  const { access } = await requireAdminSection("/admin/catalog/publication", "editor");
  const queue = await listPublicationQueue(state, platform, after);
  const counts = queue.ok && queue.data ? queue.data.counts : {};

  return (
    <AdminFrame access={access} current="catalog" title="Publication queue">
      <p className="text-sm">
        <Link href="/admin/catalog/batches" className={linkClass}>
          Review batches
        </Link>{" "}
        <Link href="/admin/catalog/search" className={linkClass}>
          Catalog records
        </Link>
      </p>
      <p className="text-sm text-muted-foreground">
        Game and platform identities whose physical existence was confirmed with evidence, and verified games still waiting for that evidence. Oldest first.
      </p>
      <Callout title="Confirming and publishing take two editors">
        Whoever confirmed a platform&apos;s physical evidence never publishes it, and nobody publishes a record they created. Publish from the game&apos;s record. Publishing an identity
        never creates a physical release.
      </Callout>
      <FilterLinks
        label="Filter by state"
        items={QUEUE_STATES.map((s) => ({
          href: href(s.value, platform),
          label: s.label,
          count: s.value === "all" ? undefined : (counts[s.value] ?? undefined),
          current: s.value === state,
        }))}
      />
      {state !== "all" ? <p className="text-sm text-muted-foreground">{STATE_DETAILS[state]}</p> : null}
      {!queue.ok ? (
        <EmptyState icon={PlugZap} title="The queue isn't available">
          {queue.reason === "refused" ? "This page can't be shown. Go back to the first page." : "It can't be loaded right now. Try again later."}
        </EmptyState>
      ) : !queue.data || queue.data.status === "unknown_platform" ? (
        <EmptyState icon={ClipboardList} title="No such platform">
          Choose a platform from the batch or record pages.
        </EmptyState>
      ) : !queue.data.items.length ? (
        <EmptyState icon={ClipboardList} title={after ? "No more here" : "Nothing here"}>
          {state === "ready" ? "No confirmed identity is waiting for publication." : "Nothing is in this state."}
        </EmptyState>
      ) : (
        <section aria-labelledby="queue-title" className="flex flex-col gap-3">
          <h2 id="queue-title" className="sr-only">
            Identities, oldest first
          </h2>
          <ol className="flex flex-col gap-2">
            {queue.data.items.map((item) => (
              <Item key={`${item.game.id}-${item.platform.slug}`} item={item} />
            ))}
          </ol>
          <Pager first={after ? href(state, platform) : null} next={queue.data.next_after ? href(state, platform, queue.data.next_after) : null} />
        </section>
      )}
    </AdminFrame>
  );
}

export default function PublicationQueuePage({ searchParams }: PageProps<"/admin/catalog/publication">) {
  return (
    <AdminShell>
      <QueueView searchParams={searchParams} />
    </AdminShell>
  );
}
