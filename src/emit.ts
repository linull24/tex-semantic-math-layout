/**
 * Emit canonical LaTeX. Nothing else is ever produced.
 *
 *   single-line              body unchanged
 *   continuation             \begin{aligned} A &= B \\ &\quad {} + C \end{aligned}
 *   continuation-unanchored  \begin{aligned} & A + B \\ &\quad {} + C \end{aligned}
 *   derivation               \begin{aligned} A &= B \\ &= C \\ &\le D \end{aligned}
 *   optimization             \min_x\quad & f(x) \\ \text{s.t.}\quad & ...
 *
 * Note on `align`: the derivation *shape* is emitted as `aligned` inside the
 * original environment. Emitting a top-level `align` would turn one equation
 * number into one per line, breaking the "preserve numbering" requirement.
 */

import type { LayoutSolution } from "./types.js";

export interface EmitOptions {
  /** Trailing `\label{...}` / `\tag{...}` recovered from the body. */
  trailers?: string[];
  /** Indentation of the generated lines. */
  indent?: string;
  /** Use a top-level `align` environment instead of `aligned`. */
  useAlign?: boolean;
}

/** Render one aligned row. */
function row(col1: string, col2: string, indent: string): string {
  const left = col1 ? `${col1} &` : "&";
  return `${indent}${left}${col2}`;
}

/** Build the replacement body for an equation. */
export function emitBody(sol: LayoutSolution, opts: EmitOptions = {}): string {
  const base = opts.indent ?? "  ";
  const inner = base + base;
  const trailers = opts.trailers ?? [];
  const trailerText = trailers.length > 0 ? trailers.join("") : "";

  if (sol.pattern === "single-line" || sol.lines.length <= 1) {
    const text = sol.lines.map((l) => (l.col1 ? `${l.col1} ${l.col2}` : l.col2)).join(" ").trim();
    return `\n${base}${text}${trailerText}\n`;
  }

  const env = opts.useAlign ? "align" : "aligned";
  const rows = sol.lines.map((l) => row(l.col1, l.col2, inner));
  const out = [
    `${base}\\begin{${env}}`,
    ...rows.map((r, i) => (i < rows.length - 1 ? `${r} \\\\` : r)),
    `${base}\\end{${env}}`,
  ];
  if (trailerText) out.push(`${base}${trailerText}`);
  return `\n${out.join("\n")}\n`;
}

/** The exact source used to measure a solved block (for verification). */
export function blockSource(sol: LayoutSolution, useAlign = false): string {
  const env = useAlign ? "align" : "aligned";
  const rows = sol.lines.map((l) => row(l.col1, l.col2, ""));
  return `\\begin{${env}}${rows.join(" \\\\ ")}\\end{${env}}`;
}
