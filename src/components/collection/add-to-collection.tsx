import { LogIn, UserRoundX } from "lucide-react";
import Link from "next/link";

import { AddCopyForm } from "@/components/collection/add-copy-form";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { getCurrentViewer } from "@/features/account/queries";
import { signInHref, welcomeHref } from "@/features/auth/redirect";
import type { PickerRelease } from "@/features/catalog/types";
import { CURRENCIES } from "@/features/collection/currencies";
import { latestAcquisitionDate, mediumLabel } from "@/features/collection/details";
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
      mediumLabel={mediumLabel(release.format?.category)}
      components={release.components.filter((c): c is typeof c & { label: string } => c.label !== null).map((c) => ({ kind: c.kind, label: c.label, quantity: c.quantity }))}
    />
  );
}

export function AddToCollectionSkeleton() {
  return <Skeleton aria-hidden="true" className="h-10 w-48" />;
}
