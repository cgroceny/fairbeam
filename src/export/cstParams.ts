// Design parameters and expressions for the CST export (src/export/cst.ts).
//
// A design parameter becomes a CST parameter (StoreParameter), and a design expression becomes the
// CST expression over those parameters. The translation is checked in CST 2026.2: every function
// below resolves there and gives the value fairbeam's evaluator gives. the CST `Sqr` is the square
// root, `Atn` the arc tangent, `log` the natural logarithm, `Int` rounds down, trigonometry is in
// radians, and `^` binds like Python's `**`.
//
// Only erasable TypeScript syntax is used (the file runs under `node --experimental-strip-types`).

import { namesIn, paramValues, tokenize, evaluate, type Tok } from "../designer/expr.ts";

export interface DesignParam { key: string; default?: number; expr?: string; label?: string; description?: string; unit?: string }

/** Names CST refuses for a parameter (measured in CST 2026.2: StoreParameter fails for them) and VBA words, lower case. */
const CST_RESERVED = new Set([
  "sin", "cos", "tan", "pi", "eps0", "mu0", "exp", "log", "sqr", "abs", "min", "max", "mod", "ln", "atn", "int", "fix", "sgn", "round",
  "true", "false", "dim", "if", "end", "step", "next", "const", "option", "and", "or", "not", "xor", "imp", "eqv", "date", "time", "name",
  "type", "error", "rem", "sub", "new", "for", "to", "do", "loop", "while", "wend", "select", "case", "else", "then", "set", "let", "call",
  "with", "function", "is", "like", "empty", "null", "nothing", "string", "integer", "long", "double", "single", "boolean", "byte", "variant",
  "object", "public", "private", "static", "exit", "goto", "on", "redim", "preserve", "erase", "print", "input", "open", "close", "get", "put",
  "as", "byval", "byref", "optional", "enum", "property", "class", "me", "sqrt", "atan", "floor", "ceil",
]);

/** The CST name of every design parameter key: letters, digits and _, not reserved, unique without regard to case. */
export function cstNames(keys: string[]): Map<string, string> {
  const out = new Map<string, string>();
  const used = new Set<string>();
  for (const key of keys) {
    let base = key.replace(/[^A-Za-z0-9_]/g, "_").replace(/^_+/, "") || "p";
    if (/^[0-9]/.test(base)) base = `p_${base}`;
    if (CST_RESERVED.has(base.toLowerCase())) base = `${base}_p`;
    let name = base;
    for (let k = 2; used.has(name.toLowerCase()); k++) name = `${base}_${k}`;
    used.add(name.toLowerCase());
    out.set(key, name);
  }
  return out;
}

type Node =
  | { k: "num"; v: number }
  | { k: "name"; v: string }
  | { k: "un"; op: "-" | "+"; a: Node }
  | { k: "bin"; op: string; a: Node; b: Node }
  | { k: "call"; f: string; args: Node[] };

class Unsupported extends Error {}

function parse(src: string): Node {
  const toks: Tok[] = tokenize(src);
  let k = 0;
  const isOp = (v: string) => toks[k]?.t === "op" && toks[k].v === v;
  const additive = (): Node => {
    let v = multiplicative();
    while (isOp("+") || isOp("-")) { const op = String(toks[k++].v); v = { k: "bin", op, a: v, b: multiplicative() }; }
    return v;
  };
  const multiplicative = (): Node => {
    let v = unary();
    while (isOp("*") || isOp("/") || isOp("//") || isOp("%")) { const op = String(toks[k++].v); v = { k: "bin", op, a: v, b: unary() }; }
    return v;
  };
  const unary = (): Node => {
    if (isOp("-") || isOp("+")) { const op = String(toks[k++].v) as "-" | "+"; return { k: "un", op, a: unary() }; }
    return power();
  };
  const power = (): Node => {
    const base = atom();
    if (isOp("**")) { k++; return { k: "bin", op: "**", a: base, b: unary() }; }
    return base;
  };
  const atom = (): Node => {
    const t = toks[k++];
    if (!t) throw new Unsupported("unexpected end");
    if (t.t === "num") return { k: "num", v: t.v };
    if (t.t === "op" && t.v === "(") {
      const v = additive();
      if (!isOp(")")) throw new Unsupported("expected )");
      k++;
      return v;
    }
    if (t.t === "id") {
      if (isOp("(")) {
        k++;
        const args: Node[] = [];
        if (!isOp(")")) { args.push(additive()); while (isOp(",")) { k++; args.push(additive()); } }
        if (!isOp(")")) throw new Unsupported("expected )");
        k++;
        return { k: "call", f: t.v, args };
      }
      return { k: "name", v: t.v };
    }
    throw new Unsupported(`unexpected ${String(t.v)}`);
  };
  const v = additive();
  if (k < toks.length) throw new Unsupported(`unexpected ${String(toks[k].v)}`);
  return v;
}

// precedence levels of what is printed
// (a unary minus sits between + - and * /, so it is always written in parentheses next to an operator)
const ADD = 1, UNARY = 1.5, MUL = 2, POW = 4, ATOM = 5;
type Out = { s: string; lv: number };
const wrap = (o: Out, lv: number) => (o.lv >= lv ? o.s : `(${o.s})`);

const CONST_TEXT: Record<string, string> = { pi: "pi", c0: "299792458", eps0: "8.8541878128e-12", mu0: "1.25663706212e-6" };
/** Functions that are the same in CST. */
const SAME = new Set(["sin", "cos", "tan", "asin", "acos", "exp", "abs"]);

function print(n: Node, nameOf: (key: string) => string | undefined): Out {
  switch (n.k) {
    case "num": return { s: String(n.v), lv: ATOM };
    case "name": {
      const c = nameOf(n.v);
      if (c !== undefined) return { s: c, lv: ATOM };
      if (Object.prototype.hasOwnProperty.call(CONST_TEXT, n.v)) return { s: CONST_TEXT[n.v], lv: ATOM };
      throw new Unsupported(`unknown name ${n.v}`);
    }
    case "un": {
      const a = print(n.a, nameOf);
      return n.op === "+" ? a : { s: `-${wrap(a, POW)}`, lv: UNARY };
    }
    case "bin": {
      const a = print(n.a, nameOf), b = print(n.b, nameOf);
      switch (n.op) {
        case "+": return { s: `${wrap(a, ADD)} + ${wrap(b, MUL)}`, lv: ADD };
        case "-": return { s: `${wrap(a, ADD)} - ${wrap(b, MUL)}`, lv: ADD };
        case "*": return { s: `${wrap(a, UNARY)}*${wrap(b, POW)}`, lv: MUL };
        case "/": return { s: `${wrap(a, UNARY)}/${wrap(b, POW)}`, lv: MUL };
        case "**": return { s: `${wrap(a, ATOM)}^${wrap(b, ATOM)}`, lv: POW };
        // Python floors: Int rounds down in CST
        case "//": return { s: `Int(${a.s}/${wrap(b, POW)})`, lv: ATOM };
        // Python's % takes the sign of the divisor: a - b * floor(a / b)
        case "%": return { s: `(${wrap(a, ADD)} - ${wrap(b, POW)}*Int(${a.s}/${wrap(b, POW)}))`, lv: ATOM };
      }
      throw new Unsupported(`operator ${n.op}`);
    }
    case "call": {
      const args = n.args.map((x) => print(x, nameOf));
      const f = n.f, a0 = args[0];
      if (SAME.has(f)) return { s: `${f}(${a0.s})`, lv: ATOM };
      switch (f) {
        case "sqrt": return { s: `Sqr(${a0.s})`, lv: ATOM };
        case "atan": return { s: `Atn(${a0.s})`, lv: ATOM };
        case "log": return args.length === 1 ? { s: `log(${a0.s})`, lv: ATOM } : { s: `(log(${a0.s})/log(${args[1].s}))`, lv: ATOM };
        case "log10": return { s: `(log(${a0.s})/log(10))`, lv: ATOM };
        case "min":
        case "max": {
          let acc = args[args.length - 1].s;
          for (let i = args.length - 2; i >= 0; i--) acc = `${f}(${args[i].s}, ${acc})`;
          return { s: acc, lv: ATOM };
        }
        case "round":
          if (args.length === 1) return { s: `round(${a0.s})`, lv: ATOM };
          throw new Unsupported("round(x, digits) has no CST equivalent");
        case "floor": return { s: `Int(${a0.s})`, lv: ATOM };
        case "ceil": return { s: `(-Int(-${wrap(a0, POW)}))`, lv: ATOM };
        case "radians": return { s: `(${wrap(a0, MUL)}*pi/180)`, lv: ATOM };
        case "degrees": return { s: `(${wrap(a0, MUL)}*180/pi)`, lv: ATOM };
        // free-space wavelength in mm at f GHz: 299792458 / (f * 1e9) * 1e3
        case "wavelength": return { s: `(299.792458/${wrap(a0, POW)})`, lv: ATOM };
        case "atan2": throw new Unsupported("atan2 has no CST equivalent");
      }
      throw new Unsupported(`function ${f}`);
    }
  }
}

/** A parameter table and the translation of expressions over it. */
export class Symbols {
  params: DesignParam[];
  /** the design key -> CST name */
  names: Map<string, string>;
  /** value of every parameter */
  values: Record<string, number>;
  /** fields written as numbers because their expression could not be translated or did not match the geometry */
  numeric: string[] = [];
  /** how many fields were written as CST expressions */
  expressions = 0;
  constructor(params: DesignParam[]) {
    this.params = params;
    this.names = cstNames(params.map((p) => p.key));
    this.values = paramValues(params).names;
  }
  /** Whether the field is an expression over parameters (a plain number, even as text, is not). */
  isSymbolic(e: unknown): e is string {
    if (typeof e !== "string") return false;
    return [...namesIn(e)].some((k) => this.names.has(k));
  }
  value(e: number | string): number | null {
    try { return evaluate(e, this.values); } catch { return null; }
  }
  /** The CST expression of a design expression, or why it has none. */
  text(e: string): { s: string } | { why: string } {
    try {
      return { s: print(parse(e), (k) => this.names.get(k)).s };
    } catch (err) {
      return { why: (err as Error).message };
    }
  }
  /** A field's CST expression when it is a parameter expression that translates and evaluates to `want`
   * (within the bundle's rounding); else null. Misses are recorded under `where`. */
  field(e: unknown, want: number, where: string, tol = 1e-5): string | null {
    if (!this.isSymbolic(e)) return null;
    const v = this.value(e);
    if (v === null || !(Math.abs(v - want) <= tol * Math.max(1, Math.abs(want)))) {
      this.numeric.push(`${where}: ${e} (the exported geometry is not that expression's value: written as ${want})`);
      return null;
    }
    const t = this.text(e);
    if ("why" in t) {
      this.numeric.push(`${where}: ${e} (${t.why}: written as ${want})`);
      return null;
    }
    this.expressions++;
    return t.s;
  }
}
