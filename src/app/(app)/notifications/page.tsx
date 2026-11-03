import { Bell } from "lucide-react";
import type { Metadata } from "next";

import { PlaceholderPage } from "@/components/shared/placeholder-page";

export const metadata: Metadata = {
  title: "Notifications",
};

export default function NotificationsPage() {
  return (
    <PlaceholderPage
      title="Notifications"
      icon={Bell}
      emptyTitle="Notifications aren't available yet"
    >
      Likes, comments and new followers will appear here once accounts exist.
    </PlaceholderPage>
  );
}
