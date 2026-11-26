"use client";

import { Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";

import { QuickAddDialog } from "@/components/explore/quick-add-dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** M17b: an invitation to add (My Copy, an empty Physical Releases), opening the same quick add as the hero. */
export function AddCopyButton({ game, platform, className }: { game: { slug: string; title: string }; platform: string | null; className?: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const onAdded = useCallback(() => router.refresh(), [router]);
  return (
    <>
      <Button type="button" variant="secondary" size="lg" className={cn("h-10 w-full", className)} onClick={() => setOpen(true)} data-action="add-copy">
        <Plus aria-hidden="true" />
        Add your copy
      </Button>
      <QuickAddDialog open={open} onOpenChange={setOpen} game={game} presetPlatform={platform} onAdded={onAdded} />
    </>
  );
}
