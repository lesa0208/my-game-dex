"use server";

import { getCurrentViewer } from "@/features/account/queries";
import { getReleasePicker } from "@/features/catalog/queries";
import { getSubmissionOptions } from "@/features/submissions/queries";
import { getGameWishPlatforms } from "@/features/wishlist/queries";

import { CURRENCIES } from "./currencies";
import { latestAcquisitionDate, mediumLabel } from "./details";
import { getMyDefaultCurrency, getMyGameOwnership } from "./queries";

/**
 * M17a: what the quick add on an Explore result needs when its dialog opens. Only reads:
 * the public catalog (the game's platforms and its verified releases, cached) and the
 * signed-in collector's own copies of the game and default currency. Adding itself goes
 * through the existing addClaim and addCopy actions, unchanged, so the same validation,
 * definer functions and RLS apply.
 */

export type QuickAddRelease = {
  id: string;
  platform: string;
  region: { code: string; label: string };
  /** "Platinum · SLUS-00594 · Sony Computer Entertainment": what tells releases apart. */
  label: string;
  mediumLabel: string;
  components: { kind: string; label: string; quantity: number }[];
};

export type QuickAddOptions =
  | { status: "signed_out" | "needs_handle" | "inactive" | "unavailable" }
  | {
      status: "ready";
      game: { id: string; slug: string; title: string };
      platforms: { id: string; slug: string; name: string; shortName: string }[];
      regions: { code: string; label: string }[];
      releases: QuickAddRelease[];
      /** The collector's counted copies of the game, when known. */
      copies: number | null;
      defaultCurrency: string | null;
      currencies: { code: string; name: string }[];
      maxDate: string;
    };

export async function loadQuickAdd(gameSlug: string): Promise<QuickAddOptions> {
  if (typeof gameSlug !== "string" || !/^[a-z0-9][a-z0-9-]{0,199}$/.test(gameSlug)) return { status: "unavailable" };
  const viewer = await getCurrentViewer().catch(() => null);
  if (!viewer) return { status: "signed_out" };
  if (!viewer.handle) return { status: "needs_handle" };
  if (!viewer.isActive) return { status: "inactive" };

  const [picker, options] = await Promise.all([getReleasePicker(gameSlug, null, null, null), getSubmissionOptions()]);
  if (!picker.ok || !picker.data || !options) return { status: "unavailable" };
  const game = picker.data.game;
  const [pairings, ownership, currency] = await Promise.all([getGameWishPlatforms(game.id), getMyGameOwnership(game.id), getMyDefaultCurrency()]);
  if (!pairings) return { status: "unavailable" };

  return {
    status: "ready",
    game: { id: game.id, slug: game.slug, title: game.title },
    // The game's published platforms: the ones an unidentified copy may name (M12a).
    platforms: pairings,
    regions: options.regions.filter((r) => r.code !== "unknown"),
    releases: picker.data.releases.map((r) => ({
      id: r.id,
      platform: r.platform.slug,
      region: r.region,
      label:
        [r.edition?.name, r.variantName, r.localTitle, r.identifiers.productCode, r.publisherName, r.format?.name].filter((v): v is string => Boolean(v)).join(" · ") ||
        `${r.platform.shortName} · ${r.region.label}`,
      mediumLabel: mediumLabel(r.format?.category),
      components: r.components.filter((c): c is typeof c & { label: string } => c.label !== null).map((c) => ({ kind: c.kind, label: c.label, quantity: c.quantity })),
    })),
    copies: ownership ? ownership.copies : null,
    defaultCurrency: currency,
    currencies: CURRENCIES,
    maxDate: latestAcquisitionDate(),
  };
}
