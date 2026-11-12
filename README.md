# office-wasm viewer

Offline preview and conversion of Office documents (.docx, .xlsx, .pptx and the older/ODF formats) entirely in the
browser: no document server, no network access after the page has loaded.

- **Preview**: file → `x2t.wasm` (in a Web Worker) → `Editor.bin` → the ONLYOFFICE/Euro-Office `sdkjs` + `web-apps`
  viewer (CryptPad build), fed by a mock co-authoring server.
- **PDF**: `sdkjs` lays the document out and emits a `pdf.bin` drawing stream → `x2t.wasm` writes the PDF.
- **Other conversions** without layout (`.txt`, `.csv`, `.odt`, ...) directly with `x2t.wasm`.
- **MathType equations** (WMF, EMF, EMF+ and EMZ pictures) are drawn with open substitute fonts for MT Extra / Symbol / Euclid Math Two,
  in the preview and in the PDF (`fonts/math-compat.mjs`, `fonts/math/`).

Licence: **AGPL-3.0-or-later** (see `LICENSE`, `NOTICE.md`). The viewer is meant to be embedded in an `<iframe>`
and driven with `postMessage`; the host-side SDK (`sdk/office-viewer.mjs` in the repo office-wasm-sdk) contains none of
this code.

## Layout

| Path | What |
|---|---|
| `index.html`, `viewer.mjs` | the page to embed; `viewer.mjs` answers the messages below |
| `x2t/` | `X2tClient` (promise API), the worker, format ids |
| `fonts/font-aliases.cjs` | adds metric-compatible names to `sdkjs/common/AllFonts.js` (Times New Roman → Tinos, ...) |
| `tools/font-pack.cjs`, `fonts/font-pack.cjs`, `fonts/vn*/` | prepares the font pack after a build: removes Arial/Calibri, adds .VnTime/.VnTimeH (`--vn original\|open`), rewrites `AllFonts.js` (see NOTICE.md) |
| `x2t/prepare-package.mjs` | fixes a package before x2t: EMZ/WMZ pictures → EMF/WMF (x2t cannot read them); TCVN3 `U+00AD` → `U+F0AD` (the editor hides soft hyphens); `{restore: true}` undoes the second on save |
| `fonts/vn-src/patch-vn-originals.py` | makes `fonts/vn-orig/patched/` (U+F0AD alias + missing glyphs) from the untouched ABC files |
| `fonts/metric/`, `fonts/metric-src/` | open fonts with Word metrics (Georgia, Palatino, Century Gothic, Segoe UI, Cambria, Tahoma, ...) and the script that builds them |
| `fonts/local-fonts.mjs` | uses the fonts installed on the user's computer (`queryLocalFonts`) in the editor and in the PDF |
| `fonts/math-compat.mjs`, `fonts/math/` | substitute fonts for MathType equations; `fonts/math-src/` builds them |
| `build/x2t/` | builds `x2t.wasm` from source with Docker (`st` and `mt`), see `build/x2t/README.md` |
| `tools/serve.cjs` | static server for the viewer (dev and reference for the production headers) |
| `tools/x2t-smoke.cjs`, `tools/x2t-run.cjs` | x2t conversion matrix under Node |
| `artifacts/` (not in git) | CryptPad sdkjs/web-apps zip, prebuilt and self-built x2t |
| `upstream/` (not in git) | clone of cryptpad/onlyoffice-x2t-wasm used by the build |

## Serving

`node tools/serve.cjs [port] [--coi] [--config viewer.config.json]` serves the site below. The config file lists the pages that may embed the viewer
(`{"frameAncestors": ["https://educora.vn", "https://*.educora.vn"]}`, example in `deploy/viewer.config.example.json`); edit it to change the domains,
the server re-reads it within 2 s. `*.x` matches subdomains only, so list `x` too. `--print-headers` shows the resulting header.
Every URL used by the viewer is relative, so it can be deployed under any path of a static host.

```
/                 index.html, viewer.mjs        /x2t/          worker + client
/oo/              artifacts/onlyoffice-editor   /wasm/st/      artifacts/x2t-st   (single-threaded)
/wasm/mt/         artifacts/x2t-mt (threads)    /wasm/prebuilt/ artifacts/x2t
/fonts/math/      substitute math fonts         /x2t-info.json, /fonts-manifest.json
```

A static host has to provide `x2t-info.json` (`{"st": true, "mt": true, "prebuilt": false}`) and
`fonts-manifest.json` (`{"base": "oo/fonts/fonts/", "files": [...]}`) as files, and serve `AllFonts.js` with the
aliases applied (`node -e` with `fonts/font-aliases.cjs`).

Multi-threaded build: only used when the viewer page is cross-origin isolated. Serve it with
`Cross-Origin-Embedder-Policy: require-corp`, `Cross-Origin-Resource-Policy: cross-origin` (and
`Cross-Origin-Opener-Policy: same-origin` for direct use); the embedding page must itself be isolated and give the
frame `allow="cross-origin-isolated"`. Otherwise the single-threaded build is used (same speed for x2t 9.3.2).

The editor runs in a frame of the viewer page, so `frame-ancestors` must include `'self'` (the server adds it by itself).

## Messages

Host → viewer: `{target: 'office-wasm-viewer', id, method, params}`; answers
`{source: 'office-wasm-viewer', id, ok, result | error}`; events `{source, type: 'event', event, data}`.

| Method | Params | Result |
|---|---|---|
| `open` | `{name, data: ArrayBuffer, mode?: 'embedded'\|'desktop'\|'edit', timeoutMs?, localFonts?: {family, style?, data}[]}` | state when the document is shown |
| `fontNames` | `{data?}` | font names the open (or given) document uses |
| `exportPdf` | – | `{data: ArrayBuffer, pdfBinBytes, x2tMs, mathPictures, timings}` |
| `save` | `{to?: 'docx'\|'xlsx'\|'pptx'\|'out.docx'...}` (edit mode) | `{data: ArrayBuffer, name, x2tMs, timings}` |
| `convert` | `{to: 'out.txt'\|'out.csv'\|..., name?, data?}` | `{data: ArrayBuffer, convertMs, totalMs}` |
| `close`, `getState` | – | – / state |

Events: `ready {version, x2t, source}`, `phase {phase, error}`, `log`, `editorError`, `editorWarning`,
`pdf {name, data}` (the viewer's own print/download button), `modified {modified}` (edit mode: first change after open / after save).

Edit mode (`mode: 'edit'`): the full editor UI, editable, without a document server. A built-in single-user stand-in
grants every lock and acknowledges every change, so typing, formatting, tables etc. work; nothing is persisted until
`save` reads the document back from the editor (`asc_nativeGetFile`) and x2t writes the .docx/.xlsx/.pptx. Limits: no
co-authoring, comments, history or autosave; pictures inserted while editing are not written yet (pictures of the
opened file are); the PDF export of an edited document uses the pictures of the opened file only. Standalone
(`?mode=edit`) the page shows a Save button that downloads the file.

The viewer answers only its parent window, and only the origin given as `?host=<origin>` (the SDK sets it) or, without
it, the origin of the first request. Page parameters: `x2t=prebuilt|st|mt`, `threads=N`,
`mathFonts=embedded|installed-first|off`, `mode` (direct use).

## Fonts of the user's computer

The editor and the PDF writer never read system fonts (sdkjs draws text from the files of the font pack; x2t reads `/working/fonts`),
so Arial installed or not gives the same result. For fidelity with Word on Windows there are two layers:

1. **Pack** (always on): metric-compatible open fonts under the Word names (Arial -> Arimo, Calibri -> Carlito, Times New Roman -> Tinos,
   Georgia -> Gelasio, Cambria -> Caladea, Segoe UI -> WasmUI, ...), see `NOTICE.md` and `fonts/metric/SOURCE.md`.
2. **Local fonts** (opt in, Chromium only): the host calls `queryLocalFonts()` in a click handler (permission prompt), reads the fonts of
   the document (`fontNames`), and passes them in `open({localFonts})` (the SDK does this with `enableLocalFonts()` / `open({localFonts: true})`).
   The viewer adds them to the editor's font list through a hook on the last line of `AllFonts.js` (`font-pack.cjs` adds it) and to x2t's
   `/working/fonts`. The PDF then embeds the user's fonts: fonts with `fsType` "restricted" are shown but kept out of the PDF; `.ttc` is not
   supported; a font that lacks a Vietnamese letter is not used when the document has Vietnamese text (the editor cannot borrow glyphs from
   another font, it would draw boxes), the pack substitute stays.

Deploy list: add `fonts/local-fonts.mjs` and `fonts/metric/` (copied into the font pack by `tools/font-pack.cjs`); re-run
`node tools/font-pack.cjs` after each rebuild of the pack (restart `tools/serve.cjs`, which caches the font list).

## Packaging

`npm run pack -- --source-url <url>` builds the deployable packages: layers `core`, `editor`, `engine-st|mt|prebuilt` (directories and `.tar.gz`, each with manifest, SHA256SUMS, SOURCE.txt),
the merged `site/`, and example server headers in `deploy/`. Options trim the editor by app, language and dictionaries (`--apps word`, `--langs en,vi`, `--dicts en_US`).
`npm run pack:verify -- <dir>` checks the files against the sha256 lists; `node tools/serve.cjs --site <dir>` serves a packed site.
Who may use a hosted copy (allowed domains, signed URLs): `docs/packaging.md`, "Access control". Details, release procedure and checks: `docs/packaging.md`.

## AGPL obligations when you deploy it

Users who interact with the viewer over a network must be offered its complete corresponding source, including your
modifications (section 13). Put the URL of that source in the `office-wasm-viewer:source` meta tag of `index.html`;
the viewer reports it in its `ready` event so the host can show a "Source" link.
