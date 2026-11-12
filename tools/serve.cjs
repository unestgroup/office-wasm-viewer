// Static server for the office-wasm viewer. No dependencies.
// usage: node tools/serve.cjs [port] [--host 127.0.0.1] [--coi] [--no-font-aliases] [--config <file>] [--site <dir>]
//   port               default 8766
//   --config <file>    JSON {"frameAncestors": ["https://educora.vn", "https://*.educora.vn"], "tokenScope": "viewer"}: which pages may embed
//                      the viewer (and the token scope). Edit the file to change the domains: it is re-read within 2 s, no restart.
//                      See deploy/viewer.config.example.json and tools/access-policy.cjs for the rules ("*." excludes the bare domain).
//   --print-headers    print the Content-Security-Policy that results and exit (to check a config)
//   --token-scope <name>  only serve /s/<expires>.<signature>/... with a valid access token (secret in env OFFICE_WASM_TOKEN_SECRET)
//   --site <dir>       serve a packed site (dist/<package>/site from tools/pack.mjs) as plain files, like a static host
//   --coi              send COOP + COEP + CORP so the viewer is cross-origin isolated, also inside a frame of an
//                      isolated page (needed by the multi-threaded x2t build)
//   --no-font-aliases  serve sdkjs/common/AllFonts.js as shipped (default: with the names of fonts/font-aliases.cjs)
//   --frame-ancestors  origins allowed to embed the viewer, e.g. "https://app.example https://*.app.example" (same rules as the config;
//                      also env OFFICE_WASM_FRAME_ANCESTORS, comma separated; the config file wins). 'self' is always added
//                      (the editor runs in a frame of the viewer). Without any of them every page can embed the viewer.
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
const crypto = require('node:crypto');
const { addFontAliases } = require('../fonts/font-aliases.cjs');
const { parseOrigins, readConfig } = require('./access-policy.cjs');

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
const TOKEN_SECRET = process.env.OFFICE_WASM_TOKEN_SECRET || '';
const SITE = opt('site') ? path.resolve(opt('site')) : null; // a packed site (tools/pack.mjs): files as they are, nothing computed
const HOST = opt('host') || '127.0.0.1';
const VALUE_FLAGS = ['--host', '--frame-ancestors', '--config', '--site', '--token-scope'];
const port = Number(argv.find((a, i) => /^\d+$/.test(a) && !VALUE_FLAGS.includes(argv[i - 1])) || process.env.PORT || 8766);

// Access policy: which pages may embed the viewer (frame-ancestors) and the token scope. Sources, first one wins:
// the --config file, env OFFICE_WASM_FRAME_ANCESTORS, the --frame-ancestors flag. Entries are validated (tools/access-policy.cjs).
// The config file is watched: edit it and the new list is in force within about 2 s, no restart; a file with an error is ignored.
const CONFIG_FILE = opt('config') ? path.resolve(opt('config')) : null;
function loadPolicy() {
  const warnings = [];
  let frameAncestors = null;
  let tokenScope = opt('token-scope');
  if (CONFIG_FILE) {
    const c = readConfig(CONFIG_FILE);
    warnings.push(...c.warnings);
    frameAncestors = c.frameAncestors ?? null;
    tokenScope = c.tokenScope ?? tokenScope;
  }
  if (frameAncestors === null && process.env.OFFICE_WASM_FRAME_ANCESTORS) {
    const p = parseOrigins(process.env.OFFICE_WASM_FRAME_ANCESTORS.split(/[\s,]+/).filter(Boolean));
    frameAncestors = p.value;
    warnings.push(...p.warnings);
  }
  if (frameAncestors === null && opt('frame-ancestors')) {
    const p = parseOrigins(opt('frame-ancestors').split(/\s+/).filter((t) => t && t !== "'self'"));
    frameAncestors = p.value;
    warnings.push(...p.warnings);
  }
  if (tokenScope && TOKEN_SECRET.length < 16) throw new Error('a token scope needs the secret (at least 16 characters) in the environment variable OFFICE_WASM_TOKEN_SECRET');
  return { frameAncestors, tokenScope: tokenScope || null, warnings };
}

let TOKEN_SCOPE = null; // gate: only /s/<expires>.<signature>/... is served, see below
let BASE_HEADERS = {};
function applyPolicy(p) {
  TOKEN_SCOPE = p.tokenScope;
  BASE_HEADERS = {
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    ...(COI ? { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cross-Origin-Resource-Policy': 'cross-origin' } : {}),
    ...(TOKEN_SCOPE ? { 'Referrer-Policy': 'no-referrer' } : {}),
    ...(p.frameAncestors ? { 'Content-Security-Policy': 'frame-ancestors ' + p.frameAncestors } : {}),
  };
}
const describe = (p) => `frame-ancestors: ${p.frameAncestors || '(not set: any page can embed the viewer)'}; token gate: ${p.tokenScope ? 'scope ' + p.tokenScope : 'off'}`;
let initial;
try {
  initial = loadPolicy();
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
applyPolicy(initial);
if (argv.includes('--print-headers')) {
  console.log(initial.frameAncestors ? 'Content-Security-Policy: frame-ancestors ' + initial.frameAncestors : '(no Content-Security-Policy)');
  for (const w of initial.warnings) console.log('warning: ' + w);
  process.exit(0);
}

function resolve(urlPath) {
  if (SITE) {
    const file = path.resolve(SITE, '.' + (urlPath === '/' ? '/index.html' : urlPath));
    return file === SITE || file.startsWith(SITE + path.sep) ? file : null;
  }
  if (Object.hasOwn(FILES, urlPath)) return path.join(ROOT, FILES[urlPath]);
  for (const [prefix, dir] of MOUNTS) {
    if (!urlPath.startsWith(prefix)) continue;
    const file = path.resolve(dir, urlPath.slice(prefix.length) || 'index.html');
    if (file !== dir && !file.startsWith(dir + path.sep)) return null; // path traversal
    return file;
  }
  return null;
}

// Access token (so that only the apps you serve it to can load the viewer). The host application's server signs a URL:
//   <site>/s/<expires>.<signature>/    expires = unix seconds, signature = base64url(HMAC-SHA256(secret, scope + "\n" + expires))
// scope names this site (word, cell, ...: a token for one site is no good on another). All URLs of the viewer are relative, so
// the prefix is carried by every request (page, worker, editor frame). office-wasm-sdk has the signing function (sdk/sign.mjs).
function tokenOk(expires, signature) {
  if (Number(expires) < Date.now() / 1000) return false;
  const want = crypto.createHmac('sha256', TOKEN_SECRET).update(TOKEN_SCOPE + '\n' + expires).digest('base64url');
  const a = Buffer.from(want), b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
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
  if (TOKEN_SCOPE) {
    const m = /^\/s\/(\d{1,12})\.([A-Za-z0-9_-]{20,64})(\/.*)?$/.exec(urlPath);
    if (!m || !tokenOk(m[1], m[2])) {
      res.writeHead(403, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }).end('forbidden');
      return;
    }
    if (m[3] === undefined) { res.writeHead(301, { Location: urlPath + '/' }).end(); return; }
    urlPath = m[3];
  }
  if (urlPath === '/server-stats.json') return json(res, stats);
  if (!SITE && urlPath === '/fonts-manifest.json') {
    const dir = path.join(ART, 'onlyoffice-editor', 'fonts', 'fonts');
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /\.(ttf|otf|ttc)$/i.test(f)) : [];
    return json(res, { base: 'oo/fonts/fonts/', files });
  }
  if (!SITE && urlPath === '/x2t-info.json') return json(res, { coi: COI, prebuilt: hasBuild('x2t'), st: hasBuild('x2t-st'), mt: hasBuild('x2t-mt') });
  const br = /\bbr\b/.test(req.headers['accept-encoding'] || '');
  if (!SITE && urlPath === ALL_FONTS_URL && !NO_FONT_ALIASES) {
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

server.listen(port, HOST, () => {
  console.log(`viewer server: http://${HOST}:${port}/` + (COI ? ' (cross-origin isolated)' : ''));
  console.log(describe(initial));
  for (const w of initial.warnings) console.log('warning: ' + w);
  if (CONFIG_FILE) {
    let last = describe(initial);
    fs.watchFile(CONFIG_FILE, { interval: 2000, persistent: false }, () => {
      try {
        const p = loadPolicy();
        const now = describe(p);
        if (now === last) return;
        applyPolicy(p);
        last = now;
        console.log('policy reloaded: ' + now);
        for (const w of p.warnings) console.log('warning: ' + w);
      } catch (e) {
        console.log('policy NOT reloaded, the previous one stays in force: ' + e.message);
      }
    });
  }
});
