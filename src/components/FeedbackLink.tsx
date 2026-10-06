// "Send feedback": links to the issue forms of the public tracker (fairbeam-releases). No telemetry:
// the app sends nothing itself, it only opens the browser. The bug form is prefilled with the app
// version and the operating system (GitHub issue forms take field values as query parameters named
// by the field ids, see release-repo/.github/ISSUE_TEMPLATE/bug.yml); nothing else goes into the URL.
//
// In a browser the link opens a new tab (target=_blank). The desktop app's webview does not open
// new windows and the viewer gets no IPC, so there the run server opens the system browser
// (POST /api/open-feedback, which accepts these URLs only).
import type { JSX } from "solid-js";
import { api } from "../runner/api";
import { health } from "../runner/store";

export const ISSUES_URL = "https://github.com/ismailakdag/fairbeam-releases/issues";

/** bug and feature: that issue form; choose: GitHub's list of the forms */
export type FeedbackKind = "bug" | "feature" | "choose";

/** "macOS" or "Windows" from the browser, null elsewhere (the bug form offers only these two). */
export function clientOs(): "macOS" | "Windows" | null {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const p = `${nav.userAgentData?.platform ?? ""} ${nav.platform ?? ""} ${nav.userAgent ?? ""}`;
  if (/mac/i.test(p)) return "macOS";
  if (/win/i.test(p)) return "Windows";
  return null;
}

/** The issue-form URL; version and os only when they look like a version and a known OS. */
export function feedbackUrl(kind: FeedbackKind, version?: string | null, os?: string | null): string {
  if (kind === "choose") return `${ISSUES_URL}/new/choose`;
  const q = new URLSearchParams({ template: `${kind}.yml` });
  if (version && /^[0-9][0-9A-Za-z.+-]{0,31}$/.test(version)) q.set("version", version);
  if (kind === "bug" && (os === "macOS" || os === "Windows")) q.set("os", os);
  return `${ISSUES_URL}/new?${q}`;
}

/** Desktop app: the run server opens the system browser; in a browser the link opens itself. */
function onOpen(e: MouseEvent, url: string) {
  if (!health()?.desktop) return;
  e.preventDefault();
  const fallback = () => window.open(url, "_blank", "noopener,noreferrer");
  api.openFeedback(url).then((r) => { if (!r.opened) fallback(); }, fallback);
}

export default function FeedbackLink(props: { kind: FeedbackKind; class?: string; title?: string; label?: string; role?: "menuitem"; onClick?: (event: MouseEvent) => void; children: JSX.Element }) {
  // the version of the local run server (the app's own fairbeam); the demo has none
  const url = () => feedbackUrl(props.kind, health()?.fairbeam, clientOs());
  return (
    <a class={props.class} role={props.role} href={url()} target="_blank" rel="noopener noreferrer" title={props.title} aria-label={props.label}
      onClick={(e) => { props.onClick?.(e); onOpen(e, url()); }}>
      {props.children}
    </a>
  );
}
