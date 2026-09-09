/**
 * Fallback preamble used when the input file is a bare math fragment.
 *
 * This is the reference stack the prototype is validated against:
 * ctexart + Termes OTF + Libertinus integral overlay + zhlineskip.
 * When the input *does* contain a preamble, that preamble is always used
 * verbatim instead — the tool never changes the user's font stack.
 */
export const DEFAULT_PREAMBLE = String.raw`\documentclass[
  11pt,
  a4paper,
  scheme=plain,
  fontset=fandol,
  no-math
]{ctexart}

\usepackage[margin=25mm]{geometry}
\usepackage{mathtools}
\usepackage{eqnlines}
\usepackage[libertinus]{termes-otf}
\usepackage[restoremathleading=true]{zhlineskip}

\AtBeginDocument{
  \fontsize{11pt}{14.5pt}\selectfont
}
`;
