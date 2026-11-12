-- M7a review fix: a submitter can't tell whether their submission made a platform
-- pairing or reused someone else's hidden one.
--
-- A game's pairing with a platform is one row, shared by every release on it. A
-- submission reuses an existing pairing, whatever its status or whoever made it, and
-- answers the same either way. But the M5 read policy let a submitter read the
-- unpublished pairings they made: after submitting a release on a new platform of a
-- published game, seeing the pairing meant theirs was new, and not seeing it meant
-- someone else's hidden pairing was there first.
--
-- Unpublished pairings are now read only by catalog editors. A submitter reads their
-- release, which names its platform, so nothing they use needs the pairing row.
-- Unpublished games and releases are always the submitter's own, so their policies
-- stay as they are.

alter policy game_platforms_read_authenticated on public.game_platforms
  using (
    status = 'published'
    or (select private.is_catalog_editor())
  );
