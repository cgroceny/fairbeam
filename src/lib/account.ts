/**
 * Optional sign-in with GitHub or Google (docs/ACCOUNTS.md). Built but switched off: the UI shows
 * only when the viewer was built with VITE_FAIRBEAM_ACCOUNTS=1 AND runs in the desktop shell, and
 * the shell has the `account` plugin only when built with `--features accounts`. With the switch
 * off nothing here calls the shell, and the viewer itself never talks to the network for accounts.
 */
import { t } from "../i18n/index.ts";

export type ProviderId = "github" | "google";
export type Profile = { provider: ProviderId; id: string; login?: string | null; name: string; avatar_url?: string | null; email?: string | null; signed_in_at: number };
export type AccountStatus = { enabled: boolean; providers: { id: ProviderId; configured: boolean }[]; profile: Profile | null };
export type Prompt = { kind: "device"; user_code: string; verification_uri: string; expires_in: number } | { kind: "browser" };
export type AccountError = { code: string; message: string };
export type Native = { invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T> };

/** "Signing in is optional…" in the current language (read at render). */
export const optionalNote = (): string => t("account.optionalNote");
export const PROVIDER_LABEL: Record<ProviderId, string> = { github: "GitHub", google: "Google" };

/** The build-time switch: off unless `VITE_FAIRBEAM_ACCOUNTS=1 vite build`. */
export const ACCOUNTS_BUILD_FLAG: boolean = (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_FAIRBEAM_ACCOUNTS === "1";

export function desktopNative(): Native | undefined {
  try { return (globalThis as unknown as { __TAURI_INTERNALS__?: Native }).__TAURI_INTERNALS__; } catch { return undefined; }
}

/** Whether any account UI may render: the switch is on and the desktop shell is there. */
export function accountUiEnabled(flag: boolean = ACCOUNTS_BUILD_FLAG, native: Native | undefined = desktopNative()): boolean {
  return flag && !!native;
}

export const DISABLED: AccountError = { code: "disabled", get message() { return t("account.error.disabled"); } };

export function errorOf(e: unknown): AccountError {
  if (e && typeof e === "object" && "code" in e && "message" in e) return e as AccountError;
  return { code: "unknown", message: e instanceof Error ? e.message : String(e) };
}

/** The shell's `account` plugin. Every call checks the switch first; off, none reaches the shell. */
export function accountClient(flag: boolean = ACCOUNTS_BUILD_FLAG, native: Native | undefined = desktopNative()) {
  const call = <T>(command: string, args?: Record<string, unknown>): Promise<T> =>
    accountUiEnabled(flag, native) ? native!.invoke<T>(`plugin:account|${command}`, args) : Promise.reject(DISABLED);
  return {
    /** Who signed in, from the local cache (no network). Null when off or unavailable. */
    status: async (): Promise<AccountStatus | null> => {
      if (!accountUiEnabled(flag, native)) return null;
      try { const s = await call<AccountStatus>("status"); return s.enabled ? s : null; } catch { return null; }
    },
    signInStart: (provider: ProviderId) => call<Prompt>("sign_in_start", { providerId: provider }),
    signInWait: () => call<Profile>("sign_in_wait"),
    signInCancel: () => call<void>("sign_in_cancel"),
    openVerification: () => call<void>("open_verification"),
    refresh: () => call<Profile | null>("refresh"),
    signOut: () => call<void>("sign_out"),
  };
}
export type AccountClient = ReturnType<typeof accountClient>;

/** The chip's text: the display name, or "Guest". */
export function chipLabel(profile: Profile | null | undefined): string {
  if (!profile) return t("account.guest");
  return profile.name?.trim() || profile.login || profile.email || PROVIDER_LABEL[profile.provider];
}

/** One or two letters for the avatar fallback. */
export function initials(label: string): string {
  const words = label.trim().split(/[\s@._-]+/).filter(Boolean);
  const letters = words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? "?").slice(0, 2);
  return letters.toUpperCase();
}

/** Avatars only from the providers' own image hosts, over https. */
export function safeAvatar(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && /(^|\.)(githubusercontent\.com|googleusercontent\.com)$/.test(u.hostname) ? u.href : undefined;
  } catch { return undefined; }
}

export function identityLine(profile: Profile): string {
  const via = PROVIDER_LABEL[profile.provider];
  const who = profile.provider === "github" && profile.login ? `@${profile.login}` : profile.email ?? "";
  return who ? `${via} · ${who}` : via;
}
