# Ended sessions and the password-change policy — analysis (M11a-4a)

**Status: option A implemented** in the M11a session-revocation checkpoint ([security-rls.md § Ended sessions](security-rls.md#ended-sessions-m11a), [ADR-067](architecture-decisions.md#adr-067-a-signed-in-request-must-belong-to-a-session-auth-still-has)); **the password policy was verified locally,** and enabling it on the hosted project remains a launch prerequisite. The analysis below is kept as written in M11a-4a; section 5 records what the checkpoint found. Behaviour cited as observed was measured on the local test stack (GoTrue v2.197.0) in M11a-2, M11a-3 and M11a-4a.

## 1. Ended sessions still write

**Observed.** After "sign out on all devices", a password reset or a password change, Auth deletes the other sessions' rows in `auth.sessions` and refuses their refresh tokens (`refresh_token_not_found`) and access tokens at `/auth/v1/user` (`session_not_found`). But an access token is an ES256 JWT that PostgREST and the app (`getClaims`) verify by signature only, so until it expires (`jwt_expiry` = 3,600 s) it still:

- reads the owner's own rows, including private purchase data (owner-only RLS uses `auth.uid()` only);
- performs collector writes: copies, private details, blocks, profile name and bio (all gated by `private.is_active_user()`, which checks the account, not the session).

Already refused at once: every staff function (`mfa_session_ok` looks up the session row), photo changes (the workflow asks Auth), and the data export (asks Auth, M11a-4a).

**Is the session id trustworthy and available?** Yes. Every access token GoTrue issues carries `session_id` (and `aal`), it is covered by the signature, and `mfa_session_ok` has relied on it since M8b. `auth.sessions.id` is its primary key. A token can't name another session without breaking the signature.

## 2. Options

| Option | What it closes | Cost and risk |
| --- | --- | --- |
| **A. Check the session in `is_active_user()`** (recommended) | Every collector write and every function that calls the helper, immediately | One primary-key lookup per statement (the collection policies already wrap the helper in `(select …)`, so it runs once per statement, not per row). Measured: about 6 µs, the same as the helper's current body. Touches the most shared helper: needs the full suite |
| B. Also gate owner reads of private data | Revoked tokens reading purchase prices, notes, locations for up to an hour | A session check in `collection_item_private` (and similar) select policies; more surface. Can follow A |
| C. Shorten `jwt_expiry` (e.g. 300 s) | Shrinks the window for everything, reads included | More refreshes (each a request to Auth); doesn't make it zero; a hosted setting |
| D. Check in the app only (e.g. `getUser()` before writes) | Writes through the app | Not a security boundary: the API accepts the token directly. Rejected |
| E. Accept and document | Nothing | The current state |

## 3. Recommendation: option A, narrowly

A new helper, called from `is_active_user()` only (`private.session_is_live()`):

```sql
-- Sketch for approval, not applied.
select exists (
  select 1 from auth.sessions s
  where s.id = nullif(auth.jwt() ->> 'session_id', '')::uuid
    and s.user_id = (select auth.uid())
    and (s.not_after is null or s.not_after > pg_catalog.now())
)
```

- **Fails closed**, like `mfa_session_ok`: a missing or malformed `session_id`, or an Auth schema change (caught `undefined_column`/`undefined_table`, logged), answers false, so writes are refused rather than allowed. `31_auth_contract` must add `auth.sessions(id, user_id, not_after)` to its pinned columns, and is run before every Auth upgrade.
- **Concurrency.** A write that checked the session before the sign-out committed may still commit (it read the row before Auth deleted it); one that starts after cannot. That is ordinary read-committed ordering and bounded by a single statement's duration. If a strict ordering is wanted for a few sensitive functions, they can lock the session row (`for share`), so Auth's delete waits for them; not proposed for ordinary writes.
- **Staff and the Owner:** unchanged in effect. Their functions already require `mfa_session_ok`, which implies a live session; the new check runs first and costs one more lookup. Owner guards are triggers on rows, unaffected.
- **RLS:** no policy text changes; every policy that already calls `is_active_user()` gains the check. Read policies without the helper are unchanged (option B is separate).
- **Supabase behaviour it relies on (pin in tests):** sign-out (local and global), reset and change delete session rows; refresh keeps the same `session_id`; `not_after` is set when a session time-box is configured; tokens minted by the service role have no `session_id` (the helper is never reached by `service_role`, which has no account).
- **What it doesn't do:** end reads (B), or stop a token stolen from a live session (that is what sign-out everywhere is for, and now it would work for writes at once).

**Test requirements.** pgTAP: the helper true for a live session, false for a deleted one, a `not_after` in the past, another user's session id, a missing or malformed claim, and with the Auth table renamed (fails closed and logs). `db-password-checks`: after each of global sign-out, reset and change, an old token's collector writes (add a copy, edit private details, block, profile update, claim a handle) are refused, while the current session's work. App checks: the ended-session observations in `app:profile-checks` and `app:password-checks` flip from "accepted" to "refused". The full suite (`db:verify`, every app check), because every policy using the helper is affected, and a benchmark of a 50,000-copy collection page before and after. Targeted mutations: the helper always true; the user-id match dropped; `not_after` ignored.

## 4. The password-change policy

Three different things:

| | What | Today |
| --- | --- | --- |
| **The app's current-password check** | `/settings/account` asks for the current password and verifies it with a throwaway sign-in before calling `updateUser` | On. But it's only the app's page: someone holding a session can call Auth's `PUT /user` directly with no current password |
| **Auth's reauthentication** (`secure_password_change`, "Secure password change") | Auth refuses a password change from a session signed in more than 24 hours ago (`reauthentication_needed`) unless it carries a nonce from `reauthenticate()` (an emailed code) | On locally (`config.toml`), observed in M11a-2. Doesn't help in the first 24 hours of a stolen session |
| **Auth's "require current password"** (`GOTRUE_SECURITY_UPDATE_PASSWORD_REQUIRE_CURRENT_PASSWORD`; hosted dashboard setting) | Auth itself requires `current_password` in `updateUser`; recovery sessions are exempt (they are recognized by their one-time-code sign-in method). An open upstream change would limit that exemption to sessions under 15 minutes old | Can't be set through the CLI's `config.toml`, so not testable on the local stacks. Whether v2.197 includes the recovery exemption must be confirmed on staging |

**Recommendation for the private beta:** turn on "require current password" in hosted Auth, keep secure password change on, and change `changePassword` to pass `current_password` to `updateUser` (supabase-js ≥ 2.102 supports it; the app uses 2.118), so Auth, not only the page, checks it. Keep the app's own check for its fixed error messages. Before enabling: on staging, verify that (1) a change without the current password is refused, (2) a recovery session within the hour still resets without it (and, if the 15-minute limit has shipped, that `/reset-password`'s one-hour window is shortened to match), (3) a TOTP account still needs aal2. Rerun `db-password-checks` and `app:password-checks` there. Until staging exists this stays a launch prerequisite.

Sources on the hosted option: supabase/auth PR #2215 (adds the setting), PR #2396 (limits the recovery exemption to 15 minutes, open), and the supabase-js `UserAttributes.current_password` documentation.

## 5. What the checkpoint found

- **Session revocation:**
  - Option A was implemented as sketched, with `require_verified_user` added next to `is_active_user` (blocks, notifications and follow lists use it).
  - Ten owner-only policies and eleven owner-scoped functions that used neither guard were changed too.
  - Read paths were covered as well (option B), because the audit found owner-only reads with no guard at all.
  - Measured cost: tens of microseconds on small queries, and within noise on large ones.
  - A statement already running when the session ends completes; later ones are refused.
- **Auth ends other sessions when an authenticator is first verified,** like a password change. This matters for tests, not users.
- **Require current password (GoTrue v2.197),** verified with a throwaway Auth server that used the test stack's settings plus this one (`auth-password-policy-checks.mjs`, 21 checks):
  - a signed-in change without the current password is refused (`current_password_required`), and with a wrong one too (`current_password_invalid`);
  - with the right one it works;
  - a recovery session may reset without the old password, still with no 15-minute limit in this version (a 50-minute-old recovery session was allowed);
  - an account with an authenticator still needs aal2, and so does its recovery session;
  - an administrator changes their password the same way and keeps their role.
- **App compatibility:**
  - The signed-in change now passes `current_password` to `updateUser`. With the setting off, Auth ignores it (tested), and the app's own check stays for its messages.
  - The two new error codes have messages.
  - The reset passes no current password, as recovery is exempt.
- **Recommended hosted configuration for the beta:**
  - "require current password" on;
  - "secure password change" on;
  - `otp_expiry` an hour.
  - If a later Auth version adds a shorter recovery window, shorten `/reset-password`'s one-hour mark to match.
