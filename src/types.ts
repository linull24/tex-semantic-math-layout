/**
 * Shared types for the math-layout prototype.
 *
 * The pipeline is:
 *   source .tex
 *     -> splitDocument()            (tex.ts)      preamble / body spans
 *     -> findEquations()            (equations.ts) candidate display equations
 *     -> splitMathBody()            (mathsplit.ts) pieces + break candidates
 *     -> measureFragments()         (measure.ts)   real XeLaTeX widths
 *     -> solve()                    (optimize.ts)  DP over candidates
 *     -> emitLayout()               (emit.ts)      canonical LaTeX patterns
 *     -> splice back into source, byte-identical everywhere else
 */

/** Math class of an operator, used for both spacing and break priority. */
export type OpClass = "rel-eq" | "rel-ord" | "add" | "mul" | "other" | "none";

/** Explicit break hint attached to a boundary by the author. */
export type BreakHint = "nobreak" | "badbreak" | "goodbreak" | "none";

/**
 * One indivisible run of the equation body at the current nesting level.
 *
 * `pieces` always partition the body contiguously, so any run
 * `pieces[i..j)` is a balanced math fragment and can be lifted verbatim
 * out of the original source.
 */
export interface Piece {
  /** Verbatim source text (trimmed at both ends). */
  text: string;
  /** Source offset of the first character of `text`. */
  start: number;
  /** Source offset just past the last character of `text`. */
  end: number;
  /**
   * If this piece begins with a break-eligible operator, its class.
   * `none` means the boundary *before* this piece is not a break candidate.
   */
  op: OpClass;
  /** Verbatim operator token, e.g. `+`, `=`, `\le`. */
  opText: string;
  /** Nesting depth of the boundary before this piece (0 = equation top level). */
  depth: number;
  /** Explicit author hint on the boundary before this piece. */
  hint: BreakHint;
  /** 1 = best (relations), 4 = worst. Only meaningful when `op !== "none"`. */
  priority: number;
}

/** A boundary before `pieces[index]` that the solver may break at. */
export interface BreakCandidate {
  /** Index into `Piece[]`. */
  index: number;
  /** Source offset of the operator that would lead the next line. */
  offset: number;
  op: OpClass;
  opText: string;
  depth: number;
  priority: number;
  hint: BreakHint;
}

/** Result of decomposing one equation body. */
export interface MathSplit {
  pieces: Piece[];
  /** Break candidates, in source order. */
  candidates: BreakCandidate[];
  /** Index of the alignment anchor (first relation), or -1. */
  anchorIndex: number;
  /** Raw text of the body. */
  body: string;
  /** Nesting depth reached inside this body (for metrics). */
  maxDepth: number;
  /** True when the body contains something we refuse to reflow (e.g. a comment). */
  unsafe: boolean;
}

/** A single emitted line of a solved layout. */
export interface EmittedLine {
  /** Column 1 (right-aligned, before `&`). Empty for continuation lines. */
  col1: string;
  /** Column 2 (after `&`), already carrying `\quad`/`{}` decorations. */
  col2: string;
  /** Predicted width in pt (model, includes safety margin). */
  predicted: number;
  /** Measured width in pt of the real rendered line, if available. */
  measured: number | null;
  /** Source piece range [from, to). */
  from: number;
  to: number;
}

/** Which canonical output shape a solved equation takes. */
export type LayoutPattern =
  | "single-line"
  | "continuation" // aligned, anchored at a relation
  | "continuation-unanchored" // aligned, no relation to anchor on
  | "derivation" // align, chain of relations
  | "optimization"; // aligned with \min / \text{s.t.} shape

/** Outcome of solving one equation. */
export interface LayoutSolution {
  pattern: LayoutPattern;
  lines: EmittedLine[];
  /** Predicted block width (model). */
  predictedWidth: number;
  /** Measured block width of the final emitted source, if verified. */
  measuredWidth: number | null;
  /** Breaks used, as piece indices. */
  breaks: number[];
  /** How many of those breaks are below depth 0. */
  deepBreaks: number;
  /** Average AST depth of the breaks used. */
  avgBreakDepth: number;
  /** True when the solver could not find an overflow-free layout. */
  overflowed: boolean;
  /** Total policy cost of the chosen layout (lower is better). */
  cost: number;
}

/** A display equation located in the document. */
export interface EquationSite {
  /** Environment or construct name: `equation`, `equation*`, `bracket`, ... */
  kind: string;
  /** Source offset of `\begin{...}` / `\[`. */
  openStart: number;
  /** Source offset just past `\end{...}` / `\]`. */
  closeEnd: number;
  /** Body span, excluding the delimiters. */
  bodyStart: number;
  bodyEnd: number;
  /** Body source text. */
  body: string;
  /** Existing `\\` or `&` inside the body. */
  hasLineBreak: boolean;
  /** `\label{...}` / `\tag{...}` occurrences inside the body. */
  trailers: string[];
  /** `% math-layout: ignore` applies. */
  ignored: boolean;
  /** Skipped for another reason (e.g. inside an `off` region). */
  skipped: boolean;
}

/** One recorded measurement request. */
export interface MeasureRequest {
  id: string;
  tex: string;
}

/** Parsed measurement results, keyed by id. */
export interface MeasureResult {
  widths: Map<string, number>;
  /** Ids that TeX failed to produce a width for. */
  failures: string[];
  /** Wall-clock ms spent in XeLaTeX. */
  elapsedMs: number;
  /** True when the cached result was reused. */
  cached: boolean;
}

/** Per-equation record for `report.json`. */
export interface EquationReport {
  index: number;
  /** Source fixture, when the report aggregates several documents. */
  fixture?: string;
  kind: string;
  pattern: LayoutPattern;
  changed: boolean;
  overflow: boolean;
  lines: number;
  breaks: number;
  avgBreakDepth: number;
  deepBreaks: number;
  lineUtilization: number[];
  /** Reason it was left alone, if it was. */
  skipReason?: string;
}

/** Aggregate `report.json` payload. */
export interface Report {
  overflow_count: number;
  changed_equations: number;
  compile_failures: number;
  average_lines: number;
  deep_break_count: number;
  roundtrip_failures: number;
  max_line_utilization: number;
  mean_line_utilization: number;
  min_line_utilization: number;
  number_of_breaks: number;
  average_break_ast_depth: number;
  equations: EquationReport[];
}
