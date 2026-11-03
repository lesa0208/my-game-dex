import { Users } from "lucide-react";
import type { Metadata } from "next";

import { PlaceholderPage } from "@/components/shared/placeholder-page";

export const metadata: Metadata = {
  title: "Community",
};

export default function CommunityPage() {
  return (
    <PlaceholderPage
      title="Community"
      icon={Users}
      emptyTitle="Community isn't available yet"
    >
      Discussions and collector discovery arrive with the social backend.
    </PlaceholderPage>
  );
}
