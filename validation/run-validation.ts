/**
 * Validation harness.
 *
 * For every fixture it produces a side-by-side comparison of
 *   A  the original single-line source
 *   B  amsmath `autobreak`
 *   C  `breqn` `dmath`
 *   D  this tool
 * and compiles the result to `validation.pdf`, plus an aggregate `report.json`.
 *
 * Two documents are compiled because the baselines cannot coexist with the
 * target font stack (documented in the README):
 *   panels-real.tex      A and D in the exact ctexart + Termes + Libertinus +
 *                        zhlineskip + eqnlines stack.
 *   panels-baseline.tex  A/B/C/D with the same geometry and a Times-metric
 *                        math font, because breqn is incompatible with
 *                        unicode-math/OTF math and eqnlines is incompatible
 *                        with autobreak.
 */

import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { processDocument } from "../src/index.js";
import { splitMathBody } from "../src/mathsplit.js";
import type { Report } from "../src/types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const FIXTURES = join(ROOT, "fixtures");

interface Panel {
  id: string;
  fixture: string;
  equation: number;
  label: string;
  original: string;
  ours: string | null;
  pattern: string;
  lines: number;
  util: number[];
}

const REAL_PREAMBLE = String.raw`\documentclass[11pt,a4paper,scheme=plain,fontset=fandol,no-math]{ctexart}
\usepackage[margin=25mm]{geometry}
\usepackage{mathtools}
\usepackage{eqnlines}
\usepackage[libertinus]{termes-otf}
\usepackage[restoremathleading=true]{zhlineskip}
\AtBeginDocument{\fontsize{11pt}{14.5pt}\selectfont}
\newcommand{\trans}{^{\top}}
\newcommand{\pinv}{^{\dagger}}
\newcommand{\norm}[1]{\left\lVert #1 \right\rVert}
\newcommand{\E}{\mathbb{E}}
\newcommand{\dplus}{\delta^{+}}
\newcommand{\dminus}{\delta^{-}}
\newcommand{\myop}[1]{\operatorname{MyLongOperatorName}\left( #1 \right)}
\DeclareMathOperator*{\argmax}{arg\,max}
\DeclareMathOperator*{\argmin}{arg\,min}
\DeclareMathOperator{\Var}{Var}
\DeclareMathOperator{\Cov}{Cov}
\DeclareMathOperator{\tr}{tr}
\DeclareMathOperator{\rank}{rank}
\DeclareMathOperator{\diag}{diag}
\newsavebox{\mlpanel}
\newcommand{\mlmeasure}[2]{%
  \setbox\mlpanel=\vbox{\hsize=\linewidth\setlength{\parindent}{0pt}\setlength{\parskip}{0pt}%
  #2}%
  \typeout{PANELHEIGHT:#1:\the\ht\mlpanel}%
  \par\unvbox\mlpanel\par}
\allowdisplaybreaks`;

const BASELINE_PREAMBLE = String.raw`\documentclass[11pt,a4paper,scheme=plain,fontset=fandol,no-math]{ctexart}
\usepackage[margin=25mm]{geometry}
\usepackage{mathtools}
\usepackage{newtxtext,newtxmath}
\usepackage{autobreak}
\usepackage{breqn}
\AtBeginDocument{\fontsize{11pt}{14.5pt}\selectfont}
\newcommand{\trans}{^{\top}}
\newcommand{\pinv}{^{\dagger}}
\newcommand{\norm}[1]{\left\lVert #1 \right\rVert}
\newcommand{\E}{\mathbb{E}}
\newcommand{\dplus}{\delta^{+}}
\newcommand{\dminus}{\delta^{-}}
\newcommand{\myop}[1]{\operatorname{MyLongOperatorName}\left( #1 \right)}
\DeclareMathOperator*{\argmax}{arg\,max}
\DeclareMathOperator*{\argmin}{arg\,min}
\DeclareMathOperator{\Var}{Var}
\DeclareMathOperator{\Cov}{Cov}
\DeclareMathOperator{\tr}{tr}
\DeclareMathOperator{\rank}{rank}
\DeclareMathOperator{\diag}{diag}
\newsavebox{\mlpanel}
\newcommand{\mlmeasure}[2]{%
  \setbox\mlpanel=\vbox{\hsize=\linewidth\setlength{\parindent}{0pt}\setlength{\parskip}{0pt}%
  #2}%
  \typeout{PANELHEIGHT:#1:\the\ht\mlpanel}%
  \par\unvbox\mlpanel\par}
\allowdisplaybreaks`;

function run(cmd: string, args: string[], cwd: string): Promise<number> {
  return new Promise((res) => {
    execFile(cmd, args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (err) => res(err ? 1 : 0));
  });
}

/** Newline-separated body: `autobreak` treats source newlines as break points. */
function autobreakBody(body: string): string {
  const split = splitMathBody(body);
  if (split.pieces.length <= 1) return body.trim();
  // A blank line inside a display environment is a paragraph break, which
  // amsmath rejects; trim so the first/last newline cannot create one.
  return split.pieces.map((p) => p.text).join("\n").trim();
}

/** Count `Overfull \hbox` occurrences inside each PANELSTART/PANELEND region. */
function overfullByPanel(log: string): Map<string, number> {
  const out = new Map<string, number>();
  let current: string | null = null;
  for (const line of log.split("\n")) {
    const start = /PANELSTART:([A-Za-z0-9_-]+)/.exec(line);
    if (start) {
      current = start[1]!;
      if (!out.has(current)) out.set(current, 0);
      continue;
    }
    if (/PANELEND:/.test(line)) {
      current = null;
      continue;
    }
    if (current && /^Overfull \\hbox/.test(line)) {
      out.set(current, (out.get(current) ?? 0) + 1);
    }
  }
  return out;
}

/** Parse `PANELHEIGHT:<id>:<pt>` lines from a log. */
function heightsByPanel(log: string): Map<string, number> {
  const out = new Map<string, number>();
  const re = /PANELHEIGHT:([A-Za-z0-9_-]+):([0-9.]+)pt/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(log)) !== null) out.set(m[1]!, Number(m[2]));
  return out;
}

function equationBlock(env: string, body: string): string {
  // A blank line inside display math is a paragraph break: trim both ends and
  // drop labels/tags, which the panels do not need.
  const clean = body
    .replace(/\\label\s*\{[^{}]*\}/g, "")
    .replace(/\\tag\s*\{[^{}]*\}/g, "")
    .trim();
  return `\\begin{${env}}\n${clean}\n\\end{${env}}`;
}

async function main(): Promise<void> {
  const files = (await readdir(FIXTURES)).filter((f) => f.endsWith(".tex")).sort();
  const panels: Panel[] = [];
  const aggregate: Report = {
    overflow_count: 0,
    changed_equations: 0,
    compile_failures: 0,
    average_lines: 0,
    deep_break_count: 0,
    roundtrip_failures: 0,
    max_line_utilization: 0,
    mean_line_utilization: 0,
    min_line_utilization: 0,
    number_of_breaks: 0,
    average_break_ast_depth: 0,
    equations: [],
  };
  const allUtil: number[] = [];
  let changedTotal = 0;
  let lineTotal = 0;

  for (const file of files) {
    const src = await readFile(join(FIXTURES, file), "utf8");
    const result = await processDocument(src, { workDir: FIXTURES });
    const name = file.replace(/\.tex$/, "");

    result.equations.forEach((eq, i) => {
      const r = eq.report;
      const util = r.lineUtilization;
      const difficult = r.changed || r.overflow || (util[0] ?? 0) > 0.82;
      if (!difficult) return;
      panels.push({
        id: `${name}-${i}`,
        fixture: file,
        equation: i,
        label: `${file} eq.${i}`,
        original: eq.original,
        ours: eq.emitted,
        pattern: r.pattern,
        lines: r.lines,
        util,
      });
    });

    for (const r of result.report.equations) {
      allUtil.push(...r.lineUtilization);
      if (r.changed) {
        changedTotal++;
        lineTotal += r.lines;
      }
    }
    for (const r of result.report.equations) aggregate.equations.push({ ...r, fixture: file });
    aggregate.overflow_count += result.report.overflow_count;
    aggregate.deep_break_count += result.report.deep_break_count;
    aggregate.number_of_breaks += result.report.number_of_breaks;
    aggregate.compile_failures += result.report.compile_failures;
    aggregate.average_break_ast_depth += result.report.average_break_ast_depth * result.report.number_of_breaks;
  }

  aggregate.changed_equations = changedTotal;
  aggregate.average_lines = changedTotal === 0 ? 0 : lineTotal / changedTotal;
  aggregate.max_line_utilization = allUtil.length ? Math.max(...allUtil) : 0;
  aggregate.min_line_utilization = allUtil.length ? Math.min(...allUtil) : 0;
  aggregate.mean_line_utilization = allUtil.length
    ? allUtil.reduce((a, b) => a + b, 0) / allUtil.length
    : 0;
  aggregate.average_break_ast_depth =
    aggregate.number_of_breaks === 0
      ? 0
      : aggregate.average_break_ast_depth / aggregate.number_of_breaks;

  /* ---- real-stack document: A and D --------------------------------- */
  const real: string[] = [REAL_PREAMBLE, "\\begin{document}", "\\section*{Exact paper stack: original (A) vs math-layout (D)}"];
  for (const p of panels) {
    real.push(`\\subsection*{${p.label} \\textnormal{(${p.pattern}, ${p.lines} lines)}}`);
    real.push(`\\typeout{PANELSTART:${p.id}-A}`);
    real.push("\\paragraph{A: original}");
    real.push(`\\mlmeasure{${p.id}-A}{${equationBlock("equation*", p.original)}}`);
    real.push(`\\typeout{PANELEND:${p.id}-A}`);
    if (p.ours) {
      real.push(`\\typeout{PANELSTART:${p.id}-D}`);
      real.push("\\paragraph{D: math-layout}");
      real.push(`\\mlmeasure{${p.id}-D}{${equationBlock("equation*", p.ours.trim())}}`);
      real.push(`\\typeout{PANELEND:${p.id}-D}`);
    }
  }
  real.push("\\end{document}");
  await writeFile(join(HERE, "panels-real.tex"), real.join("\n") + "\n", "utf8");

  /* ---- baseline document: A, B, C, D -------------------------------- */
  const base: string[] = [BASELINE_PREAMBLE, "\\begin{document}", "\\section*{Baselines: autobreak (B) and breqn (C) vs math-layout (D)}"];
  for (const p of panels) {
    base.push(`\\subsection*{${p.label}}`);
    base.push(`\\typeout{PANELSTART:${p.id}-A}`);
    base.push("\\paragraph{A: original}");
    base.push(`\\mlmeasure{${p.id}-A}{${equationBlock("equation*", p.original)}}`);
    base.push(`\\typeout{PANELEND:${p.id}-A}`);
    base.push(`\\typeout{PANELSTART:${p.id}-B}`);
    base.push("\\paragraph{B: autobreak}");
    if (/\\begin\s*\{|\\\{|\\\}/.test(p.original)) {
      // autobreak's parser cannot cope with a nested environment (pmatrix,
      // cases, ...) inside the body; say so instead of emitting broken TeX.
      base.push(
        "\\emph{not applicable: \\textsf{autobreak} cannot parse this body (nested environment or \\textbackslash\\{/\\textbackslash\\} delimiters).}"
      );
    } else {
      base.push(`\\mlmeasure{${p.id}-B}{\\begin{align*}\n\\begin{autobreak}\n${autobreakBody(p.original)}\n\\end{autobreak}\n\\end{align*}}`);
    }
    base.push(`\\typeout{PANELEND:${p.id}-B}`);
    base.push(`\\typeout{PANELSTART:${p.id}-C}`);
    base.push("\\paragraph{C: breqn dmath}");
    base.push(`\\mlmeasure{${p.id}-C}{${equationBlock("dmath*", p.original)}}`);
    base.push(`\\typeout{PANELEND:${p.id}-C}`);
    if (p.ours) {
      base.push(`\\typeout{PANELSTART:${p.id}-D}`);
      base.push("\\paragraph{D: math-layout}");
      base.push(`\\mlmeasure{${p.id}-D}{${equationBlock("equation*", p.ours.trim())}}`);
      base.push(`\\typeout{PANELEND:${p.id}-D}`);
    }
  }
  base.push("\\end{document}");
  await writeFile(join(HERE, "panels-baseline.tex"), base.join("\n") + "\n", "utf8");

  /* ---- compile ------------------------------------------------------ */
  await mkdir(HERE, { recursive: true });
  const failures: string[] = [];
  for (const doc of ["panels-real", "panels-baseline"]) {
    const code = await run("xelatex", ["-interaction=nonstopmode", `${doc}.tex`], HERE);
    if (code !== 0) failures.push(doc);
  }

  const realLog = await readFile(join(HERE, "panels-real.log"), "utf8");
  const baseLog = await readFile(join(HERE, "panels-baseline.log"), "utf8");
  const realOver = overfullByPanel(realLog);
  const baseOver = overfullByPanel(baseLog);
  const realH = heightsByPanel(realLog);
  const baseH = heightsByPanel(baseLog);

  const summary = panels.map((p) => ({
    id: p.id,
    pattern: p.pattern,
    lines: p.lines,
    util: p.util.map((u) => Number(u.toFixed(3))),
    overfull: {
      A: realOver.get(`${p.id}-A`) ?? 0,
      D: realOver.get(`${p.id}-D`) ?? 0,
      B: baseOver.get(`${p.id}-B`) ?? 0,
      C: baseOver.get(`${p.id}-C`) ?? 0,
    },
    // Rendered height in pt: a direct proxy for vertical space consumed, and
    // therefore for how finely a variant fragmented the equation.
    heightPt: {
      A: Number((realH.get(`${p.id}-A`) ?? 0).toFixed(2)),
      B: Number((baseH.get(`${p.id}-B`) ?? 0).toFixed(2)),
      C: Number((baseH.get(`${p.id}-C`) ?? 0).toFixed(2)),
      D: Number((realH.get(`${p.id}-D`) ?? 0).toFixed(2)),
    },
  }));

  await writeFile(
    join(HERE, "validation-summary.json"),
    JSON.stringify({ equations: summary, compileFailures: failures }, null, 2) + "\n",
    "utf8"
  );
  await writeFile(join(ROOT, "report.json"), JSON.stringify(aggregate, null, 2) + "\n", "utf8");

  /* ---- merge into validation.pdf ------------------------------------ */
  await run(
    "gs",
    [
      "-q", "-dNOPAUSE", "-dBATCH", "-sDEVICE=pdfwrite",
      "-sOutputFile=validation.pdf", "panels-real.pdf", "panels-baseline.pdf",
    ],
    HERE
  );

  const sumOf = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);
  const sumWhere = (m: Map<string, number>, suffix: string) =>
    [...m.entries()].filter(([k]) => k.endsWith(suffix)).reduce((a, [, v]) => a + v, 0);
  console.log(`validation: ${panels.length} equations compared`);
  console.log(
    `  exact stack   overfull boxes: A=${sumWhere(realOver, "-A")}  D=${sumWhere(realOver, "-D")}`
  );
  console.log(
    `  baseline      overfull boxes: A=${sumWhere(baseOver, "-A")}  B=${sumWhere(baseOver, "-B")}  ` +
      `C=${sumWhere(baseOver, "-C")}  D=${sumWhere(baseOver, "-D")}  (total ${sumOf(baseOver)})`
  );
  console.log(`  compile failures: ${failures.length === 0 ? "none" : failures.join(", ")}`);
  console.log(`  report.json written`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
