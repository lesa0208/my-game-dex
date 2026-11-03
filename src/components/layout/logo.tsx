import { cn } from "@/lib/utils";

export function LogoMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      shapeRendering="crispEdges"
      aria-hidden="true"
      className={cn("size-7 shrink-0", className)}
    >
      <path className="fill-primary" d="M3 1h18v2h2v20H1V3h2z" />
      <path className="fill-background" d="M5 5h14v10H5z" />
      <path className="fill-highlight" d="M7 7h4v4H7z" />
      <path className="fill-background" d="M5 18h14v2H5z" />
    </svg>
  );
}

export function LogoWordmark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "font-mono text-sm font-bold tracking-[0.14em] whitespace-nowrap",
        className,
      )}
    >
      MY GAME DEX
    </span>
  );
}
