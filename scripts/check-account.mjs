// Optional sign-in (docs/ACCOUNTS.md) stays hidden and silent while the switch is off.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { ACCOUNTS_BUILD_FLAG, accountClient, accountUiEnabled, chipLabel, DISABLED, identityLine, initials, optionalNote, safeAvatar } from "../src/lib/account.ts";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const spy = () => {
  const calls = [];
  return { calls, invoke: async (command, args) => { calls.push([command, args]); return command === "plugin:account|status" ? spy.status : null; } };
};
spy.status = { enabled: true, providers: [{ id: "github", configured: true }, { id: "google", configured: false }], profile: null };

// the switch is off by default: no env flag outside `VITE_FAIRBEAM_ACCOUNTS=1 vite build`
assert.equal(ACCOUNTS_BUILD_FLAG, false);
for (const f of readdirSync(new URL("..", import.meta.url)).filter((f) => f.startsWith(".env"))) {
  assert.doesNotMatch(read(f), /VITE_FAIRBEAM_ACCOUNTS\s*=\s*1/, `${f} turns accounts on`);
}

// off (or outside the desktop shell): no UI, and not a single call reaches the shell
const native = spy();
assert.equal(accountUiEnabled(false, native), false);
assert.equal(accountUiEnabled(true, undefined), false);
assert.equal(accountUiEnabled(undefined, native), false, "the default is the build flag, which is off");
for (const client of [accountClient(false, native), accountClient(true, undefined), accountClient(undefined, native)]) {
  assert.equal(await client.status(), null);
  await assert.rejects(client.signInStart("github"), (e) => e === DISABLED);
  await assert.rejects(client.signInWait(), (e) => e === DISABLED);
  await assert.rejects(client.refresh(), (e) => e === DISABLED);
  await assert.rejects(client.signOut(), (e) => e === DISABLED);
}
assert.equal(native.calls.length, 0, "no shell call with the switch off");

// on, in the desktop shell: calls go to the account plugin only
const on = spy();
const client = accountClient(true, on);
assert.deepEqual(await client.status(), spy.status);
await client.signInStart("google");
await client.openVerification();
assert.deepEqual(on.calls, [["plugin:account|status", undefined], ["plugin:account|sign_in_start", { providerId: "google" }], ["plugin:account|open_verification", undefined]]);
// a shell whose plugin reports itself off counts as off
const offShell = { invoke: async () => ({ enabled: false, providers: [], profile: null }) };
assert.equal(await accountClient(true, offShell).status(), null);
const failing = { invoke: async () => { throw new Error("unknown command"); } };
assert.equal(await accountClient(true, failing).status(), null);

// labels
const gh = { provider: "github", id: "1", login: "octo", name: "Octo Cat", avatar_url: "https://avatars.githubusercontent.com/u/1", email: null, signed_in_at: 0 };
assert.equal(chipLabel(null), "Guest");
assert.equal(chipLabel(gh), "Octo Cat");
assert.equal(chipLabel({ ...gh, name: " " }), "octo");
assert.equal(identityLine(gh), "GitHub · @octo");
assert.equal(identityLine({ ...gh, provider: "google", login: null, email: "ada@x.test" }), "Google · ada@x.test");
assert.equal(initials("Octo Cat"), "OC");
assert.equal(initials("ada@x.test"), "AX");
assert.equal(safeAvatar(gh.avatar_url), gh.avatar_url);
assert.equal(safeAvatar("https://lh3.googleusercontent.com/a/x"), "https://lh3.googleusercontent.com/a/x");
assert.equal(safeAvatar("http://avatars.githubusercontent.com/u/1"), undefined);
assert.equal(safeAvatar("https://evil.test/githubusercontent.com"), undefined);
assert.equal(safeAvatar("javascript:alert(1)"), undefined);
assert.equal(optionalNote(), "Signing in is optional. Fairbeam works fully offline as a guest.");
assert.equal(DISABLED.message, "Signing in is not available in this build");

// every account component renders only behind accountUiEnabled(); none talks to the network or
// the shell itself (all calls go through src/lib/account.ts)
for (const file of ["AccountChip", "AccountDialog", "AccountSettings"]) {
  const src = read(`src/components/${file}.tsx`);
  assert.match(src, /return <Show when=\{(enabled|accountUiEnabled\(\)) && /, `${file} is not gated by the switch`);
  if (src.includes("const enabled")) assert.match(src, /const enabled = accountUiEnabled\(\);/);
}
for (const file of ["AccountChip", "AccountDialog", "AccountSettings", "AccountState"]) {
  const src = read(`src/components/${file}.tsx`);
  assert.doesNotMatch(src, /\bfetch\(|XMLHttpRequest|__TAURI_INTERNALS__|\.invoke\(/, `${file} calls out directly`);
}
assert.doesNotMatch(read("src/lib/account.ts"), /\bfetch\(|XMLHttpRequest/);
assert.match(read("src/components/Header.tsx"), /<AccountChip \/>/);
assert.match(read("src/components/GeneralSettings.tsx"), /<AccountSettings closeSettings=\{props\.close\} \/>/);
// status() is the only call made on start, and only when enabled
assert.match(read("src/components/AccountChip.tsx"), /onMount\(\(\) => \{ if \(enabled\) void loadAccountStatus\(\)/);

console.log("account UI hidden and silent with the switch off; client calls only the account plugin");
