# math-layout

**TeX in, TeX out.** Automatic line breaking for long display equations that
produces ordinary, readable, editable LaTeX — no runtime, no custom renderer,
no special PDF backend. The output compiles with plain XeLaTeX.

```bash
math-layout input.tex -o output.tex
```

```latex
\begin{equation}
  \begin{aligned}
    \mathcal{L}(\theta) &= \frac{1}{2}\log\left(2\pi\sigma^2\right) + \frac{1}{2\sigma^2}\sum_{i=1}^{n}\left(y_i - f_\theta(x_i)\right)^2 + \frac{1}{2}\log\left|\Sigma_\theta\right| \\
    &\quad {}+ \frac{d}{2}\log(2\pi) + \lambda \sum_{j=1}^{p}\left|\theta_j\right| + \frac{n}{2}\log\left(\frac{1}{n}\sum_{i=1}^{n}\left(y_i - \hat{y}_i\right)^2\right)
  \end{aligned}
  \label{eq:mdl}
\end{equation}
```

It is a small, deterministic prototype answering one question: **can expression
structure + real TeX geometry + a W3C-MathML-style best-fit search produce more
natural long-formula breaks than `breqn`, while staying inside a normal
XeLaTeX toolchain?** The evidence is in [`validation/validation.pdf`](validation/validation.pdf).

---

## What it does, and what it refuses to do

It rewrites **only** display-equation bodies that actually overflow the
measure. Everything else — prose, comments, macros, preamble, labels,
numbering, short equations, hand-written `aligned`/`align`/`cases`/`matrix` —
is left **byte-identical**.

It never emits `\resizebox`, `\scalebox`, `\tiny`, or `\scriptsize` to hide a
layout failure. If it cannot fit an equation it says so in `report.json`
instead of shrinking it.

---

## Quick start

Requirements: **Node ≥ 22.6**, **TeX Live with XeLaTeX**, and the packages your
own document already uses (`math-layout` loads your preamble verbatim, it does
not add any package to it).

```bash
npm ci
npm run build
node dist/cli.js paper.tex -o paper.out.tex --report report.json
```

During development, `npx tsx src/cli.ts ...` runs the TypeScript directly.

### Options

| Flag | Meaning |
| --- | --- |
| `-o, --output FILE` | write the result (default: stdout) |
| `--report FILE` | write `report.json` |
| `--rewrite-existing` | also reflow bodies that already contain `\\`/`&` |
| `--check` | write nothing; exit 1 if any equation would change |
| `--linewidth PT` | override the measured `\linewidth` |
| `--preamble FILE` | measure against this preamble instead of the document's |
| `--safety-margin PT` | model error allowance (default 2.0) |
| `--no-cache` | bypass the width cache |

### Source directives

```latex
% math-layout: off      ... % math-layout: on     % disable a region
% math-layout: ignore                              % skip the next equation
```

`\nobreak` before an operator forbids a break there; `\goodbreak`/`\allowbreak`
and `\badbreak` bias it. These are standard TeX, so no preamble change is
needed.

---

## Output patterns

Only five canonical shapes are ever produced.

| Pattern | Shape |
| --- | --- |
| `single-line` | body untouched |
| `continuation` | `aligned`, anchored at the first relation: `LHS &= RHS` / `&\quad {}+ …` |
| `continuation-unanchored` | `aligned`, no anchor: `& LHS` / `&\quad {} = …` |
| `derivation` | `aligned`, relation-led chain: `A &= B` / `&= C` / `&\le D` |
| `optimization` | `aligned` with `\min_x\quad & f(x)` / `\text{s.t.}\quad & g(x)` |

For every anchored equation the solver **solves both `continuation` and
`continuation-unanchored` and keeps the cheaper feasible one**. That is what
rescues equations whose left-hand side plus the first RHS fragment cannot fit
on one line at all — the relation simply leads the second line.

---

## How it works

```
input.tex
  ├─ tex.ts         byte-level document scan (comment aware, no re-printing)
  ├─ equations.ts   locate display equations; directives; label/tag recovery
  ├─ mathsplit.ts   unified-latex AST → Pieces + break candidates + depth
  ├─ measure.ts     ONE XeLaTeX run measures every candidate fragment
  ├─ policy.ts      W3C-style cost model
  ├─ optimize.ts    shortest-path (DP) over break candidates
  ├─ emit.ts        canonical LaTeX
  └─ splice         only equation bodies are replaced, byte-exact elsewhere
```

`unified-latex` does the LaTeX parsing. `mathsplit.ts` builds the *math*
structure on top of it — operator classes, nesting depth, protected spans — and
records source offsets so every fragment is lifted **verbatim** from the
original source. The tool never re-prints the document.

### Real geometry

Every candidate fragment is typeset by **your own preamble** in a single
XeLaTeX process:

```latex
\setbox0=\hbox{$\displaystyle <fragment>$}\typeout{MLWIDTH:<id>:\the\wd0}
```

One process per document, not one per break. Results are content-addressed and
cached in `.math-layout-cache/`.

The composition model was calibrated empirically against the target stack
(`ctexart` + Termes OTF + Libertinus integral overlay + `zhlineskip` +
`eqnlines`, 11pt, 25mm margins, `\linewidth = 455.24411pt`):

```
block width = max_i w(col1_i) + max_j w("{}" + col2_j)
```

The `{}` is not decorative: amsmath's align preamble prepends an empty group to
column 2, which restores the spacing of a leading operator. Measured on four
independent cases, the model matched the rendered block width to five decimal
places (e.g. predicted `64.84864pt` vs actual `64.84863pt` overfull), and it is
identical for `aligned` and top-level `align`.

Because column 1 is non-empty only on the first line, "block fits" is
equivalent to "every line fits", so per-line overflow penalties give an exact
objective — which is what makes a plain shortest-path DP correct here.

**Model for search, real TeX for verification.** After solving, the emitted
block itself is measured; if it overflows, the budget is tightened by the real
deficit and the equation is re-solved (up to 3 rounds). The model never has to
be perfect.

### Layout policy

Cost per line: overflow (huge, quadratic in pt), unused width (medium,
quadratic so lines balance), plus a fixed per-line cost. Cost per break:
priority class, AST depth, and explicit hints.

Priority ladder, best first:

```
= ≤ ≥ ⇒ ⇔        (relations)          priority 1
top-level + -                         priority 2
top-level × ·                         priority 3
other operators                       priority 4
implicit multiplication (juxtaposition)  priority 5 — last resort only
```

Never broken inside: `\frac{…}{…}`, `\sqrt{…}`, `\log(…)`, `\exp(…)`, `f(…)`,
`\operatorname{…}(…)`, and `\left…\right`. Those interiors are not even
candidates. A break inside plain parentheses *is* available and carries the
depth penalty, which is what lets a single over-wide parenthesised expression
be laid out instead of reported as overflow.

A single line is kept when its natural width is under the measure; the solver
only runs on overflow.

---

## Validation

`npm run validate` produces [`validation/validation.pdf`](validation/validation.pdf)
and `report.json`. Every fixture equation is shown four ways, labelled:

| Panel | Variant |
| --- | --- |
| A | the original single-line source |
| B | amsmath `autobreak` |
| C | `breqn` `dmath` |
| D | this tool |

16 difficult equations (Kalman/state-space, KKT, network flow, Nash/minimax,
Lyapunov, Koopman/DMD, ESR/MDL, residual-XGB, diffusion, Bayes, matrix/
nullspace, pathological), measured by counting `Overfull \hbox` in the real
compile logs, attributed per panel:

| | A original | B autobreak | C breqn | D math-layout |
| --- | --- | --- | --- | --- |
| overfull panels | 14 | 11 | 0 | **0** |

`report.json` (all 12 fixtures, 31 equations):

```json
{
  "overflow_count": 0,
  "changed_equations": 15,
  "compile_failures": 0,
  "average_lines": 2.07,
  "deep_break_count": 1,
  "roundtrip_failures": 0,
  "max_line_utilization": 0.975,
  "mean_line_utilization": 0.607,
  "min_line_utilization": 0.113,
  "number_of_breaks": 16,
  "average_break_ast_depth": 0.0625
}
```

Reading: no equation it rewrote overflows; rewritten equations average 2.07
lines (not 3–5 stubs); 15 of 16 breaks sit at the equation's top level
(average break depth 0.06), i.e. syntactic constituents are not shredded;
`min_line_utilization` belongs to an untouched short equation.

### Round-trip safety on real documents

`npm run check:corpus` runs the tool over the AMS documentation sources
(`testmath.tex`, `amsldoc.tex`, `subeqn.tex`, `technote.tex`) and the
unicode-math symbol listings, then asserts that **every byte difference lies
inside a display-equation body** and that compilation does not regress. Because
real documents rarely overflow, it also re-runs each one at half measure to
force the rewrite path:

```
ok   amsmath/testmath.tex     equations= 179 rewritten=  0 compiles=yes->yes
ok   amsmath/testmath.tex     [half measure] rewritten= 37 compiles=yes->yes
ok   amsmath/amsldoc.tex      equations=  67 rewritten=  0 compiles=yes->yes
ok   amsmath/amsldoc.tex      [half measure] rewritten=  7 compiles=yes->yes
...
corpus round-trip clean
```

---

## Reproducing from scratch

```bash
npm ci
npm run gate            # lint + typecheck + tests
npm run check:fixtures  # every fixture through the tool, then XeLaTeX
npm run check:corpus    # round-trip safety on real documents
npm run validate        # validation.pdf + report.json
```

All four must be green. The first `validate` run takes a few minutes (XeLaTeX);
later runs reuse the width cache.

---

## Known limitations

1. **Deep breaks are limited.** Breaks inside `\frac`, function arguments, and
   `\left…\right` are forbidden by design (per the layout policy), so an
   equation whose *only* break opportunities are inside those constructs is
   reported as overflow rather than laid out. Plain parentheses can be broken
   (depth 1), which covers the common case.
2. **One measure per document.** The solver uses the document-level
   `\linewidth`. An equation inside a list or a `minipage` with a narrower
   measure is laid out for the outer width; pass `--linewidth` to override.
3. **The baselines cannot use the exact font stack.** `breqn` does not work
   with unicode-math/OTF math at all, and `eqnlines` breaks `autobreak`. The
   A/B/C panels therefore use the same geometry and a Times-metric math font
   (`newtxmath`); panel D always uses your exact stack. This is a property of
   the baselines, not of this tool.
4. **No MathJax/SRE semantic tree.** Structure comes from `unified-latex` plus
   explicit operator tables. It was sufficient for every fixture; a semantic
   tree was not worth the dependency.
5. **Juxtaposition breaks are a last resort** and can look unnatural
   (`\sum … | \prod …`). They only appear when no real operator offers a
   feasible break.

## Design notes

- **Derivation shape uses `aligned`, not `align`.** The spec's shape is right,
  but emitting a top-level `align` turns one equation number into one per
  line. Preserving numbering was a hard requirement, so the shape is emitted
  as `aligned` inside the original environment. A top-level `align` is only
  emitted when the source already was one (`--rewrite-existing`).
- **`{}` before a leading binary operator.** `&\quad + D` renders `\quad+D`:
  TeX demotes a Bin atom that follows glue to Ord, dropping the binary
  spacing. Measured: `\quad + c` is 23.24pt, `\quad {}+ c` is 28.13pt. The
  empty group restores correct spacing, so continuation lines that start with
  `+`/`-`/`×` emit `&\quad {}+ D`.
- **`unified-latex` is used for parsing, not printing.** Fragments are spliced
  from the original source as exact substrings, so round-trip fidelity does not
  depend on a printer.

## Licence

MIT. Corpus files under `corpus/` are LPPL-licensed AMS/unicode-math sources —
see [`corpus/README.md`](corpus/README.md).
