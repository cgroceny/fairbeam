"""Import a CST Studio Suite VBA macro (a model history) as a design (the reverse of src/export/cst.ts).

Accepted input:

* a macro as fairbeam exports it, or as CST records one: ``Sub Main`` with ``sCommand = sCommand +
  "..." + vbLf`` lines and ``AddToHistory "title", sCommand`` (the history commands are read from
  the strings; ``+``/``&``, ``vbLf``/``vbCrLf``/``vbNewLine`` and ``Chr(n)`` are understood);
* statements written directly in the macro (``With Brick ... End With``, ``StoreParameter ...``);
* a history list pasted as text (``'@ define brick: component1:solid1`` headers are the titles).

Only the CST history subset that has an exact design equivalent is imported (see ``SUPPORTED`` for
the list); everything else becomes a note of the import report and is never dropped silently.
VBA itself is not executed: control flow (If, For) and VBA variables are reported, not evaluated.

Numbers stay expressions where the design's expression syntax can hold them: CST parameters become
design parameters (a plain value: an independent one; an expression: a derived one, in dependency
order) and ``^`` -> ``**``, ``Sqr`` -> ``sqrt``, ``Atn`` -> ``atan``, ``Pi`` -> ``pi``, ``Mod`` ->
``%``, ``\\`` -> ``//`` ... are translated. Lengths are converted to mm and frequencies to GHz;
plain coordinates are rounded to 1e-6 mm (the precision the automatic mesh places its lines with,
as fairbeam.example_design does), so ports land on mesh lines.

fairbeam's own exports carry ``' fairbeam-data: {...}`` comments with what CST cannot hold (the
exact openEMS port and resistor boxes, the boundary types); they are used only where they agree
with the CST commands next to them, so a macro edited in CST is read from its CST commands.
"""

from __future__ import annotations

import copy
import json
import keyword
import math
import re
import unicodedata

from .design import (AXES, DESIGN_SCHEMA, DesignError, boolean_primitives, check_design,
                     evaluate, in_plane, param_key_error, prim_bbox, resolve_names, resolve_parts, resolve_primitive,
                     sheet_transform_issues, transform_maps)
from .legacy import CST_HELPER_RE, CST_MAKER_RE, CST_MARKER_RE, is_reserved_name

# openEMS.physical_constants.EPS0 (the value the build turns tan δ into a conductivity with)
EPS0 = 8.854187817620389e-12
DEFAULT_CPW = 20
# openEMS priorities of a cut the design Booleans can't make (_Importer.cavity): the body, the vacuum shape
# of the cut above it, dielectrics filling the cavity above that; metal (10) and ports (5) stay on top
CAVITY_HOST, CAVITY_CUT, CAVITY_FILL = 1, 2, 3
# polygon coordinates closer than this (mm) are one coordinate (_tidy_outline)
OUTLINE_TOL = 0.01
# metal at most this thick (mm) is imported as a zero-thickness sheet (_Importer._thin_metal_sheets)
THIN_METAL = 0.1
THIN_WIRE_RADIUS = 0.01   # mm: the radius given to a CST curve wire of radius 0
CIRCLE_SEGMENTS = 64
MAX_SOURCE = 4_000_000
# bounds on what a (hostile or broken) macro can make the import do: the history text its string
# variables build (s = s + s doubles it), the tokens and nesting of one expression, the shapes,
# transforms per shape and nested Booleans per solid (each of these is refused beyond the bound)
MAX_HISTORY_TEXT = 4 * MAX_SOURCE
MAX_STRING_WORK = 4 * MAX_SOURCE
MAX_EXPR_TOKENS = 500
MAX_EXPR_DEPTH = 64
MAX_SOLIDS = 5000
MAX_TRANSFORMS = 64
MAX_BOOLEAN_DEPTH = 64
# the automatic mesh of exported settings is rebuilt (_keep_exported_lines) only below this many lines
# per axis (a runnable model has a few hundred; the cell limit allows a few thousand)
MAX_REBUILD_LINES = 20000

SUPPORTED = {
    "parameters": "StoreParameter, StoreDoubleParameter, MakeSureParameterExists, StoreParameterWithDescription, "
                  "SetParameterDescription, DeleteParameter",
    "units": "Units (.SetUnit / .Geometry / .Frequency / .Resistance)",
    "materials": "Material (.Type Normal / Pec / Lossy metal, .Epsilon, .Mu, .Sigma / .Kappa, .TanD, .TanDFreq, "
                 ".TanDGiven, .Folder, .Colour)",
    "shapes": "Brick, Cylinder (inner radius: a tube), Cone, Sphere, Torus; curves Polygon, Polygon3D, Rectangle, "
              "Circle with Curve.NewCurve, CoverCurve, ExtrudeCurve, Extrude (point list); STL (a polyhedron, "
              "read from the .stl file Fairbeam's export writes next to the macro)",
    "structure": "Component.New / Delete, Solid.Add / Subtract / Intersect / Insert / Delete / Rename / "
                 "ChangeMaterial / ChangeComponent, Transform (translate, rotate by any angle, mirror, "
                 "uniform scale; with copies), WCS (axis-aligned local systems)",
    "simulation": "Solver.FrequencyRange, Solver .SteadyStateLimit, Boundary, Mesh .LinesPerWavelength / "
                  "hexahedral MeshSettings StepsPerWaveNear / StepsPerWaveFar, DiscretePort, DiscreteFacePort, "
                  "LumpedElement (R, L, C; series or parallel),WaveguidePort (Free coordinates), Monitor (Farfield, H-field / surface "
                  "current)",
}

LENGTH_MM = {"m": 1e3, "cm": 10.0, "mm": 1.0, "um": 1e-3, "nm": 1e-6, "mil": 0.0254, "in": 25.4, "ft": 304.8}
FREQ_GHZ = {"hz": 1e-9, "khz": 1e-6, "mhz": 1e-3, "ghz": 1.0, "thz": 1e3, "phz": 1e6}
OHM = {"ohm": 1.0, "kohm": 1e3, "mohm": 1e6}
HENRY = {"h": 1.0, "mh": 1e-3, "uh": 1e-6, "nh": 1e-9, "ph": 1e-12, "fh": 1e-15}
FARAD = {"f": 1.0, "mf": 1e-3, "uf": 1e-6, "nf": 1e-9, "pf": 1e-12, "ff": 1e-15}
BOUNDARY = {"electric": "PEC", "magnetic": "PMC", "open": "MUR", "expanded open": "MUR"}
FACES = ("Xmin", "Xmax", "Ymin", "Ymax", "Zmin", "Zmax")
META_FACES = ("x-", "x+", "y-", "y+", "z-", "z+")
_METALISH = re.compile(r"pec|copper|alumin|gold|silver|brass|steel|nickel|tin|zinc|metal|conductor", re.I)


_DOTLESS = str.maketrans({"\u0131": "i", "\u0130": "I"})


class CstImportError(ValueError):
    """The text is not a CST macro at all (nothing to import)."""


class _Refuse(Exception):
    """One history item cannot be imported; the message goes into the report."""


class _Quiet(_Refuse):
    """Part of an item already reported (a command on a solid whose STL file was not supplied): skipped, no extra note."""


# ---------------------------------------------------------------------------- expressions

def _num_text(v: float) -> str:
    """A number as the design expression syntax writes it (plain decimal or exponent form)."""
    v = float(v) + 0.0
    if v.is_integer() and abs(v) < 1e15:
        return str(int(v))
    return repr(v)


_ATOM = re.compile(r"^(?:[A-Za-z_]\w*|\d+(?:\.\d*)?(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)$")


def _p(e) -> str:
    """``e`` as an operand: a number or name as it is, anything else in parentheses."""
    if isinstance(e, (int, float)):
        return _num_text(e) if e >= 0 else f"({_num_text(e)})"
    s = str(e).strip()
    if _ATOM.match(s):
        return s
    # a call like sqrt(x) is an operand as well
    if re.match(r"^[A-Za-z_]\w*\(", s) and _balanced_call(s):
        return s
    return f"({s})"


def _balanced_call(s: str) -> bool:
    depth = 0
    for i, ch in enumerate(s):
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
            if depth == 0 and i != len(s) - 1:
                return False
    return depth == 0


def _is_term(s: str) -> bool:
    """Whether an expression has no top-level binary + or - (a product, quotient, power or atom)."""
    depth, prev = 0, None
    for m in re.finditer(r"\s*((?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|[A-Za-z_]\w*|\*\*|//|.)", s):
        tok = m.group(1)
        if tok == "(":
            depth += 1
        elif tok == ")":
            depth -= 1
        elif tok in "+-" and depth == 0 and prev is not None and (prev == ")" or re.match(r"[\w.]", prev)):
            return False
        prev = tok
    return True


def _txt(a) -> str:
    return a if isinstance(a, str) else _num_text(a)


def _add(a, b):
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return a + b
    if isinstance(a, (int, float)) and a == 0:
        return b
    if isinstance(b, (int, float)) and b == 0:
        return a
    if isinstance(b, (int, float)) and b < 0:
        return f"{_txt(a)} - {_num_text(-b)}"
    if isinstance(b, str) and b.startswith("-") and _is_term(b[1:]):
        return f"{_txt(a)} - {b[1:]}"
    return f"{_txt(a)} + {_txt(b)}"


def _neg(a):
    if isinstance(a, (int, float)):
        return -a + 0.0
    if a.startswith("-") and _is_term(a[1:]):
        return a[1:]
    return f"-{a}" if _is_term(a) else f"-({a})"


def _sub(a, b):
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return a - b
    if isinstance(b, (int, float)) and b == 0:
        return a
    if isinstance(a, (int, float)) and a == 0:
        return _neg(b)
    if isinstance(b, (int, float)):
        return _add(a, -b)
    if b.startswith("-") and _is_term(b[1:]):
        return f"{_txt(a)} + {b[1:]}"
    return f"{_txt(a)} - {b if _is_term(b) else f'({b})'}"


def _mul(a, k: float):
    if isinstance(a, (int, float)):
        return a * k
    if k == 1:
        return a
    if k == -1:
        return _neg(a)
    neg = a.startswith("-") and _is_term(a[1:])
    core = a[1:] if neg else a
    left = core if _is_term(core) else f"({core})"
    if k < 0:
        neg, k = not neg, -k
    return f"{'-' if neg else ''}{left} * {_num_text(k)}"


def _half(a, b, sign=1):
    """(a + b) / 2 (sign 1) or (a - b) / 2 (sign -1)."""
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return (a + sign * b) / 2
    return f"({_add(a, b) if sign > 0 else _sub(a, b)}) / 2"


# CST / VBA functions and constants -> the design's (fairbeam.design.FUNCS / CONSTANTS)
_FUNC_MAP = {"sqr": "sqrt", "sqrt": "sqrt", "sin": "sin", "cos": "cos", "tan": "tan", "atn": "atan", "atan": "atan",
             "arctan": "atan", "asin": "asin", "arcsin": "asin", "acos": "acos", "arccos": "acos", "atn2": "atan2",
             "atan2": "atan2", "exp": "exp", "log": "log", "ln": "log", "log10": "log10", "abs": "abs",
             "int": "floor", "floor": "floor", "ceil": "ceil", "round": "round", "min": "min", "max": "max"}
_CONST_MAP = {"pi": "pi", "clight": "c0", "c0": "c0", "eps0": "eps0", "epsilon0": "eps0", "mu0": "mu0"}
_VBA_UNSUPPORTED = {"and", "or", "not", "xor", "iif", "sgn", "fix", "true", "false", "if", "choose", "switch"}

_TOKEN = re.compile(r"\s*(?:(?P<num>(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)|(?P<id>[A-Za-z_]\w*)|(?P<op><=|>=|<>|[-+*/^\\(),=<>&]))")
_BLANK_REST = re.compile(r"\s*\Z")


class _Expr:
    """A VBA / CST expression parsed with VBA precedence and written in the design's (Python) syntax.

    VBA precedence, highest first: ^ (left associative), unary - / +, * and /, \\ (integer
    division), Mod, + and -. The output is parenthesised by Python's rules, so 2^3^2 stays (2**3)**2.
    """

    # Python precedence of what a node emits
    ADD, MUL, UNARY, POW, ATOM = 1, 2, 3, 4, 5

    def __init__(self, text: str, names: dict):
        self.text = text
        self.names = names  # lower-case CST name -> design key
        self.used: set[str] = set()
        self.toks = self._tokens(text)
        self.i = 0
        self.depth = 0

    def _tokens(self, text):
        out, pos = [], 0
        while pos < len(text):
            if _BLANK_REST.match(text, pos):
                break
            m = _TOKEN.match(text, pos)
            if not m or m.end() == pos:
                raise _Refuse(f"cannot read the expression {text[:80]!r} (unexpected {text[pos:].strip()[:1]!r})")
            pos = m.end()
            kind = m.lastgroup
            out.append((kind, m.group(kind)))
            if len(out) > MAX_EXPR_TOKENS:
                raise _Refuse(f"the expression {text[:40]!r}... is too long (more than {MAX_EXPR_TOKENS} terms)")
        if not out:
            raise _Refuse("empty expression")
        return out

    def _nest(self):
        self.depth += 1
        if self.depth > MAX_EXPR_DEPTH:
            raise _Refuse(f"the expression {self.text[:40]!r}... is nested too deeply (more than {MAX_EXPR_DEPTH} levels)")

    def peek(self):
        return self.toks[self.i] if self.i < len(self.toks) else (None, None)

    def take(self):
        t = self.peek()
        self.i += 1
        return t

    def parse(self) -> tuple[str, int]:
        node = self.add()
        if self.i != len(self.toks):
            raise _Refuse(f"cannot read the expression {self.text!r} (unexpected {self.peek()[1]!r})")
        return node

    @staticmethod
    def wrap(node, level):
        s, lv = node
        return s if lv >= level else f"({s})"

    def add(self):
        left = self.mod()
        while self.peek() in (("op", "+"), ("op", "-")):
            op = self.take()[1]
            right = self.mod()
            # a + (b - c): the right operand of - needs parentheses at the same level
            left = (f"{self.wrap(left, self.ADD)} {op} {self.wrap(right, self.ADD + (1 if op == '-' else 0))}", self.ADD)
        return left

    def mod(self):
        left = self.intdiv()
        while self.peek()[0] == "id" and self.peek()[1].lower() == "mod":
            self.take()
            right = self.intdiv()
            left = (f"{self.wrap(left, self.MUL)} % {self.wrap(right, self.MUL + 1)}", self.MUL)
        return left

    def intdiv(self):
        left = self.mul()
        while self.peek() == ("op", "\\"):
            self.take()
            right = self.mul()
            left = (f"{self.wrap(left, self.MUL)} // {self.wrap(right, self.MUL + 1)}", self.MUL)
        return left

    def mul(self):
        left = self.unary()
        while self.peek() in (("op", "*"), ("op", "/")):
            op = self.take()[1]
            right = self.unary()
            left = (f"{self.wrap(left, self.MUL)} {op} {self.wrap(right, self.MUL + (1 if op == '/' else 0))}", self.MUL)
        return left

    def unary(self):
        if self.peek() in (("op", "-"), ("op", "+")):
            op = self.take()[1]
            self._nest()
            operand = self.unary()
            self.depth -= 1
            return (f"{op}{self.wrap(operand, self.UNARY)}", self.UNARY)
        return self.power()

    def power(self):
        left = self.atom()
        while self.peek() == ("op", "^"):
            self.take()
            # VBA: -2 ^ 2 = -4 and 2 ^ -1 = 0.5 (a unary sign binds the exponent)
            if self.peek() in (("op", "-"), ("op", "+")):
                op = self.take()[1]
                right = (f"{op}{self.wrap(self.atom(), self.UNARY)}", self.UNARY)
            else:
                right = self.atom()
            # Python's ** is right associative: the left operand needs parentheses unless atomic
            left = (f"{self.wrap(left, self.ATOM)}**{self.wrap(right, self.UNARY)}", self.POW)
        return left

    def atom(self):
        kind, v = self.take()
        if kind == "num":
            return (_num_text(float(v)), self.ATOM)
        if kind == "op" and v == "(":
            self._nest()
            inner = self.add()
            self.depth -= 1
            if self.take() != ("op", ")"):
                raise _Refuse(f"unbalanced parentheses in {self.text!r}")
            return (inner[0], inner[1]) if inner[1] >= self.ATOM else (f"({inner[0]})", self.ATOM)
        if kind == "id":
            low = v.lower()
            if self.peek() == ("op", "("):
                if low in self.names:
                    raise _Refuse(f"{v!r} is a parameter, not a function ({self.text!r})")
                fn = _FUNC_MAP.get(low)
                if fn is None:
                    raise _Refuse(f"the function {v}() has no design equivalent ({self.text!r})")
                self.take()
                self._nest()
                args = []
                if self.peek() != ("op", ")"):
                    args.append(self.add()[0])
                    while self.peek() == ("op", ","):
                        self.take()
                        args.append(self.add()[0])
                self.depth -= 1
                if self.take() != ("op", ")"):
                    raise _Refuse(f"unbalanced parentheses in {self.text!r}")
                return (f"{fn}({', '.join(args)})", self.ATOM)
            if low in self.names:
                self.used.add(self.names[low])
                return (self.names[low], self.ATOM)
            if low in _CONST_MAP:
                return (_CONST_MAP[low], self.ATOM)
            if low in _VBA_UNSUPPORTED or low == "mod":
                raise _Refuse(f"{v!r} (logic or VBA-only operator) has no design equivalent ({self.text!r})")
            raise _Refuse(f"unknown name {v!r} in {self.text!r} (not a parameter of the macro)")
        if kind == "op" and v in ("=", "<", ">", "<=", ">=", "<>", "&"):
            raise _Refuse(f"comparisons and string operators have no design equivalent ({self.text!r})")
        raise _Refuse(f"cannot read the expression {self.text!r} (unexpected {v!r})")


def translate(text, names: dict):
    """A CST expression in the design syntax: a float when it has no parameter, else a string."""
    if isinstance(text, (int, float)) and not isinstance(text, bool):
        return float(text)
    src = str(text).strip()
    if not src:
        raise _Refuse("empty value")
    ex = _Expr(src, names)
    out, _level = ex.parse()
    if not ex.used:
        try:
            return evaluate(out, {})
        except DesignError as e:
            raise _Refuse(f"{src!r}: {e.detail}") from None
    return out


# ---------------------------------------------------------------------------- macro text -> history items

_STRING = re.compile(r'"(?:[^"]|"")*"')


def _unquote(s: str) -> str:
    return s[1:-1].replace('""', '"')


def _code_part(line: str) -> str:
    """The line without a trailing ' comment (quotes respected)."""
    inside = False
    for i, ch in enumerate(line):
        if ch == '"':
            inside = not inside
        elif ch == "'" and not inside:
            return line[:i]
    return line


def _split_args(s: str) -> list[str]:
    out, depth, inside, cur = [], 0, False, []
    for ch in s:
        if ch == '"':
            inside = not inside
        elif not inside:
            if ch == "(":
                depth += 1
            elif ch == ")":
                depth -= 1
            elif ch == "," and depth == 0:
                out.append("".join(cur).strip())
                cur = []
                continue
        cur.append(ch)
    tail = "".join(cur).strip()
    if tail or out:
        out.append(tail)
    return out


class _Arg:
    __slots__ = ("raw", "quoted", "value")

    def __init__(self, raw: str):
        self.raw = raw
        self.quoted = bool(_STRING.fullmatch(raw))
        self.value = _unquote(raw) if self.quoted else raw

    @property
    def truth(self) -> bool:
        return self.value.strip().lower() in ("true", "1", "-1", "yes")

    def __repr__(self):
        return self.raw


def _args(s: str) -> list[_Arg]:
    s = s.strip()
    if s.startswith("(") and s.endswith(")") and _balanced_call("f" + s):
        s = s[1:-1]
    return [_Arg(a) for a in _split_args(s)] if s else []


_VB_CONST = {"vblf": "\n", "vbcr": "\r", "vbcrlf": "\r\n", "vbnewline": "\r\n", "vbtab": "\t", "vbnullstring": ""}


_STRING_TOKEN = re.compile(r'\s*(?:(?P<str>"(?:[^"]|"")*")|(?P<chr>Chr\$?\s*\(\s*(?P<code>\d+)\s*\))|(?P<id>[A-Za-z_]\w*\$?)|(?P<op>[+&]))', re.I)


class _Strings:
    """The VBA string variables of a macro (``sCommand = sCommand + "..." + vbLf``), each kept as a list
    of pieces: ``s = s + ...`` grows s in place instead of copying it on every line. Bounded: a value
    is at most MAX_HISTORY_TEXT characters and the pieces copied over the whole macro at most
    MAX_STRING_WORK (``s = s + s`` doubles a string on every line)."""

    def __init__(self):
        # sStlDir is the folder of fairbeam's companion .stl files, found by the macro's own helper at run
        # time (see read_macro); the file names are looked up by their base name, so it reads as empty
        self.vars: dict[str, list[str]] = {"sstldir": [""]}
        self.sizes: dict[str, int] = {"sstldir": 0}
        self.work = 0

    def _chunks(self, expr: str, out: list, size: int):
        """(pieces, size) of the expression appended to ``out`` (``out`` is unchanged on None)."""
        n0 = len(out)
        pos, expect_value = 0, True

        def fail():
            del out[n0:]
            return None

        while pos < len(expr):
            if _BLANK_REST.match(expr, pos):
                break
            m = _STRING_TOKEN.match(expr, pos)
            if not m:
                return fail()
            pos = m.end()
            if m.group("op"):
                if expect_value:
                    return fail()
                expect_value = True
                continue
            if not expect_value:
                return fail()
            expect_value = False
            if m.group("str"):
                piece = [_unquote(m.group("str"))]
                n = len(piece[0])
            elif m.group("chr"):
                code = int(m.group("code")) if len(m.group("code")) < 8 else -1
                if not (0 <= code < 0xD800 or 0xE000 <= code < 0x110000):
                    return fail()
                piece, n = [chr(code)], 1
            else:
                name = m.group("id").rstrip("$").lower()
                if name in _VB_CONST:
                    piece = [_VB_CONST[name]]
                    n = len(piece[0])
                elif name in self.vars:
                    piece, n = self.vars[name], self.sizes[name]
                else:
                    return fail()
            size += n
            self.work += len(piece)
            if size > MAX_HISTORY_TEXT or self.work > MAX_STRING_WORK:
                return fail()
            out.extend(piece)
        return fail() if expect_value else (out, size)

    def text(self, expr: str) -> str | None:
        """Value of a VBA string expression of literals, variables, vbLf & co. and Chr(n); None otherwise."""
        got = self._chunks(expr, [], 0)
        return None if got is None else "".join(got[0])

    def assign(self, name: str, expr: str) -> bool:
        name = name.lower()
        m = re.match(r"\s*([A-Za-z_]\w*)\$?\s*[+&]", expr)
        if m and m.group(1).lower() == name and name in self.vars:
            # s = s + ...: the rest goes onto s
            got = self._chunks(expr[m.end():], self.vars[name], self.sizes[name])
        else:
            got = self._chunks(expr, [], 0)
        if got is None:
            return False
        self.vars[name], self.sizes[name] = got
        return True


_META = re.compile(rf"^'\s*{CST_MARKER_RE}\s*(\{{.*\}})\s*$")
_TAND = re.compile(r"equivalent tan d = ([-+0-9.eE]+) at ([-+0-9.eE]+) GHz")
_SKIP = re.compile(r"^(option\b|dim\b|private\b|public\b|const\b|sub\b|function\b|end\s+sub\b|end\s+function\b|"
                   r"exit\s+sub\b|#|attribute\b|'#)", re.I)
_CONTROL = re.compile(r"^(if|else|elseif|end\s+if|for|next|do|loop|while|wend|select|case|end\s+select|goto|on\s+error)\b", re.I)


class _Block:
    # lead: the fairbeam-data / WARNING / tan d comment lines written just before the item (kept in
    # their order); trail: those after the last item
    __slots__ = ("title", "line", "stmts", "tand", "lead", "trail")

    def __init__(self, title: str, line: int):
        self.title = title
        self.line = line
        self.stmts: list[tuple[int, str]] = []
        self.tand = None
        self.lead: list[str] = []
        self.trail: list[str] = []


def read_macro(text: str):
    """(history blocks, fairbeam data records, macro-level notes, suggested name) of a macro text."""
    lines = re.split(r"\r\n|\n|\r", text)
    logical: list[tuple[int, str]] = []
    # a line ending in " _" (outside a string and a comment) continues on the next one. Each physical
    # line is looked at once (VBA strings end on their line, and a continued part ends outside a
    # string), so a long chain of continuations stays linear
    buf: list[str] = []
    start = 0
    for i, raw in enumerate(lines, 1):
        code = raw.rstrip()
        if buf:
            code = code.strip()
        else:
            start = i
        head = _code_part(code)
        if re.search(r"\s_$", head) and not (not buf and code.lstrip().startswith("'")):
            buf.append(head.rstrip()[:-1].rstrip())
            continue
        buf.append(code)
        logical.append((start, " ".join(buf)))
        buf = []
    if buf:
        logical.append((start, " ".join(buf)))

    blocks: list[_Block] = []
    meta: list[dict] = []
    notes: list[tuple] = []
    strings = _Strings()
    direct: _Block | None = None
    tand = None
    comments: list[str] = []
    lead: list[str] = []
    history_text = 0
    in_helper = False
    for ln, raw in logical:
        s = raw.strip()
        if not s:
            continue
        # the VBA that finds the folder of the .stl files (fairbeam's export) is plumbing, not model
        m = re.match(rf"^'\s*{CST_HELPER_RE}\s*(begin|end)\s*$", s)
        if m:
            in_helper = m.group(1) == "begin"
            continue
        if in_helper:
            continue
        if s.startswith("'") or re.match(r"^rem\b", s, re.I):
            if len(comments) < 4:
                comments.append(s.lstrip("'").strip())
            m = _META.match(s)
            if m:
                lead.append(s)
                try:
                    rec = json.loads(m.group(1))
                    if isinstance(rec, dict):
                        meta.append(rec)
                except (ValueError, RecursionError):   # JSONDecodeError, or nested too deeply
                    notes.append((ln, "a fairbeam-data comment is not valid JSON; ignored"))
                continue
            m = re.match(r"^'\s*WARNING:\s*(.+)$", s)
            if m:
                lead.append(s)
                notes.append((ln, m.group(1).strip(), "exporter"))   # a note fairbeam's own export wrote
                continue
            m = _TAND.search(s)
            if m:
                lead.append(s)
                try:
                    tand = (float(m.group(1)), float(m.group(2)))
                except ValueError:
                    tand = None
                continue
            # a history item ('@ in the History List, '## Merged Block in CST merged/exported macros)
            m = re.match(r"^'@\s*(.*)$", s) or re.match(r"^'##\s*Merged Block\s*-?\s*(.*)$", s, re.I)
            if m:
                direct = _Block(m.group(1).strip() or f"history item (line {ln})", ln)
                direct.lead, lead = lead, []
                blocks.append(direct)
            continue
        code = _code_part(s).strip()
        if not code or _SKIP.match(code):
            continue
        if _CONTROL.match(code):
            notes.append((ln, f"VBA control flow is not executed: {code[:60]!r}; the statements around it are read once, in order"))
            continue
        m = re.match(r"^AddToHistory\s*(.*)$", code, re.I)
        if m:
            rest = m.group(1).strip()
            if rest.startswith("(") and rest.endswith(")") and _balanced_call("f" + rest):
                rest = rest[1:-1]
            args = _split_args(rest)
            title = strings.text(args[0]) if args else None
            body = strings.text(args[1]) if len(args) > 1 else None
            if title is None or body is None:
                notes.append((ln, "AddToHistory with a value that is not a plain string (VBA variables are not evaluated)"))
                continue
            history_text += len(body)
            if history_text > MAX_HISTORY_TEXT:
                notes.append((ln, f"AddToHistory: the history is longer than {MAX_HISTORY_TEXT // 1_000_000} MB of "
                                  "commands; this item and the ones after it are not imported"))
                continue
            b = _Block(title, ln)
            b.lead, lead = lead, []
            b.tand, tand = tand, None
            for k, part in enumerate(re.split(r"\r\n|\n|\r", body)):
                b.stmts.append((ln, part))
            blocks.append(b)
            direct = None
            continue
        m = re.match(r"^(?:let\s+|set\s+)?([A-Za-z_]\w*)\s*=\s*(.*)$", code, re.I)
        if m and not code.startswith("."):
            if not strings.assign(m.group(1), m.group(2)):
                notes.append((ln, f"VBA assignment {code[:60]!r} is not evaluated (only string variables for AddToHistory are)"))
            continue
        if direct is None:
            direct = _Block(f"macro statements (line {ln})", ln)
            direct.lead, lead = lead, []
            blocks.append(direct)
        if tand is not None and direct.tand is None and re.match(r"^with\s+material$", code, re.I):
            direct.tand, tand = tand, None
        direct.stmts.append((ln, code))
    if lead and blocks:
        blocks[-1].trail = lead
    name = None
    # the header of our own export: "generated by Fairbeam" (older macros: legacy.CST_MAKER_RE)
    if len(comments) >= 2 and re.search(rf"generated by {CST_MAKER_RE}\b", comments[1]):
        name = comments[0] or None
    return blocks, meta, notes, name


# ---------------------------------------------------------------------------- statements

class _With:
    """A ``With Obj ... End With`` block: its calls in order, the last value of each property."""

    def __init__(self, obj: str, line: int):
        self.obj = obj
        self.line = line
        self.calls: list[tuple[str, list[_Arg], int]] = []
        self.orig: dict[str, str] = {}   # lower-case property -> as written

    def names(self, keys) -> str:
        return ", ".join("." + self.orig.get(k, k) for k in sorted(keys))

    def get(self, key: str):
        key = key.lower()
        for k, a, _ln in reversed(self.calls):
            if k == key:
                return a
        return None

    def has(self, key: str) -> bool:
        return self.get(key) is not None

    def one(self, key: str, default=None):
        a = self.get(key)
        return a[0].value if a else default


def statements(block: _Block):
    """The block's statements: ('with', _With) or ('call', obj, method, args, line)."""
    cur: _With | None = None
    for ln, raw in block.stmts:
        s = _code_part(raw).strip()
        if not s:
            continue
        s = re.sub(r"^call\s+", "", s, flags=re.I)
        m = re.match(r"^with\s+([A-Za-z_]\w*)$", s, re.I)
        if m:
            if cur is not None:
                yield ("with", cur)
            cur = _With(m.group(1), ln)
            continue
        if re.match(r"^end\s+with$", s, re.I):
            if cur is not None:
                yield ("with", cur)
            cur = None
            continue
        m = re.match(r"^\.([A-Za-z_]\w*)\s*(.*)$", s)
        if m and cur is not None:
            cur.calls.append((m.group(1).lower(), _args(m.group(2)), ln))
            cur.orig[m.group(1).lower()] = m.group(1)
            continue
        if cur is not None:
            yield ("with", cur)
            cur = None
        m = re.match(r"^([A-Za-z_]\w*)\.([A-Za-z_]\w*)\s*(.*)$", s)
        if m:
            yield ("call", m.group(1), m.group(2), _args(m.group(3)), ln)
            continue
        m = re.match(r"^([A-Za-z_]\w*)\s*(.*)$", s)
        if m:
            yield ("call", "", m.group(1), _args(m.group(2)), ln)
            continue
        yield ("bad", s, ln)
    if cur is not None:
        yield ("with", cur)


# ---------------------------------------------------------------------------- working coordinate system

def _cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def _unit_axis(v, tol=1e-9):
    """(axis, sign) of a vector along one coordinate axis, else None."""
    n = math.sqrt(sum(x * x for x in v))
    if n < tol:
        return None
    idx = [k for k in range(3) if abs(v[k] / n) > 1 - 1e-9]
    if len(idx) != 1 or any(abs(v[k] / n) > 1e-9 for k in range(3) if k != idx[0]):
        return None
    return idx[0], 1 if v[idx[0]] > 0 else -1


class _Frame:
    """The CST working coordinate system: global = O + u U + v V + w W (V = W x U)."""

    def __init__(self):
        self.reset()
        self.stored: dict = {}

    def reset(self):
        self.local = False
        self.O = [0.0, 0.0, 0.0]
        self.W = (0.0, 0.0, 1.0)
        self.U = (1.0, 0.0, 0.0)
        self.bad = ""

    def orthogonalize(self):
        """Keep u perpendicular to the normal (CST keeps the working plane orthogonal): the old u
        projected onto the plane, or the next coordinate axis when it is parallel to the normal."""
        W = self.W
        n = math.sqrt(sum(x * x for x in W))
        if n < 1e-12:
            self.bad = "the normal is a zero vector"
            return
        W = tuple(x / n for x in W)
        d = sum(W[k] * self.U[k] for k in range(3))
        U = [self.U[k] - d * W[k] for k in range(3)]
        m = math.sqrt(sum(x * x for x in U))
        if m < 1e-9:
            ax = _unit_axis(W)
            U = [0.0, 0.0, 0.0]
            U[((ax[0] if ax else 2) + 1) % 3] = 1.0
            m = 1.0
        self.W = W
        self.U = tuple(round(x / m, 12) + 0.0 for x in U)
        if self.bad == "the normal is a zero vector":
            self.bad = ""

    def state(self):
        return (self.local, list(self.O), self.W, self.U, self.bad)

    def restore(self, st):
        self.local, self.O, self.W, self.U, self.bad = st[0], list(st[1]), st[2], st[3], st[4]

    def axes(self):
        """[(global axis, sign)] of the local u, v, w axes; _Refuse when not axis-aligned."""
        if not self.local:
            return [(0, 1), (1, 1), (2, 1)]
        if self.bad:
            raise _Refuse(f"the local working coordinate system is not usable: {self.bad}")
        V = _cross(self.W, self.U)
        out = [_unit_axis(self.U), _unit_axis(V), _unit_axis(self.W)]
        if any(o is None for o in out) or len({o[0] for o in out}) != 3:
            raise _Refuse("the local working coordinate system is not aligned with the global axes "
                          "(designs have axis-aligned shapes only)")
        return out

    def origin(self):
        return self.O if self.local else [0.0, 0.0, 0.0]

    def point(self, p):
        """A local point (three design values) in global coordinates."""
        ax = self.axes()
        O = self.origin()
        out = [0.0, 0.0, 0.0]
        for j, (g, s) in enumerate(ax):
            out[g] = _add(O[g], p[j] if s > 0 else _neg(p[j]))
        return out

    def vector(self, v):
        ax = self.axes()
        out = [0.0, 0.0, 0.0]
        for j, (g, s) in enumerate(ax):
            out[g] = v[j] if s > 0 else _neg(v[j])
        return out

    def ranges(self, rng):
        """Local [(lo, hi)] x3 -> global [(lo, hi)] x3."""
        ax = self.axes()
        O = self.origin()
        out = [None, None, None]
        for j, (g, s) in enumerate(ax):
            lo, hi = rng[j]
            out[g] = (_add(O[g], lo), _add(O[g], hi)) if s > 0 else (_sub(O[g], hi), _sub(O[g], lo))
        return out

    def axis(self, j):
        return self.axes()[j]


# ---------------------------------------------------------------------------- the importer

MAX_STL_TRIANGLES = 200_000


def parse_stl(raw: bytes) -> tuple[list[list[float]], list[list[int]]]:
    """``(vertices, faces)`` of an ASCII or binary STL: equal vertices are one vertex, faces are index triples."""
    n_bin = None
    if len(raw) >= 84:
        n_bin = int.from_bytes(raw[80:84], "little")
        if len(raw) != 84 + 50 * n_bin:
            n_bin = None
    pts: list[tuple[float, float, float]] = []
    if n_bin is not None and not (raw.lstrip()[:5].lower() == b"solid" and b"facet" in raw[:400]):
        import struct
        if n_bin > MAX_STL_TRIANGLES:
            raise ValueError(f"more than {MAX_STL_TRIANGLES} triangles")
        for i in range(n_bin):
            f = struct.unpack_from("<12f", raw, 84 + 50 * i)
            pts.extend((f[3 + 3 * j], f[4 + 3 * j], f[5 + 3 * j]) for j in range(3))
    else:
        text = raw.decode("utf-8", errors="replace")
        for m in re.finditer(r"vertex\s+(\S+)\s+(\S+)\s+(\S+)", text):
            try:
                pts.append((float(m.group(1)), float(m.group(2)), float(m.group(3))))
            except ValueError:
                raise ValueError("a vertex is not a number") from None
            if len(pts) > 3 * MAX_STL_TRIANGLES:
                raise ValueError(f"more than {MAX_STL_TRIANGLES} triangles")
    if not pts or len(pts) % 3:
        raise ValueError("no triangles found" if not pts else "the vertices are not a multiple of 3")
    if not all(math.isfinite(c) for p in pts for c in p):
        raise ValueError("a vertex is not a finite number")
    index: dict[tuple, int] = {}
    vertices: list[list[float]] = []
    ids = []
    for p in pts:
        key = tuple(round(c, 7) for c in p)
        if key not in index:
            index[key] = len(vertices)
            vertices.append([float(c) for c in p])
        ids.append(index[key])
    faces = [ids[i:i + 3] for i in range(0, len(ids), 3) if len(set(ids[i:i + 3])) == 3]
    if not faces:
        raise ValueError("every triangle is degenerate")
    return vertices, faces


class _Importer:
    def __init__(self, filename: str | None):
        self.filename = filename
        self.notes: list[dict] = []
        self.created: list[dict] = []
        self.len_mm = 1.0
        self.len_unit = "mm"
        self.f_ghz = 1.0
        self.f_unit = "GHz"
        self.ohm = 1.0
        self.ind_h = 1e-9    # the CST default inductance unit (nH); the design takes henries
        self.cap_f = 1e-12   # the CST default capacitance unit (pF); the design takes farads
        self.names: dict[str, str] = {}   # lower-case CST parameter name -> design key
        self.values: dict[str, float] = {}
        self.params: list[dict] = []
        self.materials: dict[str, dict] = {}
        self.mat_order: list[str] = []
        self.solids: dict[str, dict] = {}
        self.aliases: dict[str, str] = {}
        self.components: set[str] = set()
        self.curves: dict[str, dict] = {}
        self.wires: dict[str, dict] = {}
        self.frame = _Frame()
        self.f_range = None
        self.end_db = None
        self.boundaries = None
        self.ports: list[dict] = []
        self.resistors: list[dict] = []
        self.farfield: list = []
        self.currents: list = []
        self.cpw = None
        self.air_cpw = None
        self.meta_ports: dict[int, dict] = {}
        self.meta_res: dict[str, dict] = {}
        self.meta_bounds = None
        self.meta_unit = 1.0
        self.unsupported: dict[str, list] = {}
        self.ignored: dict[str, list] = {}
        self.item = ""
        self.line = 0
        self.solver_type = None
        self.tand = None
        self.static_mats: dict[str, _With] = {}
        self.meta_mesh = None
        self.meta_lines = None
        self.exact_lines = None
        self.meta_far = False
        self.recognized = 0
        self.files = None            # .stl files next to the macro: {name: bytes | str} or name -> bytes | str | None
        self.missing_stl: set[str] = set()   # solids whose STL file was not supplied

    # ---- report

    def note(self, severity: str, message: str, where: str | None = None, line: int | None = None,
             kind: str | None = None):
        n = {"severity": severity, "where": where if where is not None else self.item,
             "line": line if line is not None else self.line, "message": message}
        if kind:
            n["kind"] = kind   # "missing": fairbeam's own export left it out; "exporter": another note it wrote
        self.notes.append(n)

    def made(self, kind: str, name: str, detail: str = ""):
        self.created.append({"kind": kind, "name": name, "detail": detail})

    def ignored_stmt(self, key: str, message: str):
        entry = self.ignored.setdefault(key, [0, self.line, self.item, message])
        entry[0] += 1

    def unsupported_stmt(self, key: str, message: str):
        entry = self.unsupported.setdefault(key, [0, self.line, self.item, message])
        entry[0] += 1

    # ---- values

    def expr(self, arg, kind: str = "plain"):
        """A design value (float or expression) of a CST argument; lengths in mm, frequencies in GHz."""
        text = arg.value if isinstance(arg, _Arg) else arg
        v = translate(text, self.names)
        scale = {"length": self.len_mm, "freq": self.f_ghz, "ohm": self.ohm,
                 "ind": self.ind_h, "cap": self.cap_f}.get(kind, 1.0)
        v = _mul(v, scale) if scale != 1 else v
        if isinstance(v, float) and kind == "length":
            v = round(v, 6) + 0.0
        elif isinstance(v, float):
            v = float(f"{v:.12g}") + 0.0
        return v

    def val(self, e) -> float:
        try:
            return evaluate(e, self.values)
        except DesignError as err:
            raise _Refuse(err.detail) from None

    def need(self, w: _With, key: str, n: int = 1):
        a = w.get(key)
        if a is None or len(a) < n:
            raise _Refuse(f".{key} is missing" if a is None else f".{key} needs {n} values")
        return a

    def lengths(self, args, n=None):
        return [self.expr(a, "length") for a in (args if n is None else args[:n])]

    # ---- parameters (first pass)

    def collect_params(self, blocks):
        raw: dict[str, list] = {}
        order: list[str] = []
        for b in blocks:
            for st in statements(b):
                if st[0] != "call":
                    continue
                _, obj, meth, args, ln = st
                m = meth.lower()
                if obj and obj.lower() not in ("", "application"):
                    continue
                if m in ("storeparameter", "storedoubleparameter", "makesureparameterexists", "storeparameterwithdescription"):
                    if len(args) < 2:
                        continue
                    name = args[0].value.strip()
                    low = name.lower()
                    if m == "makesureparameterexists" and low in raw:
                        continue
                    desc = args[2].value if m == "storeparameterwithdescription" and len(args) > 2 else (raw.get(low, [None] * 4)[2])
                    if low not in raw:
                        order.append(low)
                    raw[low] = [name, args[1].value, desc, ln, b.title]
                elif m == "setparameterdescription" and len(args) >= 2:
                    low = args[0].value.strip().lower()
                    if low in raw:
                        raw[low][2] = args[1].value
                elif m == "deleteparameter" and args:
                    low = args[0].value.strip().lower()
                    raw.pop(low, None)
                    if low in order:
                        order.remove(low)
        used_keys: set[str] = set()
        for low in order:
            name = raw[low][0]
            # the design syntax takes ASCII names: accents dropped (çap -> cap), anything else an _
            ascii_name = unicodedata.normalize("NFKD", name.translate(_DOTLESS)).encode("ascii", "ignore").decode()
            key = re.sub(r"[^A-Za-z0-9_]", "_", ascii_name if ascii_name.strip() else name)
            if not key or key[0].isdigit():
                key = f"p_{key}"
            if param_key_error(key) or keyword.iskeyword(key) or key in ("True", "False", "None"):
                key = f"{key}_"
            base, k = key, 2
            while key in used_keys:
                key, k = f"{base}_{k}", k + 1
            used_keys.add(key)
            self.names[low] = key
            if key != name:
                self.note("warning", f"parameter {name!r} is named {key!r} in the design (a function, constant or keyword name, "
                          "or characters the design syntax does not take)", f"parameter {name}", raw[low][3])
        # translate, then order: independent values first, derived ones after what they use
        items = []
        for low in order:
            name, text, desc, ln, title = raw[low]
            key = self.names[low]
            try:
                ex = _Expr(str(text).strip(), self.names)
                out, _ = ex.parse()
                deps = ex.used - {key}
                if key in ex.used:
                    raise _Refuse(f"{name} refers to itself")
                value = None
                if not ex.used:
                    value = evaluate(out, {})
                items.append({"key": key, "expr": out, "deps": deps, "value": value, "desc": desc, "line": ln, "name": name})
            except (_Refuse, DesignError, RecursionError) as e:
                msg = e.detail if isinstance(e, DesignError) else str(e) if isinstance(e, _Refuse) else "nested too deeply"
                self.note("refused", f"parameter {name} = {text!r} not imported: {msg}", f"parameter {name}", ln)
        done: list[dict] = [it for it in items if it["value"] is not None]
        known = {it["key"] for it in done}
        pending = [it for it in items if it["value"] is None]
        progress = True
        while pending and progress:
            progress = False
            for it in list(pending):
                if it["deps"] <= known:
                    done.append(it)
                    known.add(it["key"])
                    pending.remove(it)
                    progress = True
        for it in pending:
            missing = ", ".join(sorted(it["deps"] - known))
            self.note("refused", f"parameter {it['name']} not imported: it depends on {missing}, which cannot be resolved "
                      "(missing or circular)", f"parameter {it['name']}", it["line"])
        # evaluate in order; a derived value that fails (e.g. a division by zero) is refused
        params = []
        names: dict[str, float] = {}
        for it in done:
            row = {"key": it["key"]}
            if it["value"] is not None:
                row["default"] = float(it["value"])
            else:
                row["expr"] = it["expr"]
            if it["desc"]:
                row["description"] = str(it["desc"])
                if len(str(it["desc"])) <= 60:
                    row["label"] = str(it["desc"])
            try:
                # what resolve_names does for this row, given the parameters accepted before it
                names[row["key"]] = evaluate(row["expr"], names) if "expr" in row else float(row["default"])
            except DesignError as e:
                self.note("refused", f"parameter {it['name']} not imported: {e.detail}", f"parameter {it['name']}", it["line"])
                continue
            params.append(row)
            self.made("parameter", row["key"], _num_text(row["default"]) if "default" in row else row["expr"])
        self.params = params
        kept = {p["key"] for p in params}
        self.names = {low: key for low, key in self.names.items() if key in kept}
        self.values = resolve_names({"params": params}, {p["key"]: p["default"] for p in params if "expr" not in p})

    # ---- dispatch

    def run(self, blocks):
        self.collect_params(blocks)
        for b in blocks:
            self.item = b.title
            self.tand = b.tand
            for st in statements(b):
                self.line = st[-1] if st[0] != "with" else st[1].line
                before = sum(v[0] for v in self.unsupported.values())
                try:
                    if st[0] == "with":
                        self.with_block(st[1])
                    elif st[0] == "call":
                        self.call(st[1], st[2], st[3])
                    else:
                        self.unsupported_stmt(st[1][:40], f"cannot read the statement {st[1][:80]!r}")
                except _Quiet:
                    pass
                except _Refuse as e:
                    self.note("refused", f"not imported: {e}")
                except (DesignError, ArithmeticError, ValueError, TypeError, KeyError, IndexError, RecursionError) as e:
                    detail = e.detail if isinstance(e, DesignError) else f"{type(e).__name__}: {e}"
                    self.note("refused", f"not imported: the statement could not be read ({detail[:200]})")
                if sum(v[0] for v in self.unsupported.values()) == before:
                    self.recognized += 1
        for key, (count, line, item, message) in self.unsupported.items():
            more = f" ({count} times)" if count > 1 else ""
            self.note("refused", f"{message}{more}", item, line)
        for key, (count, line, item, message) in self.ignored.items():
            more = f" ({count} times)" if count > 1 else ""
            self.note("info", f"{message}{more}", item, line)

    def call(self, obj: str, meth: str, args: list[_Arg]):
        o, m = obj.lower(), meth.lower()
        if o in ("", "application") and m in ("storeparameter", "storedoubleparameter", "makesureparameterexists",
                                              "storeparameterwithdescription", "setparameterdescription", "deleteparameter"):
            return  # first pass
        if o in ("", "application") and m in ("rebuild", "parameterupdate", "rebuildonparametricchange", "save",
                                              "selecttreeitem", "setlock", "resetall"):
            return
        # The CST version bookkeeping around each merged block (it replays the block with that version's defaults)
        if o == "" and m in ("startversionstringoverridemode", "stopversionstringoverridemode"):
            return self.ignored_stmt(m, f"{meth}: the CST version bookkeeping for the merged blocks; ignored")
        if o == "" and m == "changesolvertype":
            kind = args[0].value if args else ""
            self.solver_type = kind
            if kind.strip().lower() not in ("hf time domain", "time domain"):
                self.note("warning", f"solver type {kind!r}: openEMS is a time-domain (FDTD) solver; the design runs in the time domain")
            return
        if o == "component":
            return self.component_call(m, args)
        if o == "solid":
            return self.solid_call(m, args, meth)
        if o == "curve":
            if m == "newcurve":
                return
            if m in ("deletecurve", "deletecurveitem") and args:
                prefix = args[0].value.lower()
                for k in [k for k in self.curves if k == prefix or k.startswith(prefix + ":")]:
                    self.curves.pop(k)
                return
        if o == "wcs":
            return self.wcs_call(m, args)
        if o == "solver" and m == "frequencyrange":
            if len(args) < 2:
                raise _Refuse("Solver.FrequencyRange needs two values")
            self.f_range = (self.expr(args[0], "freq"), self.expr(args[1], "freq"))
            return
        if o == "monitor" and m == "delete" and args:
            return self.delete_monitor(args[0].value)
        # the same settings written as direct calls instead of a With block
        if o == "units" and m == "setunit" and len(args) >= 2:
            return self._unit(args[0].value.strip().lower(), args[1].value.strip())
        if o == "units" and m in ("geometry", "frequency", "resistance", "inductance", "capacitance") and args:
            return self._unit({"geometry": "length"}.get(m, m), args[0].value.strip())
        if o == "mesh" and m == "linesperwavelength" and args:
            self.cpw = self.val(self.expr(args[0]))
            return
        if o == "solver" and m == "steadystatelimit" and args:
            self.end_db = self.val(self.expr(args[0]))
            return
        if o in ("plot", "pick", "discretizer", "resulttree", "selecttreeitem", "optimizer", "parametersweep",
                 "postprocess1d", "resulttemplate", "mesh", "meshsettings", "units", "background", "boundary",
                 "fdsolver", "eigenmodesolver", "iesolver", "farfieldplot", "project"):
            self.ignored_stmt(f"{o}.{m}", f"{obj}.{meth}: a view, selection or solver-internal setting, not part of the model; ignored")
            return
        self.unsupported_stmt(f"{o}.{m}", f"{obj + '.' if obj else ''}{meth}: this command has no design equivalent")

    def with_block(self, w: _With):
        o = w.obj.lower()
        handler = {
            "units": self.units, "material": self.material, "brick": self.brick, "cylinder": self.cylinder,
            "cone": self.cone, "sphere": self.sphere, "torus": self.torus, "polygon": self.polygon,
            "polygon3d": self.polygon3d, "rectangle": self.rectangle, "circle": self.circle,
            "covercurve": self.cover, "extrudecurve": self.extrude_curve, "extrude": self.extrude,
            "boundary": self.boundary, "background": self.background, "solver": self.solver, "mesh": self.mesh,
            "meshsettings": self.mesh_settings, "discreteport": self.discrete_port,
            "discretefaceport": self.discrete_port, "lumpedelement": self.lumped_element,
            "port": self.waveguide_port, "waveguideport": self.waveguide_port, "monitor": self.monitor,
            "transform": self.transform, "wire": self.wire, "rotate": self.rotate_solid, "stl": self.stl,
            "solid": self.solid_with,
        }.get(o)
        if handler is None:
            self.unsupported_stmt(f"with {o}", f"{w.obj}: this CST object has no design equivalent")
            return
        handler(w)

    def solid_with(self, w: _With):
        """``With Solid`` ... ``.Subtract "a", "b"`` (the form fairbeam's export writes for a void): the calls of Solid, in order."""
        for k, args, _ln in w.calls:
            self.call("Solid", w.orig.get(k, k), args)

    # ---- units, parameters' units

    def units(self, w: _With):
        for k, a, _ln in w.calls:
            if k == "setunit" and len(a) >= 2:
                what, unit = a[0].value.strip().lower(), a[1].value.strip()
                self._unit(what, unit)
            elif k in ("geometry", "frequency", "resistance", "inductance", "capacitance") and a:
                self._unit({"geometry": "length"}.get(k, k), a[0].value.strip())
            elif k in ("reset", "time", "temperatureunit", "voltage", "current", "conductance", "setresultunit"):
                continue
            else:
                self.note("info", f"Units .{k}: ignored")

    def _unit(self, what: str, unit: str):
        low = unit.lower()
        if what == "length":
            if low not in LENGTH_MM:
                raise _Refuse(f"unknown length unit {unit!r}")
            self.len_mm, self.len_unit = LENGTH_MM[low], unit
            if low != "mm":
                self.note("info", f"lengths are in {unit}: converted to mm (x{_num_text(LENGTH_MM[low])}); "
                          "parameters keep their CST values and are scaled where they are used")
        elif what == "frequency":
            if low not in FREQ_GHZ:
                raise _Refuse(f"unknown frequency unit {unit!r}")
            self.f_ghz, self.f_unit = FREQ_GHZ[low], unit
            if low != "ghz":
                self.note("info", f"frequencies are in {unit}: converted to GHz")
        elif what == "resistance":
            if low not in OHM:
                raise _Refuse(f"unknown resistance unit {unit!r}")
            self.ohm = OHM[low]
        elif what == "inductance":
            if low not in HENRY:
                raise _Refuse(f"unknown inductance unit {unit!r}")
            self.ind_h = HENRY[low]
        elif what == "capacitance":
            if low not in FARAD:
                raise _Refuse(f"unknown capacitance unit {unit!r}")
            self.cap_f = FARAD[low]

    # ---- materials

    def material(self, w: _With):
        if not w.has("create"):
            if w.has("name"):
                self.note("info", f"material {w.one('name')!r} block without .Create: nothing created")
            return
        name = w.one("name", "").strip()
        if not name:
            raise _Refuse("material without .Name")
        folder = (w.one("folder") or "").strip()
        full = f"{folder}/{name}" if folder else name
        typ = (w.one("type") or "Normal").strip().lower()
        if (w.one("frqtype") or "all").strip().lower() == "static":
            # The CST library writes a static (DC) definition next to the high-frequency one
            self.note("info", f"material {full!r}: the static (FrqType \"static\") definition is not used; "
                      "the high-frequency one is")
            self.static_mats[full.lower()] = w
            return
        known = {"reset", "name", "folder", "type", "create", "epsilon", "mu", "sigma", "kappa", "tand", "tandfreq",
                 "tandgiven", "tandmodel", "colour", "color", "frqtype", "setmaterialunit", "materialunit", "wireframe",
                 "transparency", "transparentoutline", "reflection", "allowoutline", "changebackground",
                 "rho", "thermalconductivity", "heatcapacity", "thermaltype", "mechanicstype", "youngsmodulus",
                 "poissonsratio", "thermalexpansionrate", "specificheat", "dynamicviscosity", "emissivity",
                 "metabolicrate", "bloodflow", "voxelconvection", "diffusedensity", "sigmam", "tandm", "tandmgiven",
                 "tandmfreq", "tandmmodel", "kappam", "dispmodeleps", "dispmodelmu", "dispersivefittingschemeeps",
                 "dispersivefittingschememu", "usegeneraldispersioneps", "usegeneraldispersionmu", "epsinfinity",
                 "setelparametricconductivity", "setactivematerial", "enhancedmodel", "roughness", "thickness",
                 "flowresistance", "userdrawn", "setcoatingtypedefinition", "useonlydatainsimfreqrange",
                 "nlanisotropy", "nlastreaminglinepoints", "setthermalvalue", "hydrogendiffusion"}
        color = None
        col = w.get("colour") or w.get("color")
        if col and len(col) >= 3:
            try:
                rgb = [max(0, min(255, round(float(c.value) * 255))) for c in col[:3]]
                color = "#" + "".join(f"{c:02x}" for c in rgb)
            except (ValueError, OverflowError):
                color = None
        if typ in ("pec",):
            mat = {"name": full, "kind": "metal"}
        elif typ == "lossy metal":
            # finite conductivity (design material "conductivity", S/m): sheets become openEMS
            # conducting sheets, volumes a conductive material (simulation.LossyMetal)
            mat = {"name": full, "kind": "metal"}
            sig = w.one("sigma") or w.one("kappa")
            if sig and self.val(self.expr(sig)) > 0:
                mat["conductivity"] = self.expr(sig)
            else:
                self.note("warning", f"material {full!r} (Lossy metal) has no positive conductivity: imported as a perfect conductor")
            mu = w.one("mu")
            if mu and abs(self.val(self.expr(mu)) - 1) > 1e-12:
                self.note("warning", f"material {full!r}: permeability mu = {mu} is not modelled (a metal has mu_r = 1)")
        elif typ in ("ohmic sheet", "corrugated wall"):
            mat = {"name": full, "kind": "metal"}
            sig = w.one("sigma") or w.one("kappa")
            self.note("warning", f"material {full!r} ({w.one('type')}) imported as a perfect conductor"
                      + (f" (its conductivity {sig} S/m is not modelled)" if sig else ""))
        elif typ == "normal":
            eps = self.expr(w.one("epsilon", "1"))
            mu = self.expr(w.one("mu", "1"))
            if abs(self.val(mu) - 1) > 1e-12:
                self.note("warning", f"material {full!r}: permeability mu = {w.one('mu')} is not modelled (design materials have mu_r = 1)")
            mat = {"name": full, "kind": "dielectric", "eps_r": eps}
            sigma = self.val(self.expr(w.one("sigma") or w.one("kappa") or "0"))
            tand_given = (w.get("tandgiven") or [_Arg('"False"')])[0].truth
            if not tand_given and w.has("tand") and self.val(self.expr(w.one("tand"))) != 0:
                self.note("info", f"material {full!r}: .TanD is ignored because .TanDGiven is not True (as in CST)")
            if tand_given:
                munit = self._material_freq_unit(w)
                mat["tan_d"] = self.expr(w.one("tand", "0"))
                if w.has("tandfreq"):
                    mat["tan_d_freq"] = _mul(translate(w.one("tandfreq"), self.names), munit)
                if sigma:
                    mat["_sigma"] = sigma
                    self.note("warning", f"material {full!r} has both a conductivity and a loss tangent: both are "
                              "combined into one loss tangent at its frequency (openEMS models loss as a conductivity)")
            elif sigma:
                mat["_sigma"] = sigma
                mat["_tand_hint"] = self.tand
            else:
                mat["tan_d"] = 0.0
            for bad in ("sigmam", "tandm", "kappam"):
                if w.has(bad) and self.val(self.expr(w.one(bad))) != 0:
                    self.note("warning", f"material {full!r}: magnetic loss (.{bad}) is not modelled")
            disp = (w.one("dispmodeleps") or "None").strip().lower()
            if disp not in ("none", ""):
                self.note("warning", f"material {full!r}: dispersion model {w.one('dispmodeleps')!r} is not modelled")
        else:
            raise _Refuse(f"material {full!r} of type {w.one('type')!r}: only Normal, PEC and lossy metals are imported")
        if color:
            mat["color"] = color
        ignored = sorted({k for k, _a, _l in w.calls} - known)
        if ignored:
            self.note("info", f"material {full!r}: ignored {w.names(ignored)}")
        low = full.lower()
        if low not in self.materials:
            self.mat_order.append(low)
        self.materials[low] = mat

    def _material_freq_unit(self, w: _With) -> float:
        for k, a, _ln in w.calls:
            if k == "setmaterialunit" and a:
                return FREQ_GHZ.get(a[0].value.strip().lower(), self.f_ghz)
            if k == "materialunit" and len(a) >= 2 and a[0].value.strip().lower() == "frequency":
                return FREQ_GHZ.get(a[1].value.strip().lower(), self.f_ghz)
        return self.f_ghz

    def use_material(self, name: str) -> str:
        """The design material name of a CST material reference (the built-in ones are created on use)."""
        low = name.strip().lower()
        if low not in self.materials and low in self.static_mats:
            # only a static definition: use it (the note above said it was set aside)
            w = self.static_mats.pop(low)
            w.calls = [c for c in w.calls if c[0] != "frqtype"]
            self.material(w)
            self.note("warning", f"material {name!r} has only a static (DC) definition: used for the simulation")
        if low not in self.materials:
            if low == "pec":
                self.materials[low] = {"name": "PEC", "kind": "metal"}
            elif low in ("vacuum", "air"):
                self.materials[low] = {"name": name.strip(), "kind": "dielectric", "eps_r": 1.0, "tan_d": 0.0}
            elif _METALISH.search(name):
                self.materials[low] = {"name": name.strip(), "kind": "metal"}
                self.note("warning", f"material {name!r} is not defined in the macro: imported as a perfect conductor")
            else:
                self.materials[low] = {"name": name.strip(), "kind": "dielectric", "eps_r": 1.0, "tan_d": 0.0}
                self.note("warning", f"material {name!r} is not defined in the macro: imported as a dielectric with "
                          "eps_r = 1 (edit it in the designer)")
            self.mat_order.append(low)
        return self.materials[low]["name"]

    # ---- solids

    @staticmethod
    def key(comp: str, name: str) -> str:
        return f"{comp}:{name}".lower()

    def solid_ref(self, ref: str, what: str = "solid"):
        low = ref.strip().lower()
        if low in self.missing_stl:
            raise _Quiet(low)
        if low in self.aliases:
            raise _Refuse(f"{ref!r} is a copy made by a transform; the design keeps copies inside the original "
                          f"part ({self.aliases[low]}), so it cannot be used on its own")
        if low not in self.solids:
            raise _Refuse(f"unknown {what} {ref!r}")
        return self.solids[low]

    def new_solid(self, w: _With, prim: dict, kind_label: str):
        name = (w.one("name") or "").strip()
        comp = (w.one("component") or "").strip()
        if not name:
            raise _Refuse("a shape without .Name")
        mat = self.use_material(w.one("material") or "PEC")
        try:
            resolve_primitive(prim, self.values, name, 0)
        except DesignError as e:
            raise _Refuse(e.detail) from None
        key = self.key(comp, name)
        if key in self.solids or key in self.aliases:
            raise _Refuse(f"a solid named {comp}:{name} exists already")
        if len(self.solids) >= MAX_SOLIDS:
            raise _Refuse(f"more than {MAX_SOLIDS} solids: {comp}:{name} and the shapes after it are not imported")
        self.components.add(comp)
        self.solids[key] = {"comp": comp, "name": name, "material": mat, "line": self.line,
                            "pieces": [{"material": mat, "primitives": [prim]}]}

    # ---- polyhedra: fairbeam writes them as ASCII STL files next to the macro and imports them with the STL object

    def stl_bytes(self, base: str):
        """The bytes of a supplied STL file (by base name, case-insensitive), or None."""
        if self.files is None:
            return None
        if callable(self.files):
            got = self.files(base)
        else:
            got = next((v for k, v in self.files.items() if re.split(r"[\\/]", k)[-1].lower() == base.lower()), None)
        return got.encode("utf-8") if isinstance(got, str) else got

    def stl(self, w: _With):
        if not w.has("read"):
            if w.has("writecad") or w.has("writemesh"):
                self.ignored_stmt("stl.write", "STL export commands: not part of the model; ignored")
            return
        name = (w.one("name") or "").strip()
        fname = (w.one("filename") or "").strip()
        base = re.split(r"[\\/]", fname)[-1]
        if not name or not base:
            raise _Refuse("an STL import needs .Name and .FileName")
        comp = (w.one("component") or "").strip()
        raw = self.stl_bytes(base)
        if raw is None:
            self.missing_stl.add(self.key(comp, name))
            raise _Refuse(f"STL import {comp}:{name}: the file {base!r} was not supplied. Import the .bas together with its .stl files "
                          "(the command line reads them from the macro's folder), or rebuild this solid in the designer")
        scaled = (w.one("scaletounit") or "False").strip().strip('"').lower() == "true"
        unit = (w.one("importfileunits") or self.len_unit).strip().lower()
        if scaled and unit not in LENGTH_MM:
            raise _Refuse(f"unknown STL import unit {unit!r}")
        k = LENGTH_MM[unit] if scaled else self.len_mm
        try:
            vertices, faces = parse_stl(raw)
        except ValueError as e:
            raise _Refuse(f"the STL file {base!r} cannot be read ({e})") from None
        vertices = [[round(x * k, 6) + 0.0 for x in v] for v in vertices]
        self.new_solid(w, {"kind": "polyhedron", "vertices": vertices, "faces": faces}, "polyhedron")
        self._extra(w, {"reset", "name", "component", "filename", "id", "scaletounit", "importfileunits",
                        "importtoactivecoordinatesystem", "read"}, "STL")

    def brick(self, w: _With):
        if not w.has("create"):
            return
        rng = []
        for a in "xyz":
            r = self.need(w, f"{a}range", 2)
            rng.append(tuple(self.lengths(r, 2)))
        g = self.frame.ranges(rng)
        start, stop = [], []
        for lo, hi in g:
            if self.val(lo) > self.val(hi):
                lo, hi = hi, lo
            start.append(lo)
            stop.append(hi)
        self.new_solid(w, {"kind": "box", "start": start, "stop": stop}, "brick")
        self._extra(w, {"reset", "name", "component", "material", "xrange", "yrange", "zrange", "create"}, "Brick")

    def _extra(self, w: _With, known: set, label: str):
        extra = {k for k, _a, _l in w.calls} - known
        if extra:
            self.note("info", f"{label}: ignored {w.names(extra)}")

    def _axis_shape(self, w: _With):
        """(global axis, sign, global centre point (3 values), global range (lo, hi) along the axis)."""
        a = (w.one("axis") or "z").strip().lower()
        if a not in AXES:
            raise _Refuse(f"axis {a!r} is not x, y or z")
        j = AXES.index(a)
        centre = [0.0, 0.0, 0.0]
        for k, c in enumerate(AXES):
            if k != j:
                centre[k] = self.expr(self.need(w, f"{c}center")[0], "length")
        r = self.lengths(self.need(w, f"{a}range", 2), 2)
        g, s = self.frame.axis(j)
        pt = self.frame.point(centre)
        O = self.frame.origin()[g]
        lo, hi = (_add(O, r[0]), _add(O, r[1])) if s > 0 else (_sub(O, r[1]), _sub(O, r[0]))
        return g, s, pt, (lo, hi)

    def _segments(self, w: _With, label: str):
        seg = w.one("segments")
        if seg is not None:
            try:
                n = self.val(self.expr(seg))
            except _Refuse:
                n = 0
            if n:
                self.note("warning", f"{label} with {seg} segments (faceted in CST) imported as a smooth shape")

    def cylinder(self, w: _With):
        if not w.has("create"):
            return
        g, s, pt, (lo, hi) = self._axis_shape(w)
        if self.val(lo) > self.val(hi):
            lo, hi = hi, lo
        prim = {"kind": "cylinder", "axis": AXES[g], "center": [pt[(g + 1) % 3], pt[(g + 2) % 3]],
                "radius": self.expr(self.need(w, "outerradius")[0], "length"), "range": [lo, hi]}
        if w.has("innerradius"):
            ri = self.expr(w.get("innerradius")[0], "length")
            if not (isinstance(ri, float) and ri == 0):
                prim["inner_radius"] = ri
        self._segments(w, "cylinder")
        self.new_solid(w, prim, "cylinder")
        self._extra(w, {"reset", "name", "component", "material", "outerradius", "innerradius", "axis", "xrange",
                        "yrange", "zrange", "xcenter", "ycenter", "zcenter", "segments", "create"}, "Cylinder")

    def cone(self, w: _With):
        if not w.has("create"):
            return
        g, s, pt, (lo, hi) = self._axis_shape(w)
        rb = self.expr(self.need(w, "bottomradius")[0], "length")
        rt = self.expr(self.need(w, "topradius")[0], "length")
        if s < 0:
            rb, rt = rt, rb
        if self.val(lo) > self.val(hi):
            lo, hi, rb, rt = hi, lo, rt, rb
        self._segments(w, "cone")
        self.new_solid(w, {"kind": "cone", "axis": AXES[g], "center": [pt[(g + 1) % 3], pt[(g + 2) % 3]],
                           "bottom_radius": rb, "top_radius": rt, "range": [lo, hi]}, "cone")
        self._extra(w, {"reset", "name", "component", "material", "bottomradius", "topradius", "axis", "xrange",
                        "yrange", "zrange", "xcenter", "ycenter", "zcenter", "segments", "create"}, "Cone")

    def torus(self, w: _With):
        if not w.has("create"):
            return
        a = (w.one("axis") or "z").strip().lower()
        if a not in AXES:
            raise _Refuse(f"axis {a!r} is not x, y or z")
        g, _s = self.frame.axis(AXES.index(a))
        ctr = self.frame.point([self.expr(self.need(w, f"{c}center")[0], "length") for c in AXES])
        ro = self.expr(self.need(w, "outerradius")[0], "length")
        ri = self.expr(self.need(w, "innerradius")[0], "length")
        self._segments(w, "torus")
        self.new_solid(w, {"kind": "torus", "axis": AXES[g], "center": ctr, "major_radius": _half(ro, ri),
                           "minor_radius": _half(ro, ri, -1)}, "torus")
        self._extra(w, {"reset", "name", "component", "material", "outerradius", "innerradius", "axis", "xcenter",
                        "ycenter", "zcenter", "segments", "create"}, "Torus")

    def sphere(self, w: _With):
        if not w.has("create"):
            return
        for k in ("topradius", "bottomradius"):
            if w.has(k) and self.val(self.expr(w.one(k), "length")) != 0:
                raise _Refuse("a sphere with a top or bottom radius (a sphere segment) has no design equivalent")
        c = self.need(w, "center", 3)
        ctr = self.frame.point(self.lengths(c, 3))
        self._segments(w, "sphere")
        self.new_solid(w, {"kind": "sphere", "center": ctr, "radius": self.expr(self.need(w, "centerradius")[0], "length")},
                       "sphere")
        self._extra(w, {"reset", "name", "component", "material", "axis", "centerradius", "topradius", "bottomradius",
                        "center", "segments", "create"}, "Sphere")

    # ---- curves

    def _curve_key(self, w: _With):
        name = (w.one("name") or "").strip()
        curve = (w.one("curve") or "").strip()
        if not name or not curve:
            raise _Refuse("a curve item needs .Name and .Curve")
        return f"{curve}:{name}".lower(), f"{curve}:{name}"

    def _planar_2d(self, pts_local):
        """Local (u, v) points (w = 0) -> a curve item in global coordinates."""
        g_w, s_w = self.frame.axis(2)
        pts = [self.frame.point([u, v, 0.0]) for u, v in pts_local]
        return {"kind": "polygon", "normal": g_w, "wsign": s_w, "plane": self.frame.origin()[g_w], "points": pts}

    def polygon(self, w: _With):
        if not w.has("create"):
            return
        key, label = self._curve_key(w)
        pts = []
        for k, a, ln in w.calls:
            if k == "point":
                if len(a) < 2:
                    raise _Refuse(".Point needs two values")
                pts.append(self.lengths(a, 2))
            elif k in ("lineto",):
                if len(a) < 2 or not pts:
                    raise _Refuse(".LineTo needs a start .Point and two values")
                pts.append(self.lengths(a, 2))
            elif k in ("rline", "rlineto"):
                if len(a) < 2 or not pts:
                    raise _Refuse(".RLine needs a start .Point and two values")
                d = self.lengths(a, 2)
                pts.append([_add(pts[-1][0], d[0]), _add(pts[-1][1], d[1])])
            elif k not in ("reset", "name", "curve", "create"):
                self.note("info", f"Polygon: ignored .{w.orig.get(k, k)}")
        self.curves[key] = self._planar_2d(pts)
        self.curves[key]["label"] = label

    def polygon3d(self, w: _With):
        if not w.has("create"):
            return
        key, label = self._curve_key(w)
        pts = []
        for k, a, ln in w.calls:
            if k in ("point", "lineto"):
                if len(a) < 3:
                    raise _Refuse(f".{k} of a Polygon3D needs three values")
                pts.append(self.frame.point(self.lengths(a, 3)))
            elif k not in ("reset", "name", "curve", "create", "version"):
                self.note("info", f"Polygon3D: ignored .{w.orig.get(k, k)}")
        if len(pts) < 2:
            raise _Refuse("a Polygon3D needs at least two points")
        vals = [[self.val(c) for c in p] for p in pts]
        flat = [k for k in range(3) if max(v[k] for v in vals) - min(v[k] for v in vals) <= 1e-9 * max(1.0, *(abs(v[k]) for v in vals))]
        if len(pts) < 3 or len(flat) != 1:
            # not a flat area: usable as the path of a wire (Wire .Curve), not as a profile
            self.curves[key] = {"kind": "path", "points": pts, "label": label}
            return
        n = flat[0]
        # Newell's normal: the right-hand orientation of the point order
        area = sum(vals[i][(n + 1) % 3] * vals[(i + 1) % len(vals)][(n + 2) % 3]
                   - vals[(i + 1) % len(vals)][(n + 1) % 3] * vals[i][(n + 2) % 3] for i in range(len(vals)))
        self.curves[key] = {"kind": "polygon", "normal": n, "wsign": 1 if area >= 0 else -1, "plane": pts[0][n],
                            "points": pts, "label": label, "p3d": True}

    def rotate_solid(self, w: _With):
        if not w.has("create"):
            return
        raise _Refuse(f"the solid of revolution {(w.one('name') or '').strip()!r} (Rotate with a point list) has no design equivalent: "
                      "designs revolve only cones and tori (a general profile, e.g. a horn flare, cannot be imported)")

    def wire(self, w: _With):
        """With Wire: a curve wire (``.Add``) and its conversion to a solid (``.ConvertToSolidShape``)."""
        wname = (w.one("name") or "").strip()
        if w.has("add"):
            if (w.one("type") or "Curvewire").strip().lower() != "curvewire":
                raise _Refuse(f"wire {wname!r} of type {w.one('type')!r}: only curve wires are imported")
            ref = (w.one("curve") or "").strip()
            item = self.curves.get(ref.lower())
            if item is None:
                raise _Refuse(f"unknown curve item {ref!r} for wire {wname!r}")
            if item["kind"] not in ("path", "polygon"):
                raise _Refuse(f"wire {wname!r} along the curve {ref!r}: only polygon paths have a design equivalent")
            radius = self.expr(w.one("radius", "0"), "length")
            pts = [list(p) for p in item["points"]]
            mat = w.one("material") or "PEC"
            solid_model = (w.get("solidwiremodel") or [_Arg('"False"')])[0].truth
            comp = (w.one("component") or "").strip()
            wire = {"points": pts, "radius": radius, "material": mat, "name": wname,
                    "solid": ref.split(":", 1)[-1] if ":" in ref else ref}
            if self.val(radius) > 0 and solid_model:
                self.wires[wname.lower()] = wire    # becomes a solid when it is converted
                return
            if self.val(radius) > 0:
                self.note("warning", f"wire {wname!r} has a radius but no solid wire model: imported as a solid wire")
            # a curve wire with no thickness (a thin PEC line): the design's zero-radius wire; the part is named
            # after the curve item (fairbeam writes <part>_wire)
            part = wname[:-5] if wname.lower().endswith("_wire") and len(wname) > 5 else wname
            if self.val(radius) <= 0:
                wire["radius"] = THIN_WIRE_RADIUS
                self.note("warning", f"curve wire {wname!r} has no thickness; a design wire needs a radius, so it is imported "
                          f"with a radius of {_num_text(THIN_WIRE_RADIUS)} mm (the mesh puts a thin wire on the nearest cell edges)")
            self._new_wire(part, comp, wire)
            return
        if w.has("converttosolidshape"):
            wire = self.wires.get(wname.lower())
            if wire is None:
                raise _Refuse(f"unknown wire {wname!r}")
            solid = (w.one("solidname") or "").strip()
            if not solid:
                raise _Refuse(f"wire {wname!r} converted to a solid without .SolidName")
            comp, _, sname = solid.rpartition(":")
            wire["material"] = w.one("material") or wire["material"]
            self._new_wire(sname, comp, wire)
            if not (w.get("keepwire") or [_Arg('"False"')])[0].truth:
                self.wires.pop(wname.lower(), None)
            return
        self.ignored_stmt("wire", "Wire: only .Add and .ConvertToSolidShape of a curve wire are imported")

    def _new_wire(self, name: str, comp: str, wire: dict):
        fake = _With("Wire", self.line)
        fake.calls = [("name", [_Arg(f'"{name}"')], 0), ("component", [_Arg(f'"{comp}"')], 0),
                      ("material", [_Arg(f'"{wire["material"]}"')], 0)]
        self.new_solid(fake, {"kind": "wire", "points": wire["points"], "radius": wire["radius"]}, "wire")

    def rectangle(self, w: _With):
        if not w.has("create"):
            return
        key, label = self._curve_key(w)
        x = self.lengths(self.need(w, "xrange", 2), 2)
        y = self.lengths(self.need(w, "yrange", 2), 2)
        self.curves[key] = self._planar_2d([(x[0], y[0]), (x[1], y[0]), (x[1], y[1]), (x[0], y[1])])
        self.curves[key]["label"] = label

    def circle(self, w: _With):
        if not w.has("create"):
            return
        key, label = self._curve_key(w)
        r = self.expr(self.need(w, "radius")[0], "length")
        cu = self.expr(self.need(w, "xcenter")[0], "length")
        cv = self.expr(self.need(w, "ycenter")[0], "length")
        g_w, s_w = self.frame.axis(2)
        self._segments(w, "circle")
        self.curves[key] = {"kind": "circle", "normal": g_w, "wsign": s_w, "plane": self.frame.origin()[g_w],
                            "center": self.frame.point([cu, cv, 0.0]), "radius": r, "label": label}

    def _curve(self, w: _With):
        ref = (w.one("curve") or "").strip()
        item = self.curves.get(ref.lower())
        if item is None:
            raise _Refuse(f"unknown curve item {ref!r} (only Polygon, Polygon3D, Rectangle and Circle curves are imported)")
        if item["kind"] == "path":
            raise _Refuse(f"the curve item {ref!r} is a Polygon3D that is not flat in an x, y or z plane (or has fewer than "
                          "three points): it can be the path of a wire, but it has no design equivalent as a profile")
        return item

    def _profile(self, item):
        """In-plane design points of a polygon curve item (repeated and closing points dropped)."""
        n = item["normal"]
        u, v = (n + 1) % 3, (n + 2) % 3
        pts = []
        for p in item["points"]:
            q = [p[u], p[v]]
            if pts and all(abs(self.val(q[k]) - self.val(pts[-1][k])) < 1e-12 for k in range(2)):
                continue
            pts.append(q)
        while len(pts) > 1 and all(abs(self.val(pts[0][k]) - self.val(pts[-1][k])) < 1e-12 for k in range(2)):
            pts.pop()
        vals = [[self.val(a), self.val(b)] for a, b in pts]
        area = sum(vals[i][0] * vals[(i + 1) % len(vals)][1] - vals[(i + 1) % len(vals)][0] * vals[i][1] for i in range(len(vals))) / 2
        if len(pts) < 3 or abs(area) < 1e-12:
            raise _Refuse("the curve is not a closed area (fewer than three distinct points or zero area)")
        return pts, vals

    @staticmethod
    def _rectangle(vals):
        """Index order of an axis-aligned rectangle's min/max corners, else None."""
        if len(vals) != 4:
            return None
        us = sorted({round(p[0], 12) for p in vals})
        vs = sorted({round(p[1], 12) for p in vals})
        if len(us) != 2 or len(vs) != 2:
            return None
        for i in range(4):
            a, b = vals[i], vals[(i + 1) % 4]
            if abs(a[0] - b[0]) > 1e-12 and abs(a[1] - b[1]) > 1e-12:
                return None
        lo = min(range(4), key=lambda i: (vals[i][0], vals[i][1]))
        hi = max(range(4), key=lambda i: (vals[i][0], vals[i][1]))
        return lo, hi

    def _circle_points(self, item):
        n = item["normal"]
        u, v = (n + 1) % 3, (n + 2) % 3
        cu, cv, r = item["center"][u], item["center"][v], item["radius"]
        pts = []
        for k in range(CIRCLE_SEGMENTS):
            t = 2 * math.pi * k / CIRCLE_SEGMENTS
            c, s = round(math.cos(t), 12) + 0.0, round(math.sin(t), 12) + 0.0
            pts.append([_add(cu, _mul(r, c)) if c else cu, _add(cv, _mul(r, s)) if s else cv])
        return pts

    def cover(self, w: _With):
        if not w.has("create"):
            return
        item = self._curve(w)
        n = item["normal"]
        if item["kind"] == "circle":
            prim = {"kind": "polygon", "normal": AXES[n], "elevation": item["plane"], "points": self._circle_points(item)}
            self.note("warning", f"covered circle {item['label']!r} imported as a regular {CIRCLE_SEGMENTS}-gon "
                      "(CSXCAD has no disc)")
        else:
            pts, vals = self._profile(item)
            rect = self._rectangle(vals)
            if rect is not None:
                lo, hi = rect
                start, stop = [0.0] * 3, [0.0] * 3
                start[n] = stop[n] = item["plane"]
                start[(n + 1) % 3], start[(n + 2) % 3] = pts[lo]
                stop[(n + 1) % 3], stop[(n + 2) % 3] = pts[hi]
                prim = {"kind": "box", "start": start, "stop": stop}
            else:
                prim = {"kind": "polygon", "normal": AXES[n], "elevation": item["plane"], "points": pts}
        self.new_solid(w, prim, "sheet")
        self._extra(w, {"reset", "name", "component", "material", "curve", "deletecurve", "create"}, "CoverCurve")

    def extrude_curve(self, w: _With):
        if not w.has("create"):
            return
        for k in ("twistangle", "taperangle"):
            if w.has(k) and self.val(self.expr(w.one(k))) != 0:
                raise _Refuse(f"an extrusion with a {k[:-5]} angle has no design equivalent")
        item = self._curve(w)
        t = self.expr(self.need(w, "thickness")[0], "length")
        length = t if item["wsign"] > 0 else _neg(t)
        n = item["normal"]
        if item.get("p3d"):
            self.note("warning", "a Polygon3D is extruded along its right-hand normal (the point order); check the side in the designer")
        if item["kind"] == "circle":
            lo, hi = item["plane"], _add(item["plane"], length)
            if self.val(lo) > self.val(hi):
                lo, hi = hi, lo
            prim = {"kind": "cylinder", "axis": AXES[n], "center": [item["center"][(n + 1) % 3], item["center"][(n + 2) % 3]],
                    "radius": item["radius"], "range": [lo, hi]}
        else:
            pts, _vals = self._profile(item)
            prim = {"kind": "linpoly", "normal": AXES[n], "elevation": item["plane"], "length": length, "points": pts}
        self.new_solid(w, prim, "extrusion")
        self._extra(w, {"reset", "name", "component", "material", "thickness", "twistangle", "taperangle",
                        "deleteprofile", "curve", "create"}, "ExtrudeCurve")

    def extrude(self, w: _With):
        if not w.has("create"):
            return
        mode = (w.one("mode") or "").strip().lower()
        if mode != "pointlist":
            raise _Refuse(f"Extrude in mode {w.one('mode')!r} (picked faces) has no design equivalent; only point lists are imported")
        for k in ("twist", "taper"):
            if w.has(k) and self.val(self.expr(w.one(k))) != 0:
                raise _Refuse(f"an extrusion with a {k} angle has no design equivalent")
        o = self.lengths(self.need(w, "origin", 3), 3)
        U = [self.val(self.expr(a)) for a in self.need(w, "uvector", 3)[:3]]
        V = [self.val(self.expr(a)) for a in self.need(w, "vvector", 3)[:3]]
        W = _cross(U, V)
        au, av, aw = _unit_axis(U), _unit_axis(V), _unit_axis(W)
        if au is None or av is None or aw is None:
            raise _Refuse("an extrusion whose plane is not an x, y or z plane has no design equivalent")
        pts_local = []
        for k, a, _ln in w.calls:
            if k in ("point", "lineto"):
                pts_local.append(self.lengths(a, 2))
        if len(pts_local) < 3:
            raise _Refuse("an extrusion needs at least three points")
        # the extrusion plane in local coordinates of the WCS, then global
        pts = []
        for u, v in pts_local:
            p = [0.0, 0.0, 0.0]
            p[au[0]] = _add(o[au[0]], u if au[1] > 0 else _neg(u))
            p[av[0]] = _add(o[av[0]], v if av[1] > 0 else _neg(v))
            p[aw[0]] = o[aw[0]]
            pts.append(self.frame.point(p))
        gw, sw = self.frame.axis(aw[0])
        sign = aw[1] * sw
        item = {"kind": "polygon", "normal": gw, "wsign": sign, "plane": pts[0][gw], "points": pts, "label": w.one("name")}
        h = self.expr(self.need(w, "height")[0], "length")
        prof, _vals = self._profile(item)
        self.new_solid(w, {"kind": "linpoly", "normal": AXES[gw], "elevation": item["plane"],
                           "length": h if sign > 0 else _neg(h), "points": prof}, "extrusion")

    # ---- WCS

    def wcs_call(self, m: str, args: list[_Arg]):
        f = self.frame
        vals = lambda n: [self.val(self.expr(a)) for a in args[:n]]  # noqa: E731
        if m == "activatewcs":
            mode = args[0].value.strip().lower() if args else "global"
            f.local = mode == "local"
        elif m == "setnormal":
            f.W = tuple(vals(3))
        elif m == "setorigin":
            f.O = self.lengths(args, 3)
        elif m == "setuvector":
            f.U = tuple(vals(3))
        elif m in ("alignwcswithglobalcoordinates", "alignwcswithglobal"):
            f.reset()
        elif m == "movewcs":
            if len(args) < 4:
                raise _Refuse("WCS.MoveWCS needs a mode and three values")
            d = self.lengths(args[1:4], 3)
            if args[0].value.strip().lower() == "local":
                g = f.vector(d) if f.local else d
            else:
                g = d
            f.O = [_add(f.O[k], g[k]) for k in range(3)]
        elif m == "rotatewcs":
            if len(args) < 2:
                raise _Refuse("WCS.RotateWCS needs an axis and an angle")
            ax = args[0].value.strip().lower()
            ang = self.val(self.expr(args[1]))
            if abs(ang / 90 - round(ang / 90)) > 1e-9:
                f.bad = f"rotated by {ang} degrees"
                return
            c, s = round(math.cos(math.radians(ang))), round(math.sin(math.radians(ang)))
            U, W = f.U, f.W
            V = _cross(W, U)
            comb = lambda a, b, ca, cb: tuple(ca * a[k] + cb * b[k] for k in range(3))  # noqa: E731
            if ax == "w":
                f.U = comb(U, V, c, s)
            elif ax == "u":
                f.W = comb(V, W, -s, c)
            elif ax == "v":
                f.W, f.U = comb(W, U, c, s), comb(W, U, -s, c)
            else:
                raise _Refuse(f"unknown WCS axis {ax!r}")
        elif m == "store":
            f.stored[(args[0].value if args else "").lower()] = f.state()
        elif m == "restore":
            st = f.stored.get((args[0].value if args else "").lower())
            if st is None:
                raise _Refuse("WCS.Restore of a WCS that was not stored")
            f.restore(st)
        elif m in ("setwcsfromreferenceblock", "alignwcswithselected", "alignwcswithface", "alignwcswithedge",
                   "alignwcswithpoint", "alignwcswithselectedpoint", "alignwcswithselectedface"):
            f.bad = f"aligned with picked geometry (WCS.{m})"
            f.local = True
            self.unsupported_stmt(f"wcs.{m}", f"WCS aligned with picked geometry (WCS.{m}) cannot be reproduced; "
                                  "shapes drawn in it are not imported")
        elif m in ("setupvector", "setuvectorfromshape"):
            self.unsupported_stmt(f"wcs.{m}", f"WCS.{m}: not supported")
        else:
            self.unsupported_stmt(f"wcs.{m}", f"WCS.{m}: not supported")
        if m in ("setnormal", "setuvector"):
            f.orthogonalize()

    # ---- components and Boolean operations

    def component_call(self, m: str, args: list[_Arg]):
        if m == "new":
            if args:
                self.components.add(args[0].value.strip())
            return
        if m == "delete":
            comp = args[0].value.strip().lower() if args else ""
            for k in [k for k, s in self.solids.items() if s["comp"].lower() == comp or s["comp"].lower().startswith(comp + "/")]:
                del self.solids[k]
            return
        if m == "rename" and len(args) >= 2:
            old, new = args[0].value.strip(), args[1].value.strip()
            for s in self.solids.values():
                if s["comp"].lower() == old.lower() or s["comp"].lower().startswith(old.lower() + "/"):
                    s["comp"] = new + s["comp"][len(old):]
            self._rekey()
            return
        self.unsupported_stmt(f"component.{m}", f"Component.{m}: not supported")

    def _rekey(self):
        self.solids = {self.key(s["comp"], s["name"]): s for s in self.solids.values()}

    @staticmethod
    def _same_frame(a: dict, b: dict) -> bool:
        return (json.dumps(a.get("transforms", []), sort_keys=True) == json.dumps(b.get("transforms", []), sort_keys=True)
                and "booleanHistory" not in a and "booleanHistory" not in b)

    def single_part(self, solid: dict) -> dict:
        """The solid as one design part (its pieces merged when they share their transforms)."""
        pieces = solid["pieces"]
        first = pieces[0]
        if len(pieces) > 1 and not all(self._same_frame(first, p) for p in pieces[1:]):
            raise _Refuse(f"{solid['comp']}:{solid['name']} is made of pieces with different transforms; "
                          "a Boolean operand must be one design part")
        part = copy.deepcopy(first)
        for p in pieces[1:]:
            part["primitives"] += copy.deepcopy(p["primitives"])
        part["name"] = solid["name"]
        part["material"] = solid["material"]
        if solid["comp"]:
            part["component"] = solid["comp"]
        return part

    def solid_call(self, m: str, args: list[_Arg], meth: str = ""):
        if m in ("add", "subtract", "intersect", "insert"):
            if len(args) < 2:
                raise _Refuse(f"Solid.{m} needs two solids")
            a, b = self.solid_ref(args[0].value), self.solid_ref(args[1].value)
            if a is b:
                raise _Refuse(f"Solid.{m} of a solid with itself")
            if m == "add":
                return self.boolean_add(a, b)
            return self.boolean(m, a, b)
        if m == "delete" and args:
            s = self.solid_ref(args[0].value)
            del self.solids[self.key(s["comp"], s["name"])]
            return
        if m == "rename" and len(args) >= 2:
            s = self.solid_ref(args[0].value)
            new = args[1].value.strip()
            if ":" in new:
                comp, new = new.rsplit(":", 1)
                s["comp"] = comp
            if self.key(s["comp"], new) in self.solids and self.solids[self.key(s["comp"], new)] is not s:
                raise _Refuse(f"Solid.Rename to an existing name {new!r}")
            s["name"] = new
            self._rekey()
            return
        if m == "changematerial" and len(args) >= 2:
            s = self.solid_ref(args[0].value)
            s["material"] = self.use_material(args[1].value)
            for p in s["pieces"]:
                p["material"] = s["material"]
            return
        if m == "changecomponent" and len(args) >= 2:
            s = self.solid_ref(args[0].value)
            s["comp"] = args[1].value.strip()
            self._rekey()
            return
        self.unsupported_stmt(f"solid.{m}", f"Solid.{meth or m}: this operation has no design equivalent")

    def boolean_add(self, a: dict, b: dict):
        """A ∪ B: B's shapes join A (the union keeps A's material and name, as CST does)."""
        if b["material"] != a["material"]:
            self.note("warning", f"Solid.Add: {b['comp']}:{b['name']} ({b['material']}) takes the material of "
                      f"{a['comp']}:{a['name']} ({a['material']}), as in CST")
        for piece in b["pieces"]:
            target = next((p for p in a["pieces"] if self._same_frame(p, piece)), None)
            if target is not None:
                target["primitives"] += piece["primitives"]
            else:
                a["pieces"].append({**piece, "material": a["material"]})
        del self.solids[self.key(b["comp"], b["name"])]

    @staticmethod
    def _boolean_depth(solid: dict) -> int:
        depth = 0
        stack = [(p, 1) for p in solid["pieces"] if p.get("booleanHistory")]
        while stack:
            node, d = stack.pop()
            depth = max(depth, d)
            h = node.get("booleanHistory") or {}
            stack += [(h[k], d + 1) for k in ("A", "B") if isinstance(h.get(k), dict) and h[k].get("booleanHistory")]
        return depth

    def boolean(self, op: str, a: dict, b: dict):
        if max(self._boolean_depth(a), self._boolean_depth(b)) >= MAX_BOOLEAN_DEPTH:
            raise _Refuse(f"Solid.{op.capitalize()} {a['comp']}:{a['name']} with {b['comp']}:{b['name']}: more than "
                          f"{MAX_BOOLEAN_DEPTH} nested Boolean operations ({a['comp']}:{a['name']} is kept without it)")
        pa, pb = self.single_part(a), self.single_part(b)
        pa.pop("component", None)
        pb.pop("component", None)
        h = {"operation": op, "A": pa, "B": pb, "live": True}
        try:
            prims = boolean_primitives(h, self.values, "booleanHistory", curved=False)
        except DesignError as e:
            if op == "subtract" and not a.get("cavity"):
                return self.cavity(a, b, e.detail)
            lost = "" if op == "insert" else f"; {b['comp']}:{b['name']} (consumed by the operation) is not in the design either"
            raise _Refuse(f"Solid.{op.capitalize()} {a['comp']}:{a['name']} with {b['comp']}:{b['name']}: {e.detail} "
                          f"({a['comp']}:{a['name']} is kept without the operation{lost})") from None
        a["pieces"] = [{"material": a["material"], "primitives": prims, "booleanHistory": h}]
        if op != "insert":
            del self.solids[self.key(b["comp"], b["name"])]

    def cavity(self, a: dict, b: dict, why: str):
        """A − B that design Booleans can't cut (a cylinder, sphere, cone or torus, e.g. the bore of a
        connector body): B's volume becomes a vacuum shape above A, the way openEMS resolves overlapping
        shapes by priority, so the model is the same. A drops below the default dielectrics; shapes put
        in the cavity later are raised above it (``_fill_cavities``)."""
        for piece in a["pieces"]:
            for p in piece["primitives"]:
                p["priority"] = CAVITY_HOST
        air = self.use_material("Vacuum")
        for piece in b["pieces"]:
            piece["material"] = air
            for p in piece["primitives"]:
                p["priority"] = CAVITY_CUT
        was = f"{b['comp']}:{b['name']}"
        b.update(material=air, name=f"{b['name']}_cut", cavity=True)
        self._rekey()
        self.note("warning", f"Solid.Subtract {a['comp']}:{a['name']} with {was}: {why}. The cut is modelled as the vacuum "
                  f"shape {b['name']} over {a['name']} (openEMS priorities): the same model, drawn as two parts")

    def _fill_cavities(self):
        """Dielectric shapes inside a modelled cavity (e.g. a connector's PTFE) above its vacuum shape;
        metal is above both by default."""
        def boxes(s):
            out = []
            for piece in s["pieces"]:
                for p in piece["primitives"]:
                    try:
                        out.append(prim_bbox(resolve_primitive(p, self.values, s["name"], 0)))
                    except (DesignError, KeyError, TypeError, ValueError):
                        pass
            return out

        cuts = [bb for s in self.solids.values() if s.get("cavity") for bb in boxes(s)]
        if not cuts:
            return
        overlap = lambda p, q: all(min(p[1][k], q[1][k]) - max(p[0][k], q[0][k]) > 1e-9 for k in range(3))
        for s in self.solids.values():
            if s.get("cavity") or self.materials.get(s["material"].lower(), {}).get("kind") == "metal":
                continue
            if any(p["priority"] == CAVITY_HOST for piece in s["pieces"] for p in piece["primitives"] if "priority" in p):
                continue
            if any(overlap(bb, cut) for bb in boxes(s) for cut in cuts):
                for piece in s["pieces"]:
                    for p in piece["primitives"]:
                        p["priority"] = CAVITY_FILL
                self.note("info", f"{s['comp']}:{s['name']} fills a modelled cavity: drawn above its vacuum shape", "parts", 0)

    def _thin_metal_sheets(self):
        """Metal bricks and extrusions thinner than THIN_METAL (PCB copper: 18, 35, 70 um) as zero-thickness
        sheets on the face that touches a dielectric (else their base), as openEMS models are drawn:
        resolving 35 um would take cells of ~5 um and, through the timestep, ~100k steps for one pulse.

        Not for fairbeam's own exports (their fairbeam-data records carry the boundaries): those hold
        the geometry exactly as the design had it, and the design's own thin-metal setting (in the
        mesh record) decides at build time, so a round trip keeps a 35 um brick a brick."""
        if self.meta_bounds is not None:
            return
        diel = []
        for s in self.solids.values():
            if self.materials.get(s["material"].lower(), {}).get("kind") == "metal" or s.get("cavity"):
                continue
            for piece in s["pieces"]:
                for p in piece["primitives"]:
                    try:
                        diel.append(prim_bbox(resolve_primitive(p, self.values, s["name"], 0)))
                    except (DesignError, KeyError, TypeError, ValueError):
                        pass
        flat = []
        for s in self.solids.values():
            if self.materials.get(s["material"].lower(), {}).get("kind") != "metal":
                continue
            for piece in s["pieces"]:
                if piece.get("booleanHistory") or piece.get("transforms"):
                    continue
                for p in piece["primitives"]:
                    if p.get("kind") == "linpoly" and isinstance(p.get("length"), (int, float)) and isinstance(p.get("elevation"), (int, float)):
                        n = AXES.index(p["normal"])
                        lo, hi = sorted((p["elevation"], p["elevation"] + p["length"]))
                    elif p.get("kind") == "box" and all(isinstance(c, (int, float)) for c in p["start"] + p["stop"]):
                        d = [abs(p["stop"][k] - p["start"][k]) for k in range(3)]
                        n = min(range(3), key=lambda k: d[k])
                        lo, hi = sorted((p["start"][n], p["stop"][n]))
                    else:
                        continue
                    if not 0 < hi - lo <= THIN_METAL:
                        continue
                    face = next((f for f in (lo, hi) for bb in diel if abs(bb[1][n] - f) < 1e-6 or abs(bb[0][n] - f) < 1e-6),
                                p["elevation"] if p.get("kind") == "linpoly" else lo)
                    if p["kind"] == "linpoly":
                        p["kind"] = "polygon"
                        p.pop("length")
                        p["elevation"] = face
                    else:
                        p["start"][n] = p["stop"][n] = face
                    flat.append((s["name"], hi - lo))
        if flat:
            names = sorted({n for n, _ in flat})
            t = max(t for _, t in flat)
            self.note("warning", f"thin metal ({_num_text(round(t * 1000, 3))} um or less: {', '.join(names[:8])}"
                      f"{' ...' if len(names) > 8 else ''}) imported as zero-thickness sheets on its dielectric face, the "
                      "usual openEMS model of PCB copper: meshing the thickness would need cells of a few um and a very "
                      "long run. CST models the thickness; the difference is small", "parts", 0)

    # ---- transforms

    def transform(self, w: _With):
        what = w.get("transform")
        if not what or len(what) < 2:
            raise _Refuse("Transform without .Transform \"Shape\", \"<type>\"")
        target, kind = what[0].value.strip().lower(), what[1].value.strip().lower()
        if target != "shape":
            raise _Refuse(f"transforming a {what[0].value} has no design equivalent (only shapes are transformed)")
        names = [a[0].value for k, a, _ln in w.calls if k == "name" and a]
        names += [a[0].value.split("$", 1)[1] for k, a, _ln in w.calls if k == "addname" and a and "$" in a[0].value]
        if not names:
            raise _Refuse("Transform without .Name")
        multiple = (w.get("multipleobjects") or [_Arg('"False"')])[0].truth
        group = (w.get("groupobjects") or [_Arg('"False"')])[0].truth
        reps = self.expr(w.one("repetitions", "1")) if multiple else 0.0
        if multiple and (w.one("material") or "").strip():
            raise _Refuse("copies with another material have no design equivalent")
        if (w.one("destination") or "").strip():
            self.note("warning", f"Transform: copies stay in the original component (destination {w.one('destination')!r} ignored)")
        solids = [self.solid_ref(n) for n in names]
        origin = (w.one("origin") or "Free").strip().lower()
        if kind == "matrix":
            raise _Refuse("a Transform \"Matrix\" (a shear or other general linear map) has no design equivalent: "
                          "designs rotate, mirror, scale uniformly and translate")
        if kind == "translate":
            vec = self.frame.vector(self.lengths(self.need(w, "vector", 3), 3))
            tr = {"type": "translate", "copies": reps, "step": vec} if multiple else {"type": "move", "offset": vec}
        else:
            if origin == "free":
                center = self.frame.point(self.lengths(self.need(w, "center", 3), 3))
            elif origin in ("shapecenter", "commoncenter"):
                center = self._center(solids)
                self.note("info", f"Transform about the {origin.replace('center', ' centre')}: the centre is fixed at its "
                          f"current value ({', '.join(_num_text(c) for c in center)} mm)")
            else:
                raise _Refuse(f"transform origin {w.one('origin')!r} is not supported")
            if kind == "rotate":
                ang = [self.expr(a) for a in self.need(w, "angle", 3)[:3]]
                gv = self.frame.vector(ang)
                nz = [k for k in range(3) if abs(self.val(gv[k])) > 1e-12]
                if len(nz) != 1:
                    raise _Refuse("a rotation about more than one axis (or by zero) has no design equivalent")
                k = nz[0]
                a_deg = self.val(gv[k])
                if not math.isfinite(a_deg):
                    raise _Refuse("a rotation by a non-finite angle has no design equivalent")
                # any angle is a design rotation: quarter turns stay exact signed permutations, other angles
                # keep the native shape and carry a rotation matrix (design.transform_maps / map_primitive)
                tr ={"type": "rotate", "axis": AXES[k], "center": center, "angle": gv[k], "copies": reps}
            elif kind == "mirror":
                nv = [self.val(self.expr(a)) for a in self.need(w, "planenormal", 3)[:3]]
                ua = _unit_axis(self.frame.vector(nv))
                if ua is None:
                    raise _Refuse("a mirror plane that is not an x, y or z plane has no design equivalent")
                tr = {"type": "mirror", "plane": AXES[ua[0]], "point": center, "keep": bool(multiple)}
            elif kind == "scale":
                f = [self.expr(a) for a in self.need(w, "scalefactor", 3)[:3]]
                fv = [self.val(x) for x in f]
                if max(fv) - min(fv) > 1e-12 * max(1.0, *(abs(x) for x in fv)):
                    raise _Refuse("nonuniform scaling has no design equivalent")
                tr = {"type": "scale", "factors": f, "origin": center, "copies": reps}
            else:
                raise _Refuse(f"transform {what[1].value!r} is not supported")
        if any(len(p.get("transforms", [])) >= MAX_TRANSFORMS for s in solids for p in s["pieces"]):
            raise _Refuse(f"more than {MAX_TRANSFORMS} transforms of one shape")
        for s in solids:
            for p in s["pieces"]:
                p.setdefault("transforms", []).append(copy.deepcopy(tr))
            try:
                for p in s["pieces"]:
                    transform_maps(p["transforms"], self.values, "transforms")
            except DesignError as e:
                for p in s["pieces"]:
                    p["transforms"].pop()
                raise _Refuse(e.detail) from None
            issue = self._sheet_issue(s)
            if issue:
                for p in s["pieces"]:
                    p["transforms"].pop()
                raise _Refuse(f"{s['name']!r}: {issue}")
            if multiple and not group:
                n = int(round(self.val(reps)))
                for i in range(1, (1 if kind == "mirror" else n) + 1):
                    self.aliases[self.key(s["comp"], f"{s['name']}_{i}")] = f"{s['comp']}:{s['name']}"

    def _sheet_issue(self, s):
        """Why a zero-thickness metal sheet of this solid cannot keep its transforms (a sheet turned off
        the Yee grid axes), or None. Only sheets are affected: finite-thickness shapes rotate freely."""
        mat = self.materials.get(s["material"].lower(), {})
        if mat.get("kind") != "metal":
            return None
        parts = [{**copy.deepcopy(p), "name": f"x{i}", "material": "m"} for i, p in enumerate(s["pieces"])]
        d = {"materials": [{**{k: v for k, v in mat.items() if not k.startswith("_")}, "name": "m", "kind": "metal"}],
             "parts": parts}
        try:
            issues = sheet_transform_issues(d, self.values)
        except (DesignError, KeyError, TypeError, ValueError):
            return None
        return issues[0][1] if issues else None

    def _center(self, solids):
        lo, hi = [math.inf] * 3, [-math.inf] * 3
        for s in solids:
            for p in s["pieces"]:
                d = {"materials": [{"name": "m", "kind": "metal"}],
                     "parts": [{**copy.deepcopy(p), "name": "x", "material": "m"}]}
                try:
                    for part in resolve_parts(d, self.values):
                        for q in part["prims"]:
                            a, b = prim_bbox(q)
                            lo = [min(lo[k], a[k]) for k in range(3)]
                            hi = [max(hi[k], b[k]) for k in range(3)]
                except DesignError as e:
                    raise _Refuse(e.detail) from None
        return [round((lo[k] + hi[k]) / 2, 6) + 0.0 for k in range(3)]

    # ---- simulation settings

    def boundary(self, w: _With):
        kinds = []
        for face in FACES:
            v = (w.one(face.lower()) or "expanded open").strip().lower()
            if v not in BOUNDARY:
                self.note("warning", f"boundary {face} {w.one(face.lower())!r} has no design equivalent: open (MUR) used")
            kinds.append((v, BOUNDARY.get(v, "MUR")))
        self.boundaries = kinds
        for sym in ("xsymmetry", "ysymmetry", "zsymmetry"):
            v = (w.one(sym) or "none").strip().lower()
            if v != "none":
                self.note("warning", f"symmetry plane .{sym} {w.one(sym)!r} is not modelled: the full structure is simulated")
        self._extra(w, {"reset", "xmin", "xmax", "ymin", "ymax", "zmin", "zmax", "xsymmetry", "ysymmetry",
                        "zsymmetry", "applyinalldirections", "openaddspacefactor", "xminthermal", "xmaxthermal",
                        "yminthermal", "ymaxthermal", "zminthermal", "zmaxthermal", "xsymmetrythermal",
                        "ysymmetrythermal", "zsymmetrythermal", "applyinalldirectionsthermal", "resetthermalboundaryvalues",
                        "wallflow", "enteringwallflow", "leavingwallflow", "resetstructuralboundaryvalues", "xpotential",
                        "xminpotential", "xmaxpotential", "yminpotential", "ymaxpotential", "zminpotential", "zmaxpotential"},
                    "Boundary")

    def background(self, w: _With):
        typ = (w.one("type") or "Normal").strip().lower()
        if typ not in ("normal", "background"):
            self.note("warning", f"background type {w.one('type')!r}: the design background is vacuum")
        eps = w.one("epsilon")
        if eps is not None and abs(self.val(self.expr(eps)) - 1) > 1e-12:
            self.note("warning", f"background epsilon {eps} is not modelled: the design background is vacuum")
        spaces = [f for f in FACES if w.has(f"{f.lower()}space") and self.val(self.expr(w.one(f"{f.lower()}space"), "length")) != 0]
        if spaces:
            self.note("info", "background spaces (" + ", ".join(spaces) + ") ignored: the automatic mesh adds its own "
                      "space around the structure")

    def solver(self, w: _With):
        for k, a, _ln in w.calls:
            if k == "frequencyrange" and len(a) >= 2:
                self.f_range = (self.expr(a[0], "freq"), self.expr(a[1], "freq"))
            elif k == "steadystatelimit" and a:
                self.end_db = self.val(self.expr(a[0]))
        extra = {k for k, _a, _l in w.calls} - {"frequencyrange", "steadystatelimit", "reset"}
        if extra:
            self.note("info", f"Solver: ignored {w.names(extra)}")

    def mesh(self, w: _With):
        for k, a, _ln in w.calls:
            if k == "linesperwavelength" and a:
                self.cpw = self.val(self.expr(a[0]))
        extra = {k for k, _a, _l in w.calls} - {"linesperwavelength"}
        if extra:
            self.note("info", f"Mesh: ignored {w.names(extra)} (the design meshes automatically)")

    def mesh_settings(self, w: _With):
        ignored = []
        hexahedral = (w.one("setmeshtype") or "").strip().lower() in ("hex", "hextlm")
        density_seen = False
        for k, a, _ln in w.calls:
            if k == "set" and len(a) >= 2:
                what = a[0].value.strip().lower()
                if what in ("stepsperwavenear", "stepsperwavefar"):
                    density_seen = True
                    # Only hexahedral settings describe cells per wavelength for FDTD.
                    if hexahedral:
                        value = self.val(self.expr(a[1]))
                        if what == "stepsperwavenear":
                            self.cpw = value
                        else:
                            self.air_cpw = value
                else:
                    ignored.append(a[0].value)
            elif k not in ("setmeshtype",):
                ignored.append(f".{w.orig.get(k, k)}")
        if density_seen:
            if hexahedral:
                self.note("info", "MeshSettings: hexahedral StepsPerWaveNear maps to cells per wavelength; "
                          "StepsPerWaveFar maps to air cells per wavelength only when positive and lower than the near density.")
            else:
                self.note("info", "MeshSettings: StepsPerWaveNear and StepsPerWaveFar ignored because the mesh type is not "
                          "Hex or HexTLM; Fairbeam's automatic FDTD mesh default is retained unless a hexahedral density is provided.")
        if ignored:
            self.note("info", f"MeshSettings: ignored {', '.join(ignored[:12])}{' ...' if len(ignored) > 12 else ''} "
                      "(the design meshes automatically)")

    def monitor(self, w: _With):
        if not w.has("create"):
            return
        name = w.one("name") or ""
        ft = (w.one("fieldtype") or "").strip().lower()
        dom = (w.one("domain") or "Frequency").strip().lower()
        if dom != "frequency":
            raise _Refuse(f"monitor {name!r}: time-domain monitors are not imported")
        f = w.get("monitorvalue") or w.get("frequency")
        if not f:
            raise _Refuse(f"monitor {name!r} without a frequency")
        fv = self.expr(f[0], "freq")
        if ft == "farfield":
            self.farfield.append((name, fv))
        elif ft in ("hfield", "surfacecurrent", "current"):
            self.currents.append((name, fv))
            self.note("info", f"monitor {name!r} ({w.one('fieldtype')}) imported as a surface-current map")
        else:
            # a field view: nothing in the model or its S-parameters depends on it
            self.note("info", f"monitor {name!r} ({w.one('fieldtype')}) is a field view with no design equivalent; ignored "
                      "(far-field and surface-current monitors are imported; the S-parameters don't depend on it)")

    def delete_monitor(self, name: str):
        self.farfield = [x for x in self.farfield if x[0].lower() != name.lower()]
        self.currents = [x for x in self.currents if x[0].lower() != name.lower()]

    # ---- ports and lumped elements

    def _points(self, w: _With, key: str, local: bool):
        a = self.need(w, key, 4)
        if a[0].truth:
            raise _Refuse(f".{key} uses a picked point, which cannot be reproduced; give coordinates")
        p = self.lengths(a[1:4], 3)
        return self.frame.point(p) if local else p

    def _line(self, p1, p2):
        v1, v2 = [self.val(x) for x in p1], [self.val(x) for x in p2]
        d = [v2[k] - v1[k] for k in range(3)]
        ua = _unit_axis(d)
        if ua is None:
            raise _Refuse("the port or element is not along the x, y or z axis (designs need an axis-aligned line)")
        return ua[0], v1, v2

    def _meta_box(self, meta: dict | None, axis: int, v1, v2):
        """The fairbeam box of a port / resistor when its centre line is this CST line (else None)."""
        if not meta or meta.get("direction") not in AXES or AXES.index(meta["direction"]) != axis:
            return None
        try:
            s = [float(x) * self.meta_unit for x in meta["start"]]
            e = [float(x) * self.meta_unit for x in meta["stop"]]
        except (KeyError, TypeError, ValueError):
            return None
        mid = [(s[k] + e[k]) / 2 for k in range(3)]
        a, b = list(mid), list(mid)
        a[axis], b[axis] = s[axis], e[axis]
        tol = 1e-6 * max(1.0, *(abs(x) for x in v1 + v2))
        if all(abs(a[k] - v1[k]) <= tol and abs(b[k] - v2[k]) <= tol for k in range(3)):
            return [round(x, 6) + 0.0 for x in s], [round(x, 6) + 0.0 for x in e]
        return None

    def discrete_port(self, w: _With):
        if not w.has("create"):
            return
        num = int(round(self.val(self.expr(self.need(w, "portnumber")[0]))))
        typ = (w.one("type") or "SParameter").strip().lower()
        if typ != "sparameter":
            raise _Refuse(f"discrete port {num} of type {w.one('type')!r}: only S-parameter ports are imported")
        if any(p["number"] == num for p in self.ports):
            raise _Refuse(f"port number {num} is used twice")
        local = (w.get("localcoordinates") or [_Arg('"False"')])[0].truth
        p1, p2 = self._points(w, "setp1", local), self._points(w, "setp2", local)
        if (w.get("invertdirection") or [_Arg('"False"')])[0].truth:
            p1, p2 = p2, p1
        axis, v1, v2 = self._line(p1, p2)
        port = {"type": "lumped", "number": num, "R": self.expr(w.one("impedance", "50"), "ohm"),
                "start": p1, "stop": p2, "direction": AXES[axis]}
        box = self._meta_box(self.meta_ports.get(num) if (self.meta_ports.get(num) or {}).get("type") == "lumped" else None,
                             axis, v1, v2)
        if box:
            # a box that is just the CST line keeps the line's expressions (a parametric export: the port follows its
            # parameters); a box with width across the line (an openEMS port is a sheet) is the exact numeric one
            tol = 1e-6
            same = all(abs(self.val(p1[k]) - box[0][k]) <= tol * max(1.0, abs(box[0][k])) and abs(self.val(p2[k]) - box[1][k]) <= tol * max(1.0, abs(box[1][k]))
                       for k in range(3))
            if not same:
                port["start"], port["stop"] = box
            if self.meta_ports[num].get("excite") is False:
                port["excite"] = False
        elif w.obj.lower() == "discretefaceport":
            self.note("warning", f"discrete face port {num} imported as a line port between its two points")
        rad = w.one("radius")
        if rad is not None and self.val(self.expr(rad, "length")) != 0:
            self.note("info", f"port {num}: the wire radius {rad} is not modelled")
        self.ports.append(port)
        self.made("port", str(num), f"lumped, {_num_text(port['R']) if isinstance(port['R'], float) else port['R']} ohm, along {AXES[axis]}"
                  + (" (exact Fairbeam port box)" if box else ""))

    def lumped_element(self, w: _With):
        if not w.has("create"):
            return
        typ = (w.one("settype") or "RLCSerial").strip().lower()
        branches = {}
        for key, setter, kind in (("R", "setr", "ohm"), ("L", "setl", "ind"), ("C", "setc", "cap")):
            if w.has(setter):
                e = self.expr(w.one(setter), kind)
                if self.val(e) != 0:     # CST: a zero value leaves that branch out
                    branches[key] = e
        name = (w.one("setname") or w.one("name") or f"{'R' if set(branches) <= {'R'} else 'LE'}{len(self.resistors) + 1}").strip()
        if typ not in ("rlcserial", "rlcparallel"):
            raise _Refuse(f"lumped element {name!r}: the type {w.one('settype')!r} has no design equivalent "
                          "(only RLCSerial and RLCParallel elements are imported)")
        if not branches:
            raise _Refuse(f"lumped element {name!r}: R, L and C are all zero, so there is no component to build")
        for key, e in branches.items():
            if self.val(e) < 0:
                raise _Refuse(f"lumped element {name!r}: a negative {key} has no design equivalent (R, L and C must be > 0)")
        p1, p2 = self._points(w, "setp1", False), self._points(w, "setp2", False)
        if (w.get("setinvert") or [_Arg('"False"')])[0].truth:
            p1, p2 = p2, p1
        axis, v1, v2 = self._line(p1, p2)
        r = {"name": name, **branches, "start": p1, "stop": p2, "direction": AXES[axis]}
        if len(branches) > 1:
            r["topology"] = "series" if typ == "rlcserial" else "parallel"
        box = self._meta_box(self.meta_res.get(name.lower()), axis, v1, v2)
        if box:
            r["start"], r["stop"] = box
            exact = self._meta_rlc(self.meta_res.get(name.lower()))
            if exact:
                # the exact SI values (H, F) and connection that fairbeam's own export wrote next to the CST element
                r = {"name": name, **exact, "start": r["start"], "stop": r["stop"], "direction": r["direction"]}
                branches = {k: r[k] for k in ("R", "L", "C") if k in r}
        self.resistors.append(r)
        shown = {"R": "ohm", "L": "H", "C": "F"}
        text = " ".join(f"{k} = {_num_text(e) if isinstance(e, float) else e} {shown[k]}" for k, e in branches.items())
        self.made("resistor", name, text + (f" ({r['topology']})" if "topology" in r else ""))

    @staticmethod
    def _meta_rlc(meta: dict | None) -> dict | None:
        """R / L / C (SI) and topology of a fairbeam-data ``resistor`` / ``rlc`` record, else None."""
        if not meta:
            return None
        out = {}
        for k in ("R", "L", "C"):
            v = meta.get(k)
            if v is None:
                continue
            if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or v <= 0:
                return None
            out[k] = float(v)
        if not out:
            return None
        if len(out) > 1:
            if meta.get("topology") not in ("series", "parallel"):
                return None
            out["topology"] = meta["topology"]
        return out

    def waveguide_port(self, w: _With):
        if not w.has("create"):
            return
        num = int(round(self.val(self.expr(self.need(w, "portnumber")[0]))))
        if any(p["number"] == num for p in self.ports):
            raise _Refuse(f"port number {num} is used twice")
        coords = (w.one("coordinates") or "Free").strip().lower()
        if coords != "free":
            raise _Refuse(f"waveguide port {num} with {w.one('coordinates')!r} coordinates: only free (given) ranges are imported")
        orient = (w.one("orientation") or "").strip().lower()
        if not re.fullmatch(r"[xyz](min|max)", orient):
            raise _Refuse(f"waveguide port {num}: unknown orientation {w.one('orientation')!r}")
        k = AXES.index(orient[0])
        rng = [tuple(self.lengths(self.need(w, f"{a}range", 2), 2)) for a in AXES]
        g = self.frame.ranges(rng) if self.frame.local else rng
        u, v = (k + 1) % 3, (k + 2) % 3
        a = _sub(g[u][1], g[u][0])
        b = _sub(g[v][1], g[v][0])
        plane = g[k][0]
        meta = self.meta_ports.get(num)
        if meta and meta.get("type") == "waveguide" and meta.get("direction") == AXES[k]:
            port = self._meta_waveguide(meta)
            if port is not None and abs(self.val(port["start"][k]) - self.val(plane)) < 1e-6 * max(1.0, abs(self.val(plane))):
                self.ports.append(port)
                self.made("port", str(num), f"waveguide {port.get('mode', 'TE10')} (exact Fairbeam port)")
                self.note("info", f"waveguide port {num} restored from the fairbeam-data records (the exact Fairbeam port; the CST "
                          "port block holds the same cross-section)", "ports", 0)
                return
        coax = self._coax(k, [[self.val(x) for x in g[i]] for i in range(3)])
        if coax is not None:
            cu, cv, r, R, eps = coax
            p0 = round(self.val(plane), 6) + 0.0
            start, stop = [p0] * 3, [p0] * 3
            start[u] = stop[u] = round(cu, 6)   # a line port on the centre line, from the outer wall to the pin
            start[v], stop[v] = round(cv - R, 6), round(cv - r, 6)
            z0 = 60 / math.sqrt(eps) * math.log(R / r)
            self.ports.append({"type": "lumped", "number": num, "R": 50.0, "start": start, "stop": stop, "direction": AXES[v]})
            self.note("warning", f"waveguide port {num} sits on a coaxial line (pin radius {_num_text(r)} mm, outer "
                      f"{_num_text(R)} mm, eps_r {_num_text(round(eps, 4))}: Z0 ≈ {z0:.1f} ohm). It is imported as a 50 ohm "
                      "lumped port across the coax gap in the port plane; CST solves the coax TEM mode, so expect small "
                      "differences, mostly at the top of the band")
            self.made("port", str(num), f"lumped, 50 ohm across the coax gap (pin r {_num_text(r)}, outer R {_num_text(R)} mm)")
            return
        depth = _mul(a, 0.1)
        start = [g[0][0], g[1][0], g[2][0]]
        stop = [g[0][1], g[1][1], g[2][1]]
        start[k] = plane
        stop[k] = _add(plane, depth) if orient.endswith("min") else _sub(plane, depth)
        modes = w.one("numberofmodes")
        if modes is not None and self.val(self.expr(modes)) > 1:
            self.note("warning", f"waveguide port {num}: {modes} modes in CST; the design port excites and measures TE10 only")
        self.note("warning", f"waveguide port {num} imported as an openEMS rectangular TE10 port ({orient}); the probe plane "
                  "is a tenth of the width inside the guide. CST solves the modes of the real cross-section")
        self.ports.append({"type": "waveguide", "number": num, "mode": "TE10", "a": a, "b": b, "start": start, "stop": stop,
                           "direction": AXES[k]})
        self.made("port", str(num), "waveguide TE10")

    def _coax(self, k: int, g: list[list[float]]):
        """(centre u, centre v, pin radius, outer radius, eps_r) of a coaxial line crossing the port
        rectangle ``g`` (plane g[k]) along axis ``k``: a metal cylinder through the plane, inside the
        smallest coaxial non-metal cylinder (a vacuum cut, a dielectric sleeve) or metal tube around it."""
        u, v = (k + 1) % 3, (k + 2) % 3
        plane, tol = g[k][0], 1e-6
        cyl = []
        for s in self.solids.values():
            metal = self.materials.get(s["material"].lower(), {}).get("kind") == "metal"
            eps = self.val(self.materials.get(s["material"].lower(), {}).get("eps_r", 1.0))
            for piece in s["pieces"]:
                if piece.get("transforms"):
                    continue
                for p in piece["primitives"]:
                    if p.get("kind") != "cylinder":
                        continue
                    try:
                        q = resolve_primitive(p, self.values, s["name"], 0)
                    except DesignError:
                        continue
                    a, b = q["start"], q["stop"]
                    if any(abs(a[i] - b[i]) > tol for i in (u, v)) or not min(a[k], b[k]) - tol <= plane <= max(a[k], b[k]) + tol:
                        continue
                    cyl.append({"c": (a[u], a[v]), "r": q["radius"], "ri": q.get("inner_radius") or 0.0, "metal": metal,
                                "cut": bool(s.get("cavity")), "eps": 1.0 if s.get("cavity") else eps})
        for pin in sorted((c for c in cyl if c["metal"] and not c["ri"]), key=lambda c: c["r"]):
            cu, cv = pin["c"]
            if not (g[u][0] - tol <= cu - pin["r"] and cu + pin["r"] <= g[u][1] + tol and
                    g[v][0] - tol <= cv - pin["r"] and cv + pin["r"] <= g[v][1] + tol):
                continue
            around = [c for c in cyl if abs(c["c"][0] - cu) < tol and abs(c["c"][1] - cv) < tol and c is not pin]
            outer = [(c["ri"], 1.0) for c in around if c["metal"] and c["ri"] > pin["r"] + tol]
            outer += [(c["r"], c["eps"]) for c in around if not c["metal"] and c["r"] > pin["r"] + tol]
            if outer:
                R = min(r for r, _ in outer)
                fill = [c["eps"] for c in around if not c["metal"] and not c["cut"] and c["r"] >= R - tol and c["ri"] <= pin["r"] + tol]
                return cu, cv, pin["r"], R, (fill[0] if fill else 1.0)
        return None

    def _meta_waveguide(self, meta: dict):
        try:
            return {"type": "waveguide", "number": int(meta["port"]), "mode": str(meta.get("mode") or "TE10"),
                    "a": round(float(meta["a"]) * self.meta_unit, 6), "b": round(float(meta["b"]) * self.meta_unit, 6),
                    "start": [round(float(x) * self.meta_unit, 6) + 0.0 for x in meta["start"]],
                    "stop": [round(float(x) * self.meta_unit, 6) + 0.0 for x in meta["stop"]],
                    "direction": meta["direction"], **({"excite": bool(meta["excite"])} if "excite" in meta else {})}
        except (KeyError, TypeError, ValueError):
            return None

    # ---- fairbeam data

    def read_meta(self, records: list[dict]):
        for rec in records:
            if "unit_m" in rec:
                try:
                    self.meta_unit = float(rec["unit_m"]) / 1e-3
                except (TypeError, ValueError):
                    pass
            if "port" in rec:
                try:
                    self.meta_ports[int(rec["port"])] = rec
                except (TypeError, ValueError):
                    pass
            elif "resistor" in rec:
                self.meta_res[str(rec["resistor"]).lower()] = rec
            elif "rlc" in rec:
                self.meta_res[str(rec["rlc"]).lower()] = rec
            elif "boundaries" in rec and isinstance(rec["boundaries"], dict):
                self.meta_bounds = rec["boundaries"]
            elif "mesh" in rec and isinstance(rec["mesh"], dict):
                self.meta_mesh = rec["mesh"]
            elif "mesh_lines" in rec and isinstance(rec["mesh_lines"], dict):
                # the exporter writes the lines in pieces of a few dozen (short VBA lines): join them
                self.meta_lines = self.meta_lines or {}
                for a, vals in rec["mesh_lines"].items():
                    if a in ("x", "y", "z") and isinstance(vals, list):
                        self.meta_lines.setdefault(a, []).extend(vals)
            elif rec.get("far_field") is True:
                self.meta_far = True

    def _meta_lines(self) -> dict | None:
        """The exported model's explicit mesh lines (a manual mesh), in mm, rounded like the geometry."""
        try:
            out = {a: sorted({round(float(v) * self.meta_unit, 6) for v in self.meta_lines[a]
                              if not isinstance(v, bool)}) for a in "xyz"}
        except (KeyError, TypeError, ValueError, OverflowError):
            out = None
        if out and all(len(out[a]) >= 2 and all(math.isfinite(v) for v in out[a]) for a in "xyz"):
            return out
        self.note("warning", "the fairbeam-data mesh lines are not a valid line list (x, y and z, at least two finite "
                  "values each): the mesh is set up automatically instead", "mesh", 0)
        return None

    def _meta_mesh(self) -> dict | None:
        """The exported model's automatic mesh settings as a design mesh (auto mode when it can hold
        them, else design mode with every setting as an override)."""
        m = self.meta_mesh
        try:
            cpw = float(m["cells_per_wavelength"])
            pad = m.get("pad")
            if isinstance(pad, list):
                if len({float(x) for x in pad}) != 1:
                    self.note("info", "the exported mesh pads the faces differently; the design uses the largest pad", "mesh", 0)
                pad = max(float(x) for x in pad)
            out = {"cells_per_wavelength": cpw}
            if pad is not None:
                out["pad"] = float(pad) * self.meta_unit
            if m.get("edge_rule") in ("thirds", "edge"):
                out["edge_rule"] = m["edge_rule"]
            if m.get("max_ratio") is not None:
                out["max_ratio"] = float(m["max_ratio"])
            if m.get("air_cells_per_wavelength") is not None:
                out["air_cells_per_wavelength"] = float(m["air_cells_per_wavelength"])
        except (KeyError, TypeError, ValueError):
            return None
        if m.get("metal_cells") not in (None, 6):
            self.note("info", f"the exported mesh used metal_cells = {m['metal_cells']}, which designs do not set (6)", "mesh", 0)
        clean = lambda v: int(v) if isinstance(v, float) and v.is_integer() else v  # noqa: E731
        out = {k: clean(v) for k, v in out.items()}
        dc = m.get("dielectric_cells")
        if dc is not None and int(dc) != 4:
            # only the design mode sets the cells across a dielectric; air as fine as the features
            # unless given (the automatic mode's default)
            over = dict(out)
            over.setdefault("air_cells_per_wavelength", out["cells_per_wavelength"])
            over["dielectric_cells"] = int(dc)
            return {"mode": "design", "overrides": over}
        return {"mode": "auto", **out}

    # ---- the design

    def finish(self, model_id: str, name: str) -> dict:
        # waveguide ports only in the fairbeam data (the exporter cannot write a CST one)
        for num, meta in sorted(self.meta_ports.items()):
            if meta.get("type") == "waveguide" and not any(p["number"] == num for p in self.ports):
                port = self._meta_waveguide(meta)
                if port is not None:
                    self.ports.append(port)
                    self.made("port", str(num), f"waveguide {port['mode']} (from the fairbeam-data records of the export)")
                    self.note("info", f"waveguide port {num} restored from the fairbeam-data records (the CST macro has no waveguide port)",
                              "ports", 0)
        self.ports.sort(key=lambda p: p["number"])
        # frequency band
        if self.f_range is None:
            f_min, f_max = 1.0, 3.0
            self.note("warning", "the macro sets no frequency range (Solver.FrequencyRange): 1 to 3 GHz used", "simulation", 0)
        else:
            f_min, f_max = self.f_range
            try:
                lo, hi = self.val(f_min), self.val(f_max)
            except _Refuse as e:
                lo, hi = 1.0, 3.0
                f_min, f_max = 1.0, 3.0
                self.note("warning", f"frequency range not usable ({e}): 1 to 3 GHz used", "simulation", 0)
            if not hi > 0:
                f_min, f_max = 1.0, 3.0
                self.note("warning", "the frequency range has no positive maximum: 1 to 3 GHz used", "simulation", 0)
            elif not lo > 0:
                f_min = float(f"{hi / 20:.12g}") if isinstance(f_max, float) else f"{_p(f_max)} / 20"
                self.note("warning", f"the band starts at {_num_text(lo)} GHz: openEMS needs f_min > 0, so the band starts at "
                          "f_max / 20", "simulation", 0)
        f_ref = (self.val(f_min) + self.val(f_max)) / 2
        # boundaries
        bounds = ["MUR"] * 6
        if self.boundaries is not None:
            bounds = [b for _v, b in self.boundaries]
            if self.meta_bounds and all(isinstance(self.meta_bounds.get(f), str) for f in META_FACES):
                meta = [self.meta_bounds[f] for f in META_FACES]
                agree = all((m == b) if b in ("PEC", "PMC") else (m == "MUR" or m.startswith("PML")) for m, b in zip(meta, bounds))
                if agree and all(m in ("PEC", "PMC", "MUR") or re.fullmatch(r"PML_\d+", m) for m in meta):
                    bounds = meta
            elif any(v in ("open", "expanded open") for v, _b in self.boundaries):
                self.note("info", "open boundaries imported as MUR (first-order absorbing); the CST open boundary is a PML: "
                          "choose PML_8 in the simulation settings for closer agreement", "simulation", 0)
        # materials: loss as a conductivity -> tan δ at a frequency
        mats = []
        used = set()
        self._fill_cavities()
        self._thin_metal_sheets()
        merged = _tidy_coordinates([p for s in self.solids.values() for piece in s["pieces"] if not piece.get("transforms")
                                    for p in piece["primitives"]], self.ports + self.resistors)
        if merged:
            self.note("info", f"{merged} coordinate(s) within {_num_text(OUTLINE_TOL * 1000)} um of another merged with it "
                      "(each exported vertex is rounded on its own; the steps and slivers left would force mesh cells, "
                      "and a timestep, of that size)", "parts", 0)
        parts = self.parts()
        for pt in parts:
            used.add(pt["material"])
            for side in ("A", "B"):
                h = pt.get("booleanHistory")
                if h:
                    used.add(h[side]["material"])
        for low in self.mat_order:
            m = dict(self.materials[low])
            if m["kind"] == "dielectric" and "_sigma" in m:
                sigma = m.pop("_sigma")
                hint = m.pop("_tand_hint", None)
                eps = self.val(m["eps_r"])
                base_tand = self.val(m["tan_d"]) if "tan_d" in m else 0.0
                f = self.val(m["tan_d_freq"]) if "tan_d_freq" in m else None
                if f is None and hint is not None and not base_tand:
                    t, fh = hint
                    # the exporter's own "equivalent tan d" comment, when it matches the conductivity
                    if fh > 0 and abs(t * 2 * math.pi * fh * 1e9 * EPS0 * eps - sigma) <= 1e-6 * max(abs(sigma), 1e-300):
                        m["tan_d"], m["tan_d_freq"] = t, fh
                        mats.append(m)
                        self.made("material", m["name"], f"dielectric, eps_r {m.get('eps_r')}")
                        continue
                if f is None:
                    f = f_ref
                    self.note("info", f"material {m['name']!r}: conductivity {_num_text(sigma)} S/m written as the equivalent "
                              f"loss tangent at the band centre ({_num_text(round(f, 9))} GHz)", "materials", 0)
                if f > 0 and eps > 0:
                    m["tan_d"] = float(f"{base_tand + sigma / (2 * math.pi * f * 1e9 * EPS0 * eps):.12g}")
                    m["tan_d_freq"] = f
                else:
                    self.note("refused", f"material {m['name']!r}: conductivity {_num_text(sigma)} S/m not imported "
                              "(no loss tangent without a positive eps_r and frequency)", "materials", 0)
            m.pop("_tand_hint", None)
            if m["name"] in used or low not in ("pec", "vacuum"):
                mats.append(m)
            kind = "metal (PEC)" if m["kind"] == "metal" else f"dielectric, eps_r {m.get('eps_r')}"
            if m["name"] in used or low not in ("pec", "vacuum"):
                self.made("material", m["name"], kind)
        for pt in parts:
            prims = pt["primitives"]
            kinds = sorted({p["kind"] for p in prims})
            extra = (f", {len(pt.get('transforms', []))} transform(s)" if pt.get("transforms") else "") + \
                    (f", Boolean {pt['booleanHistory']['operation']}" if pt.get("booleanHistory") else "")
            self.made("part", pt["name"], f"{len(prims)} x {'/'.join(kinds)} in {pt['material']}{extra}")
        mesh = {"mode": "auto", "cells_per_wavelength": DEFAULT_CPW}
        restored = self._meta_mesh() if self.meta_mesh and not self.cpw else None
        lines = self._meta_lines() if self.meta_lines and not self.cpw else None
        self.exact_lines = _lines_on_ports(lines, self.ports + self.resistors) if lines else None
        if lines and restored:
            mesh = restored   # import_cst keeps these settings only if they rebuild the exported lines
        elif lines:
            mesh = {"mode": "manual", "lines": self.exact_lines, "automatic": dict(mesh)}
            self.note("info", "the exported model's explicit mesh lines are restored from the fairbeam-data records", "mesh", 0)
        elif restored:
            mesh = restored
            self.note("info", "the automatic mesh settings of the exported model are restored from the fairbeam-data records", "mesh", 0)
        elif self.cpw:
            mesh["cells_per_wavelength"] = float(self.cpw) if not float(self.cpw).is_integer() else int(self.cpw)
            if self.air_cpw and 0 < self.air_cpw < self.cpw:
                mesh["air_cells_per_wavelength"] = self.air_cpw
        else:
            self.note("info", f"no mesh density in the macro: the automatic mesh uses {DEFAULT_CPW} cells per wavelength",
                      "mesh", 0)
        sim = {"f_min": f_min, "f_max": f_max, "boundaries": bounds}
        if self.end_db is not None:
            sim["end_criteria_db"] = self.end_db
        far = {"enabled": bool(self.farfield)}
        if self.farfield:
            seen, freqs = set(), []
            for _n, f in self.farfield:
                k = json.dumps(f)
                if k not in seen:
                    seen.add(k)
                    freqs.append(f)
            far["frequencies"] = freqs
        elif self.meta_far:
            far["enabled"] = True
            self.note("info", "far field on, as in the exported model (it had no analysed pattern frequencies yet)",
                      "far field", 0)
        else:
            self.note("info", "no far-field monitor in the macro: far field is off (turn it on in the simulation settings)",
                      "far field", 0)
        if not parts:
            self.note("warning", "no geometry was imported", "parts", 0)
        if not self.ports:
            self.note("warning", "no port was imported: add one before running the design", "ports", 0)
        design = {
            "schema": DESIGN_SCHEMA,
            "model": {"id": model_id, "name": name,
                      "description": f"Imported from the CST macro {self.filename or '(pasted text)'}."},
            "params": self.params,
            "simulation": sim,
            "materials": mats,
            "parts": parts,
            "ports": self.ports,
            "resistors": self.resistors,
            "mesh": mesh,
            "far_field": far,
        }
        if self.currents:
            design["monitors"] = {"currents": [f for _n, f in self.currents]}
        return design

    def parts(self) -> list[dict]:
        out, taken = [], set()

        def unique(base: str) -> str:
            base = base or "part"
            if is_reserved_name(base):
                base = "cst_" + base
            name, k = base, 2
            while name in taken:
                name, k = f"{base}_{k}", k + 1
            taken.add(name)
            return name

        dup = {}
        for s in self.solids.values():
            dup[s["name"]] = dup.get(s["name"], 0) + 1
        for s in self.solids.values():
            base = s["name"] if dup[s["name"]] == 1 else f"{s['comp'].replace('/', '_')}_{s['name']}"
            for i, piece in enumerate(s["pieces"]):
                pt = {"name": unique(base if i == 0 else f"{base}_{i + 1}")}
                if s["comp"]:
                    pt["component"] = s["comp"]
                pt["material"] = s["material"]
                pt["primitives"] = piece["primitives"]
                if piece.get("transforms"):
                    pt["transforms"] = piece["transforms"]
                if piece.get("booleanHistory"):
                    h = copy.deepcopy(piece["booleanHistory"])
                    pt["booleanHistory"] = h
                out.append(pt)
        return out


def _lines_on_ports(lines: dict, boxes: list[dict], tol: float = 6e-5) -> dict:
    """Explicit mesh lines with every line within ``tol`` mm of a port or resistor face moved onto
    that face. A Python model's bundle stores its lines rounded to 1e-4 mm, and a port sheet a few
    1e-5 mm off its line covers no cell (a singular port)."""
    out = {}
    for k, a in enumerate("xyz"):
        faces = sorted({round(float(p[e][k]), 6) for p in boxes for e in ("start", "stop")
                        if isinstance(p.get(e), list) and isinstance(p[e][k], (int, float))})
        snapped = []
        for v in lines[a]:
            near = min(faces, key=lambda f: abs(f - v), default=None)
            snapped.append(near if near is not None and abs(near - v) <= tol else v)
        out[a] = sorted(set(snapped))
    return out


def _rebuild_is_bounded(design: dict, lines: dict, values: dict) -> bool:
    """Whether the design's automatic mesh stays under MAX_REBUILD_LINES lines per axis over the
    extent of ``lines``, at its finest density (cells per wavelength in the densest dielectric)."""
    m = design["mesh"]
    s = m.get("overrides", {}) if m.get("mode") == "design" else m
    dens = [evaluate(x, values) for x in (s.get("cells_per_wavelength", DEFAULT_CPW), s.get("air_cells_per_wavelength"))
            if x is not None]
    eps = [evaluate(mat["eps_r"], values) for mat in design["materials"] if mat.get("eps_r") is not None]
    f_max = evaluate(design["simulation"]["f_max"], values)
    if f_max <= 0 or not dens:
        return False
    per_mm = max(dens) * math.sqrt(max([1.0] + [e for e in eps if e > 0])) * f_max / 299.792458
    return all((lines[a][-1] - lines[a][0]) * per_mm <= MAX_REBUILD_LINES for a in "xyz")


def _keep_exported_lines(imp: _Importer, design: dict) -> None:
    """The exported model's automatic mesh settings stay (editable) when they rebuild its exact lines;
    otherwise (a Python model's own mesh rules, a part CST could not carry) the design uses those
    lines as a manual mesh and keeps the settings for Mesh settings' "Switch to automatic mesh"."""
    from .design import build   # the design module builds the openEMS model (and imports this one lazily)
    auto = design["mesh"]
    try:
        values = {p["key"]: p["default"] for p in design["params"] if "expr" not in p}
        # the settings come from the macro: build them here (in the server) only when they cannot make
        # a mesh far larger than any runnable one (cells per wavelength 3e6 took 1 GB, and it grows)
        if not _rebuild_is_bounded(design, imp.exact_lines, resolve_names(design, values)):
            raise _Refuse("the automatic settings would mesh far finer than the exported lines")
        sim = build(design, values)
        same = all(len(got := list(sim.mesh.GetLines(k))) == len(want := imp.exact_lines[a])
                   and all(abs(x - y) <= 1e-4 for x, y in zip(got, want)) for k, a in enumerate("xyz"))
    except Exception:  # noqa: BLE001 - any failure: the exported lines are the safe choice
        same = False
    if same:
        imp.note("info", "the automatic mesh settings of the exported model are restored from the fairbeam-data records", "mesh", 0)
        return
    design["mesh"] = {"mode": "manual", "lines": imp.exact_lines, "automatic": auto}
    check_design(design)
    imp.note("info", "the exported model's own mesh lines are restored from the fairbeam-data records (its automatic settings, "
             "kept for Mesh settings > Switch to automatic mesh, would mesh it differently in a design)", "mesh", 0)


def _tidy_coordinates(prims: list[dict], boxes: list[dict], tol: float = None) -> int:
    """Numeric coordinates of the model closer than ``tol`` mm along an axis made one (the one written
    with the fewest digits wins, e.g. 13.0000 over 12.9999), across every shape and port, then repeated
    polygon points dropped. Exported models round each vertex on its own, which leaves 1e-4 mm steps and
    slivers between shapes that force cells (and a timestep) of that size. Expressions are left alone.
    Returns how many coordinates moved."""
    tol = OUTLINE_TOL if tol is None else tol
    num = lambda x: isinstance(x, (int, float)) and not isinstance(x, bool)
    refs: list[list] = [[], [], []]   # (container, index) per axis

    def add(axis, holder, i):
        if num(holder[i]):
            refs[axis].append((holder, i))

    for p in prims:
        kind = p.get("kind")
        if kind == "box":
            for k in range(3):
                add(k, p["start"], k)
                add(k, p["stop"], k)
        elif kind in ("polygon", "linpoly"):
            n = AXES.index(p["normal"])
            u, v = in_plane(n)
            add(n, p, "elevation")
            for q in p["points"]:
                add(u, q, 0)
                add(v, q, 1)
        elif kind == "cylinder":
            n = AXES.index(p["axis"])
            u, v = in_plane(n)
            add(u, p["center"], 0)
            add(v, p["center"], 1)
            add(n, p["range"], 0)
            add(n, p["range"], 1)
    for b in boxes:
        for k in range(3):
            add(k, b["start"], k)
            add(k, b["stop"], k)
    moved = 0
    for axis in range(3):
        vals = sorted({float(h[i]) for h, i in refs[axis]})
        rep, cluster = {}, []
        for x in vals + [math.inf]:
            if cluster and x - cluster[-1] >= tol:
                best = min(cluster, key=lambda c: (len(f"{c:.6f}".rstrip("0")), abs(c)))
                rep.update({c: best for c in cluster})
                cluster = []
            cluster.append(x)
        for h, i in refs[axis]:
            if rep[float(h[i])] != h[i]:
                h[i] = rep[float(h[i])]
                moved += 1
    for p in prims:
        if p.get("kind") in ("polygon", "linpoly") and all(num(c) for q in p["points"] for c in q):
            out = []
            for q in p["points"]:
                if not out or list(q) != list(out[-1]):
                    out.append(q)
            while len(out) > 1 and list(out[-1]) == list(out[0]):
                out.pop()
            p["points"] = out
    return moved


def _round_floats(obj, digits=6):
    if isinstance(obj, float):
        return round(obj, digits) + 0.0
    if isinstance(obj, list):
        return [_round_floats(x, digits) for x in obj]
    if isinstance(obj, dict):
        return {k: _round_floats(v, digits) for k, v in obj.items()}
    return obj


def _snap(design: dict) -> None:
    """Round plain coordinates to 1e-6 mm (fairbeam.example_design._snap_coordinates): the automatic
    mesh places its lines with that resolution, and a port sheet a few 1e-7 mm off its line covers no
    cell edge."""
    keys = ("start", "stop", "points", "elevation", "length", "range", "radius", "inner_radius", "center",
            "bottom_radius", "top_radius", "major_radius", "minor_radius")
    for part in design.get("parts", []):
        for prim in part.get("primitives", []):
            for k in keys:
                if k in prim:
                    prim[k] = _round_floats(prim[k])
    for group in ("ports", "resistors"):
        for item in design.get(group, []):
            for k in ("start", "stop", "a", "b"):
                if k in item:
                    item[k] = _round_floats(item[k])


# fairbeam's own CST export writes "' WARNING: <label>: <what> skipped; <advice>" comments for what it
# could not put into the macro (a polyhedron, a curve, a waveguide port); read back, they are the
# gaps of the import, not "macro notes".
_SKIPPED = re.compile(r"^(?P<label>[^:]+): (?P<what>.+?) skipped(?:; (?P<hint>.+)| \((?P<why>.+)\))?$")


def exporter_note(text: str) -> tuple[str, str, str]:
    """``(where, message, kind)`` of one WARNING comment of a fairbeam export: ``kind`` is "missing"
    for something the export left out, else "exporter" (something it changed)."""
    m = _SKIPPED.match(text)
    if not m:
        return "Fairbeam export", text, "missing" if "skipped" in text else "exporter"
    label, what = m.group("label").strip(), m.group("what").strip()
    horn = "horn" in label.lower() and what.startswith("polyhedron")
    name = f"the horn flare ('{label}', {what})" if horn else f"'{label}' ({what})"
    msg = f"{name} is not in this macro: Fairbeam's CST export left it out"
    msg += ", so the imported design has no flare." if horn else "."
    advice = re.sub(r"^not exported to CST\s*", "", (m.group("hint") or m.group("why") or "").strip())
    if advice.startswith("(") and advice.endswith(")"):
        advice = advice[1:-1].strip()
    if advice:
        msg += f" {advice[0].upper()}{advice[1:]}{'' if advice.endswith('.') else '.'}"
    return label, msg, "missing"


def _dedupe_notes(notes: list[dict]) -> list[dict]:
    """Identical notes (same severity, place and message) once, with ``count`` and every ``lines`` entry:
    a macro that repeats one warning four times reports one gap, not four."""
    out: list[dict] = []
    seen: dict[tuple, dict] = {}
    for n in notes:
        key = (n["severity"], n["where"], n["message"])
        if key in seen:
            e = seen[key]
            e["count"] += 1
            if n["line"]:
                e["lines"].append(n["line"])
            continue
        e = dict(n, count=1, lines=[n["line"]] if n["line"] else [])
        seen[key] = e
        out.append(e)
    return out


def import_cst(text: str, *, model_id: str = "imported-cst", name: str | None = None,
               filename: str | None = None, files=None) -> dict:
    """``{"design", "report"}`` of a CST macro text; the report lists what was created and every
    note (``severity``: "refused" = not imported, "warning" = imported with a change, "info").
    ``files``: the .stl files of the macro's polyhedra (fairbeam's export writes one per polyhedron next to
    the .bas), as ``{name: bytes or text}`` or a function of the base name; a polyhedron whose file is not
    supplied is reported as not imported."""
    if not isinstance(text, str):
        raise CstImportError("the macro must be text")
    if "\x00" in text[:4096]:
        raise CstImportError("The file is not a text macro. Export the History List or VBA macro as a .bas, .mcs or .txt file and import that.")
    if len(text) > MAX_SOURCE:
        raise CstImportError(f"the macro is larger than {MAX_SOURCE // 1_000_000} MB")
    text = text.lstrip("﻿")
    blocks, meta, macro_notes, suggested = read_macro(text)
    if not any(b.stmts for b in blocks):
        raise CstImportError("no CST history commands found (expected With Brick ... End With, AddToHistory, "
                             "StoreParameter, ...)")
    imp = _Importer(filename)
    imp.files = files
    for entry in macro_notes:
        ln, msg = entry[0], entry[1]
        if len(entry) > 2:
            where, text_, kind = exporter_note(msg)
            imp.note("warning", text_, where, ln, kind)
        else:
            imp.note("warning", msg, "macro", ln)
    imp.read_meta(meta)
    imp.run(blocks)
    if not imp.recognized and not imp.params:
        raise CstImportError("no CST history commands found (expected With Brick ... End With, AddToHistory, "
                             "StoreParameter, ...)")
    title = name or suggested or (re.sub(r"\.[^.]*$", "", filename) if filename else "Imported CST model")
    try:
        design = imp.finish(model_id, title.strip()[:80] or "Imported CST model")
        _snap(design)
        check_design(design)
        if imp.exact_lines and design["mesh"].get("mode") != "manual":
            _keep_exported_lines(imp, design)
    except DesignError as e:
        raise CstImportError(f"the imported design is not valid ({e}); please report the macro") from None
    except (_Refuse, ArithmeticError, ValueError, TypeError, KeyError, IndexError, RecursionError) as e:
        raise CstImportError(f"the macro could not be imported ({type(e).__name__}: {str(e)[:200]}); please report it") from None
    # a waveguide port that CST macros cannot hold, put back from the fairbeam data (an info note says
    # so), is not a gap
    imp.notes = [n for n in imp.notes if not (
        n.get("kind") == "missing" and re.match(r"^port \d+$", n["where"]) and "waveguide port" in n["message"]
        and any(f"waveguide {n['where']} restored" in o["message"] for o in imp.notes))]
    order = {"refused": 0, "warning": 1, "info": 2}
    notes = _dedupe_notes(sorted(imp.notes, key=lambda n: (order.get(n["severity"], 3), n["line"] or 0)))
    counts = {k: sum(1 for c in imp.created if c["kind"] == k) for k in ("parameter", "material", "part", "port", "resistor")}
    report = {"created": imp.created, "notes": notes, "counts": counts,
              "refused": sum(1 for n in notes if n["severity"] == "refused"),
              "warnings": sum(1 for n in notes if n["severity"] == "warning"),
              "history_items": len(blocks), "suggested_name": title, "supported": SUPPORTED}
    return {"design": design, "report": report}
