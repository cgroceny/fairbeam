import { createSignal, Show } from "solid-js";
import { X } from "lucide-solid";
import { useModal } from "../lib/dialog";
import { version } from "../../package.json";
import { t } from "../i18n";
type Native = { invoke: (command: string, args: { link: string }) => Promise<unknown> };
// The desktop shell opens these by key from its own fixed table (open_external_link); the URLs
// here are only the plain-browser fallback. "repository" is the releases repository (installers
// and the issue forms), "source" the source repository.
const LINKS = {
  developer: "https://akdag.dev",
  source: "https://github.com/ismailakdag/fairbeam",
  repository: "https://github.com/ismailakdag/fairbeam-releases",
  docs: "https://fairbeam.org/guide.html",
  openems: "https://github.com/thliebig/openEMS",
  csxcad: "https://github.com/thliebig/CSXCAD",
} as const;
type Link = keyof typeof LINKS;
export default function AboutDialog(props: { open: boolean; close: () => void }) {
  let box!: HTMLDivElement;
  const [error, setError] = createSignal("");
  useModal(() => props.open ? box : undefined, props.close);
  const open = (link: Link) => {
    const native = (window as unknown as { __TAURI_INTERNALS__?: Native }).__TAURI_INTERNALS__;
    if (native) void native.invoke("open_external_link", { link }).catch((e) => setError(t("about.error.openLink", { error: String(e) })));
  };
  const link = (key: Link, label: string) => <Show when={(window as any).__TAURI_INTERNALS__} fallback={<a href={LINKS[key]} target="_blank" rel="noopener noreferrer">{label}</a>}><button class="linklike" onClick={() => open(key)}>{label}</button></Show>;
  return <Show when={props.open}><div class="scrim" onPointerDown={e => e.target === e.currentTarget && props.close()}><div class="dialog dialog-sm" role="dialog" aria-modal="true" aria-labelledby="about-title" ref={box} tabindex={-1}>
    <div class="dialog-head"><div><h2 id="about-title">{t("about.title")}</h2><p class="muted">{t("about.subtitle")}</p></div><button class="icon-btn" onClick={props.close} aria-label={t("common.close")}><X size={16}/></button></div>
    <div class="gs-body"><p><b>Fairbeam</b> · {t("about.version", { version })}</p><p>{t("about.developedBy")} · {link("developer", "akdag.dev")}</p><p>{t("about.license")} {t("about.source")} {link("source", t("about.sourceLink"))}</p><p>{t("about.solver")} {link("openems", "openEMS")} (GPL-3.0). {t("about.cadLibrary")} {link("csxcad", "CSXCAD")} (LGPL-3.0).</p><p>{t("about.releases")} {link("repository", t("about.releasesLink"))} · {link("docs", t("about.guide"))}</p><Show when={error()}><p role="alert" class="status-block status-critical">{error()}</p></Show></div>
  </div></div></Show>;
}
