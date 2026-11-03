import { UserRound } from "lucide-react";
import type { Metadata } from "next";

import { PlaceholderPage } from "@/components/shared/placeholder-page";

export const metadata: Metadata = {
  title: "My Profile",
};

export default function ProfilePage() {
  return (
    <PlaceholderPage
      title="My Profile"
      icon={UserRound}
      emptyTitle="Profiles aren't available yet"
    >
      Your avatar, public shelves, favorite games and collection stats arrive
      with accounts.
    </PlaceholderPage>
  );
}
