/**
 * The packaging vocabulary (M11b-1b), mirroring public.packaging_types in
 * 20261201100000_m11b1b_release_identity.sql. Types describe how a package is built,
 * never how many discs it holds. `unclassified` and `unknown` are states, not types.
 * A test keeps this list and the migration in step.
 */
export const PACKAGING_TYPES = [
  { code: "unclassified", name: "Not yet classified", isType: false },
  { code: "unknown", name: "Unknown", isType: false },
  { code: "cardboard-box", name: "Cardboard box", isType: true },
  { code: "jewel-case", name: "Jewel case", isType: true },
  { code: "double-depth-jewel-case", name: "Double-depth jewel case", isType: true },
  { code: "plastic-case", name: "Plastic case", isType: true },
  { code: "paper-sleeve", name: "Paper sleeve", isType: true },
] as const;

export type PackagingCode = (typeof PACKAGING_TYPES)[number]["code"];

export const PACKAGING_CODES: readonly string[] = PACKAGING_TYPES.map((t) => t.code);

/** Choices for an editor: every type, Unknown, and Not yet classified. */
export const EDITOR_PACKAGING_CHOICES = PACKAGING_TYPES.map((t) => ({ value: t.code, label: t.name }));

/** Choices for a collector: every type, or "Not sure" (unclassified). Only an editor records Unknown. */
export const SUBMITTER_PACKAGING_CHOICES = [
  { value: "unclassified", label: "Not sure" },
  ...PACKAGING_TYPES.filter((t) => t.isType).map((t) => ({ value: t.code, label: t.name })),
];

const NAMES = new Map<string, string>(PACKAGING_TYPES.map((t) => [t.code, t.name]));

/** The name of a packaging code; a code this build doesn't know is shown as itself. */
export function packagingName(code: string | null | undefined): string | null {
  if (!code) return null;
  return NAMES.get(code) ?? code;
}

/**
 * What a public page shows: the type once classified, "Unknown" when an editor said so,
 * and for an unclassified release only the packaging text as originally recorded, if any.
 */
export function packagingLabel(code: string | null | undefined, recorded: string | null | undefined): string | null {
  if (code && code !== "unclassified") return packagingName(code);
  return recorded?.trim() ? recorded : null;
}

/** What a staff page shows: the classification, with the recorded text when there is one. */
export function packagingStaffLabel(code: string | null | undefined, recorded: string | null | undefined): string {
  const name = packagingName(code ?? "unclassified") ?? "Not yet classified";
  return recorded?.trim() ? `${name} (recorded as “${recorded}”)` : name;
}
