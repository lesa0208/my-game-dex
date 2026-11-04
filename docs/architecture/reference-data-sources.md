# Reference data sources

**Written for:** anyone correcting M1 reference data. It records where the seed came from and how far to trust it.

Corrections are forward migrations keyed by code or slug, so they never rewrite history. Uncertain facts stay null or go in `platforms.notes`, and are never invented.

## How far to trust this

Platform data was checked in November 2026 against the sources below, using a tool that returns extracts of each page rather than the raw page, and long articles were only partly read. **Most rows rest on English Wikipedia alone.** Sega Retro, NEC Retro, Nintendo Life, ConsoleMods and others blocked access. Treat the seed as checked rather than authoritative, and correct it through catalog review.

## Region codes

The 11 values are the product owner's approved decision (D7). They aren't derived from an external source, and no country mapping exists.

## Markets

- **Codes:** the 249 officially assigned ISO 3166-1 alpha-2 codes, taken from the `i18n-iso-countries` npm package and cross-checked against Unicode CLDR through Node's `Intl.DisplayNames`. The package isn't a project dependency.
- **Left out:** `XK` (Kosovo), which is user-assigned rather than officially ISO-assigned. Add it if a release needs it.
- **Names:** English short names from CLDR, with explicit corrections where the short form was unsuitable, such as `US` and `GB`.

## Platforms

| Group | Main sources |
| --- | --- |
| Nintendo | [NES](https://en.wikipedia.org/wiki/Nintendo_Entertainment_System), [Disk System](https://en.wikipedia.org/wiki/Famicom_Disk_System), [SNES](https://en.wikipedia.org/wiki/Super_Nintendo_Entertainment_System), [64DD](https://en.wikipedia.org/wiki/64DD), [optical discs](https://en.wikipedia.org/wiki/Nintendo_optical_discs), [game cards](https://en.wikipedia.org/wiki/Nintendo_Game_Card), [NESdev connectors](https://www.nesdev.org/wiki/Cartridge_connector), [Korean consoles](https://hardcoregaming101.net/korea/appendix-consoles.htm), [Nintendo's Game-Key Card overview](https://en-americas-support.nintendo.com/app/answers/detail/a_id/68415/~/nintendo-switch%202-game-key-card-overview) |
| Sega | [SG-1000](https://en.wikipedia.org/wiki/SG-1000), [Sega Card](https://en.wikipedia.org/wiki/Sega_Card), [Master System](https://en.wikipedia.org/wiki/Master_System), [Genesis](https://en.wikipedia.org/wiki/Sega_Genesis), [Sega CD](https://en.wikipedia.org/wiki/Sega_CD), [32X](https://en.wikipedia.org/wiki/32X), [Saturn](https://en.wikipedia.org/wiki/Sega_Saturn), [Dreamcast](https://en.wikipedia.org/wiki/Dreamcast), [Game Gear](https://en.wikipedia.org/wiki/Game_Gear), [regional lockout](https://en.wikipedia.org/wiki/Regional_lockout) |
| NEC | [TurboGrafx-16](https://en.wikipedia.org/wiki/TurboGrafx-16), [SuperGrafx](https://en.wikipedia.org/wiki/PC_Engine_SuperGrafx), [PC-FX](https://en.wikipedia.org/wiki/PC-FX) |
| Sony | [PlayStation](https://en.wikipedia.org/wiki/PlayStation_(console)), [PS2](https://en.wikipedia.org/wiki/PlayStation_2), [PS5 specifications](https://blog.playstation.com/2020/03/18/unveiling-new-details-of-playstation-5-hardware-technical-specs/), [PSP](https://en.wikipedia.org/wiki/PlayStation_Portable), [Vita cards](https://manuals.playstation.net/document/en/psvita/game/game_card.html) |
| Microsoft | [Xbox](https://en.wikipedia.org/wiki/Xbox_(console)), [Xbox 360](https://en.wikipedia.org/wiki/Xbox_360_technical_specifications), [Xbox One](https://en.wikipedia.org/wiki/Xbox_One), [Series X and S](https://en.wikipedia.org/wiki/Xbox_Series_X_and_Series_S), [GamesRadar on discs](https://www.gamesradar.com/au/xbox-series-x-discs-compatible) |
| Atari | [2600](https://en.wikipedia.org/wiki/Atari_2600), [5200](https://en.wikipedia.org/wiki/Atari_5200), [7800](https://en.wikipedia.org/wiki/Atari_7800), [Atari Archive on the 7800](https://www.atariarchive.org/?p=211), [Lynx](https://en.wikipedia.org/wiki/Atari_Lynx), [Jaguar](https://en.wikipedia.org/wiki/Atari_Jaguar), [Jaguar CD](https://en.wikipedia.org/wiki/Atari_Jaguar_CD) |
| SNK | [Neo Geo](https://en.wikipedia.org/wiki/Neo_Geo_(system)), [Famitsu on the home release](https://www.famitsu.com/news/202007/01201338.html), [Neo Geo CD](https://en.wikipedia.org/wiki/Neo_Geo_CD), [Pocket Color](https://en.wikipedia.org/wiki/Neo_Geo_Pocket_Color) |
| Others | [WonderSwan](https://en.wikipedia.org/wiki/WonderSwan), [3DO](https://en.wikipedia.org/wiki/3DO_Interactive_Multiplayer), [CD-i](https://en.wikipedia.org/wiki/CD-i), [Intellivision](https://en.wikipedia.org/wiki/Intellivision), [ColecoVision](https://en.wikipedia.org/wiki/ColecoVision), [Odyssey²](https://en.wikipedia.org/wiki/Magnavox_Odyssey_2), [Vectrex](https://en.wikipedia.org/wiki/Vectrex), [Channel F](https://en.wikipedia.org/wiki/Fairchild_Channel_F) |

## Known uncertainty

| Item | Status |
| --- | --- |
| Xbox Series X\|S game discs | Recorded as Ultra HD Blu-ray from secondary sources. No Microsoft specification was found |
| Neo Geo AES | 1990 is first availability in Japan, initially through rental. General retail in Japan began July 1, 1991. North American date unverified |
| Atari 7800 | 1984 test market disputed, so 1986 is recorded |
| Nintendo 64DD | Day of release conflicts. Year is 1999. No distinct official name for the disk format was found |
| Dreamcast | Korean release and MIL-CD game discs not confirmed, so only GD-ROM is linked |
| Regional names | Many Korean and Brazilian names rest on one source. Some aliases, such as CBS ColecoVision, have no clear region, so it stays null |
| Proprietary disc names | "Wii Optical Disc" and "Wii U Optical Disc" come from Wikipedia. Nintendo's consumer support says "Game Disc" |

## Hardware requirements

| Requirement | Sources | Confidence |
| --- | --- | --- |
| DSi family | [Game cards](https://en.wikipedia.org/wiki/Nintendo_Game_Card), [DSi](https://en.wikipedia.org/wiki/Nintendo_DSi) | Rule high, example list incomplete |
| New 3DS family | [Xenoblade Chronicles 3D](https://www.nintendo.com/en-gb/News/2015/April/In-shops-and-on-Nintendo-eShop-now-Xenoblade-Chronicles-3D-982289.html), [Fire Emblem Warriors](https://nintendo.com/en-gb/Games/New-Nintendo-3DS/Fire-Emblem-Warriors-1175329.html) | High |
| Genesis 3 | [Virtua Racing](https://en.wikipedia.org/wiki/Virtua_Racing) | High for this title |
| Super CD-ROM² and Arcade Card | [TurboGrafx-16](https://en.wikipedia.org/wiki/TurboGrafx-16), [Dengeki guide, 1994](https://archives.tg-16.com/Dengeki_PC_Engine_1994_03.htm) | Rule high, some titles conflict |
| N64 Expansion Pak | [Accessories](https://en.wikipedia.org/wiki/Nintendo_64_accessories) | High |
| Saturn RAM cartridges | [King of Fighters '97](https://en.wikipedia.org/wiki/The_King_of_Fighters_%2797), [X-Men vs. Street Fighter](https://en.wikipedia.org/wiki/X-Men_vs._Street_Fighter) | High for these titles |
| Game Boy classification | [Pan Docs cartridge header](https://gbdev.io/pandocs/The_Cartridge_Header), [Game Boy Color](https://en.wikipedia.org/wiki/Game_Boy_Color) | High for the technical flag |

The header value in Pan Docs is technical evidence about the software, and it doesn't settle a physical edition's primary platform on its own. Editorial rules are in [ADR-035](architecture-decisions.md#adr-035-game-boy-classification-follows-the-physical-edition).
