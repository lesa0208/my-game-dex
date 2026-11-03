import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { PageLayout } from "@/components/layout/page-layout";
import { EmptyState } from "@/components/shared/empty-state";

/** Keeps navigation honest for sections that haven't been built yet. */
export function PlaceholderPage({
  title,
  icon,
  emptyTitle,
  children,
}: {
  title: string;
  icon: LucideIcon;
  emptyTitle: string;
  children: ReactNode;
}) {
  return (
    <PageLayout>
      <div className="p-4 md:p-0">
        <h1 className="mb-4 text-xl font-semibold tracking-tight">{title}</h1>
        <EmptyState icon={icon} title={emptyTitle}>
          {children}
        </EmptyState>
      </div>
    </PageLayout>
  );
}
