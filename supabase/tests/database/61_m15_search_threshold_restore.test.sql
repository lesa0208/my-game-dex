-- Collector fast add: catalog search survives a connection's second search
-- (migration 20261218100000).
--
-- search_catalog saves the pg_trgm thresholds and sets them back. On a connection whose
-- searches so far needed no fuzzy matching, pg_trgm's library isn't loaded, and a threshold
-- set locally leaves an empty placeholder once its transaction ends. The next search saved
-- that '' and, with the library loaded by then, setting it back failed.
--
-- So this file is not one transaction: each search below commits on its own, as on a pooled
-- connection, and nothing before them in this connection uses pg_trgm. It only reads; pgTAP
-- keeps its plan in temporary tables, which last for the connection.

select plan(6);

select lives_ok(
  $$select public.search_catalog(null, array['snes'])$$,
  'a platform browse first, which needs no fuzzy matching'
);
select lives_ok(
  $$select public.search_catalog('starfall odyssey', null)$$,
  'then, in the next transaction, a title search, which does: no "invalid value for parameter"'
);
select lives_ok(
  $$select public.search_catalog('ab', null)$$,
  'and a short query after it'
);
select lives_ok(
  $$select public.search_catalog('slus 01999', array['playstation'])$$,
  'and a code on a platform'
);

select is(
  (select proacl::text from pg_proc where oid = 'public.search_catalog(text,text[],integer,text)'::regprocedure),
  '{postgres=X/postgres,anon=X/postgres,authenticated=X/postgres}',
  'the function keeps its grants: anyone may search the public catalog'
);
select ok(
  (select prosecdef and proconfig @> array['search_path=""'] from pg_proc where oid = 'public.search_catalog(text,text[],integer,text)'::regprocedure),
  'and its security definer and empty search path'
);

select * from finish();
