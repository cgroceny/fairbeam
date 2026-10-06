// Reactive code that runs while a component mounts must not read a const declared further down.
// createMemo, createComputed, createRenderEffect, createSelector and createResource run their function
// at once, so a helper they call that is declared after them is still in its temporal dead zone and the
// component throws "Cannot access 'x' before initialization": the geometry export's
// CST macro memo called the file-stem helper declared below it; outside the Design tab the bundle is
// there at once and the format starts as CST, so the dialog crashed on open). createEffect, onMount,
// event handlers and other callbacks run after the component body, so they may read anything.
//
// This walks every function body (and every module's top level) in src/ and, for each statement in
// order, follows the code that runs while that statement is evaluated: initialisers, the function given
// to an eager reactive primitive, IIFEs, array callbacks, and local helpers called from there
// (transitively). A read of a const/let/class of the same body that is declared at or after that
// statement is reported.
//
//   node scripts/check-reactive-order.mjs
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "@babel/parser";
import traverseModule from "@babel/traverse";
import { VISITOR_KEYS } from "@babel/types";

const traverse = traverseModule.default ?? traverseModule;
const root = fileURLToPath(new URL("../", import.meta.url));

/** functions whose function arguments run immediately (Solid primitives, IIFE-like helpers, array callbacks) */
const EAGER_CALLS = new Set([
  "createMemo", "createComputed", "createRenderEffect", "createSelector", "createResource", "createRoot",
  "untrack", "batch", "runWithOwner", "catchError",
  "map", "forEach", "filter", "find", "findIndex", "findLast", "findLastIndex", "some", "every", "reduce", "reduceRight",
  "flatMap", "sort", "toSorted", "from",
]);
/** Solid primitives whose computation runs at once: an `on(deps, fn)` given to one runs fn at once unless deferred */
const EAGER_REACTIVE = new Set(["createMemo", "createComputed", "createRenderEffect", "createSelector"]);

const calleeName = (callee) =>
  callee.type === "Identifier" ? callee.name
  : (callee.type === "MemberExpression" || callee.type === "OptionalMemberExpression") && !callee.computed && callee.property.type === "Identifier" ? callee.property.name
  : null;
const isFunction = (p) => p.isArrowFunctionExpression() || p.isFunctionExpression();
const deferredOn = (call) => {
  const opts = call.get("arguments")[2];
  return !!opts?.isObjectExpression() && opts.node.properties.some((prop) => prop.type === "ObjectProperty" && !prop.computed
    && (prop.key.name ?? prop.key.value) === "defer" && prop.value.type === "BooleanLiteral" && prop.value.value);
};

/**
 * Report reads of `scope`'s block-scoped bindings that happen while `unit` (a top-level statement or declarator
 * of that scope) is evaluated, before they are initialised. `units` are the scope's evaluation units in order.
 */
function analyseBody(scope, units, file, problems) {
  for (const unit of units) {
    const visitedHelpers = new Set();
    const at = unit.node.start;
    const tdz = (binding) => {
      if (!binding || binding.scope !== scope || !["const", "let", "class"].includes(binding.kind)) return false;
      return binding.path.node.start >= at; // the declarator (or class) that initialises it
    };
    const report = (ref, why) => {
      const line = ref.node.loc?.start.line ?? 0;
      problems.push(`${file}:${line}: '${ref.node.name}' is read ${why} before its declaration (line ${scope.getBinding(ref.node.name).path.node.loc?.start.line})`);
    };
    /** a local helper (const f = () => …, or function f() {}) of the same body, called while the unit runs */
    const helperBody = (id) => {
      const binding = id.scope.getBinding(id.node.name);
      if (!binding || binding.scope !== scope || tdz(binding)) return null;
      if (binding.kind === "hoisted" && binding.path.isFunctionDeclaration()) return binding.path;
      if (binding.kind === "const" && binding.path.isVariableDeclarator()) {
        const init = binding.path.get("init");
        if (init.node && isFunction(init)) return init;
      }
      return null;
    };
    const runHelper = (id, why) => {
      const fn = helperBody(id);
      if (!fn || visitedHelpers.has(fn.node)) return;
      visitedHelpers.add(fn.node);
      walk(fn.get("body"), `${why} via ${id.node.name}()`);
    };
    const runFunctionArg = (arg, why) => {
      if (isFunction(arg)) walk(arg.get("body"), why);
      else if (arg.isIdentifier()) runHelper(arg, why);
    };
    /** walk code that runs now; function bodies are skipped unless something calls them now */
    function walk(path, why) {
      if (!path?.node) return;
      if (path.isFunction() || path.isClassMethod() || path.isObjectMethod()) return;
      if (path.isTSType?.() || path.isTSTypeAnnotation() || path.isTSInterfaceDeclaration() || path.isTSTypeAliasDeclaration()) return;
      if (path.isIdentifier() || path.isJSXIdentifier()) {
        if (path.isReferencedIdentifier() && tdz(path.scope.getBinding(path.node.name))) report(path, why);
        return;
      }
      if (path.isCallExpression() || path.isOptionalCallExpression() || path.isNewExpression()) {
        const callee = path.get("callee");
        const name = calleeName(callee.node);
        const args = path.get("arguments");
        if (isFunction(callee)) walk(callee.get("body"), `${why} (IIFE)`);
        else if (callee.isIdentifier()) runHelper(callee, why);
        const eager = path.isNewExpression() ? name === "Promise" : EAGER_CALLS.has(name);
        for (const arg of args) {
          if (eager && (isFunction(arg) || arg.isIdentifier())) runFunctionArg(arg, `${why} in ${name}()`);
          else if (EAGER_REACTIVE.has(name) && arg.isCallExpression() && calleeName(arg.node.callee) === "on") {
            const [deps, fn] = arg.get("arguments");
            if (deps && isFunction(deps)) walk(deps.get("body"), `${why} in ${name}(on())`);
            else walk(deps, why);
            if (fn && !deferredOn(arg)) runFunctionArg(fn, `${why} in ${name}(on())`);
          } else walk(arg, why);
        }
        if (!isFunction(callee)) walk(callee, why);
        return;
      }
      for (const key of VISITOR_KEYS[path.node.type] ?? []) {
        const child = path.get(key);
        if (Array.isArray(child)) child.forEach((c) => walk(c, why));
        else walk(child, why);
      }
    }
    if (unit.isVariableDeclarator()) {
      // the declarator's own pattern is not a read; its initialiser runs now
      walk(unit.get("init"), "while the component (or module) is set up");
    } else if (!unit.isReturnStatement() && !unit.isFunctionDeclaration() && !unit.isClassDeclaration()) {
      walk(unit, "while the component (or module) is set up");
    }
  }
}

/** evaluation units of a body: each declarator of a variable statement, or the statement itself */
function unitsOf(statements) {
  const units = [];
  for (const s of statements) {
    const decl = s.isExportNamedDeclaration() ? s.get("declaration") : s;
    if (decl?.node && decl.isVariableDeclaration()) units.push(...decl.get("declarations"));
    else if (decl?.node && !decl.isTSTypeAliasDeclaration() && !decl.isTSInterfaceDeclaration() && !decl.isImportDeclaration()) units.push(decl);
  }
  return units;
}

export function reactiveOrderProblems(source, file) {
  const ast = parse(source, { sourceType: "module", plugins: ["typescript", "jsx"] });
  const problems = [];
  traverse(ast, {
    Program(path) { analyseBody(path.scope, unitsOf(path.get("body")), file, problems); },
    Function(path) {
      const body = path.get("body");
      if (body.isBlockStatement()) analyseBody(path.scope, unitsOf(body.get("body")), file, problems);
    },
  });
  return problems;
}

// ---- the detector catches the shape of, and leaves the safe shapes alone
const crash = `export default function Dialog() {
  const [source] = createSignal(1);
  const result = createMemo(() => { const b = source(); return b ? build(b, { macroBase: macroBase() }) : null; });
  const macroBase = () => String(source());
  return <p>{result()}</p>;
}`;
assert.equal(reactiveOrderProblems(crash, "crash.tsx").length, 1, "a memo calling a helper declared below it is reported");
assert.match(reactiveOrderProblems(crash, "crash.tsx")[0], /'macroBase' is read .* in createMemo\(\)/);
const transitive = `function C() {
  const label = () => count();
  const shown = createMemo(() => label());
  const count = () => 2;
}`;
assert.equal(reactiveOrderProblems(transitive, "t.tsx").length, 1, "a memo reaching a later helper through an earlier one is reported");
const onDeps = `function C() {
  createComputed(on(a, () => b()));
  createMemo(on(a, () => c(), { defer: true }));
  const a = () => 1, b = () => 2, c = () => 3;
}`;
assert.deepEqual(reactiveOrderProblems(onDeps, "o.tsx").map((p) => p.match(/'(\w+)'/)[1]), ["a", "b", "a"], "on(): deps are read at once, a deferred fn is not");
const safe = `function C() {
  const [n, setN] = createSignal(0);
  const twice = () => n() * 2;
  const memo = createMemo(() => twice());
  createEffect(() => later());
  onMount(() => later());
  const handler = () => later();
  const later = () => setN(1);
  function hoisted() { return n(); }
  const viaHoisted = createMemo(() => hoisted());
  const shadow = createMemo(() => [1].map((later) => later + 1));
  return <button onClick={handler}>{memo()} {later()}</button>;
}`;
assert.deepEqual(reactiveOrderProblems(safe, "safe.tsx"), [], "effects, handlers, earlier helpers, hoisted functions and the JSX are not reported");

// ---- every source file
const files = [];
(function collect(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) collect(full);
    else if (/\.(tsx?|jsx?)$/.test(name) && !name.endsWith(".d.ts")) files.push(full);
  }
})(join(root, "src"));
assert.ok(files.length > 100, "the src tree was read");
const problems = files.flatMap((full) => reactiveOrderProblems(readFileSync(full, "utf8"), relative(root, full).replaceAll("\\", "/")));
assert.deepEqual(problems, [], `reactive code reads a declaration before it is initialised:\n${problems.join("\n")}`);
console.log(`check-reactive-order: ok (${files.length} files, no memo or computation reads a later declaration)`);
