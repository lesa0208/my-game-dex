import Form from "next/form";
import Link from "next/link";

import { MoveCopyForm } from "@/components/collection/move-copy-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getReleasePicker, searchCatalog } from "@/features/catalog/queries";
import type { PickerRelease } from "@/features/catalog/types";
import { releaseLine } from "@/features/collection/details";
import { type CollectionParams, collectionQuery, type MoveParams, moveHref } from "@/features/collection/list-params";
import type { CopyDetail } from "@/features/collection/types";

/** "PAL · Players Choice · SNSP-ZSFP-EUR · ROM cartridge". */
function pickerLine(r: PickerRelease) {
  return [r.region.code === "unknown" ? "Region unknown" : r.region.label, r.edition?.name, r.variantName, r.identifiers.productCode, r.format?.name].filter(Boolean).join(" · ");
}

/**
 * "Move to another release" (M7b-2a), for the copy's owner. Driven by the address, so
 * it works without JavaScript: choose a release of the same game for the copy's
 * platform, or search for another game, then confirm. Only published releases are
 * offered, through the public release picker; relink_my_copy checks the choice again.
 */
export async function MoveCopySection({
  copy,
  known,
  back,
  move,
  open,
}: {
  copy: CopyDetail;
  /** For a preserved copy, its excluded release's game as its owner may read it (M7b-2b). */
  known?: { title: string; slug: string | null } | null;
  back: CollectionParams;
  move: MoveParams;
  open: boolean;
}) {
  const platform = copy.release?.platform ?? null;
  const gameSlug = move.game ?? copy.game?.slug ?? known?.slug ?? null;
  const current = copy.release ? `${copy.game?.title ?? known?.title ?? "This game"} (${releaseLine(copy.release)})` : "A release that's no longer shown in the catalog";

  const [picker, search] = await Promise.all([
    gameSlug ? getReleasePicker(gameSlug, platform?.slug ?? null, null, null).catch(() => null) : null,
    move.query ? searchCatalog(move.query, platform?.slug ?? null, null).catch(() => null) : null,
  ]);
  const game = picker?.ok && picker.data ? picker.data.game : null;
  const releases = picker?.ok && picker.data ? picker.data.releases.filter((r) => r.id !== copy.release?.id && (!platform || r.platform.slug === platform.slug)) : [];
  const chosen = move.release ? releases.find((r) => r.id === move.release) ?? null : null;
  const games = search?.ok ? search.data.items.filter((i) => i.kind === "game").slice(0, 10) : [];
  const backFields = [...new URLSearchParams(collectionQuery(back)).entries()];

  return (
    <details id="move" open={open} className="rounded-lg border bg-card">
      <summary className="flex min-h-11 cursor-pointer items-center rounded-lg px-4 text-sm font-semibold outline-none select-none focus-visible:ring-3 focus-visible:ring-ring">
        Move to another release
      </summary>
      <div className="flex flex-col gap-4 border-t p-4">
        <p className="text-sm">
          <span className="text-muted-foreground">Now: </span>
          {current}
        </p>

        {chosen && game ? (
          <>
            <MoveCopyForm itemId={copy.id} releaseId={chosen.id} from={current} to={`${game.title} (${pickerLine(chosen)})`} back={back} />
            <p className="text-sm">
              <Link href={moveHref(copy.id, back, { game: game.slug })} className="text-primary-text underline underline-offset-4">
                Choose a different release
              </Link>
            </p>
          </>
        ) : (
          <>
            {game ? (
              <section aria-labelledby="move-releases">
                <h3 id="move-releases" className="text-sm font-medium">
                  {game.title}
                  {platform ? `, for ${platform.name}` : ""}
                </h3>
                {releases.length ? (
                  <ul className="mt-2 flex flex-col gap-1">
                    {releases.map((r) => (
                      <li key={r.id}>
                        <Link
                          href={moveHref(copy.id, back, { game: game.slug, release: r.id })}
                          className="flex min-h-10 items-center rounded-lg border px-3 text-sm outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring"
                        >
                          {pickerLine(r)}
                        </Link>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-1 text-sm text-muted-foreground">The catalog has no other release of this game{platform ? ` for ${platform.name}` : ""}.</p>
                )}
              </section>
            ) : null}

            <section aria-labelledby="move-search">
              <h3 id="move-search" className="text-sm font-medium">
                A different game?
              </h3>
              <Form action={`/collection/${copy.id}`} className="mt-2 flex flex-wrap items-end gap-2">
                {backFields.map(([name, value]) => (
                  <input key={name} type="hidden" name={name} value={value} />
                ))}
                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <label htmlFor="move_q" className="text-sm">
                    Search the catalog{platform ? ` for ${platform.name} games` : ""}
                  </label>
                  <Input id="move_q" name="move_q" type="search" maxLength={100} defaultValue={move.query ?? ""} autoComplete="off" className="h-10" />
                </div>
                <Button type="submit" variant="secondary" size="lg" className="h-10 px-4">
                  Search
                </Button>
              </Form>
              {move.query ? (
                games.length ? (
                  <ul className="mt-2 flex flex-col gap-1">
                    {games.map((g) => (
                      <li key={g.game.id}>
                        <Link
                          href={moveHref(copy.id, back, { game: g.game.slug })}
                          className="flex min-h-10 items-center rounded-lg px-3 text-sm text-primary-text underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring"
                        >
                          {g.game.title}
                        </Link>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-2 text-sm text-muted-foreground">No games match{platform ? ` on ${platform.name}` : ""}.</p>
                )
              ) : null}
            </section>
            <p className="text-xs text-muted-foreground">
              Only releases in the catalog are offered. A copy can move only to a release for the same platform; for another platform, add it as a new copy.
            </p>
            {platform ? null : (
              <p className="text-xs text-muted-foreground">
                This copy&apos;s release isn&apos;t shown any more, so the search can&apos;t be limited to its platform. Choose a release for the platform the copy was on; one
                for another platform will be refused.
              </p>
            )}
          </>
        )}
      </div>
    </details>
  );
}
