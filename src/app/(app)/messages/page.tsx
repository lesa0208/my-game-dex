import { Mail } from "lucide-react";
import type { Metadata } from "next";

import { PlaceholderPage } from "@/components/shared/placeholder-page";

export const metadata: Metadata = {
  title: "Messages",
};

export default function MessagesPage() {
  return (
    <PlaceholderPage
      title="Messages"
      icon={Mail}
      emptyTitle="Messages aren't available yet"
    >
      Private messages between collectors arrive after the core social features.
    </PlaceholderPage>
  );
}
