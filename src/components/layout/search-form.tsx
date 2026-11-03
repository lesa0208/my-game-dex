import { Search } from "lucide-react";
import Form from "next/form";

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/** Submits to /explore, which reports that search isn't available yet. */
export function SearchForm({ className }: { className?: string }) {
  return (
    <Form action="/explore" role="search" className={cn("relative", className)}>
      <Search
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
      />
      <Input
        type="search"
        name="q"
        aria-label="Search games, releases and collectors"
        placeholder="Search games, releases and collectors"
        className="h-10 border-transparent bg-card pl-9 dark:bg-card"
      />
    </Form>
  );
}
