-- Integrity inventory (schemas), as used for every persistent-database activation since M14a. Read only.
\pset format unaligned
\pset tuples_only on
select 'database ' || current_database() || ' owner ' || pg_get_userbyid(datdba) || ' ' || coalesce(datacl::text, '-') from pg_database where datname = current_database();
select 'schema ' || nspname || ' ' || pg_get_userbyid(nspowner) || ' ' || coalesce(nspacl::text, '-') from pg_namespace where nspname !~ '^pg_(toast|temp)' order by 1;
select 'extension ' || extname || ' ' || extversion || ' ' || extnamespace::regnamespace from pg_extension order by 1;
select 'default acl ' || pg_get_userbyid(defaclrole) || ' ' || coalesce(defaclnamespace::regnamespace::text, '*') || ' ' || defaclobjtype::text || ' ' || defaclacl::text from pg_default_acl order by 1;
