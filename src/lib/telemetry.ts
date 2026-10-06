// Usage statistics in the viewer (docs/TELEMETRY.md). Built and wired, but OFF: the desktop shell
// has to be built with its `telemetry` feature, and the user has to say yes. Until then
// `countUsage` does nothing at all, and in a browser or in the web demo it never does anything,
// because there is no shell. Nothing here makes a network request: the counts go to the shell
// through Tauri commands, and the shell sends at most one ping a day.

import { t } from "../i18n/index.ts";

type Native = { invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T> };

function native(): Native | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { __TAURI_INTERNALS__?: Native }).__TAURI_INTERNALS__;
}

/** Running inside the desktop shell (the only place usage statistics exist). */
export const isDesktopShell = (): boolean => !!native();

export type UsageConsent ="granted" | "denied" | null;

export interface UsageStatus {
  /** the shell was built with the telemetry feature */
  build_enabled: boolean;
  /** FAIRBEAM_NO_TELEMETRY is set: always off */
  env_disabled: boolean;
  consent: UsageConsent;
  /** counting and the daily ping are on */
  active: boolean;
  /** show the first-start question (only with the build switch on, until answered) */
  ask: boolean;
  endpoint: string;
}

/** The exact JSON of a ping (the shell builds it; the viewer only shows it). */
export type UsagePing = {
  schema: string;
  install_id: string;
  app_version: string;
  os: string;
  arch: string;
  gpu_available: boolean;
  day: string;
  counters: Record<string, number>;
};

export interface UsagePreview {
  status: UsageStatus;
  /** the next ping the shell would send (a whole previous day), or null */
  next: UsagePing | null;
  /** today's counts so far, as they would be sent tomorrow */
  today: UsagePing | null;
  /** a build without the feature: an example of the format, which nothing sends */
  example?: UsagePing;
}

/** The viewer actions the shell counts (the schema's ui_events). */
export type UsageEvent = "feature.cst_export" | "feature.touchstone_export" | "feature.pdf_report";

let status: UsageStatus | null = null;

/** The shell's telemetry status; null outside the desktop app. Cached until `refresh`. */
export async function usageStatus(refresh = false): Promise<UsageStatus | null> {
  const n = native();
  if (!n) return null;
  if (status && !refresh) return status;
  try {
    status = await n.invoke<UsageStatus>("telemetry_status");
  } catch {
    status = null; // an older shell without the commands
  }
  return status;
}

/** Count a viewer action, only when the shell reported telemetry as active; never throws. */
export function countUsage(event: UsageEvent): void {
  if (!status?.active) return;
  void native()?.invoke("telemetry_count", { event }).catch(() => {});
}

export async function setUsageConsent(granted: boolean): Promise<UsageStatus> {
  const n = native();
  if (!n) throw new Error(t("usage.error.desktopOnly"));
  status = await n.invoke<UsageStatus>("telemetry_set_consent", { granted });
  return status;
}

export async function usagePreview(): Promise<UsagePreview> {
  const n = native();
  if (!n) throw new Error(t("usage.error.desktopOnly"));
  return n.invoke<UsagePreview>("telemetry_preview");
}

export async function resetUsageId(): Promise<UsageStatus> {
  const n = native();
  if (!n) throw new Error(t("usage.error.desktopOnly"));
  status = await n.invoke<UsageStatus>("telemetry_reset_id");
  return status;
}

/** The public page listing what is collected (opened by the shell from its fixed link table). */
export function openPrivacyPage(): Promise<void> {
  const n = native();
  if (!n) return Promise.resolve();
  return n.invoke<void>("open_external_link", { link: "privacy" });
}

/** The plain-language summary shown in Settings and in the first-start question (getters: read
 *  at render, in the current language; the English texts are usage.summary.* in en.json). */
export const USAGE_SUMMARY = {
  get what() { return t("usage.summary.what"); },
  get never() { return t("usage.summary.never"); },
  get where() { return t("usage.summary.where"); },
  get off() { return t("usage.summary.off"); },
};
