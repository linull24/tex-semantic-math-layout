/**
 * Minimal, comment-aware LaTeX source scanning.
 *
 * Deliberately *not* a LaTeX parser: `unified-latex` owns parsing. This module
 * only does the byte-level bookkeeping needed to find document regions and to
 * splice replacements back into the original bytes without disturbing
 * anything else.
 */

export interface DocumentParts {
  /** Everything before `\begin{document}`. */
  preamble: string;
  /** Offset of `\begin{document}`. */
  documentStart: number;
  /** Offset just past `\begin{document}`. */
  bodyStart: number;
  /** Offset of `\end{document}`, or src.length. */
  bodyEnd: number;
  /** Document body source. */
  body: string;
  /** Offset just past `\end{document}`, or src.length. */
  documentEnd: number;
}

/** True when `offset` sits inside a `%` comment (respecting `\%`). */
export function inComment(src: string, offset: number): boolean {
  const lineStart = src.lastIndexOf("\n", offset - 1) + 1;
  for (let i = lineStart; i < offset; i++) {
    if (src[i] === "%") {
      let backslashes = 0;
      for (let j = i - 1; j >= lineStart && src[j] === "\\"; j--) backslashes++;
      if (backslashes % 2 === 0) return true;
    }
  }
  return false;
}

/** Strip a trailing `%` comment from a single line, honouring `\%`. */
export function stripComment(line: string): string {
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "%") {
      let backslashes = 0;
      for (let j = i - 1; j >= 0 && line[j] === "\\"; j--) backslashes++;
      if (backslashes % 2 === 0) return line.slice(0, i);
    }
  }
  return line;
}

/** 1-based line number containing `offset`. */
export function lineOf(src: string, offset: number): number {
  let n = 1;
  for (let i = 0; i < offset && i < src.length; i++) if (src[i] === "\n") n++;
  return n;
}

const DOC_BEGIN = /\\begin\s*\{\s*document\s*\}/;
const DOC_END = /\\end\s*\{\s*document\s*\}/g;

/** Locate `\begin{document}` / `\end{document}`, ignoring commented-out ones. */
export function splitDocument(src: string): DocumentParts {
  const beginRe = new RegExp(DOC_BEGIN.source, "g");
  let documentStart = -1;
  let m: RegExpExecArray | null;
  while ((m = beginRe.exec(src)) !== null) {
    if (!inComment(src, m.index)) {
      documentStart = m.index;
      break;
    }
  }
  if (documentStart < 0) {
    // A bare fragment: treat everything as body; the caller supplies a
    // measurement preamble.
    return {
      preamble: "",
      documentStart: 0,
      bodyStart: 0,
      bodyEnd: src.length,
      body: src,
      documentEnd: src.length,
    };
  }
  const beginText = DOC_BEGIN.exec(src.slice(documentStart))![0];
  const afterBegin = documentStart + beginText.length;

  DOC_END.lastIndex = afterBegin;
  let bodyEnd = src.length;
  let documentEnd = src.length;
  while ((m = DOC_END.exec(src)) !== null) {
    if (!inComment(src, m.index)) {
      bodyEnd = m.index;
      documentEnd = m.index + m[0].length;
      break;
    }
  }
  return {
    preamble: src.slice(0, documentStart),
    documentStart,
    bodyStart: afterBegin,
    bodyEnd,
    body: src.slice(afterBegin, bodyEnd),
    documentEnd,
  };
}

export interface EnvSpan {
  name: string;
  /** Offset of the backslash of `\begin`. */
  openStart: number;
  /** Offset just past `\end{name}`. */
  closeEnd: number;
  bodyStart: number;
  bodyEnd: number;
}

const BEGIN_RE = /\\begin\s*\{\s*([A-Za-z@*]+)\s*\}/g;
const END_RE = /\\end\s*\{\s*([A-Za-z@*]+)\s*\}/g;

/**
 * Find spans of `\begin{name}...\end{name}` for the requested environment
 * names. Handles nesting and skips commented-out occurrences.
 *
 * Only environments whose name is in `names` are returned, but nesting is
 * tracked for *all* environments so that inner `\end`s pair correctly.
 */
export function findEnvironments(src: string, names: Set<string>): EnvSpan[] {
  type Ev = { type: "open" | "close"; offset: number; name: string; end: number };
  const events: Ev[] = [];
  let m: RegExpExecArray | null;

  const beginRe = new RegExp(BEGIN_RE.source, "g");
  while ((m = beginRe.exec(src)) !== null) {
    if (inComment(src, m.index)) continue;
    events.push({ type: "open", offset: m.index, name: m[1]!, end: m.index + m[0].length });
  }
  const endRe = new RegExp(END_RE.source, "g");
  while ((m = endRe.exec(src)) !== null) {
    if (inComment(src, m.index)) continue;
    events.push({ type: "close", offset: m.index, name: m[1]!, end: m.index + m[0].length });
  }
  events.sort((a, b) => a.offset - b.offset);

  const spans: EnvSpan[] = [];
  const openStack: Array<{ name: string; openStart: number; bodyStart: number }> = [];
  for (const ev of events) {
    if (ev.type === "open") {
      openStack.push({ name: ev.name, openStart: ev.offset, bodyStart: ev.end });
      continue;
    }
    // Close the nearest matching open, discarding any unmatched inners.
    for (let i = openStack.length - 1; i >= 0; i--) {
      if (openStack[i]!.name === ev.name) {
        const o = openStack[i]!;
        openStack.length = i;
        if (names.has(ev.name)) {
          spans.push({
            name: ev.name,
            openStart: o.openStart,
            closeEnd: ev.end,
            bodyStart: o.bodyStart,
            bodyEnd: ev.offset,
          });
        }
        break;
      }
    }
  }
  spans.sort((a, b) => a.openStart - b.openStart);
  return spans;
}

/** Trim whitespace and return the trimmed span within `src`. */
export function trimSpan(
  src: string,
  start: number,
  end: number
): { start: number; end: number; text: string } {
  let s = start;
  let e = end;
  while (s < e && /\s/.test(src[s]!)) s++;
  while (e > s && /\s/.test(src[e - 1]!)) e--;
  return { start: s, end: e, text: src.slice(s, e) };
}
