import { onMount, Show } from "solid-js";
import { accountUiEnabled, chipLabel } from "../lib/account";
import AccountDialog from "./AccountDialog";
import { accountDialogOpen, accountStatus, Avatar, loadAccountStatus, refreshAccountOnce, setAccountDialogOpen } from "./AccountState";
import "../styles/account.css";
import { t } from "../i18n";

/** Top-bar account chip: "Guest", or the avatar and name (docs/ACCOUNTS.md). Renders nothing while the switch is off. */
export default function AccountChip() {
  const enabled = accountUiEnabled();
  onMount(() => { if (enabled) void loadAccountStatus().then(refreshAccountOnce); });
  return <Show when={enabled && accountStatus()}>{(status) => <>
    <button class="btn btn-ghost account-chip" onClick={() => setAccountDialogOpen(true)}
      title={status().profile ? t("account.chip.signedInAs", { name: chipLabel(status().profile) }) : t("account.chip.guestTitle")} aria-label={status().profile ? t("account.chip.aria", { name: chipLabel(status().profile) }) : t("account.chip.guestAria")}>
      <Avatar profile={status().profile} /> <span class="btn-label collapse-xl">{chipLabel(status().profile)}</span>
    </button>
    <AccountDialog open={accountDialogOpen()} close={() => setAccountDialogOpen(false)} />
  </>}</Show>;
}
