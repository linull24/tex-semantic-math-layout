# Corpus

Real documents used by `scripts/check-corpus.ts` to prove that the tool never
damages a document it cannot improve.

| File | Source | Licence |
| --- | --- | --- |
| `amsmath/testmath.tex` | AMS, *Sample Paper for the amsmath Package* | LPPL 1.3 |
| `amsmath/amsldoc.tex` | AMS, *User's Guide for the amsmath Package* (source) | LPPL 1.3 |
| `amsmath/subeqn.tex` | AMS, subequations example | LPPL 1.3 |
| `amsmath/technote.tex` | AMS, amsmath technical notes | LPPL 1.3 |
| `unicode-math/unimath-symbols.ltx` | unicode-math symbol listing | LPPL 1.3 |
| `unicode-math/unimath-example.ltx` | unicode-math example | LPPL 1.3 |

All files are unmodified copies from TeX Live 2026
(`texmf-dist/doc/latex/{amsmath,unicode-math}`). They are redistributed here
under the LaTeX Project Public License, which permits verbatim distribution;
they are test inputs only and are not part of the `math-layout` tool.

`unimath-symbols.ltx` is an `\input` fragment and does not compile standalone;
the checker records that as its baseline rather than treating it as a failure.
