## Designer state and viewport checks

Run the deterministic designer async-state tests (three tests) and viewport lifecycle checks with:

```sh
npm run -s check:state-lifecycle
```

The separate explicit browser command starts an isolated Vite app with a temporary example-project directory and fixture API, then checks a mounted example result, result tabs, and workspace remounts at 1600x1000 and 1280x720. It also forces GC and compares WebGL context and texture wrapper counts after 2, 4, and 10 remount cycles in the same result state:

```sh
npm run -s check:browser-manual
```

The command uses the `puppeteer-core` dev dependency (installed by `npm ci`, without a browser download) with the system Chrome or Edge, found in the standard install locations on Windows, macOS and Linux. Set `FAIRBEAM_CHROME` to use another Chrome or Edge executable and `FAIRBEAM_PUPPETEER` to point to another Puppeteer module. `node scripts/check-manual-browser.mjs --smoke` checks setup discovery without starting a server or browser. Browser checks in the other opt-in scripts report `SKIP` unless `FAIRBEAM_BROWSER_TESTS=1` is set.
