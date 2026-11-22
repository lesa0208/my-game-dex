"use client";

import { useId, useState, useSyncExternalStore } from "react";

import { selectClassName } from "@/components/collection/copy-fields";
import { LEVELS, MINIMUMS, NOTE_MAX, PRIORITIES } from "@/features/wishlist/format";
import type { WishlistLevel } from "@/features/wishlist/types";
import { cn } from "@/lib/utils";

export type PlatformChoice = { id: string; name: string; note?: string };
export type RegionChoice = { code: string; label: string };
export type ReleaseChoice = { id: string; label: string; group: string; note?: string };

// The fields a wish is made of, for adding and editing. Without JavaScript every field
// shows and the chosen level decides which are used (the action ignores the others);
// with it, only the level's own fields show. Choices are only what W1 accepts: the
// game's published platforms, the catalog's regions (any of them, not only those with a
// catalogued release), and its published releases.

const subscribe = () => () => {};
/** True once the page has hydrated, false in the server render. */
function useHydrated() {
  return useSyncExternalStore(subscribe, () => true, () => false);
}

function Select({ id, name, label, value, children, onChange }: { id: string; name: string; label: string; value?: string; children: React.ReactNode; onChange?: (value: string) => void }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium text-muted-foreground">
        {label}
      </label>
      <select id={id} name={name} defaultValue={value} onChange={onChange ? (e) => onChange(e.target.value) : undefined} className={selectClassName}>
        {children}
      </select>
    </div>
  );
}

export function WishTargetFields({
  gameId,
  platforms,
  regions,
  releases,
  initial,
  levels = ["game", "platform", "region", "release"],
}: {
  gameId: string;
  platforms: PlatformChoice[];
  regions: RegionChoice[];
  releases: ReleaseChoice[];
  initial: { level: WishlistLevel; platformId: string | null; regionCode: string | null; releaseId: string | null };
  levels?: WishlistLevel[];
}) {
  const id = useId();
  const hydrated = useHydrated();
  const [level, setLevel] = useState<WishlistLevel>(initial.level);
  const offered = LEVELS.filter((l) => levels.includes(l.value) && (l.value !== "release" || releases.length > 0) && (l.value === "game" || l.value === "release" || platforms.length > 0));
  const show = (needed: boolean) => !hydrated || needed;
  const groups = [...new Set(releases.map((r) => r.group))];

  return (
    <>
      <input type="hidden" name="game_id" value={gameId} />
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">What do you want?</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {offered.map((option) => (
            <label
              key={option.value}
              className={cn(
                "flex cursor-pointer gap-2.5 rounded-lg border p-2.5 text-sm transition-colors has-focus-visible:ring-3 has-focus-visible:ring-ring",
                level === option.value ? "border-primary/60 bg-primary/10" : "border-white/10 hover:bg-white/[0.03]",
              )}
            >
              <input
                type="radio"
                name="level"
                value={option.value}
                defaultChecked={initial.level === option.value}
                onChange={() => setLevel(option.value)}
                className="mt-0.5 size-4 shrink-0 accent-primary"
              />
              <span className="min-w-0">
                <span className="block font-medium">{option.label}</span>
                <span className="block text-xs text-muted-foreground">{option.hint}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      {show(level === "platform" || level === "region") || show(level === "release") ? (
        <div className="grid gap-2 sm:grid-cols-2">
          {show(level === "platform" || level === "region") && platforms.length ? (
            <Select id={`${id}-platform`} name="platform_id" label={hydrated ? "Platform" : "Platform (for a platform, or a platform and region)"} value={initial.platformId ?? platforms[0]?.id}>
              {platforms.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.note ? ` (${p.note})` : ""}
                </option>
              ))}
            </Select>
          ) : null}
          {show(level === "region") ? (
            <Select id={`${id}-region`} name="region_code" label={hydrated ? "Region" : "Region (for a platform and region)"} value={initial.regionCode ?? ""}>
              <option value="" disabled>
                Choose a region
              </option>
              {regions.map((r) => (
                <option key={r.code} value={r.code}>
                  {r.label}
                </option>
              ))}
            </Select>
          ) : null}
          {show(level === "release") && releases.length ? (
            <div className="sm:col-span-2">
              <Select id={`${id}-release`} name="release_id" label={hydrated ? "Release" : "Release (for one exact release)"} value={initial.releaseId ?? releases[0]?.id}>
                {groups.map((group) => (
                  <optgroup key={group} label={group}>
                    {releases
                      .filter((r) => r.group === group)
                      .map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.label}
                          {r.note ? ` (${r.note})` : ""}
                        </option>
                      ))}
                  </optgroup>
                ))}
              </Select>
            </div>
          ) : null}
        </div>
      ) : null}
      {level === "region" && hydrated ? (
        <p className="-mt-1 text-xs text-muted-foreground">Any region the catalog lists can be wanted, even where no release from it is catalogued yet.</p>
      ) : null}
    </>
  );
}

/** Priority, the lowest acceptable completeness and a private note. */
export function WishDetailFields({ initial }: { initial: { priority: number; completeness: string | null; note: string | null } }) {
  const id = useId();
  const [length, setLength] = useState([...(initial.note ?? "")].length);
  return (
    <>
      <div className="grid gap-2 sm:grid-cols-2">
        <Select id={`${id}-priority`} name="priority" label="Priority" value={String(initial.priority)}>
          {PRIORITIES.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </Select>
        <Select id={`${id}-completeness`} name="completeness" label="Lowest completeness you'd accept" value={initial.completeness ?? ""}>
          <option value="">Any completeness</option>
          {MINIMUMS.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </Select>
      </div>
      <p className="-mt-1 text-xs text-muted-foreground">This is what you&apos;d accept, not a copy you own: a copy counts when it&apos;s at least this complete.</p>
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-note`} className="text-xs font-medium text-muted-foreground">
          Private note <span className="font-normal">(optional, only you can see it)</span>
        </label>
        <textarea
          id={`${id}-note`}
          name="note"
          defaultValue={initial.note ?? ""}
          maxLength={NOTE_MAX}
          rows={3}
          aria-describedby={`${id}-note-count`}
          onChange={(e) => setLength([...e.target.value].length)}
          className="min-h-20 w-full rounded-lg border border-input bg-background px-2.5 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring dark:bg-input/30"
        />
        <p id={`${id}-note-count`} className="text-right text-xs text-muted-foreground">
          {length} / {NOTE_MAX}
        </p>
      </div>
    </>
  );
}
