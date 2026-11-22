-- PROPOSAL (M12c-B1, B1-M2 rollback): a forward migration that ends review batches.
--
-- Run before the B1-M1 rollback (approval uses B1-M1's pairing_created_by).
--
-- Not a complete schema reversal: it removes what can act (the five editor functions) and keeps
-- the schema objects that hold or protect history. Kept: the four tables with their guard
-- triggers and RLS, the provider-rights columns of private.external_providers (rights stay
-- recorded), and the helpers only the owner can run (review_flag_kind, review_critical_signal,
-- review_risk_problems, review_sample_size and its maths, record_provider_rights,
-- require_publication_rights).
--
-- The five editor functions go. The policy, batches, items and approvals stay as review history,
-- with their immutability triggers; nothing that was published is unpublished (published
-- records can't be, and their audit rows name the batch). An open batch can no longer be
-- approved, rejected or given outcomes: it stays open as a record of an unfinished review.
-- The five audit-action enum values (part 1) stay: a value can't be removed while rows use it,
-- and an unused value is harmless.
revoke all on function public.create_review_batch(uuid, uuid, text), public.record_batch_outcome(uuid, uuid, text, text, text),
  public.approve_review_batch(uuid, text), public.reject_review_batch(uuid, text), public.get_review_batch(uuid)
  from public, anon, authenticated, service_role;
drop function public.create_review_batch(uuid, uuid, text);
drop function public.record_batch_outcome(uuid, uuid, text, text, text);
drop function public.approve_review_batch(uuid, text);
drop function public.reject_review_batch(uuid, text);
drop function public.get_review_batch(uuid);
