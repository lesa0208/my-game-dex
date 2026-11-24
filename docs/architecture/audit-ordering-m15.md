# Audit event ordering (M15)

Migration `20261214100000_m15_audit_ordering`. Rollback in
`supabase/rollbacks/20261214100000_m15_audit_ordering.rollback.sql`. Tests:
`supabase/tests/database/57_m15_audit_ordering.test.sql`, plus one assertion each in 14, 36, 39
and 55.

Required before the first real editorial decision on the SNES pilot. Its review trail and record
histories list events that one transaction writes together.

## The defect

`private.audit_events` had two candidate ordering keys, and neither orders events written together:

- `occurred_at` defaults to `now()`, the transaction's start time, so every event a transaction
  writes has the same value.
- `id` is `private.uuid_v7()`: 48 bits of `clock_timestamp()` in milliseconds, then random bits.
  Two ids written in the same millisecond sort in a random order. A UUIDv7 id is not evidence of
  insertion order.

Several operations write more than one event in one transaction:

- `approve_review_batch` writes three for each member: the game verified, the pairing verified and
  the game published, all with `metadata.id` = the game. It also writes the approval events.
- `publish_game_identity`, `publish_release`, the import's apply and reclassify steps, and
  `resubmit_my_submission` each write two.
- `close_owner_designations` writes one for each designation it closes.
- Any staff action and its refusal record, when both happen in one call.

So the readers' orders were arbitrary within a millisecond:

| Reader | Old order | What it showed |
| --- | --- | --- |
| `get_review_batch_member` → `trail` | `(occurred_at, id)` | The outcome trail, oldest first. Two outcomes in one transaction could come out reversed. This was pgTAP 55 #101, which failed intermittently. |
| `get_catalog_record_history` | `id desc`, cursor `id < p_before` | A game's history after a batch approval: "published" could come before "verified" |
| `get_audit_log` | `id desc`, cursor `id < p_before` | The administrators' log |
| `get_account_summary` | `id desc` | The history and the *last* status change |
| `get_staff_overview` | `id desc` | Recent staff changes |

In production each review outcome is its own call and transaction, so the trail's own events were
rarely tied. Approval's many events per transaction are the real case.

Unchanged:

- `private.legacy_catalog_origin` orders a record's single creation event by id.
- `get_admin_overview` and `last_staff_action_at` use counts and `max(occurred_at)` only.
- Existence checks don't depend on order.

## The fix

- **The key.** A `seq bigint` column comes from its own sequence, `private.audit_events_seq`.
  The sequence starts at 1, never cycles and is owned by the column.
- **Assignment.** A `BEFORE INSERT` trigger, `audit_events_assign_seq`, sets `seq` on every new
  row and replaces any value the writer supplies. The number comes from PostgreSQL, never from the
  application.
- **Constraints.**
  - `audit_events_seq_positive` is `check (seq > 0)`.
  - `audit_events_seq_recorded` is `check (seq is not null)`, created `NOT VALID`. It is enforced
    for every new row and never validated against the older ones.
  - `audit_events_seq_key` makes `seq` unique.
- **Index.** `audit_events_chronological_idx` is on `(occurred_at, coalesce(seq, 0), id)` and
  serves both directions.
- **Order.** Every listed reader orders by `(occurred_at, coalesce(seq, 0), id)`: ascending for
  oldest first, all three descending for newest first.

### The guarantee

1. **Events one transaction writes are listed in the order they were written.** They share
   `occurred_at`, and each `nextval()` returns more than every earlier call.
2. **Events of different transactions are listed by `occurred_at`, the transaction's start time,
   as before.** That is not commit order: no column here is commit order (see
   [Audit log](security-rls.md#audit-log)). Two transactions that start in the same microsecond are
   listed in insertion order.
3. **`seq` is insertion order, not commit order.**
   - A transaction can take a higher `seq` and commit before one holding a lower `seq`.
   - Sequences aren't transactional, so a rolled-back write leaves a gap.
   - Nothing may rely on `seq` being gap-free or a count.
4. **Events recorded before the migration keep `seq` null.** No number is made up for them.
   - Among themselves they keep the old order, `(occurred_at, id)`. Events one old transaction
     wrote in the same millisecond keep an order that is arbitrary but stable, and their real order
     can't be recovered.
   - At the same `occurred_at`, an event without `seq` sorts before one with it (`coalesce(seq, 0)`,
     and `seq` starts at 1). One transaction can't write both kinds: `ALTER TABLE` takes an
     ACCESS EXCLUSIVE lock, which waits for every transaction that has written to the table.

The stress rehearsal is described under [Rehearsal](#rehearsal-2026-11-24). The id order would have
scrambled 1,100 of its 1,200 transactions; the new order lists all of them in write order.

### Append-only, privileges and writers

- **Rows.** The column is added without a default, so the change is catalog-only: no row is
  rewritten or updated, and the `UPDATE`, `DELETE` and `TRUNCATE` triggers never fire. `seq` can't
  be changed later, because the append-only trigger refuses any `UPDATE`.
- **Privileges.** No API role, `catalog_importer` or `PUBLIC` has any privilege on the sequence, the
  trigger function or the table (as before). Only the owner, `postgres`, can use the sequence.
  `03_schema_guards` checks every new sequence's grants, and `01_foundation` lists this one by name.
- **Writers** are unchanged. Every insert still goes through `private.record_audit()` (directly or
  through `record_catalog_audit`, `record_refusal` and `import_audit`) in the caller's transaction,
  as `postgres`, which owns the sequence. A failed audit write still fails, and so rolls back, the
  action it records. The 23 database suites, the importer's included, pass unchanged.

### Paging and cursors

`get_audit_log` and `get_catalog_record_history` keep their signatures, results and cursor: the id
of the last event seen (`next_before` for the history). The server resolves the cursor to that
event's `(occurred_at, seq, id)`. The page then holds the events after it, in the same total order
the list uses, so no event is repeated or skipped between pages. The app's "Older" links and
`getRecordHistory` are unchanged.

Two behaviours differ, both tested:

- **A cursor that names no audit event** now returns an empty page. Before, it was compared as a
  uuid. The app only passes ids it was given, and audit events are never deleted.
- **Order across transactions** is by time, not id. They differ only for events whose id and time
  disagree: a long transaction's events, or fabricated test rows such as test 39's 400-day-old
  `e009`.

As before, an event committed after a page was read, with a key before the cursor, appears only
when the list is read again from the start.

## Rehearsal (2026-11-24)

All of this ran on the disposable scratch stack only.

**A fresh database with all 83 migrations:**

- pgTAP: 57 files and 4478 assertions pass. The baseline was raised from 56 and 4432.
- All 23 database suites pass.
- App checks pass: admin 198/198, review-batch 116/116, publication 107/107.
- Tests 55 and 57 ran 25 times each: 4000 assertions, 0 failures.

**The new tests catch the defect.** Run against the old readers, 16 assertions in 57 fail, plus
55's forced tie and 39's time-order check. The tie tests give events written together ids in the
reverse of their insertion order, so they're deterministic. They use no sleeps and no luck.

**Concurrency stress.** 8 sessions wrote 1,200 transactions of 5 events each, with `seq` ranges
interleaved across 1,177 of them.

- No `seq` is null or duplicated.
- Every transaction is listed in write order.
- The old id order would have scrambled 1,100 of them.

**A restored copy of the 82-migration schema with its existing audit rows.** This was development's
data: a read-only `pg_dump`, restored as `supabase_admin` into an empty database owned by
`postgres` on scratch.

- **The migration applied in about 2 ms:**
  - The 156 rows are byte-identical over the original columns.
  - The relfilenode is unchanged, so the table wasn't rewritten.
  - Every row has `seq` null.
  - Only the five readers' bodies changed, plus one new function. Grants, owners, RLS and
    policies were identical.
- **New events** got 5, 6, 7 in one transaction, with gaps where rolled-back probes had taken
  numbers. A supplied `seq` was replaced.
- **Protections still held:**
  - `UPDATE`, `DELETE` and `TRUNCATE` were refused.
  - An insert with triggers off was refused by the NOT VALID check.
  - `authenticated` and `service_role` couldn't use the sequence.
- **The rollback** restored every function body, grant and object: the security and schema
  inventories were identical to before. The historical rows were unchanged.
- **Re-applying, then dump and restore:**
  - All the null `seq` values came back null, and the new ones came back unchanged.
  - The check stayed NOT VALID: `pg_dump` emits it after the data.
  - The trigger is created after the data load, so restored rows keep their numbers, and the
    sequence carried on.

## Migration and recovery

**Applying.** Apply it like any migration: to a stack's database, after that stack's usual backup
(development: a dump and a cold volume snapshot, see the backup notes). It takes a brief ACCESS
EXCLUSIVE lock on `audit_events` and changes no rows.

- A pilot created from `main` after this is merged has it from the start.
- Development, the persistent test stack and B1 get it only when that is separately authorized.

**Rolling back.** Run the rollback script in one transaction (`psql -1`) on a backed-up database,
then delete the migration's row from `supabase_migrations.schema_migrations`.

- It removes no audit row.
- It loses the recorded order of events written together since the migration: they sort by
  `(occurred_at, id)` again.
- It was tested only on disposable databases. It has never been run on a persistent one.

**Restoring.**

- **A full dump restores correctly** into an empty database, as above.
- **A data-only restore into a schema that already has this migration** fails for older rows: the
  NOT VALID check refuses their null `seq`. Restore the whole database instead, as the backup notes
  already require.
- **A data-only load with the trigger enabled** would renumber every row. Never load audit rows that
  way.
