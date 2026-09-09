/**
 * Layout policy: the cost model that drives the best-fit solver.
 *
 * Priorities, from the spec, in decreasing severity:
 *   overflow                huge penalty
 *   deep sub-expression     large penalty
 *   extra line              medium penalty
 *   underfull line          medium penalty
 *   break hint / priority   small penalty
 */

import type { BreakHint, OpClass } from "./types.js";

export interface PolicyConfig {
  /** Usable width in pt (already excludes margins). */
  linewidth: number;
  /** Widths are inflated by this before comparison, to absorb model error. */
  safetyMargin: number;
  /** Below this fraction of `linewidth` a single line stays as-is. */
  singleLineThreshold: number;
  /** Above this fraction of `linewidth` a single line is still preferred. */
  keepSingleLineThreshold: number;
  /** Do not reflow unless the natural width exceeds this fraction. */
  overflowTrigger: number;
}

export const DEFAULT_POLICY: Omit<PolicyConfig, "linewidth"> = {
  safetyMargin: 2.0,
  singleLineThreshold: 0.82,
  keepSingleLineThreshold: 1.0,
  overflowTrigger: 1.0,
};

/** Cost of one line being overfull by `over` pt. */
export function overflowCost(over: number, linewidth: number): number {
  void linewidth;
  if (over <= 0) return 0;
  // Absolute, and quadratic so that when overflow is unavoidable the solver
  // still minimises it. One point of overflow must dominate any number of
  // extra lines, hence the large linear term.
  return 1e4 * over + 1e3 * over * over;
}

/**
 * Badness of a line that does not use the measure.
 *
 * Continuous in the wasted space, and weighted equally for every line: since
 * the waste of an N-line split sums to a constant, minimising the sum of
 * squares balances the lines (and, with LINE_COST, keeps the line count down).
 * A cliff at a fixed floor, by contrast, leaves the solver indifferent between
 * many layouts and produces arbitrary break points.
 *
 * `isLast` is kept for callers that want to relax the final line; the default
 * weighting deliberately does not, because a stub final line such as
 * `&\quad {}+ G` is exactly the fragmentation this tool is meant to avoid.
 */
export function underfullCost(width: number, linewidth: number, isLast: boolean): number {
  void isLast;
  if (linewidth <= 0) return 0;
  const waste = Math.max(0, linewidth - width) / linewidth;
  return 120 * waste * waste;
}

/** Fixed cost of emitting one more line. */
export const LINE_COST = 60;

/**
 * Cost of breaking at an operator of the given priority (1 best, 5 worst).
 * 5 is reserved for implicit multiplication (juxtaposition).
 */
const PRIORITY_COST: Record<number, number> = { 0: 0, 1: 0, 2: 25, 3: 60, 4: 120, 5: 250 };

/** Extra cost for breaking below the equation's top level. */
export function depthCost(depth: number): number {
  return 400 * depth * depth;
}

/** Extra cost implied by an explicit author hint. */
export function hintCost(hint: BreakHint): number {
  switch (hint) {
    case "nobreak":
      return Number.POSITIVE_INFINITY;
    case "badbreak":
      return 150;
    case "goodbreak":
      return -20;
    default:
      return 0;
  }
}

/** Total cost of a single break. */
export function breakCost(priority: number, depth: number, hint: BreakHint): number {
  return (PRIORITY_COST[priority] ?? 120) + depthCost(depth) + hintCost(hint);
}

/** Whether an operator class is worth breaking at at all. */
export function breakable(op: OpClass): boolean {
  return op !== "none";
}

/**
 * W3C-style decision: does this equation need the solver at all?
 *
 * Below `singleLineThreshold` keep one line. Between the two thresholds we
 * still prefer a single line (the solver is only consulted on overflow), so
 * the caller uses `overflowTrigger` as the hard gate.
 */
export function needsLayout(naturalWidth: number, cfg: PolicyConfig): boolean {
  return naturalWidth + cfg.safetyMargin > cfg.overflowTrigger * cfg.linewidth;
}
