-- Integrity inventory (fingerprint), as used for every persistent-database activation since M14a. Read only.
\pset format unaligned
\pset tuples_only on
select n.nspname || '.' || c.relname || ' ' ||
  (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', n.nspname, c.relname), false, true, '')))[1]::text || ' ' ||
  (xpath('/row/h/text()', query_to_xml(format('select md5(coalesce(string_agg(t::text, E''\n'' order by t::text), '''')) as h from %I.%I t', n.nspname, c.relname), false, true, '')))[1]::text
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname in ('public', 'private', 'auth', 'storage', 'supabase_migrations') and c.relkind in ('r', 'p')
order by 1;
