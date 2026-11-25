import { CircleCheck, ShieldCheck } from "lucide-react";
import Link from "next/link";

import { EditForm, ReasonField } from "@/components/admin/edit-form";
import { RecordSection } from "@/components/admin/records";
import { Button } from "@/components/ui/button";
import { stepUpHref } from "@/features/admin/form";
import { publishRelease, publishReleaseFromForm, verifyRecord, verifyRecordFromForm } from "@/features/editing/actions";
import type { LinkedSubmission, RecordReview } from "@/features/records/queries";

const ACTIVE_SUBMISSION = ["open", "in_review", "changes_requested"];

const NOTICES: Record<string, string> = {
  created: "Created, in review. Another editor verifies and publishes it.",
  saved: "Saved.",
  verified: "Verified.",
  published: "Published.",
  identity_published: "Published as an identity. No physical release was created.",
  alias_added: "The other title is added.",
  alias_removed: "The other title is removed.",
  relation_saved: "The relation is saved.",
  platform_added: "The platform is added.",
  locked: "The field is locked against imports.",
  unlocked: "The field is unlocked.",
  source_confirmed: "The Wikidata match is confirmed: it is now the game's source, still a claim to check before verification.",
  source_rejected: "The Wikidata match is rejected.",
};

/** What an editing action just did, after its redirect. Unknown values show nothing. */
export function EditNotice({ notice }: { notice: string | null }) {
  const text = notice ? NOTICES[notice] : null;
  return text ? (
    <p role="status" className="flex items-center gap-2 rounded-lg border border-primary/40 bg-primary/10 px-3 py-2.5 text-sm font-medium">
      <CircleCheck aria-hidden="true" className="size-4 shrink-0" />
      {text}
    </p>
  ) : null;
}

/** Whether a record in this state can be edited: everything but merged, excluded or rejected records. */
export function editable(status: string) {
  return ["unverified", "under_review", "published"].includes(status);
}

/**
 * Asks for a TOTP verification in the last 10 minutes before a form that needs one is
 * shown (D3), so nothing typed is lost to it. The editor comes back to this page.
 */
export function StepUpNotice({ path, children }: { path: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-muted/40 p-4">
      <p className="flex gap-2 text-sm">
        <ShieldCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        <span>{children} Verify with your authenticator, and you&apos;ll come back here.</span>
      </p>
      <div>
        <Button asChild variant="outline" size="control">
          <Link href={stepUpHref(path)}>Verify to continue</Link>
        </Button>
      </div>
    </div>
  );
}

/**
 * Verifying a game or release, and publishing a release (M10c). The database decides;
 * this only explains, ahead of it, what the editor can't do: a record they created
 * (D2), one whose provenance only an administrator may resolve (D-2), or one in a
 * submission, which is reviewed there. Nothing names who created or verified it.
 */
export function ReviewPanel({
  entity,
  id,
  status,
  revision,
  verified,
  review,
  submissions,
  recentMfa,
  admin,
  path,
}: {
  entity: "game" | "release";
  id: string;
  status: string;
  revision: number;
  verified: boolean;
  review: RecordReview;
  submissions: LinkedSubmission[];
  recentMfa: boolean;
  admin: boolean;
  path: string;
}) {
  const active = submissions.find((s) => ACTIVE_SUBMISSION.includes(s.status));
  const current = verified && review.verification_current;
  let body: React.ReactNode;
  if (status === "published") {
    body = <p className="text-sm text-muted-foreground">Published. Changes to it need a recent verification with your authenticator.</p>;
  } else if (!["unverified", "under_review"].includes(status)) {
    body = <p className="text-sm text-muted-foreground">A record in this state isn&apos;t verified or published.</p>;
  } else if (active) {
    body = (
      <p className="text-sm">
        This record is part of a submission, so it&apos;s reviewed and published there.{" "}
        <Link href={`/admin/catalog/${active.id}`} className="font-medium underline underline-offset-4">
          Open the submission
        </Link>
      </p>
    );
  } else if (review.you_created) {
    body = <p className="text-sm">You created this record, so another editor verifies and publishes it.</p>;
  } else if (review.origin === "unknown" && !admin) {
    body = <p className="text-sm">Nobody knows who created this record, so only an administrator can verify or publish it.</p>;
  } else if (!recentMfa) {
    body = <StepUpNotice path={path}>Verifying and publishing need a recent verification.</StepUpNotice>;
  } else if (!current) {
    body = (
      <>
        <p className="text-sm text-muted-foreground">
          {verified
            ? "Its verification no longer matches the record, which changed since. Verify it again, as it is now."
            : entity === "game"
              ? "Check the title, type and first release, then verify the game. It's published with its first published release."
              : "Check the physical details against the evidence, then verify the release."}
        </p>
        <EditForm id={`verify-${entity}`} recordId={id} action={verifyRecord} plain={verifyRecordFromForm} submit={entity === "game" ? "Verify the game" : "Verify the release"} pending="Verifying…">
          <input type="hidden" name="entity" value={entity} />
          <input type="hidden" name="id" value={id} />
          <input type="hidden" name="revision" value={revision} />
          <ReasonField id={`verify-${entity}`} />
        </EditForm>
      </>
    );
  } else if (entity === "game") {
    body = <p className="text-sm text-muted-foreground">Verified as it is. The game is published with its first published release.</p>;
  } else if (review.you_verified && review.origin === "unknown") {
    body = <p className="text-sm">You verified this record, and nobody knows who created it, so another administrator publishes it.</p>;
  } else {
    body = (
      <>
        <p className="text-sm text-muted-foreground">Verified as it is. Publishing makes it public, with its game and platform if they aren&apos;t yet.</p>
        <EditForm id="publish-release" recordId={id} action={publishRelease} plain={publishReleaseFromForm} submit="Publish the release" pending="Publishing…" variant="default">
          <input type="hidden" name="id" value={id} />
          <input type="hidden" name="revision" value={revision} />
          <ReasonField id="publish-release" />
        </EditForm>
      </>
    );
  }
  return (
    <RecordSection id="review" title="Verification and publication">
      <div className="flex flex-col gap-3">{body}</div>
    </RecordSection>
  );
}
