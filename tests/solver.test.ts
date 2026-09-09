import { describe, expect, it } from "vitest";
import { blockSource, emitBody } from "../src/emit.js";
import { splitMathBody } from "../src/mathsplit.js";
import { choosePattern, col2Text, planEquation, solveEquation } from "../src/optimize.js";
import { DEFAULT_POLICY, breakCost, needsLayout, overflowCost, underfullCost } from "../src/policy.js";
import type { LayoutSolution } from "../src/types.js";

/**
 * A synthetic width table: every fragment costs `scale` pt per whitespace
 * separated word. Deterministic and independent of a TeX installation, which
 * keeps the solver tests fast; real geometry is covered by the integration
 * tests.
 */
class FakeWidths extends Map<string, number> {
  scale = 10;
  override get(key: string): number | undefined {
    const t = key.trim();
    if (t === "") return 0;
    return t.split(/\s+/).length * this.scale;
  }
}

function solve(body: string, linewidth = 100, widths: Map<string, number> = new FakeWidths()) {
  const split = splitMathBody(body);
  const plan = planEquation(split);
  return solveEquation(plan, widths, { policy: { ...DEFAULT_POLICY, linewidth, safetyMargin: 0 } });
}

describe("policy.ts", () => {
  it("treats overflow as far more expensive than extra lines", () => {
    expect(overflowCost(1, 100)).toBeGreaterThan(1000);
    expect(overflowCost(0, 100)).toBe(0);
  });

  it("grows monotonically with overflow", () => {
    expect(overflowCost(20, 100)).toBeGreaterThan(overflowCost(10, 100));
  });

  it("penalises empty lines and rewards full ones", () => {
    expect(underfullCost(0, 100, false)).toBeGreaterThan(underfullCost(90, 100, false));
    expect(underfullCost(90, 100, false)).toBeGreaterThan(0);
  });

  it("makes \\nobreak infeasible", () => {
    expect(breakCost(1, 0, "nobreak")).toBe(Number.POSITIVE_INFINITY);
    expect(breakCost(1, 0, "goodbreak")).toBeLessThan(breakCost(4, 0, "none"));
  });

  it("prefers a single line below the threshold", () => {
    expect(needsLayout(0.5 * 455, { ...DEFAULT_POLICY, linewidth: 455 })).toBe(false);
    expect(needsLayout(1.05 * 455, { ...DEFAULT_POLICY, linewidth: 455 })).toBe(true);
  });
});

describe("optimize.ts", () => {
  it("chooses the anchored continuation shape for a single relation", () => {
    const split = splitMathBody("a = b + c + d");
    expect(choosePattern(split, split.body)).toBe("continuation");
  });

  it("chooses the derivation shape for a relation chain", () => {
    const split = splitMathBody("a = b = c");
    expect(choosePattern(split, split.body)).toBe("derivation");
  });

  it("chooses the unanchored shape when there is no relation", () => {
    const split = splitMathBody("a + b + c");
    expect(choosePattern(split, split.body)).toBe("continuation-unanchored");
  });

  it("chooses the optimization shape for min/s.t.", () => {
    const split = splitMathBody(String.raw`\min_x f(x) \quad \text{s.t.} \quad g(x)\le 0`);
    expect(choosePattern(split, split.body)).toBe("optimization");
  });

  it("guards leading binary operators with an empty group", () => {
    const split = splitMathBody("a = b + c");
    expect(col2Text(split, "continuation", 2, 3, false)).toBe("\\quad {}+ c");
    expect(col2Text(split, "continuation", 1, 2, true)).toBe("= b");
  });

  it("does not guard leading relations", () => {
    const split = splitMathBody("a = b");
    expect(col2Text(split, "continuation", 1, 2, false)).toBe("\\quad = b");
  });

  it("breaks rather than overflow when a break exists", () => {
    const sol = solve("a = b + c + d + e + f + g + h + i + j", 40);
    expect(sol.overflowed).toBe(false);
    expect(sol.lines.length).toBeGreaterThan(1);
  });

  it("balances lines rather than filling one and stubbing the rest", () => {
    const sol = solve("a = b + c + d + e + f + g + h", 45);
    const widths = sol.lines.map((l) => l.predicted);
    const spread = Math.max(...widths) - Math.min(...widths);
    expect(spread).toBeLessThan(30);
  });

  it("falls back to the unanchored shape when the LHS plus RHS cannot fit", () => {
    // `a_1 + a_2` is 30pt and `= b` is 20pt, so the anchored first line needs
    // 50pt; the measure is 40pt. Only the unanchored shape can fit.
    const sol = solve("a_1 + a_2 = b + c", 40);
    expect(sol.pattern).toBe("continuation-unanchored");
    expect(sol.overflowed).toBe(false);
  });

  it("reports overflow when nothing can fit", () => {
    const sol = solve("a = b", 1);
    expect(sol.overflowed).toBe(true);
  });
});

describe("emit.ts", () => {
  const sol = (body: string, lw = 40): LayoutSolution => solve(body, lw);

  it("emits a single line unchanged", () => {
    const s = solve("a = b", 1000);
    expect(emitBody(s).trim()).toBe("a = b");
  });

  it("emits an anchored aligned block", () => {
    const s = sol("a = b + c + d + e");
    const out = emitBody(s);
    expect(out).toContain("\\begin{aligned}");
    expect(out).toContain("\\end{aligned}");
    expect(out).toMatch(/&=/);
    expect(out).toContain("\\\\");
  });

  it("re-emits labels after the block", () => {
    const s = sol("a = b + c + d + e");
    const out = emitBody(s, { trailers: ["\\label{eq:x}"] });
    expect(out).toContain("\\label{eq:x}");
    expect(out.indexOf("\\end{aligned}")).toBeLessThan(out.indexOf("\\label{eq:x}"));
  });

  it("blockSource round-trips through measurement", () => {
    const s = sol("a = b + c + d + e");
    const src = blockSource(s);
    expect(src.startsWith("\\begin{aligned}")).toBe(true);
    expect(src.endsWith("\\end{aligned}")).toBe(true);
  });

  it("never emits forbidden shrink commands", () => {
    const out = emitBody(sol("a = b + c + d + e"));
    expect(out).not.toMatch(/\\resizebox|\\scalebox|\\tiny|\\scriptsize/);
  });
});
