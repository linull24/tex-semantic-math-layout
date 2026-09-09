/**
 * Round-trip safety on real documents (AMS testmath/amsldoc/subeqn/technote,
 * unicode-math symbol listings).
 *
 * The tool must never damage a document it cannot improve. For each corpus
 * file we assert that every byte difference between input and output lies
 * inside a display-equation body, and that compilation does not get worse.
 */

import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { collectEquations } from "../src/equations.js";
import { processDocument } from "../src/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const TMP = join(ROOT, ".tmp", "corpus");

function run(cmd: string, args: string[], cwd: string): Promise<number> {
  return new Promise((res) =>
    execFile(cmd, args, { cwd, maxBuffer: 128 * 1024 * 1024 }, (err) => res(err ? 1 : 0))
  );
}

/**
 * Exact round-trip audit: applying the reported replacements to the input must
 * reproduce the output byte-for-byte, and every replacement must sit inside a
 * display-equation body.
 */
function verifyReplacements(
  src: string,
  output: string,
  replacements: Array<{ start: number; end: number; text: string }>,
  bodySpans: Array<[number, number]>
): { ok: boolean; reason?: string } {
  for (const r of replacements) {
    const inside = bodySpans.some(([s, e]) => r.start >= s && r.end <= e);
    if (!inside) return { ok: false, reason: `replacement [${r.start},${r.end}) outside any equation body` };
  }
  let rebuilt = src;
  for (const r of [...replacements].sort((a, b) => b.start - a.start)) {
    rebuilt = rebuilt.slice(0, r.start) + r.text + rebuilt.slice(r.end);
  }
  return rebuilt === output ? { ok: true } : { ok: false, reason: "output != src with replacements applied" };
}

async function main(): Promise<void> {
  await rm(TMP, { recursive: true, force: true });
  await mkdir(TMP, { recursive: true });

  const dirs = ["amsmath", "unicode-math"];
  const files: string[] = [];
  for (const d of dirs) {
    for (const f of await readdir(join(ROOT, "corpus", d))) {
      if (/\.(tex|ltx)$/.test(f)) files.push(join(d, f));
    }
  }
  files.sort();

  let failures = 0;
  for (const rel of files) {
    const src = await readFile(join(ROOT, "corpus", rel), "utf8");
    const workDir = join(ROOT, "corpus", rel.split("/")[0]!);

    // Compile the original, for a baseline.
    const origName = `orig-${rel.replace(/[/]/g, "-")}`;
    await writeFile(join(TMP, origName), src, "utf8");
    const origCode = await run("xelatex", ["-interaction=nonstopmode", origName], TMP);

    const result = await processDocument(src, { workDir });
    const outName = `new-${rel.replace(/[/]/g, "-")}`;
    await writeFile(join(TMP, outName), result.output, "utf8");
    const newCode = await run("xelatex", ["-interaction=nonstopmode", outName], TMP);

    const sites = collectEquations(src, { rewriteExisting: false });
    const spans = sites.map((s) => [s.bodyStart, s.bodyEnd] as [number, number]);
    const check = verifyReplacements(src, result.output, result.replacements, spans);
    const ok = check.ok;

    const worse = origCode === 0 && newCode !== 0;
    const status = ok && !worse ? "ok" : "FAIL";
    if (status === "FAIL") failures++;
    console.log(
      `${status.padEnd(4)} ${rel.padEnd(34)} equations=${String(sites.length).padStart(4)} ` +
        `rewritten=${result.report.changed_equations} ` +
        `compiles=${origCode === 0 ? "yes" : "no"}->${newCode === 0 ? "yes" : "no"}` +
        (ok ? "" : `  ${check.reason}`) +
        (worse ? "  COMPILE REGRESSION" : "")
    );

    // Second pass: force the rewrite path by halving the measure. Real
    // documents rarely overflow, so this is what actually exercises
    // rewriting on a large, real corpus. Damage, not overflow, is the failure.
    if (sites.length > 0 && result.linewidth > 0) {
      const narrow = await processDocument(src, {
        workDir,
        linewidth: result.linewidth / 2,
      });
      const nName = `narrow-${rel.replace(/[/]/g, "-")}`;
      await writeFile(join(TMP, nName), narrow.output, "utf8");
      const nCode = await run("xelatex", ["-interaction=nonstopmode", nName], TMP);
      const nDiff = verifyReplacements(src, narrow.output, narrow.replacements, spans);
      const nWorse = origCode === 0 && nCode !== 0;
      const nStatus = nDiff.ok && !nWorse ? "ok" : "FAIL";
      if (nStatus === "FAIL") failures++;
      console.log(
        `${nStatus.padEnd(4)} ${rel.padEnd(34)} [half measure] rewritten=${narrow.report.changed_equations} ` +
          `overflow=${narrow.report.overflow_count} ` +
          `compiles=${origCode === 0 ? "yes" : "no"}->${nCode === 0 ? "yes" : "no"}` +
          (nDiff.ok ? "" : `  ${nDiff.reason}`) +
          (nWorse ? "  COMPILE REGRESSION" : "")
      );
    }
  }

  console.log(failures === 0 ? "\ncorpus round-trip clean" : `\n${failures} corpus failure(s)`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

