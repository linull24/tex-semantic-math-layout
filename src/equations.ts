/**
 * Locate display equations in a document body and decide which ones the tool
 * is allowed to touch.
 *
 * Only the equation *body* is ever replaced; the surrounding `\begin{...}` /
 * `\end{...}` delimiters, the prose, and every comment outside the body are
 * left byte-identical.
 */

import { findEnvironments, inComment, stripComment } from "./tex.js";
import type { EquationSite } from "./types.js";

/** Environments we understand as "one display equation". */
const SINGLE_ENVS = new Set(["equation", "equation*", "displaymath", "math"]);

/** Environments that are already hand-structured: never touched by default. */
const STRUCTURED_ENVS = new Set([
  "align", "align*", "aligned", "alignedat", "gather", "gather*",
  "gathered", "multline", "multline*", "split", "flalign", "flalign*",
  "eqnarray", "eqnarray*", "cases", "dcases", "matrix", "pmatrix",
  "bmatrix", "Bmatrix", "vmatrix", "Vmatrix", "smallmatrix", "array",
]);

const ALL_ENVS = new Set([...SINGLE_ENVS, ...STRUCTURED_ENVS]);

export type Directive = "off" | "on" | "ignore";

export interface DirectiveHit {
  kind: Directive;
  offset: number;
}

/** Scan for `% math-layout: off|on|ignore` comments, in source order. */
export function findDirectives(src: string): DirectiveHit[] {
  const hits: DirectiveHit[] = [];
  // `[ \t]` rather than `\s`: `\s` also matches newlines, which would make the
  // directive appear to start on a previous (blank) line.
  const re = /^[ \t]*%[ \t]*math-layout[ \t]*:[ \t]*(off|on|ignore)\b/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    hits.push({ kind: m[1] as Directive, offset: m.index });
  }
  return hits;
}

/** True when `offset` falls inside an `off`..`on` region. */
function insideOffRegion(directives: DirectiveHit[], offset: number): boolean {
  let off = false;
  for (const d of directives) {
    if (d.offset >= offset) break;
    if (d.kind === "off") off = true;
    else if (d.kind === "on") off = false;
  }
  return off;
}

/** True when the closest preceding directive is a bare `ignore`. */
function hasIgnoreBefore(directives: DirectiveHit[], src: string, offset: number): boolean {
  let last: DirectiveHit | null = null;
  for (const d of directives) {
    if (d.offset >= offset) break;
    last = d;
  }
  if (!last || last.kind !== "ignore") return false;
  // `ignore` must be adjacent: nothing but whitespace/comments in between.
  const between = src.slice(last.offset, offset);
  const lineEnd = between.indexOf("\n");
  if (lineEnd < 0) return true;
  const rest = between.slice(lineEnd + 1);
  return rest.trim() === "";
}

const LABEL_RE = /\\label\s*\{[^{}]*\}/g;
const TAG_RE = /\\tag\s*\{[^{}]*\}/g;

/** Extract and remove `\label{...}` / `\tag{...}` from a body. */
function extractTrailers(body: string): { trailers: string[]; stripped: string } {
  const trailers: string[] = [];
  let stripped = body.replace(LABEL_RE, (mm) => {
    trailers.push(mm);
    return "";
  });
  stripped = stripped.replace(TAG_RE, (mm) => {
    trailers.push(mm);
    return "";
  });
  return { trailers, stripped };
}

export interface CollectOptions {
  /** Reflow equations that already contain `\\`/`&`. */
  rewriteExisting: boolean;
}

/**
 * Find every display equation in `src`, annotated with whether the tool may
 * rewrite it. `src` is the whole document; offsets are absolute.
 */
export function collectEquations(src: string, opts: CollectOptions): EquationSite[] {
  const directives = findDirectives(src);
  const sites: EquationSite[] = [];

  const add = (
    kind: string,
    openStart: number,
    closeEnd: number,
    bodyStart: number,
    bodyEnd: number,
    alreadyStructured: boolean
  ) => {
    const rawBody = src.slice(bodyStart, bodyEnd);
    const hasLineBreak = hasTopLevelBreak(rawBody);
    const { trailers, stripped } = extractTrailers(rawBody);
    const ignored =
      insideOffRegion(directives, openStart) ||
      hasIgnoreBefore(directives, src, openStart) ||
      inComment(src, openStart);
    const skipped =
      ignored ||
      (alreadyStructured && !opts.rewriteExisting) ||
      (hasLineBreak && !opts.rewriteExisting);
    sites.push({
      kind,
      openStart,
      closeEnd,
      bodyStart,
      bodyEnd,
      body: stripped,
      hasLineBreak,
      trailers,
      ignored,
      skipped,
    });
  };

  for (const env of findEnvironments(src, ALL_ENVS)) {
    if (SINGLE_ENVS.has(env.name)) {
      add(env.name, env.openStart, env.closeEnd, env.bodyStart, env.bodyEnd, false);
    } else {
      // Structured environment: only considered with --rewrite-existing.
      add(env.name, env.openStart, env.closeEnd, env.bodyStart, env.bodyEnd, true);
    }
  }

  // `\[ ... \]`
  const re = /\\\[|\\\]/g;
  let m: RegExpExecArray | null;
  let open = -1;
  while ((m = re.exec(src)) !== null) {
    if (inComment(src, m.index)) continue;
    if (m[0] === "\\[") {
      if (open < 0) open = m.index;
    } else if (open >= 0) {
      const bodyStart = open + 2;
      const bodyEnd = m.index;
      const rawBody = src.slice(bodyStart, bodyEnd);
      const { trailers, stripped } = extractTrailers(rawBody);
      const hasLineBreak = hasTopLevelBreak(rawBody);
      const ignored =
        insideOffRegion(directives, open) || hasIgnoreBefore(directives, src, open);
      sites.push({
        kind: "bracket",
        openStart: open,
        closeEnd: m.index + 2,
        bodyStart,
        bodyEnd,
        body: stripped,
        hasLineBreak,
        trailers,
        ignored,
        skipped: ignored || (hasLineBreak && !opts.rewriteExisting),
      });
      open = -1;
    }
  }

  sites.sort((a, b) => a.openStart - b.openStart);
  // Drop nested sites (an equation inside another environment's span).
  const out: EquationSite[] = [];
  for (const s of sites) {
    const enclosing = out.find((o) => s.openStart > o.openStart && s.closeEnd <= o.closeEnd);
    if (enclosing) continue;
    out.push(s);
  }
  return out;
}

/** Remove `%` comments so `&`/`\\` detection doesn't trip on comments. */
function stripCommentsForMath(body: string): string {
  return body
    .split("\n")
    .map((l) => stripComment(l))
    .join("\n");
}

/**
 * Environments that are *content objects*: their internal `&`/`\\` are row
 * separators of the object, not line breaks of the equation. An `equation`
 * containing a `pmatrix` is still a single-line display equation.
 */
const CONTENT_ENVS = new Set([
  "cases", "dcases", "rcases", "matrix", "pmatrix", "bmatrix", "Bmatrix",
  "vmatrix", "Vmatrix", "smallmatrix", "array", "subarray", "substack",
]);

/** Environments that structure the equation into lines. */
const LINE_ENVS = new Set([
  "aligned", "align", "align*", "alignat", "alignat*", "alignedat",
  "gathered", "gather", "gather*", "split", "multline", "multline*",
  "flalign", "flalign*", "eqnarray", "eqnarray*",
]);

/** Blank out every content-object `\begin{...}...\end{...}` span. */
function maskNestedEnvironments(body: string): string {
  const names = new Set<string>();
  const re = /\\begin\s*\{\s*([A-Za-z@*]+)\s*\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) if (CONTENT_ENVS.has(m[1]!)) names.add(m[1]!);
  if (names.size === 0) return body;

  const chars = body.split("");
  for (const env of findEnvironments(body, names)) {
    for (let i = env.openStart; i < env.closeEnd; i++) {
      if (chars[i] !== "\n") chars[i] = " ";
    }
  }
  return chars.join("");
}

/**
 * True when the equation is already broken *at its own top level*.
 *
 * `&`/`\\` inside a nested `pmatrix`, `cases`, or `aligned` do not count: an
 * `equation` containing a matrix is still a single-line display equation and
 * may be reflowed at its top-level operators (the matrix stays intact as one
 * atom).
 */
function hasTopLevelBreak(body: string): boolean {
  const stripped = stripCommentsForMath(body);
  if (/\\\\|&/.test(maskNestedEnvironments(stripped))) return true;
  // A nested line-structuring environment means the author already broke it.
  for (const name of LINE_ENVS) {
    if (new RegExp(`\\\\begin\\s*\\{\\s*${name.replace("*", "\\*")}\\s*\\}`).test(stripped)) return true;
  }
  return false;
}

/**
 * Flatten an already-structured body (`aligned`, `align`, `cases`, ...) into a
 * single math expression, for `--rewrite-existing`.
 */
export function flattenStructured(body: string): string {
  return body
    .split("\n")
    .map((l) => stripComment(l))
    .join(" ")
    .replace(/\\begin\s*\{[^{}]*\}(\[[^\]]*\])?/g, " ")
    .replace(/\\end\s*\{[^{}]*\}/g, " ")
    .replace(/\\\\(\[[^\]]*\])?/g, " ")
    .replace(/&/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
