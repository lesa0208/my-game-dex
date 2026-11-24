-- Integrity inventory (acl), as used for every persistent-database activation since M14a. Read only.
set search_path to pg_catalog;
\pset format unaligned
\pset tuples_only on
select 'rel ' || n.nspname || '.' || c.relname || ' ' || pg_get_userbyid(c.relowner) || ' ' || coalesce(c.relacl::text, '-') || ' rls=' || c.relrowsecurity
from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname in ('public', 'private') and c.relkind in ('r', 'p', 'v') order by 1;
select 'fn ' || p.oid::regprocedure::text || ' ' || pg_get_userbyid(p.proowner) || ' ' || coalesce(p.proacl::text, '-') || ' definer=' || p.prosecdef || ' ' || md5(p.prosrc)
from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'private') order by 1;
select 'policy ' || schemaname || '.' || tablename || '.' || policyname || ' ' || cmd || ' ' || array_to_string(roles, ',') || ' ' || md5(coalesce(qual, '') || coalesce(with_check, '')) from pg_policies where schemaname in ('public', 'private') order by 1;
