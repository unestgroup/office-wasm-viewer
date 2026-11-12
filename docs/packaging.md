# Packaging

Three repositories, three kinds of package. Each is built by one command and can be deployed on its own.

| Repository | Command | Result | Licence of the result |
|---|---|---|---|
| `office-wasm-viewer` | `npm run pack` | layers (`core`, `editor`, `engine-*`) as directories and `.tar.gz`, plus the merged `site/` | AGPL-3.0-or-later (+ upstream AGPL, fonts under their own open licences) |
| `metafile-wasm` | `npm run pack` | `metafile-wasm-<v>.tgz` (npm layout) | AGPL-3.0-only |
| `office-wasm-sdk` | `npm run pack` | `office-wasm-sdk-<v>.tgz` (npm layout) | Apache-2.0 |

The SDK is the only package your application links against. It talks to the viewer over `postMessage`, so the viewer
package stays a separate program on its own origin (see the licence section of the SDK README).

## What to deploy for what

| Need | Packages |
|---|---|
| Preview / edit / PDF of docx, xlsx, pptx in a web app | viewer `core` + `editor` + one `engine-*` (normally `engine-st`), and the SDK in the app |
| Same, only Word documents | as above, packed with `--apps word` (editor 133 MB instead of 211 MB) |
| Show WMF/EMF/EMF+ pictures as SVG/PNG (no Office documents) | `metafile-wasm` only |
| Extract text from Office files in the browser or Node | SDK only (`office-wasm-sdk/extract`, pure JS) |
| Multi-threaded x2t | add `engine-mt`, serve with COOP/COEP (see the README); the single-threaded build is as fast for x2t 9.3.2 |

## Viewer: layers

Every layer holds its files at their final URL paths. Extract several archives into one directory and you have the site;
no two layers contain the same path. `site/` and `office-wasm-viewer-site-<v>.tar.gz` are the same thing already merged.

| Layer | Contains | Size (default options) |
|---|---|---|
| `core` | `index.html`, `viewer.mjs`, `x2t/` (client + worker), `fonts/` (math fonts, local-fonts, math-compat), `x2t-info.json`, `LICENSE`, `NOTICE.md` | 0.3 MB (0.2 MB gz) |
| `editor` | `oo/` sdkjs, web-apps, fonts, dictionaries; `fonts-manifest.json`; `oo/sdkjs/common/AllFonts.js` with the alias names baked in | 211 MB (74 MB gz) |
| `engine-st` | `wasm/st/` x2t.wasm single-threaded | 56 MB (19 MB gz) |
| `engine-mt` | `wasm/mt/` x2t.wasm with pthreads | 57 MB (19 MB gz) |
| `engine-prebuilt` | `wasm/prebuilt/` x2t.wasm from CryptPad | 43 MB (16 MB gz) |

Each layer also carries `_pack/<layer>/{manifest.json, SHA256SUMS, SOURCE.txt}`: file list with sizes and sha256, the licence of
the layer, where the source of exactly this version is, and what upstream it comes from.

What the tool does that `tools/serve.cjs` does at request time on the development server:

- bakes `oo/sdkjs/common/AllFonts.js` with the font aliases (Times New Roman → Tinos, ...) and writes a matching `.br` (a server that
  prefers `.br` would otherwise hand out the unaliased list);
- writes `fonts-manifest.json` (the font files of the pack) and `x2t-info.json` (`{coi, prebuilt, st, mt, apps}` from `--engines`/`--coi`/`--apps`);
- writes the source URL into the `office-wasm-viewer:source` meta tag of `index.html` (`--source-url`).

### Options

```
node tools/pack.mjs [--out dist] [--apps word,cell,slide] [--langs en] [--dicts en_US] [--engines st,mt,prebuilt]
                    [--coi] [--source-url <url>] [--keep-help] [--keep-extras] [--no-site] [--no-archive] [--allow-dirty]
node tools/pack.mjs --verify <dist/package dir | directory the layers were extracted into>
```

Trimming (all verified by serving the packed site and loading the sample documents, see "Checks"):

| Option | Effect | Default |
|---|---|---|
| `--apps` | `word` = documenteditor + sdkjs/word, `cell` = spreadsheeteditor + sdkjs/cell, `slide` = presentationeditor + sdkjs/slide. A document of a dropped kind does not open. | all |
| `--langs` | editor UI languages (`web-apps/apps/*/*/locale/<lang>.json`), `all` keeps every file | `en` |
| `--dicts` | spell-check/hyphenation dictionaries, `all` keeps every language | `en_US` |
| `--keep-help` | keep the offline help (480 MB; never requested by the viewer) | dropped |
| `--keep-extras` | keep sdkjs/visio, sdkjs/pdf, monaco, the forms apps (not used by the viewer) | dropped |
| `--engines` | which `engine-*` layers to build | all three |

Source maps are always left out. The `.br` siblings are kept (a host with precompressed support serves them; others ignore them).

### Release procedure

1. Commit everything (the tool refuses a dirty tree; `--allow-dirty` marks the package `-dirty`, for experiments only), tag the release.
2. `npm run font-pack:check` (the tool also refuses a font pack that still holds Arial/Calibri or lacks the local-fonts hook).
3. `npm run pack -- --source-url https://<where the tagged source is published>`.
4. `npm run pack:verify -- dist/office-wasm-viewer-<v>` (sha256 of every file against the lists).
5. Publish the archives and `SHA256SUMS`; deploy with the examples in `deploy/` (headers: `frame-ancestors`, optional COOP/COEP, `.wasm` type).

AGPL: users who reach the viewer over a network must be offered the source of the exact version. The URL goes into `index.html`
(meta tag, shown by the viewer's `ready` event) and into every `SOURCE.txt`. That includes your own changes to the files in the package.

### Deployment notes

- The viewer needs its own origin (host name), embedded in an `<iframe>`; the editor runs in a frame of the viewer page, so
  `frame-ancestors` must include `'self'` and your app's origin.
- If you deploy fewer engine layers than `x2t-info.json` lists, edit that small file (`{"coi": false, "prebuilt": false, "st": true, "mt": false}`).
- Version the directory (`/v0.1.0/`): every URL in the viewer is relative, and everything except `index.html` and `x2t-info.json` can be cached hard.
- Do not edit files under `site/`: they are hard links to the layer files, so a change shows up in both (and `--verify` reports it).

### Checks done on a packed site (12/11/2026)

Both are run from `office-wasm-sdk`, with the packed site served by `node tools/serve.cjs 8766 --site <dir>`:

- `node tools/trace-requests.cjs --viewer-url http://127.0.0.1:8766/ --baseline out/trace-source.json`: opens 6 documents (docx, xlsx, pptx, EMF math, Word and Vietnamese fonts) in embedded and edit mode, exports PDF, and compares every
  request with the same run on the unpacked source: the same 307 files, the same known 404s (upstream references the editor never needs), nothing new.
- `node demo/e2e.cjs --viewer-url http://127.0.0.1:8766/ --modes embedded,desktop,edit ...`: all PASS (open, PDF, text extraction, edit and save) except `emf-math.docx [edit]` ("marker not found", which fails the same way on the unpacked source),
  also from a directory that holds only `core` + `editor` + `engine-st` extracted from their archives, and from a `--apps word` pack for Word documents.

## Access control: only your applications load the viewer

Everything runs in the user's browser, so a file that the browser can load can also be downloaded; the aim is to stop other sites from
using *your* hosted copy, not to make the code secret. One site serves all three editors: a site per editor was tried and dropped, because the browser
fetches only the files of the editor in use (17–23 MB per session, cached afterwards), so splitting saves disk, not bandwidth. `--apps` remains as a trim for disk.

1. **Allowed domains** (`frame-ancestors`): browsers refuse to show the viewer inside any other page. The list is one small file:

   ```json
   { "frameAncestors": ["https://educora.vn", "https://*.educora.vn", "https://mschool.vn", "https://*.mschool.vn"] }
   ```

   `OFFICE_WASM_TOKEN_SECRET=... node tools/serve.cjs 8766 --site <dir> --config viewer.config.json` (example: `deploy/viewer.config.example.json`).
   - To change a domain, edit the file: the server re-reads it within 2 s, no restart, no repack. A file with an error is ignored and the old list stays (the log says why).
   - `https://*.educora.vn` matches every subdomain (also `a.b.educora.vn`) but **not `educora.vn` itself**: list both (the server warns when one is missing).
   - Accepted entries: `https://host`, `https://*.domain`, `https://host:port` (`:*` = any port); `http` only for `localhost` and `127.0.0.1`. Refused: `*`, `*.vn` (no registrable domain),
     paths, quotes, semicolons. `'self'` is added by the server (the editor runs in a frame of the viewer).
   - `node tools/serve.cjs --config viewer.config.json --print-headers` prints the resulting header. Other ways to give the list: env `OFFICE_WASM_FRAME_ANCESTORS` (comma separated)
     or `--frame-ancestors "<origins>"`; the config file wins.
   - Behind nginx/Caddy/Cloudflare Pages without `serve.cjs`, put the same list in the `Content-Security-Policy` line of `deploy/*.example` (one line to edit, then reload).
2. **Signed URLs** (optional, add `"tokenScope": "viewer"` to the config): the host application's server signs the viewer URL with a secret that only it and the viewer site know:
   `<site>/s/<expires>.<signature>/` where `signature = base64url(HMAC-SHA256(secret, scope + "\n" + expires))`, `expires` = unix seconds, `scope` = `tokenScope`.
   All URLs of the viewer are relative, so the prefix is carried by the page, the worker and the editor frame. A request without a valid, unexpired token gets 403.
   - Sign (Node, in your backend): `import { signViewerUrl } from 'office-wasm-sdk/server'; const url = signViewerUrl({ base: 'https://viewer.educora.vn', secret, ttlSeconds: 3600 });`
     and send `url` to the logged-in user's page: `OfficeViewer.create(box, { url })`.
   - The check is in `tools/serve.cjs` (plain Node, can sit behind nginx or Caddy as an upstream). The static examples in `deploy/` do not check tokens (an nginx/Caddy token check is not provided).
   - Keep the secret in the environment (`OFFICE_WASM_TOKEN_SECRET`, at least 16 characters), never in a page.
3. Keep the repositories and packages private (no public npm/GitHub), and keep the font pack to yourself (see NOTICE.md on the Vietnamese fonts).

What this does not do: a user with a valid token can save the files, and a copy of the AGPL parts that someone obtains legitimately can be run
anywhere. The AGPL source offer goes to the users of the service; with a gated viewer that means your users (the source URL can require a login).
Ask a lawyer before relying on this for anything beyond "do not host my copy".

Checked by `office-wasm-sdk/demo/e2e-access.cjs` (`npm run e2e:access`, 12/11 run: 23 of 23, on the source viewer and on a packed site with `--site`): 403 without token, with a wrong signature,
expired, for another scope or with another secret; 301 without the trailing slash; the header value; from Chromium, `app.localhost` and `a.b.localhost` embed the viewer under `http://*.localhost:PORT`
(docx opened in the editor, PDF exported) while bare `localhost`, `127.0.0.1` and a bad signature do not; editing the file adds `localhost` and `educora.vn`/`*.educora.vn` without a restart
and the new domain then works; four kinds of invalid file (bad JSON, `*.vn`, an injected `;`, `http://` on a public host) leave the old list in force; removing a domain stops it at once.

## metafile-wasm

`npm run pack -- --source-url <url>` writes `dist/metafile-wasm-<v>/metafile-wasm-<v>.tgz`, `SHA256SUMS`, `release.json`.
Install it (`npm install ./metafile-wasm-<v>.tgz`) or unpack it beside your app: `src/` and `artifacts/metafile-st/` keep the layout the client expects.
`fonts/math/` holds the five MathType substitute fonts (OFL, copied from the viewer repository; `--no-math-fonts` leaves them out).
`npm run pack:smoke -- dist/.../metafile-wasm-<v>.tgz` unpacks the archive into a temp directory, serves it and converts samples to SVG and PNG in Chromium.
3.4 MB archive, 6.8 MB unpacked. Needs no COOP/COEP.

## office-wasm-sdk

`npm run pack` → `dist/office-wasm-sdk-<v>.tgz` (12 files, 20 kB): `sdk/office-viewer.mjs` (`office-wasm-sdk`, `office-wasm-sdk/viewer`) and `src/extract` (`office-wasm-sdk/extract`).
`npm run pack:smoke -- dist/office-wasm-sdk-<v>.tgz` unpacks it, imports both entry points, checks that no AGPL header is inside and extracts text from a sample.
