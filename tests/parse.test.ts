import { describe, expect, it } from "vitest";
import { collectEquations, findDirectives, flattenStructured } from "../src/equations.js";
import { splitMathBody } from "../src/mathsplit.js";
import { findEnvironments, inComment, splitDocument, stripComment } from "../src/tex.js";

describe("tex.ts", () => {
  it("splits a document into preamble and body", () => {
    const src = "\\documentclass{article}\n\\begin{document}\nhello\n\\end{document}\n";
    const d = splitDocument(src);
    expect(d.preamble).toContain("\\documentclass");
    expect(d.body).toContain("hello");
    expect(d.body).not.toContain("\\begin{document}");
  });

  it("treats a bare fragment as body", () => {
    const d = splitDocument("a = b");
    expect(d.preamble).toBe("");
    expect(d.body).toBe("a = b");
  });

  it("ignores commented-out environments", () => {
    const src = "% \\begin{document}\n\\begin{document}\nX\n\\end{document}";
    expect(splitDocument(src).body.trim()).toBe("X");
  });

  it("respects escaped percent signs", () => {
    expect(stripComment("a \\% b % real")).toBe("a \\% b ");
    expect(inComment("a \\% b % real", 8)).toBe(true);
    expect(inComment("a \\% b % real", 4)).toBe(false);
  });

  it("matches nested environments of the same name", () => {
    const src = "\\begin{a}\\begin{a}x\\end{a}y\\end{a}";
    const spans = findEnvironments(src, new Set(["a"]));
    expect(spans).toHaveLength(2);
    expect(spans[1]!.bodyStart).toBeGreaterThan(spans[0]!.bodyStart);
  });
});

describe("mathsplit.ts", () => {
  it("keeps \\frac and \\log intact", () => {
    const s = splitMathBody(String.raw`x = \frac{a+b}{c} + \log(d)`);
    expect(s.pieces.map((p) => p.text)).toEqual([
      "x",
      String.raw`= \frac{a+b}{c}`,
      String.raw`+ \log(d)`,
    ]);
  });

  it("never breaks inside \\left...\\right", () => {
    const s = splitMathBody(String.raw`a = \left( b + c \right) + d`);
    expect(s.pieces[1]!.text).toBe(String.raw`= \left( b + c \right)`);
    expect(s.candidates.map((c) => c.opText)).toEqual(["=", "+"]);
  });

  it("does not break inside a function argument", () => {
    const s = splitMathBody(String.raw`\log(a+b) + c`);
    expect(s.pieces[0]!.text).toBe(String.raw`\log(a+b)`);
    expect(s.candidates).toHaveLength(1);
  });

  it("classifies unary minus as part of the operand", () => {
    const s = splitMathBody("x = -a + b");
    expect(s.pieces[1]!.text).toBe("= -a");
    expect(s.candidates.map((c) => c.opText)).toEqual(["=", "+"]);
  });

  it("ranks relations above addition above multiplication", () => {
    const s = splitMathBody(String.raw`a = b + c \times d`);
    const pri = Object.fromEntries(s.candidates.map((c) => [c.opText, c.priority]));
    expect(pri["="]).toBe(1);
    expect(pri["+"]).toBe(2);
    expect(pri["\\times"]).toBe(3);
  });

  it("offers juxtaposition as a last-resort break", () => {
    const s = splitMathBody("A_1 A_2 A_3");
    expect(s.candidates).toHaveLength(2);
    expect(s.candidates.every((c) => c.priority === 5)).toBe(true);
  });

  it("does not separate a macro from its argument", () => {
    const s = splitMathBody(String.raw`\myop{a} + \myop{b}`);
    expect(s.pieces[0]!.text).toBe(String.raw`\myop{a}`);
  });

  it("pieces are exact source slices", () => {
    const body = String.raw`x = a+b + c`;
    const s = splitMathBody(body);
    for (const p of s.pieces) expect(body.slice(p.start, p.end)).toBe(p.text);
  });

  it("honours \\nobreak", () => {
    const s = splitMathBody(String.raw`a = b \nobreak + c`);
    const plus = s.candidates.find((c) => c.opText === "+");
    expect(plus?.hint).toBe("nobreak");
  });
});

describe("equations.ts", () => {
  const doc = (body: string) => `\\documentclass{article}\\begin{document}\n${body}\n\\end{document}`;

  it("finds equation and bracket displays", () => {
    const sites = collectEquations(doc("\\begin{equation}a=b\\end{equation}\n\\[c=d\\]"), {
      rewriteExisting: false,
    });
    expect(sites.map((s) => s.kind)).toEqual(["equation", "bracket"]);
  });

  it("skips hand-written aligned by default", () => {
    const sites = collectEquations(
      doc("\\begin{equation}\\begin{aligned}a&=b\\\\&=c\\end{aligned}\\end{equation}"),
      { rewriteExisting: false }
    );
    expect(sites[0]!.skipped).toBe(true);
    expect(sites[0]!.hasLineBreak).toBe(true);
  });

  it("still processes an equation containing a matrix", () => {
    const sites = collectEquations(
      doc("\\begin{equation}P = A + \\begin{pmatrix} 1 & 0 \\\\ 0 & 1 \\end{pmatrix}\\end{equation}"),
      { rewriteExisting: false }
    );
    expect(sites[0]!.hasLineBreak).toBe(false);
    expect(sites[0]!.skipped).toBe(false);
  });

  it("honours % math-layout: off / on", () => {
    const src = doc(
      "% math-layout: off\n\\begin{equation}a=b\\end{equation}\n% math-layout: on\n\\begin{equation}c=d\\end{equation}"
    );
    const sites = collectEquations(src, { rewriteExisting: false });
    expect(sites[0]!.skipped).toBe(true);
    expect(sites[1]!.skipped).toBe(false);
  });

  it("honours % math-layout: ignore", () => {
    const src = doc("% math-layout: ignore\n\\begin{equation}a=b\\end{equation}\n\\begin{equation}c=d\\end{equation}");
    const sites = collectEquations(src, { rewriteExisting: false });
    expect(sites[0]!.skipped).toBe(true);
    expect(sites[1]!.skipped).toBe(false);
  });

  it("extracts labels without losing them", () => {
    const sites = collectEquations(doc("\\begin{equation}a=b\\label{eq:x}\\end{equation}"), {
      rewriteExisting: false,
    });
    expect(sites[0]!.trailers).toEqual(["\\label{eq:x}"]);
    expect(sites[0]!.body).not.toContain("\\label");
  });

  it("finds directives in order", () => {
    expect(findDirectives("% math-layout: off\n% math-layout: on").map((d) => d.kind)).toEqual([
      "off",
      "on",
    ]);
  });

  it("flattens structured bodies", () => {
    const flat = flattenStructured("\\begin{aligned}a &= b \\\\ &= c\\end{aligned}");
    expect(flat).toBe("a = b = c");
  });
});
