// Interpret the actual association macros in memory. This deliberately supports only
// their small NSIS subset and rejects unknown instructions; it never calls a DLL,
// accesses the registry, or runs an installer. NSIS compilation is a separate check.
import assert from "node:assert/strict";

const ext = "Software\\Classes\\.fb";
const progId = "Fairbeam document";
const ownClass = `Software\\Classes\\${progId}`;
const command = `${ownClass}\\shell\\open\\command`;
const openWith = `${ext}\\OpenWithProgids`;
const application = "Software\\Classes\\Applications\\fairbeam.exe";
const appCommand = `${application}\\shell\\open\\command`;
const supportedTypes = `${application}\\SupportedTypes`;
const pathA = "C:\\Program Files\\Fairbeam A";
const pathB = "C:\\Test Space\\Türkçe 文档\\Fairbeam B";
const quotedCommand = (path) => `"${path}\\fairbeam.exe" "%1"`;
const lower = (text) => text.toLowerCase();
const key = (path, name = "") => lower(`${path}\0${name}`);
const words = (line) => [...line.matchAll(/"[^"]*"|'[^']*'|`[^`]*`|[^\s]+/g)]
  .map(([word]) => /^["'`]/.test(word) ? word.slice(1, -1) : word);

function macroReader(source, constants) {
  const macros = new Map();
  let current;
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(";")) continue;
    const [op, name, ...params] = words(line);
    if (op === "!macro") { assert.equal(current, undefined); current = { name, params, lines: [] }; }
    else if (op === "!macroend") { assert.ok(current); macros.set(current.name, current); current = undefined; }
    else if (current) current.lines.push(line);
    else assert.ok(op === "!macroundef" && ["APP_ASSOCIATE", "APP_UNASSOCIATE"].includes(name));
  }
  assert.equal(current, undefined);
  function expand(name, args = [], definitions = constants) {
    if (name === "UPDATEFILEASSOC") { assert.equal(args.length, 0); return [["Notify"]]; }
    const macro = macros.get(name);
    assert.ok(macro, `Unknown macro ${name}`);
    assert.equal(args.length, macro.params.length);
    const values = { ...definitions, ...Object.fromEntries(macro.params.map((param, i) => [param, args[i]])) };
    const output = [], branches = [];
    let active = true;
    const condition = ([left, op, right]) => {
      assert.ok(["==", "!="].includes(op));
      return op === "==" ? left === right : left !== right;
    };
    for (const raw of macro.lines) {
      const line = raw.replace(/\$\{(\w+)\}/g, (_, value) => {
        assert.ok(Object.hasOwn(values, value), `Unknown definition ${value}`); return values[value];
      });
      const [op, ...parts] = words(line);
      if (op === "!if") {
        const matched = condition(parts); branches.push({ parent: active, matched }); active &&= matched;
      } else if (op === "!else") {
        const branch = branches.at(-1); assert.ok(branch);
        const matched = !branch.matched && (parts.length === 0 || (parts[0] === "if" && condition(parts.slice(1))));
        active = branch.parent && matched; branch.matched ||= matched;
      } else if (op === "!endif") { assert.ok(branches.length); active = branches.pop().parent; }
      else if (active && op === "!error") throw new Error(parts.join(" "));
      else if (active && op === "!insertmacro") output.push(...expand(parts[0], parts.slice(1), values));
      else if (active) { assert.ok(!op.startsWith("!"), `Unsupported directive ${op}`); output.push([op, ...parts]); }
    }
    assert.equal(branches.length, 0);
    return output;
  }
  return {
    install: () => expand("APP_ASSOCIATE", ["fb", progId, progId, "$INSTDIR\\fairbeam.exe,0", "Open with Fairbeam", "unused"]),
    uninstall: () => expand("APP_UNASSOCIATE", ["fb", progId]),
    expand,
  };
}

function registry() {
  return { user: new Map(), machine: new Map(), errors: new Map(), notifications: 0, queries: [], writes: [] };
}
function execute(instructions, state, path) {
  const variables = { $R0: "caller-R0", $INSTDIR: path }, stack = [];
  const labels = new Map(instructions.flatMap(([op], i) => op.endsWith(":") ? [[op.slice(0, -1), i]] : []));
  const expand = (arg) => arg.replace(/\$(?:INSTDIR|R0)/g, (name) => variables[name]);
  for (let pc = 0, steps = 0; pc < instructions.length; pc += 1, steps += 1) {
    assert.ok(steps < 200, "Instruction budget exceeded");
    const [op, ...raw] = instructions[pc], args = raw.map(expand);
    if (op.endsWith(":")) continue;
    if (op === "Push") stack.push(args[0]);
    else if (op === "Pop") { assert.ok(stack.length); variables[raw[0]] = stack.pop(); }
    else if (op === "StrCpy") variables[raw[0]] = args[1];
    else if (op === "StrCmp") {
      const target = lower(args[0]) === lower(args[1]) ? args[2] : args[3];
      if (target && target !== "0") { assert.ok(labels.has(target)); pc = labels.get(target); }
    } else if (op === "Notify") state.notifications += 1;
    else if (op === "System::Call") {
      // Inject documented presence statuses, not native ABI/merged-view behavior.
      const query = args[0].match(/^advapi32::RegGetValueW\(p (-214748364[78]), w "([^"]+)", w "", i (0x100[12]ffff), p 0, p 0, p 0\) i \.R0$/);
      assert.ok(query, `Unsupported native instruction ${args[0]}`);
      const [, root, subkey, flags] = query;
      const full = root === "-2147483647" ? subkey : `Software\\Classes\\${subkey}`;
      const present = state.user.has(key(full)) || (root === "-2147483648" && state.machine.has(key(full)));
      variables.$R0 = state.errors.get(`${root}|${subkey}`) ?? (present ? "0" : "2");
      state.queries.push({ root, subkey, flags });
    } else if (op === "ReadRegStr") {
      assert.equal(args[1], "SHCTX"); variables[raw[0]] = state.user.get(key(args[2], args[3])) ?? "";
    } else {
      const emptyOnly = op === "DeleteRegKey" && args[0] === "/ifempty";
      if (emptyOnly) args.shift();
      assert.equal(args[0], "SHCTX", "All mutations use the guarded current-user context");
      state.writes.push([op, ...(emptyOnly ? ["/ifempty"] : []), ...args.slice(1)]);
      if (op === "WriteRegStr") state.user.set(key(args[1], args[2]), args[3]);
      else if (op === "DeleteRegValue") state.user.delete(key(args[1], args[2]));
      else if (op === "DeleteRegKey") {
        if (emptyOnly && [...state.user.keys()].some((candidate) =>
          candidate.startsWith(`${lower(args[1])}\0`) || candidate.startsWith(`${lower(args[1])}\\`))) continue;
        for (const candidate of state.user.keys()) {
          if (candidate.startsWith(`${lower(args[1])}\0`) || candidate.startsWith(`${lower(args[1])}\\`)) state.user.delete(candidate);
        }
      } else assert.fail(`Unsupported instruction ${op}`);
    }
  }
  assert.equal(stack.length, 0); assert.equal(variables.$R0, "caller-R0", "Preserve caller register");
}

export function checkInstallerAssociations(source, identifier, installMode) {
  const constants = { BUNDLEID: identifier, INSTALLMODE: installMode, MAINBINARYNAME: "fairbeam", ARCH: "x64" };
  const macros = macroReader(source, constants), installCode = macros.install(), uninstallCode = macros.uninstall();
  let cases = 0;
  function run(body) {
    const state = registry();
    const install = (path = pathA) => {
      const before = state.user.get(key(ext)), notices = state.notifications;
      execute(installCode, state, path);
      if (before !== undefined) assert.equal(state.user.get(key(ext)), before, "Keep any existing default, including empty");
      assert.equal(state.user.get(key(command)), quotedCommand(path));
      assert.equal(state.user.get(key(openWith, progId)), "");
      assert.equal(state.user.get(key(application, "FriendlyAppName")), "Fairbeam");
      assert.equal(state.user.get(key(supportedTypes, ".fb")), "");
      assert.equal(state.user.get(key(appCommand)), quotedCommand(path));
      assert.equal(state.notifications, notices + 1);
    };
    const uninstall = (path = pathA) => {
      const before = state.user.get(key(ext)), notices = state.notifications, count = state.writes.length;
      const owned = lower(state.user.get(key(command)) ?? "") === lower(quotedCommand(path));
      const appOwned = lower(state.user.get(key(appCommand)) ?? "") === lower(quotedCommand(path));
      const appNameOwned = lower(state.user.get(key(application, "FriendlyAppName")) ?? "") === "fairbeam";
      execute(uninstallCode, state, path);
      assert.equal(state.user.get(key(ext)), before, "Never change the extension default on uninstall");
      assert.equal(state.notifications, notices + Number(owned) + Number(appOwned));
      assert.deepEqual(state.writes.slice(count), [...(owned ? [
        ["DeleteRegValue", openWith, progId], ["DeleteRegKey", ownClass],
      ] : []), ...(appOwned ? [
        ["DeleteRegValue", appCommand, ""], ["DeleteRegValue", supportedTypes, ".fb"],
        ...(appNameOwned ? [["DeleteRegValue", application, "FriendlyAppName"]] : []),
        ...[appCommand, `${application}\\shell\\open`, `${application}\\shell`, supportedTypes, application]
          .map((path) => ["DeleteRegKey", "/ifempty", path]),
      ] : [])]);
    };
    body(state, install, uninstall); cases += 1;
  }
  run((s, install, uninstall) => { install(); assert.equal(s.user.get(key(ext)), progId); assert.equal(s.queries.length, 4); uninstall(); });
  for (const value of ["", "Other.Handler", "Long.Handler.".repeat(100)]) {
    run((s, install, uninstall) => { s.user.set(key(ext), value); install(); uninstall(); assert.equal(s.user.get(key(ext)), value); });
  }
  for (const inherited of [ext, command]) {
    run((s, install, uninstall) => { s.machine.set(key(inherited), "Machine.Handler"); install(); assert.ok(!s.user.has(key(ext))); uninstall(); });
  }
  run((s, install, uninstall) => { install(); install(); install(); uninstall(); install(pathB); assert.equal(s.user.get(key(ext)), progId); });
  for (const value of ["", "Later.Handler", undefined]) {
    run((s, install, uninstall) => {
      install(); if (value === undefined) s.user.delete(key(ext)); else s.user.set(key(ext), value);
      install(pathB); assert.equal(s.user.get(key(ext)), value); uninstall(pathA);
      assert.equal(s.user.get(key(command)), quotedCommand(pathB));
      assert.equal(s.user.get(key(appCommand)), quotedCommand(pathB)); uninstall(pathB);
    });
  }
  // Accepted no-history boundary: uninstall-first reinstall after both values vanished.
  run((s, install, uninstall) => { install(); s.user.delete(key(ext)); uninstall(); install(pathB); assert.equal(s.user.get(key(ext)), progId); });
  for (const foreign of ['"C:\\Other\\other.exe" "%1"', `${pathA}\\fairbeam.exe "%1"`, `${quotedCommand(pathA)} --different`]) {
    run((s, install, uninstall) => {
      install(); s.user.set(key(command), foreign); s.user.set(key(appCommand), foreign);
      const before = new Map(s.user); uninstall(); assert.deepEqual(s.user, before);
    });
  }
  // The document class and Applications entry have independent lifecycles.
  // Cover absent, current, newer and foreign commands on both; preserve every
  // registry value outside the exact command-owned key(s).
  for (const classValue of [undefined, quotedCommand(pathA), quotedCommand(pathB), '"C:\\Other\\other.exe" "%1"']) {
    for (const appValue of [undefined, quotedCommand(pathA), quotedCommand(pathB), '"C:\\Other\\other.exe" "%1"']) {
      run((s, install, uninstall) => {
        install();
        if (classValue === undefined) s.user.delete(key(command)); else s.user.set(key(command), classValue);
        if (appValue === undefined) s.user.delete(key(appCommand)); else s.user.set(key(appCommand), appValue);
        const preserved = [...s.user].filter(([name]) =>
          !(classValue === quotedCommand(pathA) && (name.startsWith(`${lower(ownClass)}\\`) || name.startsWith(`${lower(ownClass)}\0`) || name === key(openWith, progId))) &&
          !(appValue === quotedCommand(pathA) && (name.startsWith(`${lower(application)}\\`) || name.startsWith(`${lower(application)}\0`))));
        uninstall();
        assert.deepEqual(s.user, new Map(preserved));
        const once = new Map(s.user); uninstall(); assert.deepEqual(s.user, once, "Uninstall is idempotent");
      });
    }
  }
  run((s, _install, uninstall) => {
    // Explicit executable choice can leave only an Applications registration.
    s.user.set(key(application, "FriendlyAppName"), "Fairbeam");
    s.user.set(key(appCommand), quotedCommand(pathA).toUpperCase());
    s.user.set(key(supportedTypes, ".fb"), "");
    uninstall(); assert.equal(s.user.size, 0);
  });
  for (const customName of [undefined, "My document app"]) {
    run((s, install, uninstall) => {
      install();
      const additions = [[key(supportedTypes, ".other"), ""], [key(appCommand, "OtherMetadata"), "keep"],
        [key(`${application}\\shell\\inspect\\command`), '"C:\\Other\\inspect.exe" "%1"'],
        [key(application, "CustomMetadata"), "keep"]];
      if (customName === undefined) s.user.delete(key(application, "FriendlyAppName"));
      else additions.push([key(application, "FriendlyAppName"), customName]);
      for (const [name, value] of additions) s.user.set(name, value);
      uninstall();
      for (const [name, value] of additions) assert.equal(s.user.get(name), value, "Preserve independent application metadata");
      assert.ok(!s.user.has(key(appCommand))); assert.ok(!s.user.has(key(supportedTypes, ".fb")));
    });
  }
  run((s, install, uninstall) => {
    const foreign = [[key(ext, "Content Type"), "application/other"], [key(openWith, "Other.Handler"), ""],
      [key(ext, "Fairbeam document_backup"), "Old.Handler"], [key("Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.fb\\UserChoice", "ProgId"), "User.Handler"]];
    foreign.push([key("Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.fb\\UserChoiceLatest", "ProgId"), "Applications\\fairbeam.exe"],
      [key("Software\\Classes\\Applications\\other.exe\\shell\\open\\command"), '"C:\\Other\\other.exe" "%1"']);
    for (const [name, value] of foreign) s.user.set(name, value);
    install(); uninstall(); for (const [name, value] of foreign) assert.equal(s.user.get(name), value);
  });
  for (const [root, subkey] of [["-2147483647", ext], ["-2147483648", ".fb"], ["-2147483647", command], ["-2147483648", `${progId}\\shell\\open\\command`]]) {
    for (const status of ["0", "5", "234", "1630", "error"]) {
      run((s, install) => { s.errors.set(`${root}|${subkey}`, status); install(); assert.ok(!s.user.has(key(ext)), `Do not claim on ${status} at ${subkey}`); });
    }
  }
  for (const ARCH of ["x64", "arm64", "x86"]) {
    const state = registry(); execute(macroReader(source, { ...constants, ARCH }).install(), state, pathA);
    assert.equal(state.queries.length, 4);
    assert.ok(state.queries.every(({ flags }) => flags === (ARCH === "x86" ? "0x1002ffff" : "0x1001ffff")));
  }
  for (const changed of [{ BUNDLEID: `${identifier}.preview` }, { INSTALLMODE: "perMachine" }]) {
    const rejected = macroReader(source, { ...constants, ...changed });
    assert.throws(() => rejected.install()); assert.throws(() => rejected.uninstall());
  }
  for (const args of [["json", progId], ["fb", "Other class"]]) assert.throws(() => macros.expand("APP_UNASSOCIATE", args));
  // A preview with no configured associations never expands the guarded macros.
  macroReader(source, { ...constants, BUNDLEID: `${identifier}.preview` });
  console.log(`check-installer-associations: ${cases} in-memory lifecycle cases; views and dispatch guards pass (no native execution)`);
}
