import { Settings } from "lucide-react";
import type { Metadata } from "next";

import { PlaceholderPage } from "@/components/shared/placeholder-page";

export const metadata: Metadata = {
  title: "Settings",
};

export default function SettingsPage() {
  return (
    <PlaceholderPage
      title="Settings"
      icon={Settings}
      emptyTitle="Settings aren't available yet"
    >
      Account, privacy and appearance settings arrive with accounts.
    </PlaceholderPage>
  );
}
