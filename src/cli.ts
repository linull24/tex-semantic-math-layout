#!/usr/bin/env node
/**
 * math-layout — TeX in, TeX out.
 *
 *   math-layout input.tex -o output.tex
 *
 * Only display-equation *bodies* that actually overflow are rewritten, and
 * only into one of the canonical shapes in emit.ts. Everything else in the
 * document is byte-identical to the input.
 */

import { readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { processDocument } from "./index.js";
import { workDirFor } from "./measure.js";
import { DEFAULT_POLICY } from "./policy.js";

interface Options {
  input: string;
  output: string | null;
  reportPath: string | null;
  rewriteExisting: boolean;
  check: boolean;
  quiet: boolean;
  noCache: boolean;
  engine: string;
  linewidth: number | null;
  preambleFile: string | null;
  safetyMargin: number;
}

function parseArgs(argv: string[]): Options {
  const o: Options = {
    input: "",
    output: null,
    reportPath: null,
    rewriteExisting: false,
    check: false,
    quiet: false,
    noCache: false,
    engine: "xelatex",
    linewidth: null,
    preambleFile: null,
    safetyMargin: DEFAULT_POLICY.safetyMargin,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    switch (a) {
      case "-o":
      case "--output":
        o.output = argv[++i] ?? null;
        break;
      case "--report":
        o.reportPath = argv[++i] ?? null;
        break;
      case "--rewrite-existing":
        o.rewriteExisting = true;
        break;
      case "--check":
        o.check = true;
        break;
      case "-q":
      case "--quiet":
        o.quiet = true;
        break;
      case "--no-cache":
        o.noCache = true;
        break;
      case "--engine":
        o.engine = argv[++i] ?? "xelatex";
        break;
      case "--linewidth":
        o.linewidth = Number(argv[++i]);
        break;
      case "--preamble":
        o.preambleFile = argv[++i] ?? null;
        break;
      case "--safety-margin":
        o.safetyMargin = Number(argv[++i]);
        break;
      case "-h":
      case "--help":
        printHelp();
        process.exit(0);
        break;
      default:
        if (a.startsWith("-")) {
          console.error(`unknown option: ${a}`);
          process.exit(2);
        }
        o.input = a;
    }
  }
  return o;
}

function printHelp(): void {
  console.log(`math-layout — semantic line breaking for long display math

usage: math-layout input.tex -o output.tex [options]

options:
  -o, --output FILE        write result (default: stdout)
      --report FILE        write report.json
      --rewrite-existing   also reflow hand-written aligned/align bodies
      --check              do not write output; exit 1 if changes are needed
      --linewidth PT       override the measured \\linewidth
      --preamble FILE      use this preamble instead of the document's own
      --safety-margin PT   width safety margin (default 2.0)
      --engine NAME        TeX engine (default xelatex)
      --no-cache           bypass the width cache
  -q, --quiet              only print the report summary
`);
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.input) {
    printHelp();
    process.exit(2);
  }

  const src = await readFile(opts.input, "utf8");
  const preamble = opts.preambleFile ? await readFile(opts.preambleFile, "utf8") : undefined;

  const result = await processDocument(src, {
    workDir: workDirFor(resolve(opts.input)),
    preamble,
    rewriteExisting: opts.rewriteExisting,
    linewidth: opts.linewidth ?? undefined,
    safetyMargin: opts.safetyMargin,
    engine: opts.engine,
    noCache: opts.noCache,
  });

  if (opts.reportPath) {
    await writeFile(opts.reportPath, JSON.stringify(result.report, null, 2) + "\n", "utf8");
  }
  if (!opts.check) {
    if (opts.output) await writeFile(opts.output, result.output, "utf8");
    else process.stdout.write(result.output);
  }

  if (!opts.quiet) {
    const r = result.report;
    console.log(
      `math-layout: ${r.equations.length} equations, ${r.changed_equations} rewritten, ` +
        `${r.overflow_count} overflow, linewidth ${result.linewidth.toFixed(2)}pt`
    );
  }
  if (opts.check && result.report.changed_equations > 0) process.exit(1);
}

main().catch((err) => {
  console.error(`${basename(process.argv[1] ?? "math-layout")}: ${(err as Error).message}`);
  process.exit(1);
});
