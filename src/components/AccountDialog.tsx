import { createSignal, For, Show } from "solid-js";
import { Copy, UserRound, X } from "lucide-solid";
import { useModal } from "../lib/dialog";
import { accountUiEnabled, chipLabel, errorOf, identityLine, optionalNote, PROVIDER_LABEL, type ProviderId, type Prompt } from "../lib/account";
import { t } from "../i18n";
import { accountStatus, Avatar, client, setAccountProfile } from "./AccountState";

/** Sign in with GitHub or Google, or continue as a guest (docs/ACCOUNTS.md). Renders nothing while the switch is off. */
export default function AccountDialog(props: { open: boolean; close: () => void }) {
  let box!: HTMLDivElement;
  const [prompt, setPrompt] = createSignal<Prompt | null>(null);
  const [busy, setBusy] = createSignal<ProviderId | null>(null);
  const [error, setError] = createSignal("");
  const [copied, setCopied] = createSignal(false);
  // a newer attempt (or Cancel) makes an older one's result irrelevant
  let attempt = 0;
  const reset = () => { attempt++; setPrompt(null); setBusy(null); setCopied(false); };
  const cancel = () => { if (busy()) void client.signInCancel().catch(() => {}); reset(); };
  const close = () => { cancel(); setError(""); props.close(); };
  useModal(() => props.open ? box : undefined, close);

  const signIn = async (provider: ProviderId) => {
    cancel(); setError("");
    const mine = attempt;
    setBusy(provider);
    try {
      const p = await client.signInStart(provider);
      if (mine !== attempt) return;
      setPrompt(p);
      const profile = await client.signInWait();
      if (mine !== attempt) return;
      setAccountProfile(profile); reset(); props.close();
    } catch (e) {
      if (mine !== attempt) return;
      const err = errorOf(e);
      if (err.code !== "cancelled") setError(err.message);
      reset();
    }
  };
  const copyAndOpen = async (code: string) => {
    try { await navigator.clipboard.writeText(code); setCopied(true); } catch { /* the code stays on screen */ }
    try { await client.openVerification(); } catch (e) { setError(errorOf(e).message); }
  };
  const signOut = async () => {
    setError("");
    try { await client.signOut(); setAccountProfile(null); } catch (e) { setError(errorOf(e).message); }
  };
  const configured = (id: ProviderId) => !!accountStatus()?.providers.find((p) => p.id === id)?.configured;

  return <Show when={accountUiEnabled() && props.open && accountStatus()}>{(status) =>
    <div class="scrim" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div class="dialog dialog-sm" role="dialog" aria-modal="true" aria-labelledby="account-title" ref={box} tabindex={-1}>
        <div class="dialog-head"><div><h2 id="account-title"><UserRound size={17} /> {t("account.title")}</h2><p class="muted">{optionalNote()}</p></div><button class="icon-btn" onClick={close} aria-label={t("common.close")}><X size={16} /></button></div>
        <div class="gs-body">
          <Show when={status().profile} fallback={
            <Show when={prompt()} fallback={
              <div class="account-providers">
                <For each={["github", "google"] as ProviderId[]}>{(id) =>
                  <button class="btn btn-ghost" disabled={!!busy() || !configured(id)} title={configured(id) ? undefined : t("account.notConfigured", { provider: PROVIDER_LABEL[id] })} onClick={() => void signIn(id)}>
                    {busy() === id ? t("account.starting") : t("account.continueWith", { provider: PROVIDER_LABEL[id] })}
                  </button>}
                </For>
                <button class="btn btn-primary" onClick={close}>{t("account.continueGuest")}</button>
                <p class="note">{t("account.localNote")}</p>
              </div>}>
              {(p) => <Show when={p().kind === "device" ? p() as Extract<Prompt, { kind: "device" }> : undefined} fallback={
                <><p>{t("account.continueInBrowser")}</p><button class="btn btn-ghost" onClick={cancel}>{t("common.cancel")}</button></>}>
                {(d) => <>
                  <p>{t("account.enterCode")}</p>
                  <p class="account-code" aria-label={t("account.deviceCode")}>{d().user_code}</p>
                  <button class="btn btn-primary" onClick={() => void copyAndOpen(d().user_code)}><Copy size={14} aria-hidden="true" /> {t("account.copyAndOpen")}</button>
                  <p class="note" aria-live="polite">{copied() ? t("account.codeCopied") + " " : ""}{t("account.waiting", { count: Math.round(d().expires_in / 60) })}</p>
                  <button class="btn btn-ghost" onClick={cancel}>{t("common.cancel")}</button>
                </>}
              </Show>}
            </Show>}>
            {(profile) => <div class="account-section">
              <div class="account-identity"><Avatar profile={profile()} size={32} /><div><b>{chipLabel(profile())}</b><div class="muted">{identityLine(profile())}</div></div></div>
              <button class="btn btn-ghost btn-sm" onClick={() => void signOut()}>{t("account.signOut")}</button>
            </div>}
          </Show>
          <Show when={error()}><p role="alert" class="status-block status-critical">{error()}</p></Show>
        </div>
      </div>
    </div>}
  </Show>;
}
