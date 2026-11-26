"use client";

import { Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";

import { QuickAddDialog } from "@/components/explore/quick-add-dialog";
import { Button } from "@/components/ui/button";

/** M17b: the My Copy panel's invitation to add, opening the same quick add as the hero. */
export function AddCopyButton({ game, platform }: { game: { slug: string; title: string }; platform: string | null }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const onAdded = useCallback(() => router.refresh(), [router]);
  return (
    <>
      <Button type="button" variant="secondary" size="lg" className="h-10 w-full" onClick={() => setOpen(true)} data-action="add-copy">
        <Plus aria-hidden="true" />
        Add your copy
      </Button>
      <QuickAddDialog open={open} onOpenChange={setOpen} game={game} presetPlatform={platform} onAdded={onAdded} />
    </>
  );
}
