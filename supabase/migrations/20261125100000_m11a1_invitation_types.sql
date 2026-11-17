-- M11a-1 Invitations: the audit actions the invitation functions record. Enum values
-- must be committed before a function can use them, so they come first, on their own.
--
-- Design: docs/architecture/security-rls.md#invitations-and-registration-m11a-1.

alter type private.audit_action add value 'account_invited';
alter type private.audit_action add value 'account_invitation_delivery';
alter type private.audit_action add value 'account_invitation_resent';
alter type private.audit_action add value 'account_invitation_revoke_requested';
alter type private.audit_action add value 'account_invitation_revoked';
