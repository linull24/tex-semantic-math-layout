/**
 * Best-fit line breaking (W3C MathML "linebreaking" style) as a shortest-path
 * problem over candidate breakpoints.
 *
 * Geometry model, verified empirically against the target stack:
 *
 *   block width = max_i w(col1_i) + max_j w("{}" + col2_j)
 *
 * amsmath's align preamble prepends an empty group to column 2, which is why
 * column-2 fragments are measured with a leading `{}`. Because column 1 is
 * non-empty only on the first line, "block fits" is equivalent to "every line
 * fits", so per-line overflow penalties give an exact objective.
 *
 * Two shapes are solved for every anchored equation and the cheaper feasible
 * one wins:
 *   - anchored:   `LHS &= RHS`, continuations `&\quad {}+ ...`
 *   - unanchored: `& LHS`, continuations `&\quad {} = ...`
 * The unanchored shape is what saves equations whose LHS plus the first RHS
 * fragment cannot fit on one line at all.
 */

import {
  LINE_COST,
  breakCost,
  overflowCost,
  underfullCost,
  type PolicyConfig,
} from "./policy.js";
import type { EmittedLine, LayoutPattern, LayoutSolution, MathSplit } from "./types.js";

export interface EquationPlan {
  split: MathSplit;
  /** Preferred shape; the solver may fall back to `continuation-unanchored`. */
  pattern: LayoutPattern;
  /** Piece index of the alignment anchor, or -1. */
  anchor: number;
  /** Every fragment string that must be measured for this equation. */
  fragments: string[];
  /** Candidate piece indices usable as line starts. */
  positions: number[];
  /** Text of column 1 (only non-empty for anchored patterns). */
  col1Text: string;
}

const OPT_MARKER = /\\(?:text|mathrm|operatorname)\s*\{\s*(?:s\.t\.|subject\s+to)\s*\}/;
// `\b` would fail before `_` because `_` is a word character.
const OPT_PREFIX = /^\s*\\(?:min|max|argmin|argmax|sup|inf)(?![A-Za-z])/;

/** Detect the constrained-optimization shape. */
export function detectOptimization(body: string): boolean {
  return OPT_PREFIX.test(body) && OPT_MARKER.test(body);
}

/** Decide which canonical shape to emit. */
export function choosePattern(split: MathSplit, body: string): LayoutPattern {
  if (detectOptimization(body)) return "optimization";
  const rels = split.candidates.filter((c) => c.op === "rel-eq");
  if (rels.length >= 2) return "derivation";
  if (split.candidates.length === 0) return "single-line";
  return split.anchorIndex >= 0 ? "continuation" : "continuation-unanchored";
}

/** Join a piece range with single spaces (math ignores them). */
export function rangeText(split: MathSplit, from: number, to: number): string {
  return split.pieces
    .slice(from, to)
    .map((p) => p.text)
    .join(" ")
    .trim();
}

/**
 * Column-2 text for a line, including indent/guard decorations.
 *
 * `from` is the first piece of column 2 (the anchor, for an anchored first
 * line), not the first piece of the line.
 */
export function col2Text(
  split: MathSplit,
  pattern: LayoutPattern,
  from: number,
  to: number,
  isFirst: boolean
): string {
  const body = rangeText(split, from, to);
  if (pattern === "derivation") return body;
  if (isFirst) return body;
  const op = split.pieces[from]?.op ?? "none";
  const guard = op === "add" || op === "mul" || op === "other" ? "{}" : "";
  return `\\quad ${guard}${body}`.trimEnd();
}

/** Shapes worth solving for a given equation. */
function patternsFor(chosen: LayoutPattern, anchor: number): LayoutPattern[] {
  if (chosen === "single-line" || chosen === "optimization") return [chosen];
  if (anchor < 0) return ["continuation-unanchored"];
  return [chosen, "continuation-unanchored"];
}

/** Build the plan: which fragments need measuring, and where breaks may go. */
export function planEquation(split: MathSplit, pattern?: LayoutPattern): EquationPlan {
  const chosen = pattern ?? choosePattern(split, split.body);
  const anchor = chosen === "continuation" || chosen === "derivation" ? split.anchorIndex : -1;
  const positions = split.candidates.map((c) => c.index).sort((a, b) => a - b);
  const col1Text = anchor >= 0 ? rangeText(split, 0, anchor) : "";

  const fragments: string[] = [];
  if (col1Text) fragments.push(col1Text);
  // `starts` doubles as the set of legal line ends, so it must include the
  // end of the body as well as every candidate break.
  const starts = [0, ...positions, split.pieces.length];

  for (const pat of patternsFor(chosen, anchor)) {
    const anchored = pat === "continuation" || pat === "derivation";
    for (let a = 0; a < starts.length; a++) {
      for (let b = a + 1; b < starts.length; b++) {
        const from = starts[a]!;
        const to = starts[b]!;
        if (to <= from) continue;
        const isFirst = a === 0;
        if (isFirst && anchored && to <= anchor) continue;
        const col2From = isFirst && anchored ? anchor : from;
        fragments.push("{}" + col2Text(split, pat, col2From, to, isFirst));
      }
    }
  }
  return { split, pattern: chosen, anchor, fragments, positions, col1Text };
}

function width(widths: Map<string, number>, text: string): number | null {
  const w = widths.get(text);
  return typeof w === "number" ? w : null;
}

export interface SolveOptions {
  policy: PolicyConfig;
  /** Multiplier on the usable width; < 1 tightens the budget. */
  budgetScale?: number;
  /** Absolute extra shrink in pt, applied on top of the safety margin. */
  shrink?: number;
  /** Force a particular shape. */
  pattern?: LayoutPattern;
}

interface DpResult {
  lines: EmittedLine[];
  cost: number;
  overflowed: boolean;
}

/** Shortest-path over break candidates for one shape. */
function runDp(
  plan: EquationPlan,
  widths: Map<string, number>,
  usable: number,
  cfg: PolicyConfig,
  pattern: LayoutPattern
): DpResult | null {
  const { split } = plan;
  const anchor = plan.anchor;
  const anchored = pattern === "continuation" || pattern === "derivation";
  const n = split.pieces.length;
  const positions = [0, ...plan.positions, n];
  const last = positions.length - 1;

  const col1W = plan.col1Text ? width(widths, plan.col1Text) : 0;
  if (plan.col1Text && col1W === null) return null;

  const dp = new Array<number>(positions.length).fill(Number.POSITIVE_INFINITY);
  const prev = new Array<number>(positions.length).fill(-1);
  dp[0] = 0;

  for (let i = 0; i < last; i++) {
    if (!Number.isFinite(dp[i]!)) continue;
    const from = positions[i]!;
    for (let j = i + 1; j <= last; j++) {
      const to = positions[j]!;
      if (to <= from) continue;
      const isFirst = i === 0;
      if (isFirst && anchored && to <= anchor) continue;
      if (!isFirst) {
        const op = split.pieces[from]?.op ?? "none";
        if (op === "none") continue;
      }

      const col2From = isFirst && anchored ? anchor : from;
      const text = "{}" + col2Text(split, pattern, col2From, to, isFirst);
      const w = width(widths, text);
      if (w === null) continue;

      const lineW = (isFirst && anchored ? (col1W ?? 0) : 0) + w;
      let cost = LINE_COST + overflowCost(lineW + cfg.safetyMargin - usable, usable);
      cost += underfullCost(lineW, usable, false);

      if (j < last) {
        const piece = split.pieces[to]!;
        const bc = breakCost(piece.priority, piece.depth, piece.hint);
        if (!Number.isFinite(bc)) continue; // \nobreak
        cost += bc;
      }

      const cand = dp[i]! + cost;
      if (cand < dp[j]!) {
        dp[j] = cand;
        prev[j] = i;
      }
    }
  }

  if (!Number.isFinite(dp[last]!) || prev[last]! < 0) return null;

  const lineEnds: number[] = [];
  let cur = last;
  while (cur > 0) {
    lineEnds.push(cur);
    cur = prev[cur]!;
  }
  lineEnds.reverse();

  const lines: EmittedLine[] = [];
  let start = 0;
  let overflowed = false;
  for (let k = 0; k < lineEnds.length; k++) {
    const to = positions[lineEnds[k]!]!;
    const isFirst = k === 0;
    const col1 = isFirst && anchored ? plan.col1Text : "";
    const col2From = isFirst && anchored ? anchor : start;
    const col2 = col2Text(split, pattern, col2From, to, isFirst);
    const measured = width(widths, "{}" + col2) ?? 0;
    const lineW = (col1 ? (col1W ?? 0) : 0) + measured;
    if (lineW + cfg.safetyMargin > usable) overflowed = true;
    lines.push({ col1, col2, predicted: lineW + cfg.safetyMargin, measured, from: start, to });
    start = to;
  }
  return { lines, cost: dp[last]!, overflowed };
}

/** Solve one planned equation with measured widths. */
export function solveEquation(
  plan: EquationPlan,
  widths: Map<string, number>,
  opts: SolveOptions
): LayoutSolution {
  const cfg = opts.policy;
  const usable = cfg.linewidth * (opts.budgetScale ?? 1) - (opts.shrink ?? 0);
  const candidates = opts.pattern ? [opts.pattern] : patternsFor(plan.pattern, plan.anchor);

  let best: { res: DpResult; pattern: LayoutPattern } | null = null;
  for (const pat of candidates) {
    const res = runDp(plan, widths, usable, cfg, pat);
    if (!res) continue;
    // Prefer a layout that fits; among equal feasibility prefer lower cost.
    const better =
      best === null ||
      (best.res.overflowed && !res.overflowed) ||
      (best.res.overflowed === res.overflowed && res.cost < best.res.cost);
    if (better) best = { res, pattern: pat };
  }

  if (!best) {
    return {
      pattern: "single-line",
      lines: [
        {
          col1: "",
          col2: rangeText(plan.split, 0, plan.split.pieces.length),
          predicted: Number.POSITIVE_INFINITY,
          measured: null,
          from: 0,
          to: plan.split.pieces.length,
        },
      ],
      predictedWidth: Number.POSITIVE_INFINITY,
      measuredWidth: null,
      breaks: [],
      deepBreaks: 0,
      avgBreakDepth: 0,
      overflowed: true,
      cost: Number.POSITIVE_INFINITY,
    };
  }

  const { res, pattern } = best;
  const breaks = res.lines.slice(0, -1).map((l) => l.to);
  const breakPieces = breaks.map((b) => plan.split.pieces[b]!);
  const deepBreaks = breakPieces.filter((p) => p.depth > 0).length;
  const avgDepth =
    breakPieces.length === 0
      ? 0
      : breakPieces.reduce((s, p) => s + p.depth, 0) / breakPieces.length;

  return {
    pattern,
    lines: res.lines,
    predictedWidth: Math.max(...res.lines.map((l) => l.predicted)),
    measuredWidth: null,
    breaks,
    deepBreaks,
    avgBreakDepth: avgDepth,
    overflowed: res.overflowed,
    cost: res.cost,
  };
}
