"use client";

import { Loader2, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";

import { Input } from "@/components/ui/input";
import { latestOnly, type Suggestion, suggestQuery } from "@/features/catalog/suggest";
import { cn } from "@/lib/utils";

/** How long typing must pause before suggestions are asked for. */
const DEBOUNCE_MS = 180;

type Status = "idle" | "loading" | "ready" | "error";

/**
 * M17a: a search field that suggests real catalog games while typing, shared by the
 * header search and Explore. It sits inside its own form: Enter with no suggestion
 * chosen submits that form (the full results page, as before); choosing a suggestion
 * opens that game. ARIA 1.2 combobox: arrow keys move through the list, Enter opens,
 * Escape closes (and clears on a second press), and the list works by mouse and touch.
 *
 * Each pause in typing sends one request; a newer one cancels the last, and only the
 * newest answer may replace the list, so a slow response can't show stale suggestions.
 */
export function SearchAutocomplete({
  label,
  placeholder,
  defaultValue = "",
  name = "q",
  className,
  inputClassName,
  large = false,
}: {
  label: string;
  placeholder: string;
  defaultValue?: string;
  name?: string;
  className?: string;
  inputClassName?: string;
  large?: boolean;
}) {
  const router = useRouter();
  const id = useId();
  const listId = `${id}-list`;
  const [value, setValue] = useState(defaultValue);
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<Status>("idle");
  const [items, setItems] = useState<Suggestion[]>([]);
  // The query the listed suggestions answer: a choice is only taken from the current list.
  const [itemsFor, setItemsFor] = useState<string | null>(null);
  const [active, setActive] = useState(-1);
  const [order] = useState(latestOnly);
  const abort = useRef<AbortController | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const root = useRef<HTMLDivElement>(null);

  // The field follows the page's query when it changes (a new search, back and forward).
  const [shownDefault, setShownDefault] = useState(defaultValue);
  if (shownDefault !== defaultValue) {
    setShownDefault(defaultValue);
    setValue(defaultValue);
  }

  useEffect(
    () => () => {
      abort.current?.abort();
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  function request(input: string) {
    if (timer.current) clearTimeout(timer.current);
    abort.current?.abort();
    const query = suggestQuery(input);
    if (!query) {
      order.next();
      setItems([]);
      setStatus("idle");
      setActive(-1);
      return;
    }
    setStatus("loading");
    timer.current = setTimeout(async () => {
      const ticket = order.next();
      const controller = new AbortController();
      abort.current = controller;
      try {
        const response = await fetch(`/api/catalog/suggest?q=${encodeURIComponent(query)}`, { signal: controller.signal });
        const body = (await response.json().catch(() => null)) as { suggestions?: Suggestion[] } | null;
        if (!order.isLatest(ticket)) return;
        if (!response.ok || !Array.isArray(body?.suggestions)) {
          setStatus("error");
          setItems([]);
          setItemsFor(null);
        } else {
          setItems(body.suggestions);
          setItemsFor(query);
          setStatus("ready");
        }
        setActive(-1);
      } catch {
        // Cancelled by newer typing, or offline: the newest request decides what shows.
        if (order.isLatest(ticket)) setStatus("error");
      }
    }, DEBOUNCE_MS);
  }

  function choose(item: Suggestion) {
    setOpen(false);
    setValue(item.title);
    router.push(item.href);
  }

  const query = suggestQuery(value);
  const current = itemsFor !== null && itemsFor === query;
  const showList = open && query !== null && status !== "idle";
  // While the first answer is on its way there is nothing to list yet.
  const listVisible = showList && !(status === "loading" && !items.length);
  const activeId = current && active >= 0 && items[active] ? `${id}-option-${active}` : undefined;
  const announcement =
    !showList || status === "loading"
      ? ""
      : status === "error"
        ? "Suggestions aren't available. Press Enter to search."
        : items.length
          ? `${items.length} ${items.length === 1 ? "suggestion" : "suggestions"}. Use the arrow keys to choose one.`
          : "No suggestions. Press Enter to search.";

  return (
    <div
      ref={root}
      className={cn("relative", className)}
      onBlur={(event) => {
        if (!root.current?.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <Search aria-hidden="true" className={cn("pointer-events-none absolute top-1/2 -translate-y-1/2 text-muted-foreground", large ? "left-4 size-5" : "left-3 size-4")} />
      <Input
        type="search"
        name={name}
        value={value}
        role="combobox"
        aria-label={label}
        aria-expanded={listVisible}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={activeId}
        autoComplete="off"
        spellCheck={false}
        maxLength={100}
        placeholder={placeholder}
        className={cn(large ? "h-13 pl-12 text-base" : "pl-9", inputClassName)}
        onChange={(event) => {
          setValue(event.target.value);
          // A highlighted suggestion belongs to the text before this keystroke.
          setActive(-1);
          setOpen(true);
          request(event.target.value);
        }}
        onFocus={() => {
          if (suggestQuery(value)) {
            setOpen(true);
            if (status === "idle") request(value);
          }
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            if (!items.length) return;
            event.preventDefault();
            setOpen(true);
            const step = event.key === "ArrowDown" ? 1 : -1;
            setActive((current) => {
              const next = current + step;
              if (next < -1) return items.length - 1;
              if (next >= items.length) return -1;
              return next;
            });
          } else if (event.key === "Enter") {
            // Only a suggestion for the text in the field now, never a stale one.
            if (showList && current && active >= 0 && items[active]) {
              event.preventDefault();
              choose(items[active]);
            } else {
              setOpen(false);
            }
          } else if (event.key === "Escape") {
            if (showList) {
              event.preventDefault();
              setOpen(false);
              setActive(-1);
            }
          } else if (event.key === "Tab") {
            setOpen(false);
          }
        }}
      />
      {status === "loading" && showList ? (
        <Loader2 aria-hidden="true" className={cn("absolute top-1/2 size-4 -translate-y-1/2 animate-spin text-muted-foreground motion-reduce:animate-none", large ? "right-4" : "right-3")} />
      ) : null}
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
      <ul
        id={listId}
        role="listbox"
        aria-label={`Suggestions for ${value}`}
        hidden={!listVisible}
        className="absolute inset-x-0 top-full z-40 mt-1.5 max-h-[min(28rem,70vh)] overflow-y-auto rounded-xl border border-white/10 bg-[#16151c] p-1.5 shadow-[0_24px_48px_-12px_rgb(0_0_0/0.8)]"
      >
        {status === "error" ? (
          <li role="presentation" className="px-3 py-2.5 text-sm text-muted-foreground">
            Suggestions aren&apos;t available right now. Press Enter to search.
          </li>
        ) : items.length === 0 ? (
          <li role="presentation" className="px-3 py-2.5 text-sm text-muted-foreground">
            No suggestions. Press Enter to search the catalog.
          </li>
        ) : (
          items.map((item, i) => (
            <li
              key={item.key}
              id={`${id}-option-${i}`}
              role="option"
              aria-selected={i === active}
              data-suggestion={item.title}
              // Keep focus in the field, so the list doesn't close before the choice.
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(item)}
              className={cn("flex cursor-pointer flex-col gap-0.5 rounded-lg px-3 py-2 text-left", i === active ? "bg-primary/18" : "hover:bg-white/5")}
            >
              <span className="text-sm font-medium text-foreground">
                <Highlight text={item.title} query={query ?? ""} />
              </span>
              <span className="text-xs text-muted-foreground">
                {[item.year, item.platforms.join(" · ")].filter(Boolean).join(" · ")}
                {item.note ? <span className="block truncate">{item.note}</span> : null}
              </span>
            </li>
          ))
        )}
      </ul>
    </div>
  );
}

/** The typed text in bold where the title contains it, ignoring case and accents. */
function Highlight({ text, query }: { text: string; query: string }) {
  const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const at = query ? fold(text).indexOf(fold(query)) : -1;
  // Accents folded away keep the same length only for precomposed letters; when they
  // don't line up, the title is shown plain rather than cut wrongly.
  if (at < 0 || fold(text).length !== text.length) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark className="bg-transparent font-semibold text-primary-text">{text.slice(at, at + query.length)}</mark>
      {text.slice(at + query.length)}
    </>
  );
}
