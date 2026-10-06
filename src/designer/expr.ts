// The design-file expression language, evaluated in the browser for instant feedback in the
// inspector. Mirrors python/fairbeam/design.py (which stays the authority when the model is built):
// numbers, + - * / // % **, parentheses, parameter names, pi / c0 / eps0 / mu0 and the whitelisted
// maths functions. Python precedence: ** binds tighter than a unary minus on its left (-2**2 = -4)
// and is right-associative. Python's rules also for // and % on floats, round() (half to even),
// argument counts and domain errors (sqrt(-1), log(0), an overflow, a NaN or infinite number are
// errors, not NaN/inf). The shared cases in python/tests/fixtures/designer_parity.json are checked
// on both sides (scripts/check-designer.mjs).
//
// Numbers (the contract both evaluators keep): every value is an IEEE-754 double. A literal is read
// as the nearest double (9007199254740993 is 9007199254740992, as in JSON), every operation and
// function result is a double, and a literal, operation or function result that is not finite is
// an error (1e999, 1 / (1e308 * 10)). Python keeps its own number rules only where they agree with
// these: its exact integer arithmetic is not used, so 9007199254740993 - 9007199254740992 is 0 on
// both sides. + - * / // % and round / floor / ceil / abs / min / max / radians / degrees give the
// same bits on both sides; sqrt is exact too, while sin, log, exp, ** ... come from each runtime's
// maths library and may differ in the last bit (the fixture compares those to 1e-9 relative).
//
// Names: a parameter key is an ASCII identifier ([A-Za-z_][A-Za-z0-9_]*) that is not a function,
// a constant or a Python keyword (paramKeyError). Keys such as __proto__, constructor or toString
// are ordinary names: the lookups below use own properties only and the maps are prototype-free.

const C0 = 299_792_458;

/** Python's round(x[, n]): rounds the exact binary value (round(2.675, 2) = 2.67, as 2.675 is
 * stored as 2.67499...), exact ties to even (round(2.5) = 2), for any n (round(5e300, -301) =
 * 1e301). Like CPython, n above 323 keeps x and n below -308 gives 0. */
function pyRound(x: number, n = 0): number {
  if (!Number.isInteger(n)) throw new ExprError("round() digits must be a whole number");
  if (x === 0 || n > 323) return x;
  if (n < -308) return 0 * x;
  // |x| = m * 2^e exactly; |x| * 10^n = num / den, rounded to an integer q, ties to even
  const dv = new DataView(new ArrayBuffer(8));
  dv.setFloat64(0, Math.abs(x));
  const bits = dv.getBigUint64(0);
  const be = Number(bits >> 52n);
  const m = (bits & 0xfffffffffffffn) | (be ? 1n << 52n : 0n);
  const e = (be || 1) - 1075;
  const num = m * 2n ** BigInt(Math.max(e, 0)) * 10n ** BigInt(Math.max(n, 0));
  const den = 2n ** BigInt(Math.max(-e, 0)) * 10n ** BigInt(Math.max(-n, 0));
  let q = num / den;
  const r2 = (num % den) * 2n;
  if (r2 > den || (r2 === den && q % 2n === 1n)) q += 1n;
  const v = Number(`${q}e${-n}`); // correctly rounded, as Python's strtod
  return x < 0 ? -v : v;
}

/** Python's float // and %: fmod, then the result moved to the sign of the divisor (-7 % 3 = 2,
 * 1 // 0.1 = 9.0, not floor(1 / 0.1) = 10), as CPython's float_divmod. */
function pyDivmod(a: number, b: number): [number, number] {
  if (b === 0) throw new ExprError("division by zero");
  let mod = a % b; // JavaScript's % is C's fmod
  let div = (a - mod) / b;
  if (mod) {
    if (b < 0 !== mod < 0) { mod += b; div -= 1; }
  } else {
    mod = b < 0 ? -0 : 0;
  }
  let floordiv: number;
  if (div) {
    floordiv = Math.floor(div);
    if (div - floordiv > 0.5) floordiv += 1;
  } else {
    floordiv = a / b < 0 ? -0 : 0;
  }
  return [floordiv, mod];
}

/** Python's math.log(x[, base]) domain rules: log of x <= 0 is an error, not -inf/NaN. */
function pyLog(x: number, base?: number): number {
  if (x <= 0 || (base !== undefined && (base <= 0 || base === 1))) throw new ExprError("math domain error");
  return base === undefined ? Math.log(x) : Math.log(x) / Math.log(base);
}

const domain = (ok: boolean) => { if (!ok) throw new ExprError("math domain error"); };

/** A copy of `o` without a prototype: only its own keys are entries (no toString, __proto__ ...). */
function bare<T extends object>(o: T): T {
  return Object.assign(Object.create(null) as T, o);
}

/** The whitelisted functions with Python's argument counts ([min, max]) and domain errors. */
type Func = { fn: (...a: number[]) => number; args: [number, number] };
const FUNCS = bare<Record<string, Func>>({
  sqrt: { fn: (x) => (domain(x >= 0), Math.sqrt(x)), args: [1, 1] },
  sin: { fn: Math.sin, args: [1, 1] }, cos: { fn: Math.cos, args: [1, 1] }, tan: { fn: Math.tan, args: [1, 1] },
  asin: { fn: (x) => (domain(Math.abs(x) <= 1), Math.asin(x)), args: [1, 1] },
  acos: { fn: (x) => (domain(Math.abs(x) <= 1), Math.acos(x)), args: [1, 1] },
  atan: { fn: Math.atan, args: [1, 1] }, atan2: { fn: Math.atan2, args: [2, 2] },
  exp: { fn: Math.exp, args: [1, 1] }, log: { fn: pyLog, args: [1, 2] },
  log10: { fn: (x) => (domain(x > 0), Math.log10(x)), args: [1, 1] },
  abs: { fn: Math.abs, args: [1, 1] },
  min: { fn: Math.min, args: [2, Infinity] }, max: { fn: Math.max, args: [2, Infinity] },
  round: { fn: pyRound, args: [1, 2] },
  floor: { fn: Math.floor, args: [1, 1] }, ceil: { fn: Math.ceil, args: [1, 1] },
  // one multiplication by the rounded ratio, as CPython's math.radians / math.degrees (same last bit)
  radians: { fn: (d) => d * (Math.PI / 180), args: [1, 1] }, degrees: { fn: (r) => r * (180 / Math.PI), args: [1, 1] },
  wavelength: { fn: (fGHz) => (domain(fGHz !== 0), (C0 / (fGHz * 1e9)) * 1e3), args: [1, 1] },
});
const CONSTANTS = bare<Record<string, number>>({ pi: Math.PI, c0: C0, eps0: 8.8541878128e-12, mu0: 1.25663706212e-6 });
export const RESERVED = new Set([...Object.keys(FUNCS), ...Object.keys(CONSTANTS)]);
/** Python's keywords (keyword.kwlist, compared by scripts/check-designer.mjs): Python cannot
 * parse them as names, so they are not parameter keys. */
export const PY_KEYWORDS = new Set(["False", "None", "True", "and", "as", "assert", "async", "await", "break", "class",
  "continue", "def", "del", "elif", "else", "except", "finally", "for", "from", "global", "if", "import", "in", "is",
  "lambda", "nonlocal", "not", "or", "pass", "raise", "return", "try", "while", "with", "yield"]);
export class ExprError extends Error {}

const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/** A map from parameter keys that has no prototype: any key (__proto__ included) is an own entry. */
export function nameMap<T = number>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

/** Why `key` cannot be a parameter key, or null (design.py check_design refuses the same keys). */
export function paramKeyError(key: string): string | null {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return "use letters, digits and _, starting with a letter or _";
  if (RESERVED.has(key)) return "that is a function or constant name";
  if (PY_KEYWORDS.has(key)) return "that is a Python keyword";
  return null;
}

export type Tok = { t: "num"; v: number } | { t: "id"; v: string } | { t: "op"; v: string };

export function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/[ \t\n\r\f\v]/.test(c)) { i++; continue; } // ASCII whitespace only, as Python
    const num = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(src.slice(i));
    if (num) {
      const rest = src.slice(i + num[0].length);
      if (rest.startsWith("_") || (num[0] === "0" && /^[xXoObB]/.test(rest))) throw new Error("write plain decimal numbers (no 0x.., 0b.., 1_000)");
      if (/^0+[1-9]\d*$/.test(num[0])) throw new Error("leading zeros in a whole number are not allowed (write 7, not 07)");
      // the nearest double (atom() refuses one that overflows, such as 1e999)
      out.push({ t: "num", v: parseFloat(num[0]) }); i += num[0].length; continue;
    }
    const id = /^[A-Za-z_]\w*/.exec(src.slice(i));
    if (id) { out.push({ t: "id", v: id[0] }); i += id[0].length; continue; }
    const two = src.slice(i, i + 2);
    if (two === "**" || two === "//") { out.push({ t: "op", v: two }); i += 2; continue; }
    if ("+-*/%(),".includes(c)) { out.push({ t: "op", v: c }); i++; continue; }
    throw new Error(`unexpected '${c}'`);
  }
  return out;
}

const finite = (v: number) => {
  if (!Number.isFinite(v)) throw new ExprError("not a finite number");
  return v;
};

/** Parameter names an expression refers to (functions and constants excluded), like names_in(). */
export function namesIn(expr: number | string): Set<string> {
  const out = new Set<string>();
  if (typeof expr === "number") return out;
  let toks: Tok[];
  try {
    toks = tokenize(String(expr));
  } catch {
    return out;
  }
  toks.forEach((t, i) => {
    const next = toks[i + 1];
    if (t.t === "id" && !(next?.t === "op" && next.v === "(") && !own(CONSTANTS, t.v)) out.add(t.v);
  });
  return out;
}

/** Value of a number or expression; `names` maps parameter keys to numbers (own properties only:
 * an inherited toString or __proto__ is not a parameter). */
export function evaluate(expr: number | string, names: Record<string, number>): number {
  if (typeof expr === "number") return finite(expr);
  let toks: Tok[];
  try {
    toks = tokenize(String(expr));
  } catch (e) {
    throw new ExprError((e as Error).message);
  }
  if (!toks.length) throw new ExprError("empty");
  let k = 0;
  const peek = () => toks[k];
  const isOp = (v: string) => peek()?.t === "op" && peek()!.v === v;
  const expect = (v: string) => {
    if (!isOp(v)) throw new ExprError(`expected '${v}'`);
    k++;
  };
  // additive < multiplicative < unary < power < atom
  const additive = (): number => {
    let v = multiplicative();
    while (isOp("+") || isOp("-")) {
      const op = toks[k++].v;
      const r = multiplicative();
      v = finite(op === "+" ? v + r : v - r);
    }
    return v;
  };
  const multiplicative = (): number => {
    let v = unary();
    while (isOp("*") || isOp("/") || isOp("//") || isOp("%")) {
      const op = toks[k++].v;
      const r = unary();
      if ((op === "/" || op === "//" || op === "%") && r === 0) throw new ExprError("division by zero");
      v = finite(op === "*" ? v * r : op === "/" ? v / r : pyDivmod(v, r)[op === "//" ? 0 : 1]);
    }
    return v;
  };
  const unary = (): number => {
    if (isOp("-")) { k++; return -unary(); }
    if (isOp("+")) { k++; return unary(); }
    return power();
  };
  const power = (): number => {
    const base = atom();
    if (isOp("**")) {
      k++;
      const e = unary();
      if (base === 0 && e < 0) throw new ExprError("0.0 cannot be raised to a negative power");
      return finite(base ** e);
    }
    return base;
  };
  const atom = (): number => {
    const t = peek();
    if (!t) throw new ExprError("unexpected end");
    if (t.t === "num") { k++; return finite(t.v); }
    if (t.t === "op" && t.v === "(") { k++; const v = additive(); expect(")"); return v; }
    if (t.t === "id") {
      k++;
      if (isOp("(")) {
        const f = own(FUNCS, t.v) ? FUNCS[t.v] : undefined;
        if (!f) throw new ExprError(`unknown function ${t.v}()`);
        k++;
        const args: number[] = [];
        if (!isOp(")")) {
          args.push(additive());
          while (isOp(",")) { k++; args.push(additive()); }
        }
        expect(")");
        if (args.length < f.args[0] || args.length > f.args[1]) throw new ExprError(`${t.v}() takes ${f.args[0] === f.args[1] ? f.args[0] : `${f.args[0]} or more`} argument(s)`);
        return finite(f.fn(...args));
      }
      if (own(names, t.v)) return finite(names[t.v]);
      if (own(CONSTANTS, t.v)) return CONSTANTS[t.v];
      if (own(FUNCS, t.v)) throw new ExprError(`${t.v} is a function: ${t.v}(...)`);
      throw new ExprError(`unknown name ${t.v}`);
    }
    throw new ExprError(`unexpected '${t.v}'`);
  };
  const v = additive();
  if (k < toks.length) throw new ExprError(`unexpected '${toks[k].v}'`);
  if (!Number.isFinite(v)) throw new ExprError("not a finite number");
  return v;
}

/** Result for an inspector field: the value, or the error message. */
export function tryEvaluate(expr: number | string | undefined | null, names: Record<string, number>): { value?: number; error?: string } {
  if (expr === undefined || expr === null || expr === "") return { error: "empty" };
  try {
    return { value: evaluate(expr, names) };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

/** Independent defaults plus derived parameters, in order (same rule as resolve_names()). */
export function paramValues(params: { key: string; default?: number; expr?: string }[]): { names: Record<string, number>; errors: Record<string, string> } {
  const names = nameMap();
  const errors = nameMap<string>();
  for (const p of params) {
    if (p.expr !== undefined) {
      const r = tryEvaluate(p.expr, names);
      if (r.error) errors[p.key] = r.error;
      else names[p.key] = r.value!;
    } else if (typeof p.default === "number") {
      // a NaN or infinite default is an error, as check_design() makes it
      const r = tryEvaluate(p.default, {});
      if (r.error) errors[p.key] = r.error;
      else names[p.key] = r.value!;
    }
  }
  return { names, errors };
}

/** A number as the inspector shows it next to an expression. */
export function fmt(v: number): string {
  if (v === 0) return "0";
  const a = Math.abs(v);
  if (a >= 1e5 || a < 1e-3) return v.toExponential(3);
  return String(Math.round(v * 1e4) / 1e4);
}
