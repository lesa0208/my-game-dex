import "server-only";

import { isSeedDataEnabled } from "@/config/features";
import { previewViewer } from "@/dev/seed/collectors";
import type { Collector } from "@/types/user";

/** Authentication isn't implemented yet, so this is the seed viewer or nobody. */
export function getCurrentViewer(): Collector | null {
  return isSeedDataEnabled ? previewViewer : null;
}
