/**
 * Expression-structure analysis: turn a math body into a contiguous list of
 * `Piece`s separated by break-eligible operators.
 *
 * `unified-latex` does the LaTeX parsing; this module builds the *math*
 * structure on top of it (operator classes, nesting depth, protected spans)
 * and records source offsets so fragments can be lifted verbatim.
 */

import { parse } from "@unified-latex/unified-latex-util-parse";
import type { Ast } from "@unified-latex/unified-latex-types";
import { trimSpan } from "./tex.js";
import type { BreakCandidate, BreakHint, MathSplit, OpClass, Piece } from "./types.js";

/* ------------------------------------------------------------------ *
 * Operator tables
 * ------------------------------------------------------------------ */

/** Relations that anchor a line (`=` and friends) -> priority 1. */
const REL_MACROS = new Set([
  "le", "leq", "leqslant", "ge", "geq", "geqslant", "neq", "ne",
  "equiv", "approx", "sim", "simeq", "cong", "propto", "asymp", "doteq",
  "ll", "gg", "prec", "succ", "preceq", "succeq", "subset", "supset",
  "subseteq", "supseteq", "in", "ni", "notin", "owns", "parallel", "perp",
  "mid", "models", "vdash", "dashv", "to", "rightarrow", "leftarrow",
  "Rightarrow", "Leftarrow", "leftrightarrow", "Leftrightarrow",
  "longrightarrow", "longleftarrow", "Longrightarrow", "implies", "iff",
  "mapsto", "longmapsto", "coloneqq", "eqqcolon", "triangleq", "overset",
  "underset", "stackrel", "because", "therefore", "pmb",
]);

/** Binary additive operators -> priority 2. */
const ADD_MACROS = new Set(["pm", "mp"]);

/** Binary multiplicative operators -> priority 3. */
const MUL_MACROS = new Set([
  "times", "cdot", "div", "ast", "star", "circ", "bullet", "odot",
  "otimes", "oplus", "oslash", "diamond", "wr", "amalg",
]);

/** Other binary operators -> priority 4. */
const OTHER_MACROS = new Set([
  "cup", "cap", "vee", "wedge", "setminus", "sqcup", "sqcap", "uplus",
  "bigcup", "bigcap", "bigvee", "bigwedge", "bigoplus", "bigotimes",
  "bigodot", "biguplus", "bigsqcup", "sum", "prod", "coprod", "int",
  "iint", "iiint", "oint",
]);

/** Macros whose parenthesised argument must never be split. */
const FUNC_MACROS = new Set([
  "log", "ln", "lg", "exp", "sin", "cos", "tan", "cot", "sec", "csc",
  "arcsin", "arccos", "arctan", "sinh", "cosh", "tanh", "coth",
  "max", "min", "sup", "inf", "arg", "argmax", "argmin", "det", "dim",
  "ker", "deg", "gcd", "hom", "lim", "liminf", "limsup", "Pr", "E",
  "operatorname", "mathrm", "mathbf", "mathit", "mathcal", "text",
  "norm", "abs", "Var", "Cov", "Corr", "tr", "rank", "diag", "vec",
]);

/** Hint macros recognised at break boundaries (standard TeX, no preamble change). */
const HINT_MACROS: Record<string, BreakHint> = {
  nobreak: "nobreak",
  badbreak: "badbreak",
  goodbreak: "goodbreak",
  allowbreak: "goodbreak",
  linebreak: "goodbreak",
};

function classifyMacro(name: string): OpClass {
  if (REL_MACROS.has(name)) return "rel-eq";
  if (ADD_MACROS.has(name)) return "add";
  if (MUL_MACROS.has(name)) return "mul";
  if (OTHER_MACROS.has(name)) return "other";
  return "none";
}

function classifyChar(ch: string): OpClass {
  if (ch === "=") return "rel-eq";
  if (ch === "<" || ch === ">") return "rel-eq";
  if (ch === "+" || ch === "-") return "add";
  return "none";
}

/** Priority reserved for implicit multiplication, below every real operator. */
export const JUXTAPOSITION_PRIORITY = 5;

/** Map an operator class to the spec's break-priority ladder. */
export function priorityOf(op: OpClass, depth: number): number {
  switch (op) {
    case "rel-eq":
    case "rel-ord":
      return 1;
    case "add":
      return depth === 0 ? 2 : 3;
    case "mul":
      return depth === 0 ? 3 : 4;
    case "other":
      return 4;
    default:
      return 4;
  }
}

/* ------------------------------------------------------------------ *
 * Token walk
 * ------------------------------------------------------------------ */

interface Item {
  text: string;
  start: number;
  end: number;
  /** `op` items are candidate break leaders. */
  kind: "op" | "atom" | "open" | "close" | "hint" | "unsafe";
  op: OpClass;
  opText: string;
  depth: number;
  protected: boolean;
}


interface RawNode {
  type: string;
  content?: unknown;
  position?: { start: { offset: number }; end: { offset: number } };
}

/**
 * Flatten the top-level AST into items with exact source spans.
 *
 * Nested macro arguments (`\frac{a}{b}`) stay inside their macro node, so they
 * are never split. Flat constructs whose parts *are* siblings — `\log(x)`,
 * `\left( ... \right)` — are protected explicitly.
 */
function flatten(body: string, ast: Ast): { items: Item[]; unsafe: boolean } {
  const nodes = ((ast as unknown as { content: RawNode[] }).content ?? []).filter(
    (n) => n.type !== "whitespace" && n.type !== "parbreak"
  );
  const items: Item[] = [];
  let unsafe = false;

  // Pre-compute span of each node using the next sibling's start.
  const spans: Array<{ start: number; end: number; node: RawNode }> = [];
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]!;
    const start = n.position?.start?.offset ?? 0;
    const end = i + 1 < nodes.length ? (nodes[i + 1]!.position?.start?.offset ?? body.length) : body.length;
    spans.push({ start, end, node: n });
  }

  let depth = 0;
  /** Stack of protected regions: `\left..\right` and function-call parens. */
  const protect: Array<{ start: number; end: number }> = [];
  let pendingFunc = false;

  const push = (text: string, start: number, end: number, kind: Item["kind"], op: OpClass, opText: string) => {
    if (!text) return;
    const isProtected = protect.some((p) => start >= p.start && start < p.end);
    items.push({ text, start, end, kind, op, opText, depth, protected: isProtected });
  };

  for (const { start, end, node } of spans) {
    const text = body.slice(start, end);
    const trimmed = text.trim();
    if (!trimmed) continue;

    if (node.type === "comment") {
      unsafe = true;
      continue;
    }

    if (node.type === "string") {
      // Split at operator characters; `_`/`^` never start a break candidate.
      const lead = text.length - text.trimStart().length;
      let i = 0;
      while (i < trimmed.length) {
        const ch = trimmed[i]!;
        const abs = start + lead + i;
        if (ch === "(") {
          // A parenthesis directly after a function macro opens a protected region.
          if (pendingFunc) {
            const close = matchParen(body, abs);
            protect.push({ start: abs, end: close < 0 ? body.length : close });
            pendingFunc = false;
          }
          push(ch, abs, abs + 1, "open", "none", "");
          depth++;
          i++;
          continue;
        }
        if (ch === ")") {
          depth = Math.max(0, depth - 1);
          push(ch, abs, abs + 1, "close", "none", "");
          i++;
          continue;
        }
        const cls = classifyChar(ch);
        if (cls !== "none") {
          // `-`/`+` are unary when nothing can be their left operand.
          const prev = lastSignificant(items);
          const unary =
            (ch === "-" || ch === "+") &&
            (prev === null || prev.kind === "op" || prev.kind === "open");
          if (unary) {
            push(ch, abs, abs + 1, "atom", "none", "");
          } else {
            push(ch, abs, abs + 1, "op", cls, ch);
          }
          i++;
          continue;
        }
        // Merge a run of non-operator characters into one item.
        let j = i;
        while (j < trimmed.length) {
          const c = trimmed[j]!;
          if (c === "(" || c === ")" || classifyChar(c) !== "none") break;
          j++;
        }
        const chunk = trimmed.slice(i, j);
        push(chunk, abs, abs + j - i, "atom", "none", "");
        // A bare identifier immediately followed by `(` is a function call.
        if (/^[A-Za-z]$/.test(chunk)) pendingFunc = true;
        i = j;
      }
      continue;
    }

    if (node.type === "macro") {
      const name = String(node.content ?? "").replace(/^\\/, "");
      const hint = HINT_MACROS[name];
      if (hint) {
        push(trimmed, start, end, "hint", "none", "");
        continue;
      }
      if (name === "left") {
        push(trimmed, start, end, "open", "none", "");
        depth++;
        const close = findMatchingRight(body, end);
        protect.push({ start: end, end: close < 0 ? body.length : close });
        continue;
      }
      if (name === "right") {
        depth = Math.max(0, depth - 1);
        push(trimmed, start, end, "close", "none", "");
        continue;
      }
      const cls = classifyMacro(name);
      if (cls !== "none") {
        const prev = lastSignificant(items);
        const unary = (name === "pm" || name === "mp") && (prev === null || prev.kind === "op");
        if (unary) {
          push(trimmed, start, end, "atom", "none", "");
        } else {
          push(trimmed, start, end, "op", cls, trimmed);
        }
      } else {
        push(trimmed, start, end, "atom", "none", "");
      }
      if (FUNC_MACROS.has(name)) pendingFunc = true;
      else pendingFunc = false;
      continue;
    }

    // group / environment / anything else: one indivisible atom.
    push(trimmed, start, end, "atom", "none", "");
    pendingFunc = false;
  }

  return { items, unsafe };
}

function lastSignificant(items: Item[]): Item | null {
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i]!.kind !== "hint") return items[i]!;
  }
  return null;
}

/** Index just past the `)` matching the `(` at `open`, or -1. */
function matchParen(src: string, open: number): number {
  let d = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i]!;
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "(") d++;
    else if (c === ")") {
      d--;
      if (d === 0) return i + 1;
    }
  }
  return -1;
}

/** Offset of the `\right` that closes the `\left` ending at `from`, or -1. */
function findMatchingRight(src: string, from: number): number {
  let d = 0;
  const re = /\\(left|right)\b/g;
  re.lastIndex = from;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    if (m[1] === "left") d++;
    else {
      if (d === 0) return m.index;
      d--;
    }
  }
  return -1;
}

/* ------------------------------------------------------------------ *
 * Pieces
 * ------------------------------------------------------------------ */

/**
 * Build pieces + break candidates from a math body.
 *
 * Every `Piece.text` is an exact, trimmed slice of `body`, so any run
 * `pieces[i..j)` can be spliced back into the document verbatim.
 */
export function splitMathBody(body: string): MathSplit {
  // `unified-latex` always records source positions on parsed nodes.
  const ast = parse(body) as unknown as Ast;
  const { items, unsafe } = flatten(body, ast);

  // Boundaries: item index -> start offset, plus the operator metadata.
  interface Boundary {
    itemIndex: number;
    start: number;
    op: OpClass;
    opText: string;
    depth: number;
    hint: BreakHint;
    priority?: number;
  }
  const boundaries: Boundary[] = [];
  let pendingHint: BreakHint = "none";

  for (let i = 0; i < items.length; i++) {
    const it = items[i]!;
    if (it.kind === "hint") {
      pendingHint = HINT_MACROS[it.text.replace(/^\\/, "")] ?? "none";
      continue;
    }
    const startsLine = it.kind === "op" && !it.protected;
    if (startsLine) {
      boundaries.push({
        itemIndex: i,
        start: it.start,
        op: it.op,
        opText: it.opText,
        depth: it.depth,
        hint: pendingHint,
      });
      pendingHint = "none";
      continue;
    }

    // Juxtaposition (implicit multiplication) is a last-resort break
    // opportunity, e.g. `A_1 A_2 \cdots A_n`. It is only offered at the top
    // level, only between two operands, and carries priority 5 so the solver
    // prefers any real operator. Without this a long product has no legal
    // break at all.
    const prevItem = i > 0 ? items[i - 1]! : null;
    if (
      prevItem &&
      prevItem.kind === "atom" &&
      it.kind === "atom" &&
      !it.protected &&
      !prevItem.protected &&
      it.depth === 0 &&
      prevItem.depth === 0 &&
      pendingHint !== "nobreak" &&
      // Only where the source actually has whitespace between the two
      // operands. Without this, `\myop{...}` or `f(x)` would be split into
      // `\myop` and `{...}`, breaking a macro away from its argument.
      /\s/.test(body.slice(prevItem.end, it.start))
    ) {
      boundaries.push({
        itemIndex: i,
        start: it.start,
        op: "other",
        opText: "",
        depth: 0,
        hint: pendingHint,
        priority: JUXTAPOSITION_PRIORITY,
      });
    }
  }

  if (items.length === 0) {
    return { pieces: [], candidates: [], anchorIndex: -1, body, maxDepth: 0, unsafe };
  }

  // Piece k spans [boundaryStart_k, boundaryStart_{k+1}), clamped to the body.
  const starts = [items[0]!.start, ...boundaries.map((b) => b.start)];
  const pieces: Piece[] = [];
  for (let k = 0; k < starts.length; k++) {
    const rawStart = starts[k]!;
    const rawEnd = k + 1 < starts.length ? starts[k + 1]! : body.length;
    const t = trimSpan(body, rawStart, rawEnd);
    const b = k === 0 ? null : boundaries[k - 1]!;
    pieces.push({
      text: t.text,
      start: t.start,
      end: t.end,
      op: b ? b.op : "none",
      opText: b ? b.opText : "",
      depth: b ? b.depth : (items[0]!.depth ?? 0),
      hint: b ? b.hint : "none",
      priority: b ? (b.priority ?? priorityOf(b.op, b.depth)) : 0,
    });
  }

  // Drop candidates that would leave a dangling `_`/`^` or an empty left side.
  const candidates: BreakCandidate[] = [];
  for (let i = 1; i < pieces.length; i++) {
    const p = pieces[i]!;
    if (p.op === "none") continue;
    const prev = pieces[i - 1]!;
    if (!prev.text) continue;
    if (/[_^]$/.test(prev.text)) continue;
    candidates.push({
      index: i,
      offset: p.start,
      op: p.op,
      opText: p.opText,
      depth: p.depth,
      priority: p.priority,
      hint: p.hint,
    });
  }

  // The anchor is the *first relation*, not necessarily the first candidate:
  // a juxtaposition or other low-priority candidate may precede it, and
  // anything before the anchor simply stays in column 1.
  const anchorIndex = candidates.find((c) => c.op === "rel-eq")?.index ?? -1;
  const maxDepth = pieces.reduce((d, p) => Math.max(d, p.depth), 0);

  return { pieces, candidates, anchorIndex, body, maxDepth, unsafe };
}
