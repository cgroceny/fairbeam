// The entry point. The app's modules read their preferences from localStorage as they load, so the
// ones imported from the older app (desktop) or carried over from the old keys (web demo) are written
// first, and the app (src/start.tsx) is loaded after that.
import { bootViewerPrefs } from "./lib/importedPrefs";

void bootViewerPrefs().then(() => import("./start"));
