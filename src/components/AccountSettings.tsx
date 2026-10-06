import { createSignal, onMount, Show } from "solid-js";
import { accountUiEnabled, chipLabel, errorOf, identityLine, optionalNote } from "../lib/account";
import { t } from "../i18n";
import { accountStatus, Avatar, client, loadAccountStatus, setAccountDialogOpen, setAccountProfile } from "./AccountState";
import "../styles/account.css";

/** General settings › Account: who is signed in, Sign out (docs/ACCOUNTS.md). Renders nothing while the switch is off. */
export default function AccountSettings(props: { closeSettings: () => void }) {
  const enabled = accountUiEnabled();
  const [message, setMessage] = createSignal("");
  onMount(() => { if (enabled) void loadAccountStatus(); });
  const signOut = async () => {
    setMessage("");
    try { await client.signOut(); setAccountProfile(null); setMessage(t("account.signedOut")); }
    catch (e) { setMessage(errorOf(e).message); }
  };
  return <Show when={enabled && accountStatus()}>{(status) => <>
    <hr />
    <div class="account-section">
      <span class="dz-label">{t("account.title")}</span>
      <Show when={status().profile} fallback={<>
        <p>{t("account.guestNote", { note: optionalNote() })}</p>
        <button class="btn btn-ghost btn-sm" onClick={() => { props.closeSettings(); setAccountDialogOpen(true); }}>{t("account.signIn")}</button>
      </>}>
        {(profile) => <>
          <div class="account-identity"><Avatar profile={profile()} size={28} /><div><b>{chipLabel(profile())}</b><div class="muted">{identityLine(profile())}</div></div></div>
          <button class="btn btn-ghost btn-sm" onClick={() => void signOut()}>{t("account.signOut")}</button>
          <p class="note">{t("account.signOutNote")}{profile().provider === "github" ? " " + t("account.revokeGithub") : ""}</p>
        </>}
      </Show>
      <Show when={message()}><p class="note" role="status">{message()}</p></Show>
    </div>
  </>}</Show>;
}
