/**
 * A throwaway Owner for the check scripts (M8c). Owner authority needs two verified
 * TOTP factors registered at least 24 hours ago (D13). The checks can't wait a day,
 * so, as postgres, they record the registrations as 25 hours old: something only a
 * database owner can do, since register_my_verified_factors() always uses now().
 *
 * The Owner record is permanent by design, so removing the test Owner disables the
 * record's guard inside one transaction, again as only a database owner can.
 * Nothing here prints; secrets stay in memory.
 */
import { addFactor } from "./mfa-session.mjs";

/** Exits if the stack already has an Owner, which the checks would otherwise disturb. */
export function requireNoOwner(psql) {
  if (psql("select count(*) from private.platform_owner;") !== "0") {
    console.error("This local stack already has an Owner. These checks assign and remove a test Owner, so they need a stack without one.");
    process.exit(1);
  }
}

/** Registers every verified TOTP factor of the user as 25 hours old. */
export function matureFactors(psql, userId) {
  psql(`delete from private.mfa_factor_registrations where user_id = '${userId}';
insert into private.mfa_factor_registrations (factor_id, user_id, factor_created_at, registered_at)
select f.id, f.user_id, f.created_at, now() - interval '25 hours' from auth.mfa_factors f
where f.user_id = '${userId}' and f.factor_type = 'totp' and f.status = 'verified';`);
}

/**
 * Gives an elevated session's user a second factor and assigns them as the Owner with
 * the operator procedure, then matures their factors. Returns the session that the
 * second verification issued, for the caller's requests.
 */
export async function makeTestOwner(psql, { api, anonKey, session, handle, userId }) {
  const second = await addFactor(api, anonKey, session, "Second factor");
  psql(`select private.assign_initial_owner('${handle}', 'Test owner, removed after the checks');`);
  matureFactors(psql, userId);
  return second;
}

/** Removes the test Owner record, and any transfer or recovery left over. */
export function removeTestOwner(psql) {
  psql(`begin;
alter table private.platform_owner disable trigger platform_owner_guard;
delete from private.platform_owner;
alter table private.platform_owner enable trigger platform_owner_guard;
delete from private.ownership_transfers;
delete from private.owner_recoveries;
commit;`);
}
