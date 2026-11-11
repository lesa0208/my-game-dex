import { LogIn, UserRoundX } from "lucide-react";
import Link from "next/link";

import { AddCopyForm } from "@/components/collection/add-copy-form";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { getCurrentViewer } from "@/features/account/queries";
import { signInHref, welcomeHref } from "@/features/auth/redirect";
import type { PickerRelease } from "@/features/catalog/types";
import { latestAcquisitionDate } from "@/features/collection/details";
import { getMyDefaultCurrency, getMyReleaseCopyCount } from "@/features/collection/queries";
import { uuidv7 } from "@/features/collection/uuid";

/**
 * "Add to collection" for the selected release. Reads the session, so it renders per
 * request inside its own Suspense boundary, apart from the cached public catalog.
 * Signed-out visitors are sent to sign in and back to this release.
 */
export async function AddToCollection({ release, returnPath }: { release: PickerRelease; returnPath: string }) {
  const viewer = await getCurrentViewer().catch(() => null);

  if (!viewer) {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <Button asChild size="lg" className="h-10">
          <Link href={signInHref(returnPath)}>
            <LogIn aria-hidden="true" />
            Sign in to add to your collection
          </Link>
        </Button>
      </div>
    );
  }
  if (!viewer.handle) {
    return (
      <p className="text-sm">
        <Link href={welcomeHref(returnPath)} className="font-medium text-primary-text underline underline-offset-4">
          Choose your handle
        </Link>{" "}
        to start your collection.
      </p>
    );
  }
  if (!viewer.isActive) {
    return (
      <p className="flex gap-2 text-sm text-muted-foreground">
        <UserRoundX aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        Your account can&apos;t add copies right now.
      </p>
    );
  }

  const [count, currency] = await Promise.all([getMyReleaseCopyCount(release.id), getMyDefaultCurrency()]);
  return (
    <AddCopyForm
      key={release.id}
      releaseId={release.id}
      initialItemId={uuidv7()}
      initialCount={count}
      defaultCurrency={currency}
      currencies={CURRENCIES}
      maxDate={latestAcquisitionDate()}
      mediumLabel={mediumLabel(release)}
      components={release.components.filter((c): c is typeof c & { label: string } => c.label !== null).map((c) => ({ kind: c.kind, label: c.label, quantity: c.quantity }))}
    />
  );
}

/** ISO 4217 currencies, with English names, made once on the server so the browser renders the same list. */
const currencyNames = new Intl.DisplayNames(["en"], { type: "currency" });
const CURRENCIES = Intl.supportedValuesOf("currency").map((code) => ({ code, name: currencyNames.of(code) ?? code }));

/** "Cartridge" or "Disc", from the catalog's format. Generic when the catalog doesn't say. */
function mediumLabel(release: PickerRelease) {
  switch (release.format?.category) {
    case "cartridge":
      return "Cartridge";
    case "optical_disc":
      return "Disc";
    case "solid_state_card":
      return "Game card";
    case "magnetic_disk":
      return "Disk";
    case "magnetic_tape":
      return "Tape";
    default:
      return "Medium";
  }
}

export function AddToCollectionSkeleton() {
  return <Skeleton aria-hidden="true" className="h-10 w-48" />;
}
