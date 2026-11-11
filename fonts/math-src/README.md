# Building the substitute math fonts

`build-math-fonts.py` writes `../math/` (TTF + WOFF2 + `math-fonts.json`) from STIX Two Math and Adobe's Symbol.afm.

1. STIX Two Math 2.13 b171 (OFL 1.1) into `.cache/stix/` (not in git):
   `https://raw.githubusercontent.com/stipub/stixfonts/v2.13b171/fonts/static_ttf/STIXTwoMath-Regular.ttf` and
   `OFL.txt` of the same tag. Expected sha256 of the TTF starts with `49b22767`.
2. Python 3.11 venv with fontTools and brotli (not in git):
   `python -m venv .venv && .venv/Scripts/python -m pip install fonttools==4.68.0 brotli`
3. From the repository root: `npm run build:math-fonts`, or
   `.venv/Scripts/python.exe -I build-math-fonts.py --stix .cache/stix/STIXTwoMath-Regular.ttf --afm afm/Symbol.afm --out ../math`

The MT Extra code table and glyph boxes in the script were checked against the installed MT Extra and Symbol fonts
with a proof sheet (our glyph over the original at every code). Arrows, harpoons and horizontal brace pieces of
MT Extra are drawn as polygons; everything else is a scaled STIX glyph.

Encoding data: `encodings/design-science.json` holds the official Design Science tables for Euclid Math One
(`eumat1`), Euclid Math Two (`eumat2`), Euclid Fraktur (`eufrak`), MT Extra (`mtextra`) and Symbol (`symbol`): byte
code -> MathType code + description. The build resolves them to STIX glyphs (see the docstring of the script);
Wasm Math Symbol was checked against the table too (163 of 189 codes identical; the others are the bracket/extender
pieces whose private use codes we map to the Unicode pieces, plus `suchthat` and `lozenge`).
`node fonts/math-src/proof.cjs out.png [extra symbol blackboard script fraktur]` draws every glyph with the
description of the table for checking.
`emf-sample/` builds `samples/emf-math.docx`: a GDI EMF (ExtTextOutW with a dx array, like MathType) with text in
MT Extra, Symbol and the three Euclid fonts, wrapped in a minimal docx, for the preview/PDF check of EMF equations.
