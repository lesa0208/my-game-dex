/**
 * M12c-A: the first real physical catalog pilot. Eight games and their physical release
 * candidates on NES, SNES and PlayStation, revalidated on 2026-11-19 from the M11b-0
 * shortlist (docs/architecture/physical-catalog-m11b.md § 8).
 *
 * Every fact below was read from a saved copy of the cited page. The copies stay outside
 * the repository in ~/.my-game-dex/source-evidence/2026-11-19/, and each is named here
 * with its SHA-256, so a reviewer can see exactly what was read. Nothing is taken from a
 * search snippet, a ROM dump name, a cover image or a code pattern.
 *
 * Classes (M11b-0 § 8):
 *   A  item-level evidence for the platform, shell, printed code and edition: publishable
 *      once a different editor reviews it;
 *   B  staged as a candidate with an evidence gap an editor must close first;
 *   H  held: not entered at all until the gap is resolved.
 *
 * Packaging: none of these sources states how a package is built, so the A rows are
 * classified `unknown` (an editor examined the evidence and it can't be established),
 * and B rows stay `unclassified`. No product code is taken from a disc serial (M11b-0),
 * and no MIG-4 identifier is recorded: that work is cancelled.
 *
 * Data only: scripts/catalog-pilot-m12c.mjs stages it on the isolated test stack.
 */

export const EVIDENCE_DATE = "2026-11-19";

/** Saved copies of the pages read, by key. */
export const EVIDENCE = {
  "snescentral-0000": { url: "https://snescentral.com/article.php?id=0000", sha256: "23406759b2842ff04b413eee67f24876b464b61b881aec4edfa151974af41cd0", what: "SNES Central, Super Mario World: cartridge label table" },
  "snescentral-0164": { url: "https://snescentral.com/article.php?id=0164", sha256: "5f3a7deaa84ebc9321140641fbaf1d54f2872ae16c3088391dd957116bf11912", what: "SNES Central, A Link to the Past: cartridge label table" },
  "snescentral-0885": { url: "https://snescentral.com/article.php?id=0885", sha256: "57af9d36090da00c196787479b4bf3f47266b7c515f378f395780a83cdfa0ace", what: "SNES Central, Super Metroid: cartridge label table" },
  "wikipedia-snes": { url: "https://en.wikipedia.org/wiki/Super_Nintendo_Entertainment_System", sha256: "a262259bc416945c98d17c1efb13fbe44657ab767fdd0ebecee7f61c7de00f26", what: "Wikipedia, SNES: \"North American cartridges have a rectangular bottom… other regions' cartridges are narrower\"" },
  "psxdc-SLPS-00700": { url: "https://psxdatacenter.com/games/J/F/SLPS-00700.html", sha256: "00655fb45295cccbfbb0a57bf266066bd47595f41d3a5f761da9bad56a378901", what: "PSXDataCenter, Final Fantasy VII (NTSC-J)" },
  "psxdc-SCUS-94163": { url: "https://psxdatacenter.com/games/U/F/SCUS-94163.html", sha256: "4aa4ea41a2efa6100b5309fe7f5ba93eb52da5838ec699b473cfcc3d28f7be72", what: "PSXDataCenter, Final Fantasy VII (NTSC-U)" },
  "psxdc-SCES-00867": { url: "https://psxdatacenter.com/games/P/F/SCES-00867.html", sha256: "0f3caea96f220d495cfed53dfcfcc2dc7b93e96bc5e19f58bb751486a8418a64", what: "PSXDataCenter, Final Fantasy VII (PAL, UK flag)" },
  "psxdc-SCES-00868": { url: "https://psxdatacenter.com/games/P/F/SCES-00868.html", sha256: "ba242b7cbff56d604d74fa3b8789403be597ceb2f8f9ca50f13fa1949d955780", what: "PSXDataCenter, Final Fantasy VII (PAL, French flag)" },
  "psxdc-SCES-00869": { url: "https://psxdatacenter.com/games/P/F/SCES-00869.html", sha256: "133bdb2c1abffb6a55b276d86dbf38f28cd875ee0a5976477725f5f966a8f504", what: "PSXDataCenter, Final Fantasy VII (PAL, German flag)" },
  "psxdc-SCES-00900": { url: "https://psxdatacenter.com/games/P/F/SCES-00900.html", sha256: "7b592bf12174ab9aed4bf33aa48c273a2d929c8ba11482f60282d3960c3cd6ff", what: "PSXDataCenter, Final Fantasy VII (PAL, Spanish flag)" },
  "psxdc-SCUS-94900": { url: "https://psxdatacenter.com/games/U/C/SCUS-94900.html", sha256: "474d62be5050029442b5562ee0646a3af2564a9d7de4857bfd0f51da201b2022", what: "PSXDataCenter, Crash Bandicoot (NTSC-U)" },
  "psxdc-SCES-00344": { url: "https://psxdatacenter.com/games/P/C/SCES-00344.html", sha256: "cf2890cb0efdc41d0d6d0b1701ee454e3a9540d6fcdeac53f17f31af00f3e0aa", what: "PSXDataCenter, Crash Bandicoot (PAL)" },
  "psxdc-SCPS-10031": { url: "https://psxdatacenter.com/games/J/C/SCPS-10031.html", sha256: "12530049153415f829ba97901fe89e21afc2de4e73a0fa3757f102e72a5dc8d5", what: "PSXDataCenter, Crash Bandicoot (NTSC-J)" },
  "psxdc-SCPS-91057": { url: "https://psxdatacenter.com/games/J/C/SCPS-91057.html", sha256: "3442ad046eadbcd983129da61ba292480f9a1d178af283ff606468cb8ca6479d", what: "PSXDataCenter, Crash Bandicoot [PlayStation the Best for Family]" },
  "psxdc-SLUS-00594": { url: "https://psxdatacenter.com/games/U/M/SLUS-00594.html", sha256: "2b29561f81fc265826c48e9e3f59101d30e3c51639efa0c28bce4332688f70ab", what: "PSXDataCenter, Metal Gear Solid (NTSC-U)" },
  "mariowiki-smb": { url: "https://www.mariowiki.com/Super_Mario_Bros.", sha256: "b8e07aea1d9e712eb5504a5e8739e46aaf14cf1589fa1a83eab0c0440c8f31f6", what: "MarioWiki, Super Mario Bros.: serial code list" },
  "wikipedia-smb": { url: "https://en.wikipedia.org/wiki/Super_Mario_Bros.", sha256: "1411b9b98593aa7818788770bc2d5c933335590d91c5599596ac5f5306f7f515", what: "Wikipedia, Super Mario Bros." },
  "wikipedia-zelda": { url: "https://en.wikipedia.org/wiki/The_Legend_of_Zelda_(video_game)", sha256: "2fb5e4abfb3e1507bc100f4ce0d931780950a05ade98c4501b1f6502c39e211e", what: "Wikipedia, The Legend of Zelda" },
};

/** NesCartDB's robots.txt refuses AI agents (ClaudeBot, anthropic-ai) and reserves its rights, so it wasn't re-read. */
export const NOT_REREAD = {
  "nescartdb-270": "https://nescartdb.com/profile/view/270",
  "nescartdb-490": "https://nescartdb.com/profile/view/490",
  "nescartdb-872": "https://nescartdb.com/profile/view/872",
};

/** The Wikidata items, checked on 2026-11-19 (label, instance of video game, platform). */
export const GAMES = [
  { key: "smb", qid: "Q11168", title: "Super Mario Bros.", platform: "nes" },
  { key: "zelda", qid: "Q12395", title: "The Legend of Zelda", platform: "nes" },
  { key: "smw", qid: "Q853143", title: "Super Mario World", platform: "snes" },
  { key: "alttp", qid: "Q370055", title: "The Legend of Zelda: A Link to the Past", platform: "snes" },
  { key: "smetroid", qid: "Q1194825", title: "Super Metroid", platform: "snes" },
  { key: "ff7", qid: "Q214232", title: "Final Fantasy VII", platform: "playstation" },
  { key: "crash", qid: "Q719176", title: "Crash Bandicoot", platform: "playstation" },
  { key: "mgs", qid: "Q6582527", title: "Metal Gear Solid", platform: "playstation" },
];

const NA = "snes-game-pak-na";
const JP_PAL = "snes-cartridge-jp-pal";
const cart = { media_count: 1, media_playability: "playable_from_media", packaging_code: "unknown" };
const standard = { edition_kind: "standard", edition_name: "Standard" };
const disc = (count) => ({ media_count: count, media_playability: "playable_from_media", packaging_code: "unknown" });
const day = (date) => ({ release_date: date, release_date_precision: "day" });

/**
 * Release candidates. `facts` is what the source states, `markets` the countries it
 * names (ISO 3166-1), `evidence` the saved pages, `basis` what an editor reads there.
 */
export const RELEASES = [
  // SNES / Super Famicom: SNES Central's cartridge label table documents each printed code,
  // its country and, in its notes, the edition. The shell follows the release's market.
  { id: "S1", game: "smw", platform: "snes", format: JP_PAL, region: "ntsc-j", class: "A", markets: ["JP"], evidence: ["snescentral-0000", "wikipedia-snes"],
    facts: { ...standard, ...cart, product_code: "SHVC-MW", publisher_name: "Nintendo" }, basis: "Japan, SHVC-MW, \"regular release\"" },
  { id: "S2", game: "smw", platform: "snes", format: NA, region: "ntsc-uc", class: "A", markets: ["US"], evidence: ["snescentral-0000", "wikipedia-snes"],
    facts: { ...standard, ...cart, product_code: "SNS-MW-USA", publisher_name: "Nintendo" }, basis: "USA, SNS-MW-USA, \"regular release\"" },
  { id: "S3", game: "smw", platform: "snes", format: NA, region: "ntsc-uc", class: "A", markets: ["US"], evidence: ["snescentral-0000", "wikipedia-snes"],
    facts: { ...standard, ...cart, product_code: "SNS-MW-USA-1", variant_name: "Two-line logo label", publisher_name: "Nintendo" }, basis: "USA, SNS-MW-USA-1, \"logo changed to be on two lines of text\": a label revision, not a reprint" },
  { id: "S4", game: "smw", platform: "snes", format: JP_PAL, region: "pal", class: "A", markets: ["DE"], evidence: ["snescentral-0000", "wikipedia-snes"],
    facts: { ...standard, ...cart, product_code: "SNSP-MW-NOE", publisher_name: "Nintendo" }, basis: "Germany (Nintendo of Europe), SNSP-MW-NOE, \"regular release\"" },
  { id: "S6", game: "smw", platform: "snes", format: JP_PAL, region: "pal", class: "A", markets: ["FR", "NL"], evidence: ["snescentral-0000", "wikipedia-snes"],
    facts: { ...standard, ...cart, product_code: "SNSP-MW-FAH-1", publisher_name: "Nintendo" }, basis: "France and Netherlands, SNSP-MW-FAH-1, \"first revision\"" },
  { id: "S7", game: "alttp", platform: "snes", format: JP_PAL, region: "ntsc-j", class: "A", markets: ["JP"], evidence: ["snescentral-0164", "wikipedia-snes"],
    facts: { ...standard, ...cart, product_code: "SHVC-ZL", publisher_name: "Nintendo" }, basis: "Japan, SHVC-ZL, \"regular release\"" },
  { id: "S8", game: "alttp", platform: "snes", format: NA, region: "ntsc-uc", class: "A", markets: ["US"], evidence: ["snescentral-0164", "wikipedia-snes"],
    facts: { ...standard, ...cart, product_code: "SNS-ZL-USA", publisher_name: "Nintendo" }, basis: "USA, SNS-ZL-USA, \"regular release\"" },
  { id: "S9", game: "alttp", platform: "snes", format: NA, region: "ntsc-uc", class: "A", markets: ["US"], evidence: ["snescentral-0164", "wikipedia-snes"],
    facts: { edition_kind: "reprint", edition_name: "Player's Choice", ...cart, product_code: "SNS-ZL-USA-1", publisher_name: "Nintendo" },
    basis: "USA, SNS-ZL-USA-1, \"Player's Choice Million Seller - \"K-A\" Rating\", with a label scan. The edition name is the source's spelling" },
  { id: "S11", game: "alttp", platform: "snes", format: JP_PAL, region: "pal", class: "A", markets: ["GB"], evidence: ["snescentral-0164", "wikipedia-snes"],
    facts: { ...standard, ...cart, product_code: "SNSP-ZL-UKV", publisher_name: "Nintendo" }, basis: "United Kingdom, SNSP-ZL-UKV, \"regular release\"" },
  { id: "S12", game: "alttp", platform: "snes", format: JP_PAL, region: "pal", class: "A", markets: ["DE"], evidence: ["snescentral-0164", "wikipedia-snes"],
    facts: { ...standard, ...cart, product_code: "SNSP-ZL-NOE/SFRG", publisher_name: "Nintendo" }, basis: "Germany (Nintendo of Europe), SNSP-ZL-NOE/SFRG, \"German language version\": the combined code is stored whole, as printed" },
  { id: "S13", game: "smetroid", platform: "snes", format: NA, region: "ntsc-uc", class: "A", markets: ["US"], evidence: ["snescentral-0885", "wikipedia-snes"],
    facts: { ...standard, ...cart, product_code: "SNS-RI-USA", publisher_name: "Nintendo" }, basis: "USA, SNS-RI-USA, \"regular release\"" },
  { id: "S14", game: "smetroid", platform: "snes", format: JP_PAL, region: "pal", class: "A", markets: ["FR", "NL"], evidence: ["snescentral-0885", "wikipedia-snes"],
    facts: { ...standard, ...cart, product_code: "SNSP-RI-FAH", publisher_name: "Nintendo" }, basis: "France and Netherlands, SNSP-RI-FAH, \"regular release\"" },
  { id: "S15", game: "smetroid", platform: "snes", format: JP_PAL, region: "pal", class: "A", markets: ["GB"], evidence: ["snescentral-0885", "wikipedia-snes"],
    facts: { ...standard, ...cart, product_code: "SNSP-RI-UKV", publisher_name: "Nintendo" }, basis: "United Kingdom, SNSP-RI-UKV, \"regular release\"" },

  // PlayStation: PSXDataCenter documents each disc set, its date and the barcode "From the
  // back cover", which is the package's. No package code is confirmed, so none is set.
  { id: "P1", game: "ff7", platform: "playstation", format: "cd-rom", region: "ntsc-j", class: "A", markets: [], evidence: ["psxdc-SLPS-00700"],
    facts: { ...standard, ...disc(3), ...day("1997-01-31"), barcode: "4961012967056" }, basis: "NTSC-J, discs SLPS-00700 to 00702, released 31 January 1997, back-cover barcode 4961012967056" },
  { id: "P2", game: "ff7", platform: "playstation", format: "cd-rom", region: "ntsc-uc", class: "A", markets: [], evidence: ["psxdc-SCUS-94163"],
    facts: { ...standard, ...disc(3), ...day("1997-08-15"), barcode: "711719416326" }, basis: "NTSC-U, discs SCUS-94163, 94164, 94165, released 15 August 1997, back-cover barcode 7 11719 41632 6. The M11b \"Black label\" variant isn't stated by the source and is dropped" },
  { id: "P9", game: "crash", platform: "playstation", format: "cd-rom", region: "ntsc-uc", class: "A", markets: [], evidence: ["psxdc-SCUS-94900"],
    facts: { ...standard, ...disc(1), ...day("1996-09-09"), barcode: "711719490029" }, basis: "NTSC-U, disc SCUS-94900, released 9 September 1996, back-cover barcode 711719490029. No \"Black label\" variant is stated" },
  { id: "P10", game: "crash", platform: "playstation", format: "cd-rom", region: "pal", class: "A", markets: [], evidence: ["psxdc-SCES-00344"],
    facts: { ...standard, ...disc(1), ...day("1996-11-15"), barcode: "711719627623" }, basis: "PAL, disc SCES-00344, released 15 November 1996, back-cover barcode 711719627623" },
  { id: "P11", game: "crash", platform: "playstation", format: "cd-rom", region: "ntsc-j", class: "A", markets: [], evidence: ["psxdc-SCPS-10031"],
    facts: { ...standard, ...disc(1), ...day("1996-12-06"), barcode: "4948872100311" }, basis: "NTSC-J, disc SCPS-10031, released 6 December 1996, back-cover barcode 4948872100311" },
  { id: "P12", game: "crash", platform: "playstation", format: "cd-rom", region: "ntsc-j", class: "A", markets: [], evidence: ["psxdc-SCPS-91057"],
    facts: { edition_kind: "reprint", edition_name: "PlayStation the Best for Family", ...disc(1), ...day("1998-05-28"), barcode: "4948872910576" },
    basis: "NTSC-J, \"Crash Bandicoot [Playstation the Best for Family]\", disc SCPS-91057, released 28 May 1998, back-cover barcode 4948872910576" },
  { id: "P13", game: "mgs", platform: "playstation", format: "cd-rom", region: "ntsc-uc", class: "A", markets: [], evidence: ["psxdc-SLUS-00594"],
    facts: { ...standard, ...disc(2), ...day("1998-10-21"), barcode: "083717170310" }, basis: "NTSC-U, discs SLUS-00594 and SLUS-00776, released 21 October 1998, back-cover barcode 083717170310" },

  // Staged candidates (B): entered for review with their gap, never verified in this pilot.
  { id: "P4", game: "ff7", platform: "playstation", format: "cd-rom", region: "pal", class: "B", markets: [], evidence: ["psxdc-SCES-00867"],
    facts: { ...standard, media_count: 3, ...day("1997-11-14"), barcode: "711719694328" },
    gap: "Four PAL packages (UK, French, German and Spanish flags) differ only by language and barcode. Without a confirmed package code they can't be told apart, so none is published", basis: "PAL, discs SCES-00867, 10867, 20867, released 14 November 1997, back-cover barcode 711719694328" },
  { id: "P5", game: "ff7", platform: "playstation", format: "cd-rom", region: "pal", class: "B", markets: [], evidence: ["psxdc-SCES-00868"],
    facts: { ...standard, media_count: 3, ...day("1997-11-14"), barcode: "711719694427" }, gap: "As P4: the package code", basis: "PAL, discs SCES-00868, 10868, 20868, released 14 November 1997, back-cover barcode 7 11719 69442 7" },
  { id: "P6", game: "ff7", platform: "playstation", format: "cd-rom", region: "pal", class: "B", markets: [], evidence: ["psxdc-SCES-00869"],
    facts: { ...standard, media_count: 3, ...day("1997-11-17"), barcode: "711719694526" }, gap: "As P4: the package code", basis: "PAL, discs SCES-00869, 10869, 20869, released 17 November 1997, back-cover barcode 711719694526 (the page lists 711719737025 for the Platinum re-release separately)" },
  { id: "P7", game: "ff7", platform: "playstation", format: "cd-rom", region: "pal", class: "B", markets: [], evidence: ["psxdc-SCES-00900"],
    facts: { ...standard, media_count: 3, ...day("1997-11-14"), barcode: "711719694625" }, gap: "As P4: the package code", basis: "PAL, discs SCES-00900, 10900, 20900, released 14 November 1997, back-cover barcode 711719694625" },
  { id: "N1", game: "smb", platform: "nes", format: "famicom-cartridge", region: "ntsc-j", class: "B", markets: [], evidence: ["mariowiki-smb"],
    facts: { ...standard, media_count: 1, product_code: "HVC-SM" }, gap: "The code is from a wiki list, not an item page", basis: "MarioWiki serial codes: Family Computer HVC-SM" },
  { id: "N2", game: "smb", platform: "famicom-disk-system", format: "famicom-disk-card", region: "ntsc-j", class: "B", markets: [], evidence: ["mariowiki-smb"],
    facts: { media_count: 1, product_code: "FMC-SMA" }, gap: "The code is from a wiki list, and the edition isn't established", basis: "MarioWiki serial codes: Family Computer Disk System FMC-SMA" },
  { id: "N3", game: "smb", platform: "nes", format: "nes-game-pak", region: "ntsc-uc", class: "B", markets: [], evidence: ["wikipedia-smb"],
    facts: { ...standard, media_count: 1, product_code: "NES-SM-USA" }, gap: "Class A in M11b from NesCartDB 270, which refuses AI agents and wasn't re-read: a person re-reads it before verifying", basis: "NesCartDB 270 (M11b-0, 2026-11-18); MarioWiki lists NES-SM" },
  { id: "N5", game: "smb", platform: "nes", format: "nes-game-pak", region: "pal", class: "B", markets: [], evidence: ["mariowiki-smb"],
    facts: { ...standard, media_count: 1, product_code: "NES-SM-AUS" }, gap: "The code is from a wiki list, not an item page", basis: "MarioWiki serial codes: NES-SM-AUS" },
  { id: "N7", game: "zelda", platform: "nes", format: "nes-game-pak", region: "ntsc-uc", class: "B", markets: [], evidence: ["wikipedia-zelda"],
    facts: { ...standard, media_count: 1, product_code: "NES-ZL-USA", variant_name: "Gold cartridge" }, gap: "Class A in M11b from NesCartDB 490 and 872, which refuse AI agents and weren't re-read", basis: "NesCartDB 490 and 872 (M11b-0, 2026-11-18)" },
];

/** Held (H): not entered. */
export const HELD = [
  { id: "N4", summary: "Super Mario Bros., NES PAL", reason: "The code conflicts (NES-P-SM on MarioWiki, NES-SM-EEC only in a search snippet)" },
  { id: "N6", summary: "The Legend of Zelda, Famicom Disk System", reason: "The code FMC-ZEL was seen only in a snippet" },
  { id: "N8", summary: "The Legend of Zelda, NES Classic Series", reason: "No code" },
  { id: "N9", summary: "The Legend of Zelda, NES PAL", reason: "No code or country package" },
  { id: "N10", summary: "The Legend of Zelda, Famicom cartridge (1994)", reason: "No code" },
  { id: "S5", summary: "Super Mario World, PAL UK", reason: "SNES Central lists \"SNS-MW-UKV\", whose missing P may be a source error" },
  { id: "S10", summary: "A Link to the Past, Player's Choice \"E\" rating (SNS-ZL-USA-2)", reason: "Newly held in M12c-A: SNES Central lists it with \"scan needed\", so no item-level copy backs it" },
  { id: "P3", summary: "Final Fantasy VII, US Greatest Hits", reason: "The package is shown only by cover images filed under the original serial" },
  { id: "P8", summary: "Final Fantasy VII, PAL Platinum", reason: "The package isn't confirmed. The bonus disc is SCED-02062 on the German page (M11b recorded SCED-20062), a conflict to resolve" },
];

/** The reason an editor writes when creating a release: the evidence, read and saved. */
export function creationReason(release) {
  // Reasons are at most 500 characters: the sources and the gap are kept whole, and the
  // description of what was read is shortened if it must be (the full text is above).
  const pages = release.evidence.map((k) => `${EVIDENCE[k].url} [sha256 ${EVIDENCE[k].sha256.slice(0, 12)}]`).join("; ");
  const gap = release.gap ? ` Gap: ${release.gap}.` : "";
  const packaging = release.facts.packaging_code === "unknown" ? " Packaging not stated by the source: unknown." : "";
  const head = `M12c-A ${release.id}, read ${EVIDENCE_DATE}: `;
  const tail = `. Source: ${pages}.${packaging}${gap}`;
  const room = 500 - head.length - tail.length;
  const basis = release.basis.length <= room ? release.basis : `${release.basis.slice(0, Math.max(0, room - 1))}…`;
  return `${head}${basis}${tail}`;
}
