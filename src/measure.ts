/**
 * Real geometry from real TeX.
 *
 * Every fragment is typeset by the *user's own preamble* in a single XeLaTeX
 * run, so widths reflect the exact fonts, sizes, and packages of the target
 * document. Results are content-addressed and cached across runs.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { MeasureRequest, MeasureResult } from "./types.js";

export interface MeasureOptions {
  /** Verbatim preamble of the target document (everything before `\begin{document}`). */
  preamble: string;
  /** Directory to run TeX in; relative `\input`s of the document resolve here. */
  workDir: string;
  /** Cache directory. Defaults to `<workDir>/.math-layout-cache`. */
  cacheDir?: string;
  /** TeX engine. Defaults to `xelatex`. */
  engine?: string;
  timeoutMs?: number;
  /** Disable the on-disk cache. */
  noCache?: boolean;
}

const ID_RE = /MLWIDTH:([A-Za-z0-9_]+):([0-9.]+)pt/g;

/** Stable id for a fragment; also the cache key. */
export function fragmentId(tex: string): string {
  return createHash("sha1").update(tex).digest("hex").slice(0, 16);
}

function preambleHash(preamble: string): string {
  return createHash("sha1").update(preamble).digest("hex").slice(0, 16);
}

/** Fragments that would break the measurement document outright. */
function unusable(tex: string): boolean {
  return (
    tex.trim() === "" ||
    tex.includes("\\end{document}") ||
    tex.includes("$") ||
    tex.includes("\\typeout")
  );
}

interface CacheFile {
  [id: string]: number;
}

/**
 * Measure many math fragments in one XeLaTeX process.
 *
 * Returns a map from fragment id to width in pt. Fragments TeX could not
 * typeset are reported in `failures` and are absent from `widths`.
 */
export async function measureFragments(
  requests: MeasureRequest[],
  opts: MeasureOptions
): Promise<MeasureResult> {
  const started = Date.now();
  const engine = opts.engine ?? "xelatex";
  const cacheDir = opts.cacheDir ?? join(opts.workDir, ".math-layout-cache");
  const cacheFile = join(cacheDir, `widths-${preambleHash(opts.preamble)}.json`);

  const widths = new Map<string, number>();
  const failures: string[] = [];
  const pending: MeasureRequest[] = [];
  const seen = new Set<string>();

  let cache: CacheFile = {};
  if (!opts.noCache) {
    try {
      cache = JSON.parse(await readFile(cacheFile, "utf8")) as CacheFile;
    } catch {
      cache = {};
    }
  }

  for (const r of requests) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    if (unusable(r.tex)) {
      failures.push(r.id);
      continue;
    }
    const hit = cache[r.id];
    if (typeof hit === "number") {
      widths.set(r.id, hit);
    } else {
      pending.push(r);
    }
  }

  if (pending.length === 0) {
    return { widths, failures, elapsedMs: Date.now() - started, cached: true };
  }

  await mkdir(cacheDir, { recursive: true });
  const stem = `mlmeasure-${process.pid}-${Math.floor(Date.now() % 1e7)}`;
  const texPath = join(opts.workDir, `${stem}.tex`);
  const logPath = join(opts.workDir, `${stem}.log`);

  const lines: string[] = [];
  lines.push(opts.preamble.trimEnd());
  lines.push("\\begin{document}");
  lines.push("\\makeatletter");
  for (const r of pending) {
    lines.push(`\\setbox0=\\hbox{$\\displaystyle ${r.tex}$}\\typeout{MLWIDTH:${r.id}:\\the\\wd0}`);
  }
  lines.push("\\makeatother");
  lines.push("\\end{document}");
  await writeFile(texPath, lines.join("\n") + "\n", "utf8");

  let log = "";
  try {
    await run(engine, ["-interaction=nonstopmode", "-no-pdf", "-file-line-error", `${stem}.tex`], {
      cwd: opts.workDir,
      timeout: opts.timeoutMs ?? 180_000,
    });
  } catch (err) {
    // Non-zero exit is common (recoverable TeX errors); read whatever log we got.
    void err;
  }
  try {
    log = await readFile(logPath, "utf8");
  } catch {
    log = "";
  }

  const found = new Map<string, number>();
  ID_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ID_RE.exec(log)) !== null) {
    // `\typeout` echoes to both terminal and log; last write wins.
    found.set(m[1]!, Number(m[2]));
  }

  for (const r of pending) {
    const w = found.get(r.id);
    if (typeof w === "number" && Number.isFinite(w)) {
      widths.set(r.id, w);
      cache[r.id] = w;
    } else {
      failures.push(r.id);
    }
  }

  if (!opts.noCache && Object.keys(cache).length > 0) {
    await writeFile(cacheFile, JSON.stringify(cache, null, 0), "utf8");
  }
  await cleanupStem(opts.workDir, stem);

  return { widths, failures, elapsedMs: Date.now() - started, cached: false };
}

/** Measure the natural width of a single math fragment. */
export async function measureOne(
  tex: string,
  opts: MeasureOptions
): Promise<number | null> {
  const id = fragmentId(tex);
  const res = await measureFragments([{ id, tex }], opts);
  return res.widths.get(id) ?? null;
}

const LINEWIDTH_ID = "__linewidth__";

/**
 * Measure the document's `\linewidth` in pt using the real preamble.
 *
 * This is the only geometry that cannot come from an `\hbox`, so it gets its
 * own tiny run. The result is cached alongside fragment widths.
 */
export async function measureLinewidth(opts: MeasureOptions): Promise<number | null> {
  const engine = opts.engine ?? "xelatex";
  const cacheDir = opts.cacheDir ?? join(opts.workDir, ".math-layout-cache");
  const cacheFile = join(cacheDir, `widths-${preambleHash(opts.preamble)}.json`);

  let cache: CacheFile = {};
  if (!opts.noCache) {
    try {
      cache = JSON.parse(await readFile(cacheFile, "utf8")) as CacheFile;
    } catch {
      cache = {};
    }
    const hit = cache[LINEWIDTH_ID];
    if (typeof hit === "number") return hit;
  }

  await mkdir(cacheDir, { recursive: true });
  const stem = `mllinewidth-${process.pid}-${Math.floor(Date.now() % 1e7)}`;
  const texPath = join(opts.workDir, `${stem}.tex`);
  const logPath = join(opts.workDir, `${stem}.log`);
  const doc = [
    opts.preamble.trimEnd(),
    "\\begin{document}",
    `\\makeatletter\\typeout{MLWIDTH:${LINEWIDTH_ID}:\\the\\linewidth}\\makeatother`,
    "\\end{document}",
  ].join("\n");
  await writeFile(texPath, doc + "\n", "utf8");

  let log = "";
  try {
    await run(engine, ["-interaction=nonstopmode", "-no-pdf", `${stem}.tex`], {
      cwd: opts.workDir,
      timeout: opts.timeoutMs ?? 180_000,
    });
  } catch {
    /* recoverable */
  }
  try {
    log = await readFile(logPath, "utf8");
  } catch {
    log = "";
  }

  const re = new RegExp(`MLWIDTH:${LINEWIDTH_ID}:([0-9.]+)pt`);
  const m = re.exec(log);
  const value = m ? Number(m[1]) : null;
  if (value !== null && !opts.noCache) {
    cache[LINEWIDTH_ID] = value;
    await writeFile(cacheFile, JSON.stringify(cache, null, 0), "utf8");
  }
  await cleanupStem(opts.workDir, stem);
  return value;
}

function run(
  cmd: string,
  args: string[],
  opts: { cwd: string; timeout: number }
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    execFile(cmd, args, { cwd: opts.cwd, timeout: opts.timeout, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stdout, stderr }));
      else resolvePromise({ stdout, stderr });
    });
  });
}

/** Remove every auxiliary file TeX produced for `stem`. */
async function cleanupStem(dir: string, stem: string): Promise<void> {
  let entries: string[] = [];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.startsWith(`${stem}.`)) continue;
    try {
      await rm(join(dir, name), { force: true });
    } catch {
      /* best effort */
    }
  }
}

/** Resolve the directory TeX should run in for a given input file. */
export function workDirFor(inputFile: string): string {
  const abs = resolve(inputFile);
  const i = abs.lastIndexOf("/");
  return i > 0 ? abs.slice(0, i) : ".";
}
