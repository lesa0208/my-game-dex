"use client";

import { useState } from "react";

import { Input } from "@/components/ui/input";
import { REQUIREMENT_LEVELS, REQUIREMENT_LIMIT, type GameFields } from "@/features/editing/form";
import { PIECE_LIMIT, pieceRows, type Piece, type ReleaseRecord as ReleaseFieldValues } from "@/features/review/form";
import { EDITION_KINDS, GAME_KINDS, PIECE_KINDS } from "@/features/submissions/form";
import { AdminField as Field, adminControl, adminSelect, adminTextarea } from "@/components/admin/form-controls";

/**
 * The editing forms' fields (M10c), for features/editing/actions.ts. Each starts from
 * the record as it is now, or empty for a new one; the action sends only what differs.
 */

export function GameInputs({ id, game }: { id: string; game: GameFields | null }) {
  return (
    <>
      <Field id={`${id}-title`} label="Title">
        <Input id={`${id}-title`} name="title" required maxLength={200} defaultValue={game?.title ?? ""} autoComplete="off" className={adminControl} />
      </Field>
      <div className="grid items-start gap-4 sm:grid-cols-2">
        <Field id={`${id}-sort_title`} label="Sort title (optional)" hint="How the title sorts, such as without a leading “The”. Empty means the title.">
          <Input
            id={`${id}-sort_title`}
            name="sort_title"
            maxLength={200}
            defaultValue={game && game.sort_title !== game.title ? game.sort_title : ""}
            autoComplete="off"
            aria-describedby={`${id}-sort_title-hint`}
            className={adminControl}
          />
        </Field>
        <Field id={`${id}-kind`} label="Type">
          <select id={`${id}-kind`} name="kind" defaultValue={game?.kind ?? "game"} className={adminSelect}>
            {GAME_KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </select>
        </Field>
        <Field id={`${id}-year`} label="First released (optional)" hint="The year, as four digits.">
          <Input
            id={`${id}-year`}
            name="first_release_year"
            inputMode="numeric"
            maxLength={4}
            defaultValue={game?.first_release_year ? String(game.first_release_year) : ""}
            autoComplete="off"
            aria-describedby={`${id}-year-hint`}
            className={adminControl}
          />
        </Field>
      </div>
      <Field id={`${id}-summary`} label="Summary (optional)" hint="Up to 2,000 characters.">
        <textarea
          id={`${id}-summary`}
          name="summary"
          maxLength={2000}
          rows={4}
          defaultValue={game?.summary ?? ""}
          aria-describedby={`${id}-summary-hint`}
          className={adminTextarea}
        />
      </Field>
    </>
  );
}

/** The platform and physical format of a new release: formats are those its platform uses. */
export function PlatformInputs({
  id,
  platforms,
  formats,
}: {
  id: string;
  platforms: { slug: string; name: string }[];
  formats: { platform: string; code: string; name: string }[];
}) {
  const [platform, setPlatform] = useState(platforms[0]?.slug ?? "");
  const usable = formats.filter((f) => f.platform === platform);
  return (
    <div className="grid items-start gap-4 sm:grid-cols-2">
      <Field id={`${id}-platform`} label="Platform">
        <select id={`${id}-platform`} name="platform" value={platform} onChange={(e) => setPlatform(e.target.value)} className={adminSelect}>
          {platforms.map((p) => (
            <option key={p.slug} value={p.slug}>
              {p.name}
            </option>
          ))}
        </select>
      </Field>
      <Field id={`${id}-format`} label="Physical format">
        <select id={`${id}-format`} name="format" key={platform} defaultValue={usable[0]?.code ?? ""} className={adminSelect}>
          {usable.map((f) => (
            <option key={f.code} value={f.code}>
              {f.name}
            </option>
          ))}
        </select>
      </Field>
    </div>
  );
}

export function ReleaseInputs({ id, release, regions }: { id: string; release: ReleaseFieldValues | null; regions: { code: string; label: string }[] }) {
  const [region, setRegion] = useState(release?.region_code || regions[0]?.code || "");
  const text = (name: keyof ReleaseFieldValues) => {
    const value = release?.[name];
    return value === null || value === undefined ? "" : String(value);
  };
  return (
    <>
      <div className="grid items-start gap-4 sm:grid-cols-2">
        <Field id={`${id}-edition_name`} label="Edition">
          <Input id={`${id}-edition_name`} name="edition_name" maxLength={120} defaultValue={text("edition_name")} autoComplete="off" className={adminControl} />
        </Field>
        <Field id={`${id}-edition_kind`} label="Edition type">
          <select id={`${id}-edition_kind`} name="edition_kind" defaultValue={text("edition_kind")} className={adminSelect}>
            <option value="">Not recorded</option>
            {EDITION_KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </select>
        </Field>
        <Field id={`${id}-media_count`} label="Discs or cartridges">
          <Input id={`${id}-media_count`} name="media_count" inputMode="numeric" maxLength={2} defaultValue={text("media_count")} autoComplete="off" className={adminControl} />
        </Field>
        <Field id={`${id}-region_code`} label="Region">
          <select id={`${id}-region_code`} name="region_code" value={region} onChange={(e) => setRegion(e.target.value)} className={adminSelect}>
            {regions.map((r) => (
              <option key={r.code} value={r.code}>
                {r.code === "unknown" ? "Unknown" : r.label}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {region === "unknown" ? (
        <div className="flex gap-3 rounded-lg border bg-muted/40 p-3">
          <input
            id={`${id}-confirm`}
            name="region_unknown_confirmed"
            type="checkbox"
            defaultChecked={release?.region_unknown_confirmed ?? false}
            className="mt-0.5 size-5 shrink-0 accent-primary-solid"
          />
          <label htmlFor={`${id}-confirm`} className="text-sm">
            I confirm the region can&apos;t be determined from the evidence. An unknown region is verified only with this confirmation.
          </label>
        </div>
      ) : null}
      <div className="grid items-start gap-4 sm:grid-cols-2">
        <Field id={`${id}-variant_name`} label="Variant (optional)">
          <Input id={`${id}-variant_name`} name="variant_name" maxLength={120} defaultValue={text("variant_name")} autoComplete="off" className={adminControl} />
        </Field>
        <Field id={`${id}-packaging`} label="Packaging (optional)">
          <Input id={`${id}-packaging`} name="packaging" maxLength={80} defaultValue={text("packaging")} autoComplete="off" className={adminControl} />
        </Field>
        <Field id={`${id}-product_code`} label="Product code (optional)">
          <Input id={`${id}-product_code`} name="product_code" maxLength={40} defaultValue={text("product_code")} autoComplete="off" className={adminControl} />
        </Field>
        <Field id={`${id}-barcode`} label="Barcode (optional)">
          <Input id={`${id}-barcode`} name="barcode" inputMode="numeric" maxLength={20} defaultValue={text("barcode")} autoComplete="off" className={adminControl} />
        </Field>
        <Field id={`${id}-local_title`} label="Title on the package (optional)">
          <Input id={`${id}-local_title`} name="local_title" maxLength={200} defaultValue={text("local_title")} autoComplete="off" className={adminControl} />
        </Field>
        <Field id={`${id}-publisher_name`} label="Publisher (optional)">
          <Input id={`${id}-publisher_name`} name="publisher_name" maxLength={120} defaultValue={text("publisher_name")} autoComplete="off" className={adminControl} />
        </Field>
        <Field id={`${id}-release_year`} label="Release year (optional)">
          <Input
            id={`${id}-release_year`}
            name="release_year"
            inputMode="numeric"
            maxLength={4}
            defaultValue={release?.release_date ? release.release_date.slice(0, 4) : ""}
            autoComplete="off"
            className={adminControl}
          />
        </Field>
      </div>
    </>
  );
}

export function PieceRows({ id, pieces }: { id: string; pieces: Piece[] }) {
  const rows = pieceRows(pieces.length);
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-sm font-semibold">Pieces in the box</legend>
      <input type="hidden" name="piece_rows" value={rows} />
      <p id={`${id}-hint`} className="text-xs text-muted-foreground">
        Manuals, maps, posters and other original materials, up to {PIECE_LIMIT}. Clear a name to remove that piece; collectors&apos; copies keep their record of it.
      </p>
      {Array.from({ length: rows }, (_, i) => {
        const piece = pieces[i];
        return (
          <div key={i} className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)_4.5rem] gap-2">
            <label className="sr-only" htmlFor={`${id}-kind-${i}`}>
              Piece {i + 1} type
            </label>
            <select id={`${id}-kind-${i}`} name={`piece_kind_${i}`} defaultValue={piece?.kind ?? "insert"} className={adminSelect}>
              {PIECE_KINDS.map((k) => (
                <option key={k.value} value={k.value}>
                  {k.label}
                </option>
              ))}
            </select>
            <label className="sr-only" htmlFor={`${id}-label-${i}`}>
              Piece {i + 1} name
            </label>
            <Input id={`${id}-label-${i}`} name={`piece_label_${i}`} maxLength={120} defaultValue={piece?.label ?? ""} autoComplete="off" aria-describedby={`${id}-hint`} className={adminControl} />
            <label className="sr-only" htmlFor={`${id}-quantity-${i}`}>
              Piece {i + 1} quantity
            </label>
            <Input
              id={`${id}-quantity-${i}`}
              name={`piece_quantity_${i}`}
              inputMode="numeric"
              maxLength={2}
              defaultValue={piece ? String(piece.quantity) : ""}
              placeholder="1"
              autoComplete="off"
              className={adminControl}
            />
          </div>
        );
      })}
    </fieldset>
  );
}

export function RequirementRows({
  id,
  current,
  choices,
}: {
  id: string;
  current: { code: string; level: string; note: string | null }[];
  choices: { code: string; label: string }[];
}) {
  const rows = Math.min(Math.max(current.length + 2, 3), REQUIREMENT_LIMIT);
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-sm font-semibold">Hardware</legend>
      <input type="hidden" name="requirement_rows" value={rows} />
      <p id={`${id}-hint`} className="text-xs text-muted-foreground">
        Accessories or hardware this release needs or works with, from its platform&apos;s list. Leave a row on “None” to skip it.
      </p>
      {Array.from({ length: rows }, (_, i) => {
        const row = current[i];
        return (
          <div key={i} className="grid gap-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,2fr)]">
            <label className="sr-only" htmlFor={`${id}-code-${i}`}>
              Hardware {i + 1}
            </label>
            <select id={`${id}-code-${i}`} name={`requirement_${i}`} defaultValue={row?.code ?? ""} aria-describedby={`${id}-hint`} className={adminSelect}>
              <option value="">None</option>
              {choices.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.label}
                </option>
              ))}
            </select>
            <label className="sr-only" htmlFor={`${id}-level-${i}`}>
              Hardware {i + 1}: how it&apos;s needed
            </label>
            <select id={`${id}-level-${i}`} name={`requirement_level_${i}`} defaultValue={row?.level ?? "required"} className={adminSelect}>
              {REQUIREMENT_LEVELS.map((l) => (
                <option key={l.value} value={l.value}>
                  {l.label}
                </option>
              ))}
            </select>
            <label className="sr-only" htmlFor={`${id}-note-${i}`}>
              Hardware {i + 1}: note
            </label>
            <Input id={`${id}-note-${i}`} name={`requirement_note_${i}`} maxLength={300} defaultValue={row?.note ?? ""} placeholder="Note (optional)" autoComplete="off" className={adminControl} />
          </div>
        );
      })}
    </fieldset>
  );
}
