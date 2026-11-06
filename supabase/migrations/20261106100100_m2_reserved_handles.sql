-- M2 Identity: reserved names.
--
-- 'exact' blocks a name and its lookalikes, while leaving longer names free, so
-- badminton_fan remains valid. 'contains' is only for platform brand terms.
-- Corrections are later forward migrations.

insert into private.handle_holds (handle, kind, match) values
  -- Platform brand: blocked anywhere in a handle or display name
  ('mygamedex', 'reserved', 'contains'),
  ('gamedex', 'reserved', 'contains'),

  -- Staff and system identities
  ('admin', 'reserved', 'exact'),
  ('administrator', 'reserved', 'exact'),
  ('root', 'reserved', 'exact'),
  ('system', 'reserved', 'exact'),
  ('staff', 'reserved', 'exact'),
  ('moderator', 'reserved', 'exact'),
  ('mod', 'reserved', 'exact'),
  ('support', 'reserved', 'exact'),
  ('help', 'reserved', 'exact'),
  ('security', 'reserved', 'exact'),
  ('official', 'reserved', 'exact'),
  ('team', 'reserved', 'exact'),
  ('owner', 'reserved', 'exact'),
  ('legal', 'reserved', 'exact'),
  ('privacy', 'reserved', 'exact'),
  ('terms', 'reserved', 'exact'),
  ('abuse', 'reserved', 'exact'),
  ('postmaster', 'reserved', 'exact'),
  ('webmaster', 'reserved', 'exact'),
  ('noreply', 'reserved', 'exact'),

  -- Routes and technical names
  ('home', 'reserved', 'exact'),
  ('explore', 'reserved', 'exact'),
  ('collection', 'reserved', 'exact'),
  ('community', 'reserved', 'exact'),
  ('notifications', 'reserved', 'exact'),
  ('messages', 'reserved', 'exact'),
  ('profile', 'reserved', 'exact'),
  ('settings', 'reserved', 'exact'),
  ('login', 'reserved', 'exact'),
  ('logout', 'reserved', 'exact'),
  ('signin', 'reserved', 'exact'),
  ('signup', 'reserved', 'exact'),
  ('register', 'reserved', 'exact'),
  ('account', 'reserved', 'exact'),
  ('api', 'reserved', 'exact'),
  ('auth', 'reserved', 'exact'),
  ('www', 'reserved', 'exact'),
  ('null', 'reserved', 'exact'),
  ('undefined', 'reserved', 'exact'),
  ('anonymous', 'reserved', 'exact'),
  ('deleted', 'reserved', 'exact'),
  ('unknown', 'reserved', 'exact');
