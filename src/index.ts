/**
 * Public API: `processDocument` runs the whole pipeline on a TeX source string
 * and returns the rewritten source plus a full report. The CLI and the
 * validation harness are both thin wrappers around this.
 */

import { DEFAULT_PREAMBLE } from "./defaults.js";
import { blockSource, emitBody } from "./emit.js";
import { collectEquations, flattenStructured } from "./equations.js";
import { fragmentId, measureFragments, measureLinewidth } from "./measure.js";
import { splitMathBody } from "./mathsplit.js";
import { planOptimization, solveOptimization } from "./optimization.js";
import { detectOptimization, planEquation, solveEquation } from "./optimize.js";
import { DEFAULT_POLICY, needsLayout, type PolicyConfig } from "./policy.js";
import { splitDocument } from "./tex.js";
import type {
  EquationReport,
  EquationSite,
  LayoutSolution,
  MeasureRequest,
  Report,
} from "./types.js";

export * from "./types.js";
export { emitBody, blockSource } from "./emit.js";
export { splitMathBody } from "./mathsplit.js";
export { collectEquations } from "./equations.js";
export { measureFragments, measureLinewidth, fragmentId, workDirFor } from "./measure.js";
export { DEFAULT_PREAMBLE } from "./defaults.js";

export interface ProcessOptions {
  /** Directory TeX runs in; relative `\input`s of the document resolve here. */
  workDir: string;
  /** Override the document's own preamble (measurement only). */
  preamble?: string;
  /** Also reflow bodies that already contain `\\` or `&`. */
  rewriteExisting?: boolean;
  /** Override the measured `\linewidth`. */
  linewidth?: number;
  safetyMargin?: number;
  engine?: string;
  noCache?: boolean;
}

export interface ProcessedEquation {
  siteIndex: number;
  site: EquationSite;
  /** The body that was analysed (flattened, if the source was structured). */
  original: string;
  /** Replacement body, or null when the source is left untouched. */
  emitted: string | null;
  solution: LayoutSolution | null;
  report: EquationReport;
}

export interface Replacement {
  /** Source span replaced, in the *input* coordinate system. */
  start: number;
  end: number;
  text: string;
}

export interface ProcessResult {
  /** Rewritten document source. */
  output: string;
  report: Report;
  equations: ProcessedEquation[];
  /** Exactly the spans that were rewritten, for round-trip auditing. */
  replacements: Replacement[];
  linewidth: number;
  /** Fragments TeX could not typeset. */
  failures: number;
}

interface Planned {
  site: EquationSite;
  siteIndex: number;
  body: string;
  fragments: string[];
  plan: ReturnType<typeof planEquation> | null;
  optPlan: ReturnType<typeof planOptimization>;
  kind: "generic" | "optimization";
  naturalWidth: number;
}

function baseReport(index: number, kind: string, extra: Partial<EquationReport>): EquationReport {
  return {
    index,
    kind,
    pattern: "single-line",
    changed: false,
    overflow: false,
    lines: 1,
    breaks: 0,
    avgBreakDepth: 0,
    deepBreaks: 0,
    lineUtilization: [],
    ...extra,
  };
}

/** Run the full TeX-in / TeX-out pipeline. */
export async function processDocument(src: string, opts: ProcessOptions): Promise<ProcessResult> {
  const doc = splitDocument(src);

  let preamble = opts.preamble ?? doc.preamble;
  if (!/\\documentclass/.test(preamble)) preamble = DEFAULT_PREAMBLE;

  const measureOpts = {
    preamble,
    workDir: opts.workDir,
    engine: opts.engine ?? "xelatex",
    noCache: opts.noCache ?? false,
  };

  const linewidth = opts.linewidth ?? (await measureLinewidth(measureOpts)) ?? 455.24411;
  const cfg: PolicyConfig = {
    ...DEFAULT_POLICY,
    linewidth,
    safetyMargin: opts.safetyMargin ?? DEFAULT_POLICY.safetyMargin,
  };

  const sites = collectEquations(src, { rewriteExisting: opts.rewriteExisting ?? false });

  /* ---- pass A: natural width of every candidate body -------------- */
  const bodies: MeasureRequest[] = [];
  for (const site of sites) {
    if (site.skipped || !site.body.trim()) continue;
    const body = site.hasLineBreak ? flattenStructured(site.body) : site.body;
    bodies.push({ id: fragmentId(body), tex: body });
  }
  const passA = await measureFragments(bodies, measureOpts);

  const planned: Planned[] = [];
  const reports: Array<EquationReport | null> = new Array(sites.length).fill(null);
  const originals: string[] = new Array(sites.length).fill("");

  for (let idx = 0; idx < sites.length; idx++) {
    const site = sites[idx]!;
    const rawBody = site.hasLineBreak ? flattenStructured(site.body) : site.body;
    originals[idx] = rawBody;

    if (site.skipped || !rawBody.trim()) {
      reports[idx] = baseReport(idx, site.kind, {
        skipReason: site.ignored
          ? "directive"
          : site.hasLineBreak
            ? "already-structured"
            : "structured-env",
      });
      continue;
    }

    const naturalWidth = passA.widths.get(fragmentId(rawBody));
    if (naturalWidth === undefined) {
      reports[idx] = baseReport(idx, site.kind, { skipReason: "unmeasurable" });
      continue;
    }

    if (!needsLayout(naturalWidth, cfg)) {
      reports[idx] = baseReport(idx, site.kind, {
        skipReason: "fits",
        lineUtilization: [naturalWidth / linewidth],
      });
      continue;
    }

    const split = splitMathBody(rawBody);
    if (split.unsafe || split.candidates.length === 0) {
      reports[idx] = baseReport(idx, site.kind, {
        skipReason: split.unsafe ? "unsafe-body" : "no-breakpoints",
        overflow: naturalWidth + cfg.safetyMargin > linewidth,
        lineUtilization: [naturalWidth / linewidth],
      });
      continue;
    }

    const common = { site, siteIndex: idx, body: rawBody, naturalWidth };
    if (detectOptimization(rawBody)) {
      const optPlan = planOptimization(rawBody);
      if (optPlan) {
        planned.push({ ...common, fragments: optPlan.fragments, plan: null, optPlan, kind: "optimization" });
        continue;
      }
    }
    const plan = planEquation(split);
    planned.push({ ...common, fragments: plan.fragments, plan, optPlan: null, kind: "generic" });
  }

  /* ---- pass B: measure solver fragments ---------------------------- */
  const frags: MeasureRequest[] = [];
  for (const p of planned) for (const f of p.fragments) frags.push({ id: fragmentId(f), tex: f });
  const passB = await measureFragments(frags, measureOpts);
  const fragWidths = new Map<string, number>();
  for (const f of frags) {
    const v = passB.widths.get(f.id);
    if (typeof v === "number") fragWidths.set(f.tex, v);
  }

  /* ---- solve, verify against real TeX, re-solve on mismatch -------- */
  const solve = (p: Planned, shrink: number): LayoutSolution =>
    p.kind === "optimization"
      ? solveOptimization(p.optPlan!, fragWidths, { ...cfg, linewidth: cfg.linewidth - shrink })
      : solveEquation(p.plan!, fragWidths, { policy: cfg, shrink });

  let solutions = planned.map((p) => solve(p, 0));
  const shrink = new Map<number, number>();

  for (let round = 0; round < 3; round++) {
    const blocks: MeasureRequest[] = [];
    solutions.forEach((sol) => {
      if (sol.overflowed || sol.predictedWidth > linewidth) return;
      const s = blockSource(sol);
      blocks.push({ id: fragmentId(s), tex: s });
    });
    if (blocks.length === 0) break;
    const passC = await measureFragments(blocks, measureOpts);
    let again = false;
    solutions.forEach((sol) => {
      if (sol.overflowed) return;
      const w = passC.widths.get(fragmentId(blockSource(sol)));
      if (w === undefined) return;
      sol.measuredWidth = w;
      if (w > linewidth) again = true;
    });
    if (!again) break;
    // Tighten the budget by the real deficit and try again.
    solutions.forEach((sol, i) => {
      const w = sol.measuredWidth;
      if (w === undefined || w === null || w <= linewidth) return;
      shrink.set(i, (shrink.get(i) ?? 0) + (w - linewidth) + 0.5);
    });
    solutions = planned.map((p, i) => solve(p, shrink.get(i) ?? 0));
  }

  /* ---- emit + splice ---------------------------------------------- */
  const replacements: Array<{ start: number; end: number; text: string }> = [];
  const byIndex = new Map<number, ProcessedEquation>();

  solutions.forEach((sol, i) => {
    const p = planned[i]!;
    const changed = sol.pattern !== "single-line" && sol.lines.length > 1;
    const util =
      !changed && sol.lines.length === 1
        ? [p.naturalWidth / linewidth]
        : sol.lines.map((l) => (l.predicted - cfg.safetyMargin) / linewidth);
    const overflow = (sol.measuredWidth ?? sol.predictedWidth) + cfg.safetyMargin > linewidth;

    reports[p.siteIndex] = baseReport(p.siteIndex, p.site.kind, {
      pattern: sol.pattern,
      changed,
      overflow,
      lines: sol.lines.length,
      breaks: sol.breaks.length,
      avgBreakDepth: sol.avgBreakDepth,
      deepBreaks: sol.deepBreaks,
      lineUtilization: util,
    });

    const emitted = changed ? emitBody(sol, { trailers: p.site.trailers }) : null;
    byIndex.set(p.siteIndex, {
      siteIndex: p.siteIndex,
      site: p.site,
      original: p.body,
      emitted,
      solution: sol,
      report: reports[p.siteIndex]!,
    });
    if (emitted !== null) {
      replacements.push({ start: p.site.bodyStart, end: p.site.bodyEnd, text: emitted });
    }
  });

  // Every discovered equation, in document order.
  const equations: ProcessedEquation[] = sites.map((site, idx) =>
    byIndex.get(idx) ?? {
      siteIndex: idx,
      site,
      original: originals[idx] ?? site.body,
      emitted: null,
      solution: null,
      report: reports[idx]!,
    }
  );

  let output = src;
  for (const r of replacements.sort((a, b) => b.start - a.start)) {
    output = output.slice(0, r.start) + r.text + output.slice(r.end);
  }

  const finalReports = reports.filter((r): r is EquationReport => r !== null);
  const failures = passA.failures.length + passB.failures.length;
  return {
    output,
    report: buildReport(finalReports, failures),
    equations,
    replacements: [...replacements].sort((a, b) => a.start - b.start),
    linewidth,
    failures,
  };
}

/** Aggregate per-equation records into the reported metrics. */
export function buildReport(reports: EquationReport[], failures: number): Report {
  const changed = reports.filter((r) => r.changed);
  const allUtil = reports.flatMap((r) => r.lineUtilization);
  const breaks = reports.reduce((s, r) => s + r.breaks, 0);
  const depthSum = reports.reduce((s, r) => s + r.avgBreakDepth * r.breaks, 0);
  return {
    overflow_count: reports.filter((r) => r.overflow).length,
    changed_equations: changed.length,
    compile_failures: failures,
    average_lines: changed.length === 0 ? 0 : changed.reduce((s, r) => s + r.lines, 0) / changed.length,
    deep_break_count: reports.reduce((s, r) => s + r.deepBreaks, 0),
    roundtrip_failures: 0,
    max_line_utilization: allUtil.length ? Math.max(...allUtil) : 0,
    mean_line_utilization: allUtil.length ? allUtil.reduce((a, b) => a + b, 0) / allUtil.length : 0,
    min_line_utilization: allUtil.length ? Math.min(...allUtil) : 0,
    number_of_breaks: breaks,
    average_break_ast_depth: breaks === 0 ? 0 : depthSum / breaks,
    equations: reports,
  };
}
