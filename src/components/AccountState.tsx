import { createSignal, Show } from "solid-js";
import { UserRound } from "lucide-solid";
import { accountClient, chipLabel, initials, safeAvatar, type AccountStatus, type Profile } from "../lib/account";

// Shared by the top-bar chip, the account dialog and General settings (docs/ACCOUNTS.md).
// With the switch off `client.status()` resolves null without calling the shell and nothing renders.
export const client = accountClient();
const [status, setStatus] = createSignal<AccountStatus | null>(null);
const [dialogOpen, setDialogOpen] = createSignal(false);
export { status as accountStatus, dialogOpen as accountDialogOpen, setDialogOpen as setAccountDialogOpen };

let loading: Promise<void> | undefined;
/** Reads who signed in from the shell's cache (no network), once per start. */
export function loadAccountStatus(): Promise<void> {
  return (loading ??= client.status().then((s) => { setStatus(s); }));
}

export function setAccountProfile(profile: Profile | null) {
  const s = status();
  if (s) setStatus({ ...s, profile });
}

/** Silent refresh once per start while signed in; a failure keeps the cached identity. */
let refreshed = false;
export function refreshAccountOnce() {
  if (refreshed || !status()?.profile) return;
  refreshed = true;
  void client.refresh().then(setAccountProfile, () => {});
}

export function Avatar(props: { profile: Profile | null; size?: number }) {
  const [broken, setBroken] = createSignal(false);
  const src = () => (broken() ? undefined : safeAvatar(props.profile?.avatar_url));
  return <span class="account-avatar" style={{ "--account-avatar": `${props.size ?? 20}px` }} aria-hidden="true">
    <Show when={src()} fallback={props.profile ? initials(chipLabel(props.profile)) : <UserRound size={Math.round((props.size ?? 20) * 0.7)} />}>
      <img src={src()} alt="" referrerpolicy="no-referrer" onError={() => setBroken(true)} />
    </Show>
  </span>;
}
