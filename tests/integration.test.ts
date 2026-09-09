/**
 * End-to-end tests. These run XeLaTeX through the real measurement harness,
 * so they are slower than the unit tests; the width cache makes reruns quick.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { processDocument } from "../src/index.js";

const ROOT = join(__dirname, "..");
const FIXTURES = join(ROOT, "fixtures");
const hasTex = existsSync("/Library/TeX/texbin/xelatex") || existsSync("/usr/bin/xelatex");

const SHORT_DOC = String.raw`\documentclass[11pt,a4paper,scheme=plain,fontset=fandol,no-math]{ctexart}
\usepackage[margin=25mm]{geometry}
\usepackage{mathtools}
\usepackage{eqnlines}
\usepackage[libertinus]{termes-otf}
\usepackage[restoremathleading=true]{zhlineskip}
\begin{document}
正文保持不动。

\begin{equation}\label{eq:long}
\mathcal{L}(\theta) = \frac{1}{2}\log\left(2\pi\sigma^2\right) + \frac{1}{2\sigma^2}\sum_{i=1}^{n}\left(y_i - f_\theta(x_i)\right)^2 + \frac{1}{2}\log\left|\Sigma_\theta\right| + \frac{d}{2}\log(2\pi) + \lambda\sum_{j=1}^{p}\left|\theta_j\right| + \frac{n}{2}\log\left(\frac{1}{n}\sum_{i=1}^{n}\left(y_i - \hat{y}_i\right)^2\right)
\end{equation}

\begin{equation}
a = b
\end{equation}
\end{document}
`;

describe.runIf(hasTex)("processDocument", () => {
  it("rewrites only the overflowing equation", async () => {
    const res = await processDocument(SHORT_DOC, { workDir: FIXTURES });
    expect(res.report.changed_equations).toBe(1);
    expect(res.report.overflow_count).toBe(0);

    // Surrounding prose and the short equation are byte-identical.
    expect(res.output).toContain("正文保持不动。");
    expect(res.output).toContain("\\begin{equation}\na = b\n\\end{equation}");
    // The label survives.
    expect(res.output).toContain("\\label{eq:long}");
    expect(res.output).toContain("\\begin{aligned}");
    // Exactly one replacement, inside the first equation body.
    expect(res.replacements).toHaveLength(1);
  }, 120_000);

  it("emits output that only differs inside equation bodies", async () => {
    const res = await processDocument(SHORT_DOC, { workDir: FIXTURES });
    let rebuilt = SHORT_DOC;
    for (const r of [...res.replacements].sort((a, b) => b.start - a.start)) {
      rebuilt = rebuilt.slice(0, r.start) + r.text + rebuilt.slice(r.end);
    }
    expect(rebuilt).toBe(res.output);
  }, 120_000);

  it("honours % math-layout: ignore", async () => {
    const src = SHORT_DOC.replace("\\begin{equation}\\label{eq:long}", "% math-layout: ignore\n\\begin{equation}\\label{eq:long}");
    const res = await processDocument(src, { workDir: FIXTURES });
    expect(res.report.changed_equations).toBe(0);
  }, 120_000);

  it("is deterministic across runs", async () => {
    const a = await processDocument(SHORT_DOC, { workDir: FIXTURES });
    const b = await processDocument(SHORT_DOC, { workDir: FIXTURES });
    expect(a.output).toBe(b.output);
  }, 120_000);

  it("processes every fixture without a TeX failure", async () => {
    const files = ["kalman.tex", "kkt.tex", "esr.tex", "pathological.tex"];
    for (const f of files) {
      const src = await readFile(join(FIXTURES, f), "utf8");
      const res = await processDocument(src, { workDir: FIXTURES });
      expect(res.failures, `${f} had unmeasurable fragments`).toBe(0);
      expect(res.report.overflow_count, `${f} still overflows`).toBe(0);
      expect(res.output).toContain("\\begin{document}");
      expect(res.output).toContain("\\end{document}");
    }
  }, 300_000);
});
