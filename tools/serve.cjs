// Static server for the office-wasm viewer. No dependencies.
// usage: node tools/serve.cjs [port] [--host 127.0.0.1] [--coi] [--no-font-aliases] [--frame-ancestors "<origins>"]
//   port               default 8766
//   --coi              send COOP + COEP + CORP so the viewer is cross-origin isolated, also inside a frame of an
//                      isolated page (needed by the multi-threaded x2t build)
//   --no-font-aliases  serve sdkjs/common/AllFonts.js as shipped (default: with the names of fonts/font-aliases.cjs)
//   --frame-ancestors  value of the CSP frame-ancestors directive (which pages may embed the viewer), e.g.
//                      "'self' https://app.example" ('self' is needed: the editor runs in a frame of the viewer); default: any
// Layout of the served site (all URLs used by the viewer are relative, so it can live under any path):
//   /                    index.html, viewer.mjs
//   /x2t/...             x2t/ (worker + client)
//   /fonts/math/...      fonts/math/ (substitute math fonts), /fonts/math-compat.mjs, /fonts/local-fonts.mjs
//   /oo/...              artifacts/onlyoffice-editor/  (sdkjs + web-apps + fonts, CryptPad build)
//   /wasm/prebuilt/...   artifacts/x2t/     (CryptPad's x2t.js + x2t.wasm)
//   /wasm/st/...         artifacts/x2t-st/  (our build, single-threaded)
//   /wasm/mt/...         artifacts/x2t-mt/  (our build, pthreads; only usable when cross-origin isolated)
//   /x2t-info.json       which builds exist and whether --coi is on
//   /fonts-manifest.json font files of the pack (loaded into x2t for PDF output)
//   /server-stats.json   request and byte counters (tests)
// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { addFontAliases } = require('../fonts/font-aliases.cjs');

const ROOT = path.resolve(__dirname, '..');
const ART = path.join(ROOT, 'artifacts');
const FILES = { '/': 'index.html', '/index.html': 'index.html', '/viewer.mjs': 'viewer.mjs', '/fonts/math-compat.mjs': 'fonts/math-compat.mjs', '/fonts/local-fonts.mjs': 'fonts/local-fonts.mjs', '/LICENSE': 'LICENSE', '/NOTICE.md': 'NOTICE.md' };
const MOUNTS = [
  ['/x2t/', path.join(ROOT, 'x2t')],
  ['/fonts/math/', path.join(ROOT, 'fonts', 'math')],
  ['/oo/', path.join(ART, 'onlyoffice-editor')],
  ['/wasm/prebuilt/', path.join(ART, 'x2t')],
  ['/wasm/st/', path.join(ART, 'x2t-st')],
  ['/wasm/mt/', path.join(ART, 'x2t-mt')],
];
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.md': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff': 'font/woff',
  '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml', '.map': 'application/json',
  '.bin': 'application/octet-stream', '': 'text/plain; charset=utf-8',
};

const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf('--' + name);
  return i < 0 ? null : argv[i + 1];
};
const COI = argv.includes('--coi');
const NO_FONT_ALIASES = argv.includes('--no-font-aliases');
const FRAME_ANCESTORS = opt('frame-ancestors');
const HOST = opt('host') || '127.0.0.1';
const port = Number(argv.find((a, i) => /^\d+$/.test(a) && !['--host', '--frame-ancestors'].includes(argv[i - 1])) || process.env.PORT || 8766);

const BASE_HEADERS = {
  'Cache-Control': 'no-cache',
  'X-Content-Type-Options': 'nosniff',
  ...(COI ? { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cross-Origin-Resource-Policy': 'cross-origin' } : {}),
  ...(FRAME_ANCESTORS ? { 'Content-Security-Policy': 'frame-ancestors ' + FRAME_ANCESTORS } : {}),
};

function resolve(urlPath) {
  if (Object.hasOwn(FILES, urlPath)) return path.join(ROOT, FILES[urlPath]);
  for (const [prefix, dir] of MOUNTS) {
    if (!urlPath.startsWith(prefix)) continue;
    const file = path.resolve(dir, urlPath.slice(prefix.length) || 'index.html');
    if (file !== dir && !file.startsWith(dir + path.sep)) return null; // path traversal
    return file;
  }
  return null;
}

const hasBuild = (dir) => fs.existsSync(path.join(ART, dir, 'x2t.wasm'));
const stats = { requests: 0, bytes: 0 };
const ALL_FONTS_URL = '/oo/sdkjs/common/AllFonts.js';
let allFonts = null;
let allFontsBr = null;

function json(res, body) {
  res.writeHead(200, { ...BASE_HEADERS, 'Content-Type': TYPES['.json'] }).end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  if (urlPath === '/fonts-manifest.json') {
    const dir = path.join(ART, 'onlyoffice-editor', 'fonts', 'fonts');
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /\.(ttf|otf|ttc)$/i.test(f)) : [];
    return json(res, { base: 'oo/fonts/fonts/', files });
  }
  if (urlPath === '/x2t-info.json') return json(res, { coi: COI, prebuilt: hasBuild('x2t'), st: hasBuild('x2t-st'), mt: hasBuild('x2t-mt') });
  if (urlPath === '/server-stats.json') return json(res, stats);
  const br = /\bbr\b/.test(req.headers['accept-encoding'] || '');
  if (urlPath === ALL_FONTS_URL && !NO_FONT_ALIASES) {
    // the font list of sdkjs with our alias names (Times New Roman -> Tinos, ...), see fonts/font-aliases.cjs
    try {
      allFonts ??= Buffer.from(addFontAliases(fs.readFileSync(resolve(ALL_FONTS_URL), 'utf8')));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain' }).end(String(e.message));
      return;
    }
    const body = br ? (allFontsBr ??= zlib.brotliCompressSync(allFonts)) : allFonts;
    stats.requests++;
    stats.bytes += body.length;
    res.writeHead(200, {
      ...BASE_HEADERS, 'Content-Type': TYPES['.js'], Vary: 'Accept-Encoding', 'Content-Length': body.length, ...(br ? { 'Content-Encoding': 'br' } : {}),
    });
    res.end(req.method === 'HEAD' ? undefined : body);
    return;
  }
  if (urlPath.endsWith('/') && urlPath !== '/') urlPath += 'index.html';
  let file = resolve(urlPath);
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { ...BASE_HEADERS, 'Content-Type': 'text/plain' }).end('not found: ' + urlPath);
    return;
  }
  const headers = { ...BASE_HEADERS, 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream' };
  // The CryptPad zip ships precompressed .br siblings (and our builds write them): use them when accepted.
  if (br && fs.existsSync(file + '.br')) {
    file += '.br';
    headers['Content-Encoding'] = 'br';
    headers.Vary = 'Accept-Encoding';
  }
  const size = fs.statSync(file).size;
  headers['Content-Length'] = size;
  stats.requests++;
  stats.bytes += size;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') res.end();
  else fs.createReadStream(file).pipe(res);
});

server.listen(port, HOST, () => console.log(`viewer server: http://${HOST}:${port}/` + (COI ? ' (cross-origin isolated)' : '')));
