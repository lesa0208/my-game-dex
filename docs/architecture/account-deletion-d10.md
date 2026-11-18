# D10: account deletion and retention — decision document (M11a-4a)

**Status: proposed, for decision. Nothing here is implemented.** M11a-4a adds no deletion, anonymization or retention cleanup. Every period below is a proposal; none is adopted until the product owner approves it, and the items marked **Legal** also need legal review. The inventory comes from the migrations as of `20261127100000` and is cited by file.

Related: [security-rls.md § Account deletion](security-rls.md#account-deletion), [§ Retention of unverified accounts](security-rls.md#retention-of-unverified-accounts), [§ Legal and age blockers](security-rls.md#legal-and-age-blockers), [architecture-decisions.md D10 (retention), A2, M4-D4, M4-D10, D12](architecture-decisions.md).

## 1. What happens today if an account is deleted

The only supported path is `deleteAccountWithAvatars()` (`src/features/avatars/avatar-workflow.ts`), which has no route: it asks `account_deletion_blocked`, clears the avatar path, removes the user's Storage folder, then deletes the Auth user. That cascades `auth.users → public.profiles → everything that references profiles`. Every other effect is a foreign key (`cascade` or `set null`) or a trigger. **Setting a foreign key to null does not remove the personal data around it**, and several records hold user ids with no foreign key at all (section 3).

Guards that stay (D12, M8): the Owner can't be deleted (`platform_owner.user_id ... on delete restrict`, the `protect_owner_profile` trigger, and `account_deletion_blocked` checked first); the Owner's admin role can't be removed; pending ownership transfers and recoveries naming the person are cancelled with cause `account_deleted` before the profile goes. A deleted handle is held for 30 days (approved, M2).

## 2. Decision matrix

Categories: **Delete** at deletion time · **Anonymize** (keep the row, remove what identifies the person) · **Retain: security/integrity** · **Retain: period** (removed after a documented time) · **Backups** · **Decide** (product or legal decision needed first).

### Account and identity

| Data | Where | Today on deletion | Proposed | Needs |
| --- | --- | --- | --- | --- |
| Auth user, email, password hash, identities | `auth.users`, `auth.identities` | Deleted by Auth | **Delete** | — |
| Sessions, refresh tokens, MFA factors and challenges | `auth.sessions`, `auth.refresh_tokens`, `auth.mfa_*` | Deleted by Auth (cascade inside Auth) | **Delete**. Confirm on staging that Auth leaves none | Staging check |
| Auth's own audit log (sign-ins, IPs, emails in payloads) | `auth.audit_log_entries` | **Not deleted**; Supabase-managed, no FK | **Decide**: Supabase retains it; the app reads it only for the invitation password step. Document Supabase's retention, or purge rows naming the user through a supported path | **Legal** (IP addresses, emails); check Supabase |
| Profile: handle, display name, bio, country, avatar path, settings | `public.profiles` | Deleted (cascade) | **Delete** | — |
| Preferences | `public.user_preferences` | Deleted (cascade) | **Delete** | — |
| Released handle (string only, no link to the person) | `private.handle_holds` | Hold for 30 days | **Retain: period**, 30 days (approved). Schedule `purge_expired_handle_holds()`: today nothing runs it | Approve a scheduler |
| Staff roles | `public.staff_roles` | Deleted (cascade); the Owner's admin row can't be | **Delete**, Owner guard kept | — |
| Factor registrations (factor id and dates) | `private.mfa_factor_registrations` | Deleted (cascade) | **Delete** | — |
| Request counts (M11a-4a) | `private.request_slots` | Deleted (cascade) | **Delete**; at most one hour kept anyway | — |
| Avatar files | Storage `avatars/{id}/` | Removed by the workflow only; any other path leaves them **public** | **Delete** through the workflow only (keep the procedure) | — |
| Cached copies of avatars | Browsers, CDN (one-year `immutable` cache) | Not reachable | **Decide**: shorten the cache lifetime, or state the cache window in the privacy notice | **Legal** |

### Social graph and notifications

| Data | Where | Today | Proposed | Needs |
| --- | --- | --- | --- | --- |
| Follows (including rejected and cancelled), blocks | `public.follows`, `public.blocked_users` | Deleted (cascade) | **Delete** | — |
| Rejected/cancelled follow rows of living accounts | `public.follows` | Kept indefinitely | **Retain: period**, proposed 90 days after the request closes | Product |
| Notifications to or caused by the person | `public.notifications` | Deleted (cascade, M4-D4) | **Delete** | — |
| Notifications of living accounts | `public.notifications` | Kept | **Retain: period**, proposed 90 days (the D10 proposal) | Product |

### Collection

| Data | Where | Today | Proposed | Needs |
| --- | --- | --- | --- | --- |
| Copies, conditions, components | `collection_items`, `collection_item_components` | Deleted (cascade) | **Delete** | — |
| Purchase price, date, notes, storage location | `collection_item_private` | Deleted (cascade) | **Delete** | — |
| A copy's row in an exclusion or merge | `catalog_exclusion_copies`, `catalog_merge_copies` (owner id, **no FK**) | Deleted with the copy (cascade from `item_id`; the merge guard allows only this delete) | **Delete** (already happens) | — |

### Catalog contributions

| Data | Where | Today | Proposed | Needs |
| --- | --- | --- | --- | --- |
| Published games and releases the person submitted | `games`, `releases`, `game_platforms` | `submitted_by` is already cleared on publication; `verified_by` set null | **Retain: integrity** (shared catalog data, not personal) | — |
| Pending or rejected releases and games they submitted | same | `submitted_by` set null; their typed text (title, edition, variant, local title, publisher, packaging, summary) stays | **Decide**: delete unpublished records with no other copies (as withdrawing does), or keep them for review without an owner | Product |
| Their submissions: note, snapshot of what they typed, reviewer's note | `catalog_change_requests` (`submitted_by` set null) | Row stays with `reason`, `details`, `proposed_changes`, `reviewer_note` | **Anonymize**: clear `reason` (the submitter's note); keep `details` (catalog facts) and the reviewer's note for the record's history | Product; **Legal** for free text |
| Creator provenance | `private.catalog_record_origins` | `creator_id` cleared, `creator_removed = true`; "provenance is permanent" | **Retain: integrity** (already says only "a person who has left") | — |
| Field locks and reclassification resolutions they made (staff) | `catalog_field_locks.locked_by`, `catalog_reclassifications.resolved_by` | Set null; staff text in `resolution` stays | **Retain: integrity**, staff work product | Product |
| Exclusions they made or restored (staff) | `private.catalog_exclusions` (`excluded_by`, `restored_by`: **no FK**) | **Ids stay**, with `staff_reason`, `owner_note` and a `previous_request` snapshot holding `reviewed_by` and `reviewer_note` | **Retain: security/integrity** for staff actions, ids kept as pseudonymous ids; **Decide** whether ids of departed staff are replaced by a marker | Product, **Legal** |
| Merges they made (staff) | `private.catalog_merges` (`merged_by`, `request_id`: **no FK**; the row can't be changed at all) | **Ids stay**, with reasons and a `previous_request` snapshot | **Retain: security/integrity**. Anonymizing would need a deliberate, audited exception to `refuse_change` | Product, **Legal** |

### Audit, ownership and invitations

| Data | Where | Today | Proposed | Needs |
| --- | --- | --- | --- | --- |
| Audit events by or about the person | `private.audit_events` (`actor_id`, `target_profile_id`: **no FK**; ids also in `metadata`: `invitee`, `owner_id`, `previous_owner_id`, `successor_id`, `previous_successor_id`; free-text `reason`) | **Kept unchanged**; append-only triggers refuse any update or delete. Reads show handles resolved at read time, so a deleted account shows none | **Retain: security**, as pseudonymous ids, for a defined period: proposed 2 years for staff and security actions, 1 year for collector actions, then purged by an operator procedure that is itself audited | **Legal** (reason text, period); M4-D10 |
| Owner record | `private.platform_owner` | Owner can't be deleted; a deleted successor's id is cleared but the **succession fingerprint stays** | **Retain: security**; **Decide** whether the fingerprint of a deleted successor is cleared | Product |
| Ownership transfers and recoveries | `private.ownership_transfers`, `private.owner_recoveries` | Ids set null; pending ones cancelled; operator `case_ref` text stays | **Retain: security**, proposed 2 years; `case_ref` must not contain personal data (operator rule) | **Legal** |
| Invitations sent to the person | `private.account_invitations` | `invited_user_id` set null; **the email address stays**, with the administrator's reason | **Anonymize** at deletion: clear the email (keep a hash if resends must be refused), keep state and dates | Product, **Legal** |
| Unaccepted invitations | same | Kept indefinitely with the email | **Retain: period**, proposed 30 days after expiry, then delete the row (the audit event remains) | Product |
| Withheld invitations (address already had an account) | same | Kept with the email | Same as unaccepted | Product |
| Revoked, banned invitees' Auth accounts | `auth.users` (banned) | Kept, banned, "until an operator removes them" | **Retain: period**, proposed 30 days after revocation, then delete through `deleteAccountWithAvatars` | Product |
| Unverified accounts | `auth.users`, `profiles` | Nothing deletes them | **Retain: period**, 7 days proposed (M2 proposal) | Product |

### Backups

| Data | Where | Proposed | Needs |
| --- | --- | --- | --- |
| Database backups and point-in-time recovery | Supabase (hosted) | **Backups**: deleted data stays until the backup expires (Supabase's plan retention, e.g. 7 days, or the PITR window). State the window in the privacy notice; never restore a backup into production without re-applying deletions made since | **Legal**; confirm the plan's retention |
| Storage | Supabase Storage | Same; confirm whether Storage objects are in the backups | Staging check |
| Local demo snapshots | Docker volumes on the developer's machine | Local only, synthetic accounts; not production data | — |

## 3. Where nulling a foreign key leaves personal data behind

1. `audit_events`: plain user ids, ids inside `metadata`, and free-text `reason`; append-only.
2. `catalog_exclusions`: `excluded_by`, `restored_by` and `previous_request.reviewed_by` with no FK; `reviewer_note`, `staff_reason`, `owner_note`.
3. `catalog_merges`: `merged_by`, `request_id`, `previous_request.reviewed_by` with no FK; the row can't be changed at all.
4. `catalog_change_requests`: the submitter's `reason`, the `details` snapshot and `reviewer_note` outlive `submitted_by`; audit rows link the old id to the request id.
5. Pending or rejected `games` and `releases`: text the submitter typed.
6. `account_invitations`: the email address and administrators' reasons.
7. `owner_recoveries.case_ref`, `catalog_reclassifications.resolution`: operator and staff text; `platform_owner.succession_fingerprint`.
8. `handle_holds`: the former handle (no link to the person) for 30 days, longer while nothing schedules the purge.
9. Avatar files after any deletion path other than the workflow, and cached copies everywhere.
10. Auth's own `audit_log_entries` (Supabase-managed).

Side effects to design for: clearing `submitted_by` raises `revision` on pending records and `version` on requests, so open review pages report "changed"; an exclusion or merge in progress fails with a retryable conflict when an account it touches is deleted (`lock_new_profiles` NOWAIT), never the reverse.

## 4. What can be decided as product policy, and what needs legal review

- **Product decisions:** what happens to unpublished submissions; clearing the submitter's note; retention periods for closed follow requests, notifications, unaccepted invitations, revoked invitees and unverified accounts; scheduling the handle-hold purge; whether departed staff ids in exclusion and merge records are replaced; the successor fingerprint.
- **Legal review:** whether pseudonymous ids and free-text reasons in the audit log, exclusion and merge records may be kept, and for how long (legitimate interest vs. erasure); Auth's own logs (IP addresses); invitation emails; cache and backup windows in the privacy notice; whether the M11a-4a export satisfies access requests (it says it doesn't); the lawful basis, privacy notice and terms (none written).

## 5. Proposed shape of self-service deletion (M11a-4b, for approval)

1. A page that says exactly what is deleted, kept and for how long (from the approved matrix), requiring the current password and, with an authenticator, aal2; offering the export first.
2. A database function, as the person, that refuses the Owner and anyone holding a staff role (staff leave by an administrator removing their role first), applies the approved anonymizations in one transaction, and records an audit event.
3. Then the server workflow (`deleteAccountWithAvatars`, the only secret-key step) removes Storage files and the Auth user; safe to repeat until done.
4. Tests: every table in section 2 before and after, the Owner and staff refusals, a deletion during an exclusion or merge, repeat after partial failure, and the files gone from Storage.

## 6. D12: minimum age — still open

Unchanged and unresolved: no age or birth date is collected or checked, and none will be without approval. The open questions are whether a self-declared age (provisionally 16) is acceptable, what happens to an account found to be under age (including its retention under this document), and whether parental consent is needed in any market. Public registration stays closed until D12 is decided.
