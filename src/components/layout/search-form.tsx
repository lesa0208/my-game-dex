import Form from "next/form";

import { SearchAutocomplete } from "@/components/catalog/search-autocomplete";
import { cn } from "@/lib/utils";

/**
 * Submits to /explore, which searches the published game catalog. Suggests games while
 * typing (M17a); choosing one opens it, Enter without one searches.
 */
export function SearchForm({ className }: { className?: string }) {
  return (
    <Form action="/explore" role="search" className={cn("relative", className)}>
      <SearchAutocomplete
        label="Search games and releases"
        placeholder="Search games and releases"
        inputClassName="h-10 border-transparent bg-card dark:bg-card"
      />
    </Form>
  );
}
