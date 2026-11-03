import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

export function EmptyState({
  icon: Icon,
  title,
  children,
  action,
}: {
  icon: LucideIcon;
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center rounded-lg border border-dashed px-6 py-14 text-center">
      <span className="flex size-12 items-center justify-center rounded-lg bg-secondary">
        <Icon aria-hidden="true" className="size-6 text-muted-foreground" />
      </span>
      <h2 className="mt-4 font-medium text-pretty">{title}</h2>
      <div className="mt-1.5 max-w-sm text-sm leading-relaxed text-pretty text-muted-foreground">
        {children}
      </div>
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}
