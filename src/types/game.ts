/**
 * The catalog keeps three concepts separate, and they must stay separate when
 * the database schema arrives:
 *
 * - Game: the underlying video game.
 * - Release: a specific platform and physical edition of a game.
 * - CollectionItem: one physical copy owned by one collector.
 */

export type Platform = {
  id: string;
  name: string;
  shortName: string;
};

export type Game = {
  id: string;
  title: string;
};

export type ReleaseRegion = "NA" | "EU" | "JP";

export type Release = {
  id: string;
  game: Game;
  platform: Platform;
  region: ReleaseRegion;
  year: number;
  edition?: string;
  coverUrl: string;
};

export type ItemCompleteness = "loose" | "complete" | "sealed";

export type CollectionItem = {
  release: Release;
  completeness: ItemCompleteness;
};
