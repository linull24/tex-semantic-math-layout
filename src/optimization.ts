/**
 * The constrained-optimization canonical shape:
 *
 *   \begin{aligned}
 *   \min_x\quad
 *     & f(x) \\
 *   \text{s.t.}\quad
 *     & g_1(x)\le0, \\
 *     & g_2(x)=0.
 *   \end{aligned}
 *
 * Only produced when the body really is `\min/\max ... s.t. ...`; everything
 * else goes through the generic best-fit solver.
 */

import { splitMathBody, priorityOf } from "./mathsplit.js";
import type { PolicyConfig } from "./policy.js";
import { overflowCost, underfullCost, LINE_COST } from "./policy.js";
import type { EmittedLine, LayoutSolution, MathSplit } from "./types.js";

const HEAD_RE =
  /^\s*(\\(?:min|max|argmin|argmax|sup|inf)(?![A-Za-z])\s*(?:_\s*(?:\{[^{}]*\}|\\[A-Za-z]+|[^\s{}]))?)([\s\S]*)$/;
const ST_RE = /\\(?:text|mathrm|operatorname)\s*\{\s*(?:s\.t\.|subject\s+to)\s*\}/;

export interface OptimizationPlan {
  head: string;
  objective: string;
  marker: string;
  constraints: string[];
  fragments: string[];
  body: string;
  split: MathSplit;
}

/** Split a constraint list at top-level commas (parenthesis aware). */
function splitTopLevelCommas(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "{" || c === "(" || c === "[") depth++;
    else if (c === "}" || c === ")" || c === "]") depth = Math.max(0, depth - 1);
    else if (c === "," && depth === 0) {
      out.push(text.slice(start, i + 1).trim());
      start = i + 1;
    }
  }
  const tail = text.slice(start).trim();
  if (tail) out.push(tail);
  return out.filter(Boolean);
}

/** Build the plan if the body matches the optimization shape. */
export function planOptimization(body: string): OptimizationPlan | null {
  const headMatch = HEAD_RE.exec(body);
  if (!headMatch) return null;
  const stMatch = ST_RE.exec(body);
  if (!stMatch) return null;
  const head = headMatch[1]!.trim();
  const rest = headMatch[2]!;
  const stIndex = rest.indexOf(stMatch[0]);
  if (stIndex < 0) return null;
  const objective = rest.slice(0, stIndex).trim();
  const constraintsRaw = rest.slice(stIndex + stMatch[0].length).trim();
  const constraints = splitTopLevelCommas(constraintsRaw);
  if (!objective || constraints.length === 0) return null;

  const fragments: string[] = [];
  fragments.push(`${head}\\quad`);
  fragments.push(`${stMatch[0]}\\quad`);
  fragments.push("{}" + objective);
  for (const c of constraints) fragments.push("{}" + c);
  // Possible splits of an over-wide constraint.
  for (const c of constraints) {
    const s = splitMathBody(c);
    for (const cand of s.candidates) {
      const left = s.pieces.slice(0, cand.index).map((p) => p.text).join(" ");
      const right = s.pieces.slice(cand.index).map((p) => p.text).join(" ");
      if (!left || !right) continue;
      const guard = cand.op === "rel-eq" ? "" : "{}";
      fragments.push("{}" + left);
      fragments.push("{}" + `\\quad ${guard}${right}`);
    }
  }

  return {
    head,
    objective,
    marker: stMatch[0],
    constraints,
    fragments,
    body,
    split: splitMathBody(body),
  };
}

function w(widths: Map<string, number>, text: string): number | null {
  const v = widths.get(text);
  return typeof v === "number" ? v : null;
}

/** Emit the canonical optimization layout. */
export function solveOptimization(
  plan: OptimizationPlan,
  widths: Map<string, number>,
  cfg: PolicyConfig
): LayoutSolution {
  const usable = cfg.linewidth - cfg.safetyMargin;
  const headW = w(widths, `${plan.head}\\quad`) ?? 0;
  const stW = w(widths, `${plan.marker}\\quad`) ?? 0;
  const col1W = Math.max(headW, stW);

  const lines: EmittedLine[] = [];
  let overflow = false;
  let cost = 0;

  const push = (col1: string, col2: string) => {
    const measured = w(widths, "{}" + col2) ?? 0;
    const width = col1 ? col1W + measured : measured;
    cost += LINE_COST + overflowCost(width - usable, usable) + underfullCost(width, usable, false);
    if (width > usable) overflow = true;
    lines.push({ col1, col2, predicted: width + cfg.safetyMargin, measured, from: 0, to: 0 });
  };

  push(`${plan.head}\\quad`, plan.objective);
  plan.constraints.forEach((c, i) => {
    const prefix = i === 0 ? `${plan.marker}\\quad` : "";
    const width = (prefix ? col1W : 0) + (w(widths, "{}" + c) ?? 0);
    if (width <= usable) {
      push(prefix, c);
      return;
    }
    // Over-wide constraint: break at its best top-level operator.
    const s = splitMathBody(c);
    const cands = [...s.candidates].sort(
      (a, b) => priorityOf(a.op, a.depth) - priorityOf(b.op, b.depth) || a.index - b.index
    );
    let split = -1;
    for (const cand of cands) {
      const left = s.pieces.slice(0, cand.index).map((p) => p.text).join(" ");
      const right = s.pieces.slice(cand.index).map((p) => p.text).join(" ");
      const lw = (prefix ? col1W : 0) + (w(widths, "{}" + left) ?? Number.POSITIVE_INFINITY);
      const guard = cand.op === "rel-eq" ? "" : "{}";
      const rw = w(widths, "{}" + `\\quad ${guard}${right}`) ?? Number.POSITIVE_INFINITY;
      if (lw <= usable && rw <= usable) {
        split = cand.index;
        break;
      }
    }
    if (split < 0) {
      push(prefix, c);
      return;
    }
    const left = s.pieces.slice(0, split).map((p) => p.text).join(" ");
    const right = s.pieces.slice(split).map((p) => p.text).join(" ");
    const guard = s.pieces[split]!.op === "rel-eq" ? "" : "{}";
    push(prefix, left);
    push("", `\\quad ${guard}${right}`);
  });

  const blockWidth = Math.max(...lines.map((l) => l.predicted));
  return {
    pattern: "optimization",
    lines,
    predictedWidth: blockWidth,
    measuredWidth: null,
    breaks: [],
    deepBreaks: 0,
    avgBreakDepth: 0,
    overflowed: overflow,
    cost,
  };
}
