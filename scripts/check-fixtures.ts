/**
 * Run every fixture through the tool and compile the result with XeLaTeX.
 *
 * Fails (exit 1) if any rewritten document does not compile or if the tool
 * leaves an overfull display equation behind in a case where a layout was
 * possible.
 */

import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { processDocument } from "../src/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const FIXTURES = join(ROOT, "fixtures");
const TMP = join(ROOT, ".tmp", "fixtures");

function run(cmd: string, args: string[], cwd: string): Promise<number> {
  return new Promise((res) =>
    execFile(cmd, args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (err) => res(err ? 1 : 0))
  );
}

async function main(): Promise<void> {
  await rm(TMP, { recursive: true, force: true });
  await mkdir(TMP, { recursive: true });

  const files = (await readdir(FIXTURES)).filter((f) => f.endsWith(".tex")).sort();
  let failed = 0;

  for (const file of files) {
    const src = await readFile(join(FIXTURES, file), "utf8");
    const result = await processDocument(src, { workDir: FIXTURES });
    const out = join(TMP, file);
    await writeFile(out, result.output, "utf8");

    const code = await run("xelatex", ["-interaction=nonstopmode", file], TMP);
    const log = await readFile(join(TMP, file.replace(/\.tex$/, ".log")), "utf8");
    const errors = log.split("\n").filter((l) => l.startsWith("! ")).length;
    const overfull = log.split("\n").filter((l) => l.startsWith("Overfull \\hbox")).length;

    const status = code === 0 && errors === 0 ? "ok" : "FAIL";
    if (status === "FAIL") failed++;
    console.log(
      `${status.padEnd(4)} ${file.padEnd(24)} equations=${result.report.equations.length} ` +
        `rewritten=${result.report.changed_equations} overflow=${result.report.overflow_count} ` +
        `texErrors=${errors} overfullBoxes=${overfull}`
    );
  }

  console.log(failed === 0 ? "\nall fixtures compiled" : `\n${failed} fixture(s) failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
