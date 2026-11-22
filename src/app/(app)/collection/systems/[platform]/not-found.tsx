import { SearchX } from "lucide-react";
import Link from "next/link";

import { EmptyState } from "@/components/shared/empty-state";
import { Button } from "@/components/ui/button";

/** An address that names no platform in the catalog. */
export default function SystemNotFound() {
  return (
    <div className="mx-auto w-full max-w-[1320px] px-4 py-4 md:px-6 md:py-6">
      <EmptyState
        icon={SearchX}
        title="There's no such system"
        action={
          <Button asChild variant="secondary" size="lg">
            <Link href="/collection/systems">Go to your systems</Link>
          </Button>
        }
      >
        This address doesn&apos;t name a system in the catalog. The link may be wrong.
      </EmptyState>
    </div>
  );
}
