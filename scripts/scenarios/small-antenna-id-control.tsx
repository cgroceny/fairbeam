// Browser-only mount control, loaded through Vite so JSX/Solid resolve as in the app.
import { render } from "solid-js/web";
import SmallAntennaPanel from "../../src/components/SmallAntennaPanel";
import type { SmallAntennaSession } from "../../src/lib/smallAntennaSession";

export function checkSmallAntennaPanelIds(session: SmallAntennaSession) {
  const host = document.createElement("div");
  host.style.position = "fixed"; host.style.left = "-10000px";
  document.body.append(host);
  const dispose = render(() => <SmallAntennaPanel bundle={session.source()!} session={session} />, host);
  try {
    const ids = [...document.querySelectorAll<HTMLElement>("[data-small-antenna] [id]")].map(element => element.id);
    return { count: ids.length, unique: new Set(ids).size };
  } finally { dispose(); host.remove(); }
}
