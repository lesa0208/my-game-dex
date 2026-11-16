-- M8a Superadmin foundation: audit actions for the Owner, its protections, its
-- recovery and ownership transfer. In their own migration, because a new enum value
-- can't be used in the transaction that adds it.
--
-- Design: docs/architecture/security-rls.md#the-owner-m8

-- Operator steps, run in SQL by a named operator (outcome 'operator').
alter type private.audit_action add value 'owner_assigned';
alter type private.audit_action add value 'owner_recovery_started';
alter type private.audit_action add value 'owner_recovery_completed';
alter type private.audit_action add value 'owner_status_set_by_operator';
-- By the Owner or the successor in the app, or by an operator (actor null).
alter type private.audit_action add value 'owner_recovery_confirmed';
alter type private.audit_action add value 'owner_recovery_cancelled';
-- Ownership transfer and succession, in the app (M8c).
alter type private.audit_action add value 'ownership_transfer_started';
alter type private.audit_action add value 'ownership_transfer_accepted';
alter type private.audit_action add value 'ownership_transfer_cancelled';
alter type private.audit_action add value 'owner_successor_set';
alter type private.audit_action add value 'owner_succession_registered';
-- Refused attempts by verified staff (outcome 'refused', D9).
alter type private.audit_action add value 'owner_protection_refused';
alter type private.audit_action add value 'staff_change_refused';
