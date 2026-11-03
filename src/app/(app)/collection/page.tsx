import { Library } from "lucide-react";
import type { Metadata } from "next";

import { PlaceholderPage } from "@/components/shared/placeholder-page";

export const metadata: Metadata = {
  title: "My Collection",
};

export default function CollectionPage() {
  return (
    <PlaceholderPage
      title="My Collection"
      icon={Library}
      emptyTitle="Your shelves aren't available yet"
    >
      Virtual shelves, physical copy tracking and your wantlist arrive with
      accounts and the game catalog.
    </PlaceholderPage>
  );
}
