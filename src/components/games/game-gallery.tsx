"use client";

import { ArrowUpRight, ChevronLeft, ChevronRight, ImageOff, Loader2, Maximize2, X } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { type KeyboardEvent, type ReactNode, type RefObject, useEffect, useRef, useState } from "react";

import type { GalleryItem } from "@/features/media/gallery";
import { viewerMaxWidth } from "@/features/media/gallery";
import { cn } from "@/lib/utils";

// Game Details 2.0, Phase 3: the Gallery. Every image whole, in its own proportions: thumbnails sit
// in frames of one shape on a dark matte, never cropped or stretched; the viewer shows an image as
// large as the screen allows, but never far beyond its original size. Each image keeps its source
// and terms in sight. Only the page's own items: nothing is added, generated or guessed.
//
// IGDB's images come only from the app's authorization-checked route. The viewer asks that route
// again (revalidating, no stored copy trusted) every time it shows one, and shows exactly the
// bytes it was given, so an image withdrawn while the viewer is open is never shown from a copy:
// it gets a safe "not available" state instead.

// One answer from the route, for one showing of one image (`view` counts showings).
type Loaded = { view: number; url: string | null; failed: boolean };

function frameLabel(item: GalleryItem, index: number, total: number) {
  return `${item.label}, ${index + 1} of ${total}: open larger`;
}

function Credit({ item, className }: { item: GalleryItem; className?: string }) {
  if (item.source === "igdb") {
    return (
      <p className={cn("text-xs text-muted-foreground", className)}>
        Screenshot from{" "}
        <a href={item.credit.url ?? "https://www.igdb.com"} className="inline-flex items-center gap-0.5 font-medium text-primary-text underline-offset-2 hover:underline" rel="noopener noreferrer" target="_blank">
          IGDB.com
          <ArrowUpRight aria-hidden="true" className="size-3" />
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
        <span aria-hidden="true"> · </span>
        <span className="sr-only">. </span>
        {/* Short on a phone, in full from 640px: either way, game-level, not release evidence. */}
        <span className="sm:hidden">Game-level, not a verified release image.</span>
        <span className="hidden sm:inline">Of the game as a whole; it doesn&apos;t verify any physical release, region or edition.</span>
      </p>
    );
  }
  return (
    <p className={cn("text-xs text-muted-foreground", className)}>
      {item.credit.url ? (
        <a href={item.credit.url} className="font-medium text-primary-text underline-offset-2 hover:underline" rel="noopener noreferrer" target="_blank">
          {item.credit.name}
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
      ) : (
        <span className="text-foreground/85">{item.credit.name}</span>
      )}
      {item.credit.license ? ` · ${item.credit.license}` : ""}
      {item.credit.attribution ? ` · ${item.credit.attribution}` : ""}
    </p>
  );
}

function Thumbnail({ item, index, total, failed, onFail, onOpen, buttonRef }: { item: GalleryItem; index: number; total: number; failed: boolean; onFail: () => void; onOpen: () => void; buttonRef: (el: HTMLButtonElement | null) => void }) {
  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={onOpen}
      aria-label={frameLabel(item, index, total)}
      aria-haspopup="dialog"
      className="group relative block aspect-[16/10] w-full overflow-hidden rounded-xl border border-white/[0.08] bg-[radial-gradient(120%_90%_at_50%_0%,rgb(124_92_255/0.10),transparent_60%),#0c0b11] outline-none transition-colors hover:border-[rgb(167_139_250/0.55)] focus-visible:ring-3 focus-visible:ring-ring motion-reduce:transition-none"
    >
      {failed ? (
        <span className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 text-xs text-muted-foreground" data-gallery-unavailable="">
          <ImageOff aria-hidden="true" className="size-5" />
          Not available
        </span>
      ) : (
        // A plain img: IGDB's images never go through the image optimizer (next.config.ts), and the
        // registry's are served as they were approved. object-contain: the whole image, never cropped.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={item.src}
          alt=""
          width={item.width ?? undefined}
          height={item.height ?? undefined}
          loading={index < 4 ? "eager" : "lazy"}
          decoding="async"
          onError={onFail}
          className="absolute inset-0 h-full w-full object-contain p-1.5 transition-transform duration-300 group-hover:scale-[1.02] motion-reduce:transition-none motion-reduce:group-hover:scale-100"
        />
      )}
      <span aria-hidden="true" className="absolute right-2 bottom-2 flex size-7 items-center justify-center rounded-full bg-black/60 text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 motion-reduce:transition-none">
        <Maximize2 className="size-3.5" />
      </span>
    </button>
  );
}

function Group({ id, title, note, items, offset, total, failed, onFail, onOpen, refs }: { id: string; title: string; note?: ReactNode; items: GalleryItem[]; offset: number; total: number; failed: Set<string>; onFail: (id: string) => void; onOpen: (index: number) => void; refs: RefObject<(HTMLButtonElement | null)[]> }) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id={id} className="text-xl font-semibold text-white">
          {title} <span className="text-base font-normal text-muted-foreground">({items.length})</span>
        </h2>
        {note}
      </div>
      <ul className="grid grid-cols-2 gap-3 sm:gap-4 md:grid-cols-3 lg:grid-cols-4">
        {items.map((item, i) => (
          <li key={item.id} className="flex min-w-0 flex-col gap-1.5" data-gallery-item={item.source} {...(item.source === "igdb" ? { "data-screenshot": "igdb" } : { "data-photo": "registry" })}>
            <Thumbnail
              item={item}
              index={offset + i}
              total={total}
              failed={failed.has(item.id)}
              onFail={() => onFail(item.id)}
              onOpen={() => onOpen(offset + i)}
              buttonRef={(el) => {
                refs.current[offset + i] = el;
              }}
            />
            {/* A photo's label says what it shows; a screenshot's would only repeat its number,
                which its accessible name and the viewer's counter already give. */}
            {item.source === "registry" ? (
              <>
                <p className="truncate text-xs text-muted-foreground">{item.label}</p>
                <Credit item={item} />
              </>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function GameGallery({ title, items, igdbUrl }: { title: string; items: GalleryItem[]; igdbUrl: string | null }) {
  const [open, setOpen] = useState<number | null>(null);
  const [failed, setFailed] = useState<Set<string>>(() => new Set());
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [view, setView] = useState(0);
  const thumbs = useRef<(HTMLButtonElement | null)[]>([]);
  const last = useRef(0);
  const photos = items.filter((i) => i.source === "registry");
  const shots = items.filter((i) => i.source === "igdb");
  const current = open === null ? null : (items[open] ?? null);

  // Each time the viewer shows an IGDB image, the route is asked again ("no-cache": revalidated,
  // a 304 while it stays authorized) and the image is shown from exactly that answer. A 404 (a
  // withdrawn or unknown image) or anything that isn't an image is "not available".
  useEffect(() => {
    if (!current || current.source !== "igdb") return;
    const controller = new AbortController();
    let url: string | null = null;
    fetch(current.src, { cache: "no-cache", credentials: "same-origin", signal: controller.signal })
      .then(async (response) => {
        const type = response.headers.get("content-type") ?? "";
        if (!response.ok || !/^image\/(jpeg|png|webp)$/.test(type.split(";")[0].trim())) throw new Error("unavailable");
        url = URL.createObjectURL(await response.blob());
        setLoaded({ view, url, failed: false });
      })
      .catch(() => {
        if (!controller.signal.aborted) setLoaded({ view, url: null, failed: true });
      });
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [current, view]);

  const show = (index: number) => {
    last.current = index;
    setView((v) => v + 1);
    setOpen(index);
  };
  const step = (by: number) => {
    if (open === null) return;
    show((open + by + items.length) % items.length);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      step(-1);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      step(1);
    }
  };

  // What the viewer shows now: a registry photo straight from its file; an IGDB image once the
  // route has answered for it, and not before.
  const ready = current && loaded?.view === view ? loaded : null;
  const src = current?.source === "registry" ? (failed.has(current.id) ? null : current.src) : (ready?.url ?? null);
  const unavailable = current ? (current.source === "registry" ? failed.has(current.id) : Boolean(ready?.failed)) : false;
  const loading = Boolean(current && !src && !unavailable);
  const fail = (id: string) => setFailed((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));

  return (
    <div className="flex flex-col gap-8" data-gallery="">
      {photos.length ? (
        <Group id="gallery-photos" title="Photos" items={photos} offset={0} total={items.length} failed={failed} onFail={fail} onOpen={show} refs={thumbs} />
      ) : null}
      {shots.length ? (
        <Group
          id="gallery-screenshots"
          title="Screenshots"
          items={shots}
          offset={photos.length}
          total={items.length}
          failed={failed}
          onFail={fail}
          onOpen={show}
          refs={thumbs}
          note={
            <p className="text-xs text-muted-foreground" data-igdb-credit="">
              Game screenshots from{" "}
              <a href={igdbUrl ?? "https://www.igdb.com"} className="underline underline-offset-2 hover:text-foreground" rel="noopener noreferrer" target="_blank">
                IGDB.com
              </a>
              , not tied to a platform or release.
            </p>
          }
        />
      ) : null}

      <DialogPrimitive.Root open={current !== null} onOpenChange={(next) => (next ? null : setOpen(null))}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/60" />
          <DialogPrimitive.Content
            onKeyDown={onKeyDown}
            // Back to the thumbnail of the image last shown, not only the one that opened it.
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              thumbs.current[last.current]?.focus();
            }}
            className="fixed inset-0 z-50 flex flex-col bg-[#09080d] text-foreground outline-none"
            data-gallery-viewer=""
          >
            {current ? (
              <>
                <div className="flex items-center justify-between gap-3 px-4 pt-[max(0.75rem,env(safe-area-inset-top))] pb-2 sm:px-6 sm:pt-4">
                  <div className="min-w-0">
                    <DialogPrimitive.Title className="truncate text-base font-semibold text-white sm:text-lg">{current.label}</DialogPrimitive.Title>
                    <p className="text-xs text-muted-foreground">
                      <span className="sr-only">{title}, image </span>
                      <span data-gallery-position="">
                        {(open ?? 0) + 1} of {items.length}
                      </span>
                    </p>
                  </div>
                  <DialogPrimitive.Close aria-label="Close" className="flex size-11 shrink-0 items-center justify-center rounded-full bg-white/[0.06] text-white outline-none hover:bg-white/[0.12] focus-visible:ring-3 focus-visible:ring-ring">
                    <X aria-hidden="true" className="size-5" />
                  </DialogPrimitive.Close>
                </div>

                <div className="grid min-h-0 flex-1 grid-cols-2 grid-rows-[minmax(0,1fr)_auto] gap-x-3 gap-y-3 px-4 [grid-template-areas:'stage_stage'_'prev_next'] sm:px-6 md:grid-cols-[auto_minmax(0,1fr)_auto] md:grid-rows-[minmax(0,1fr)] md:gap-x-4 md:[grid-template-areas:'prev_stage_next']">
                  <button
                    type="button"
                    onClick={() => step(-1)}
                    aria-label="Previous image"
                    className="flex h-11 items-center justify-center gap-1.5 justify-self-start rounded-full bg-white/[0.06] px-4 text-sm font-medium text-white outline-none [grid-area:prev] hover:bg-white/[0.12] focus-visible:ring-3 focus-visible:ring-ring md:size-12 md:self-center md:px-0"
                  >
                    <ChevronLeft aria-hidden="true" className="size-5" />
                    <span className="md:sr-only">Previous</span>
                  </button>
                  <div className="relative min-h-0 min-w-0 [grid-area:stage]" aria-busy={loading} data-gallery-stage={unavailable ? "unavailable" : loading ? "loading" : "image"}>
                    {src ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        key={current.id}
                        src={src}
                        alt={current.alt}
                        width={current.width ?? undefined}
                        height={current.height ?? undefined}
                        onError={() => (current.source === "registry" ? fail(current.id) : setLoaded({ view, url: null, failed: true }))}
                        style={{ maxWidth: `min(100%, ${viewerMaxWidth(current.width)}px)` }}
                        className="absolute inset-0 m-auto h-auto max-h-full w-auto rounded-lg object-contain shadow-[0_30px_80px_-20px_rgb(0_0_0/0.9)]"
                        data-gallery-image=""
                      />
                    ) : unavailable ? (
                      <div role="status" className="absolute inset-0 m-auto flex h-fit max-w-xs flex-col items-center gap-2 rounded-xl border border-white/[0.08] bg-white/[0.03] p-6 text-center" data-gallery-unavailable="">
                        <ImageOff aria-hidden="true" className="size-6 text-muted-foreground" />
                        <p className="text-sm font-medium text-white">This image isn&apos;t available</p>
                        <p className="text-xs text-muted-foreground">It may have been withdrawn. Nothing is shown in its place.</p>
                      </div>
                    ) : (
                      <div className="absolute inset-0 flex items-center justify-center text-muted-foreground">
                        <Loader2 aria-hidden="true" className="size-6 animate-spin motion-reduce:animate-none" />
                        <span className="sr-only">Loading image</span>
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => step(1)}
                    aria-label="Next image"
                    className="flex h-11 items-center justify-center gap-1.5 justify-self-end rounded-full bg-white/[0.06] px-4 text-sm font-medium text-white outline-none [grid-area:next] hover:bg-white/[0.12] focus-visible:ring-3 focus-visible:ring-ring md:size-12 md:self-center md:px-0"
                  >
                    <span className="md:sr-only">Next</span>
                    <ChevronRight aria-hidden="true" className="size-5" />
                  </button>
                </div>

                <div className="px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-6 sm:pb-5">
                  <DialogPrimitive.Description asChild>
                    <div className="mx-auto max-w-3xl text-center">
                      <p className="sr-only">{current.alt}</p>
                      <Credit item={current} />
                    </div>
                  </DialogPrimitive.Description>
                  <p aria-live="polite" className="sr-only">
                    {current.label}, {(open ?? 0) + 1} of {items.length}
                    {unavailable ? ": not available" : ""}
                  </p>
                </div>
              </>
            ) : null}
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </div>
  );
}
