import { Eye, Lock } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { PageMessage, param } from "@/components/admin/admin-frame";
import { HandleForm } from "@/components/auth/handle-form";
import { AccountPageSkeleton } from "@/components/auth/require-account";
import { PageLayout } from "@/components/layout/page-layout";
import { AvatarSection } from "@/components/profile/avatar-section";
import { ProfileForm } from "@/components/profile/profile-form";
import { SettingsCard } from "@/components/profile/settings-card";
import { UserAvatar } from "@/components/shared/user-avatar";
import { requireViewerWithHandle } from "@/features/account/queries";
import { nextHandleChange } from "@/features/auth/account";
import { avatarError, avatarNotice } from "@/features/avatars/form";
import { collectionVisibilityText, profileError, profileNotice } from "@/features/profile/form";
import { getMyProfile } from "@/features/profile/queries";

export const metadata: Metadata = {
  title: "Profile",
};

const PATH = "/settings/profile";

/** Settings → Profile (M11a-3): the public card's name, bio, photo and handle, and the collection's privacy. */
async function ProfileView({ searchParams }: { searchParams: PageProps<"/settings/profile">["searchParams"] }) {
  const search = await searchParams;
  const viewer = await requireViewerWithHandle(PATH);
  const profile = await getMyProfile();
  if (!profile || !viewer.handle) throw new Error("The profile couldn't be loaded.");
  const active = viewer.accountStatus === "active";
  const errorCode = param(search.error);
  const error = profileError(errorCode) ?? avatarError(errorCode);
  const notice = profileNotice(param(search.notice)) ?? avatarNotice(param(search.notice));
  const waitUntil = nextHandleChange(viewer);
  const shownName = profile.displayName ?? viewer.handle;

  return (
    <div className="flex flex-col gap-6">
      <PageMessage notice={notice} error={error} errorId="page-error" />

      {!active ? (
        <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
          This account isn&apos;t active, so its profile can&apos;t be changed. You can still view it.
        </p>
      ) : null}

      <section aria-labelledby="public-heading" className="rounded-xl border bg-card p-4 sm:p-5">
        <h2 id="public-heading" className="flex items-center gap-2 text-base font-semibold tracking-tight">
          <Eye aria-hidden="true" className="size-4 text-muted-foreground" />
          What others see
        </h2>
        <p className="mt-2 max-w-prose text-sm text-muted-foreground">
          Your handle, display name, bio and photo{profile.countryCode ? ", and your country," : ""} are public: anyone can see them, including
          people who aren&apos;t signed in, so they can find you and see who wrote what. Accounts you block stop seeing them while signed in.
          Your email address is never shown.{" "}
          {profile.collectionVisibility === "private" ? "Your collection stays private." : "Your collection has its own setting, below."}
        </p>
        {/* The card as it's saved, not as typed. React escapes it: nothing here is read as HTML. */}
        <div className="mt-4 flex max-w-md gap-3 rounded-lg border bg-background/40 p-3" aria-label="Your public card, as saved" role="group">
          <UserAvatar collector={{ displayName: shownName, avatarUrl: profile.avatarUrl ?? undefined }} size={48} />
          <div className="min-w-0">
            <p className="truncate font-medium">{shownName}</p>
            <p className="truncate text-sm text-muted-foreground">@{viewer.handle}</p>
            {profile.bio ? <p className="mt-2 text-sm break-words whitespace-pre-line">{profile.bio}</p> : null}
          </div>
        </div>
      </section>

      <SettingsCard id="photo-heading" title="Photo">
        <AvatarSection avatarUrl={profile.avatarUrl} displayName={shownName} disabled={!active} serverErrorCode={avatarError(errorCode) ? errorCode : null} />
      </SettingsCard>

      <SettingsCard id="details-heading" title="Name and bio">
        <ProfileForm displayName={profile.displayName} bio={profile.bio} handle={viewer.handle} serverErrorCode={profileError(errorCode) ? errorCode : null} disabled={!active} />
      </SettingsCard>

      <SettingsCard id="handle-heading" title="Handle">
        <p className="mb-3 text-sm text-muted-foreground">
          Your handle is <span className="font-medium text-foreground">@{viewer.handle}</span>. It&apos;s how people find and mention you. After
          your first choice you can correct it once within a day; after that, a change needs 30 days since the last one, and a handle you
          give up stays reserved for 30 days.
        </p>
        {!active ? (
          <p className="text-sm text-muted-foreground">Your handle can&apos;t be changed while the account isn&apos;t active.</p>
        ) : waitUntil ? (
          <p className="text-sm">
            You can change it again on {waitUntil.toLocaleDateString("en", { dateStyle: "long", timeZone: "UTC" })}.
          </p>
        ) : (
          <HandleForm next={PATH} current={viewer.handle} submitLabel="Change handle" />
        )}
      </SettingsCard>

      <SettingsCard id="privacy-heading" title="Collection privacy">
        <p className="flex items-start gap-2 text-sm">
          <Lock aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <span>{collectionVisibilityText(profile.collectionVisibility)}</span>
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          Sharing your collection with others arrives in a later update. Until then nothing in it, including what you paid, is shown to anyone else.
        </p>
      </SettingsCard>

      <p className="text-sm">
        <Link href="/settings" className="text-primary-text underline underline-offset-4">
          Back to settings
        </Link>
      </p>
    </div>
  );
}

export default function ProfileSettingsPage({ searchParams }: PageProps<"/settings/profile">) {
  return (
    <PageLayout>
      <div className="p-4 md:p-0">
        <h1 className="mb-4 text-xl font-semibold tracking-tight">Profile</h1>
        <Suspense fallback={<AccountPageSkeleton />}>
          <ProfileView searchParams={searchParams} />
        </Suspense>
      </div>
    </PageLayout>
  );
}
