// Packs the viewer site into layers that can be deployed together or one by one.
//
//   node tools/pack.mjs [--out dist] [--apps word,cell,slide] [--langs en] [--dicts en_US]
//                       [--engines st,mt,prebuilt] [--coi] [--source-url <url>] [--keep-help] [--keep-extras]
//                       [--no-site] [--no-archive] [--allow-dirty]
//
// Layers (every member sits at its final URL path under the web root, so extracting several layers into one directory
// gives the site; nothing overlaps):
//   core            index.html, viewer.mjs, x2t/ (client + worker), fonts/ (math fonts, local fonts), x2t-info.json, licences
//   editor          oo/  sdkjs + web-apps + fonts + dictionaries of the editor, trimmed; the font list with the alias names
//                   baked in (what tools/serve.cjs does per request) and fonts-manifest.json
//   engine-st       wasm/st/        x2t.wasm single-threaded (our build)
//   engine-mt       wasm/mt/        x2t.wasm with pthreads (only used when the page is cross-origin isolated)
//   engine-prebuilt wasm/prebuilt/  x2t.wasm of CryptPad
//   metafile        metafile/  metafile.wasm + JS from the sibling repository metafile-wasm (WMF/EMF -> PNG for metafile.html,
//                   which is in core); --metafile <dir> (default ../metafile-wasm), --metafile-source-url <url>, --no-metafile
// A deployment needs core + editor + at least one engine. x2t-info.json (in core) lists the engines that were packed:
// edit it when you deploy fewer.
//
// Output (dist/office-wasm-viewer-<version>[-dirty]/):
//   layers/<name>/            the layer as a directory, with _pack/<name>/{manifest.json,SHA256SUMS,SOURCE.txt}
//   <package>-<name>-<v>.tar.gz   one archive per layer (+ the composed site)
//   site/                     all layers merged (hard links): serve it as it is (node tools/serve.cjs --site)
//   deploy/                   example server configurations (headers)
//   release.json, SHA256SUMS  summary and checksums of the archives
//
// Trimming (the defaults keep what the viewer and the editor frame use; checked by office-wasm-sdk/tools/trace-requests.cjs):
//   --apps       editors to keep: word (documenteditor + sdkjs/word), cell, slide (default all three)
//   --langs      user interface languages (web-apps/apps/*/*/locale/<lang>.json) to keep, `all` for all (default en)
//   --dicts      spell check / hyphenation dictionaries to keep, `all` for all (default en_US)
//   --keep-help  keep the offline help (480 MB, never requested by the viewer)
//   --keep-extras keep sdkjs/visio, sdkjs/pdf, web-apps/vendor/monaco and the forms apps (not used by the viewer)
// Source maps are always left out.
//
// The viewer is AGPL-3.0-or-later: a deployment that users reach over a network has to offer them the source of this exact
// version (section 13). --source-url is written into index.html (meta office-wasm-viewer:source) and into SOURCE.txt;
// package from a tagged commit with a clean tree (--allow-dirty only for experiments).
// SPDX-License-Identifier: AGPL-3.0-or-later
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { addFontAliases } = require('../fonts/font-aliases.cjs');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ART = path.join(ROOT, 'artifacts');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i < 0 ? d : argv[i + 1]; };
const flag = (n) => argv.includes('--' + n);
const list = (s) => (s === 'all' ? 'all' : new Set(s.split(',').map((x) => x.trim()).filter(Boolean)));
const o = {
  out: path.resolve(ROOT, opt('out', 'dist')),
  apps: list(opt('apps', 'word,cell,slide')),
  langs: list(opt('langs', 'en')),
  dicts: list(opt('dicts', 'en_US')),
  engines: [...list(opt('engines', 'st,mt,prebuilt'))],
  coi: flag('coi'),
  sourceUrl: opt('source-url', ''),
  keepHelp: flag('keep-help'),
  keepExtras: flag('keep-extras'),
  site: !flag('no-site'),
  archive: !flag('no-archive'),
  allowDirty: flag('allow-dirty'),
  metafile: flag('no-metafile') ? null : path.resolve(ROOT, opt('metafile', process.env.METAFILE_WASM || '../metafile-wasm')),
  metafileSourceUrl: opt('metafile-source-url', ''),
};
if (flag('help') || flag('h')) { console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n')); process.exit(0); }

// --verify <package dir or layer dir>: recomputes the sha256 of every file listed in the SHA256SUMS files under it
if (flag('verify')) {
  const target = path.resolve(opt('verify', ''));
  if (!opt('verify') || !fs.existsSync(target)) { console.error('usage: node tools/pack.mjs --verify <dist/package dir | extracted site>'); process.exit(1); }
  let sums = [];
  const found = (function find(dir) { return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? find(path.join(dir, d.name)) : d.name === 'SHA256SUMS' ? [path.join(dir, d.name)] : [])); })(target);
  // list files of a layer relative to the directory that holds _pack/ ; archives relative to the package dir
  let bad = 0, n = 0;
  for (const f of found) {
    const base = f.split(path.sep).includes('_pack') ? path.resolve(f, '..', '..', '..') : path.dirname(f);
    for (const line of fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)) {
      const [hash, ...rest] = line.split('  ');
      const file = path.join(base, rest.join('  '));
      n++;
      if (!fs.existsSync(file) || crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== hash) { bad++; if (bad <= 20) console.error('MISMATCH ' + path.relative(target, file)); }
    }
    sums.push(f);
  }
  console.log(`${n} files in ${sums.length} checksum lists, ${bad} mismatch`);
  process.exit(bad || !n ? 1 : 0);
}

const APPS = { word: ['documenteditor', 'word'], cell: ['spreadsheeteditor', 'cell'], slide: ['presentationeditor', 'slide'] };
for (const a of o.apps === 'all' ? [] : o.apps) if (!APPS[a]) fail('unknown --apps value: ' + a + ' (word, cell, slide)');
const ENGINES = { st: ['x2t-st', 'wasm/st'], mt: ['x2t-mt', 'wasm/mt'], prebuilt: ['x2t', 'wasm/prebuilt'] };
for (const e of o.engines) if (!ENGINES[e]) fail('unknown --engines value: ' + e + ' (st, mt, prebuilt)');
if (!o.engines.length) fail('--engines is empty');

function fail(msg) { console.error('pack: ' + msg); process.exit(1); }
const sh = (cmd, args) => { const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : ''; };
const posix = (p) => p.split(path.sep).join('/');
const mb = (n) => (n / 1048576).toFixed(1) + ' MB';

// ---- version and source state -------------------------------------------------------------------------------------
const commit = sh('git', ['rev-parse', 'HEAD']);
const dirty = commit ? sh('git', ['status', '--porcelain', '--untracked-files=no']) !== '' : true;
if (dirty && !o.allowDirty) fail('the working tree has uncommitted changes (or this is not a git checkout): the source of the package would not be reproducible. Commit first, or use --allow-dirty for an experiment.');
const version = pkg.version + (dirty ? '-dirty' : '');
const NAME = 'office-wasm-viewer';
const outDir = path.join(o.out, `${NAME}-${version}`);
if (dirty) console.warn('warning: dirty tree, package is marked -dirty and must not be deployed to users');
if (!o.sourceUrl) console.warn('warning: no --source-url: SOURCE.txt and the source meta tag of index.html stay empty (AGPL section 13 needs a URL for network use)');

// ---- inputs -------------------------------------------------------------------------------------------------------
const editorDir = path.join(ART, 'onlyoffice-editor');
const allFontsFile = path.join(editorDir, 'sdkjs', 'common', 'AllFonts.js');
if (!fs.existsSync(allFontsFile)) fail('missing artifacts/onlyoffice-editor (download the CryptPad zip, see NOTICE.md), then npm run font-pack');
const allFontsSrc = fs.readFileSync(allFontsFile, 'utf8');
const packFonts = fs.existsSync(path.join(editorDir, 'fonts', 'fonts')) ? fs.readdirSync(path.join(editorDir, 'fonts', 'fonts')) : [];
if (!allFontsSrc.includes('office-wasm:local-fonts') || packFonts.some((f) => /^(arial|calibri)/i.test(f))) {
  fail('the font pack is not prepared: run npm run font-pack (removes Arial/Calibri, adds the local fonts hook) and npm run font-pack:check');
}
for (const e of o.engines) if (!fs.existsSync(path.join(ART, ENGINES[e][0], 'x2t.wasm'))) fail(`missing artifacts/${ENGINES[e][0]}/x2t.wasm (engine "${e}")`);

// ---- file helpers -------------------------------------------------------------------------------------------------
function* walk(dir, rel = '') {
  for (const d of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const r = rel ? rel + '/' + d.name : d.name;
    if (d.isDirectory()) yield* walk(path.join(dir, d.name), r);
    else if (d.isFile()) yield r;
  }
}

class Layer {
  constructor(name, desc) { this.name = name; this.desc = desc; this.dir = path.join(outDir, 'layers', name); this.files = new Map(); fs.mkdirSync(this.dir, { recursive: true }); }
  put(rel, data) { // data: Buffer | string
    const dst = path.join(this.dir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, data);
    this.files.set(rel, null);
  }
  copy(srcFile, rel) {
    const dst = path.join(this.dir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(srcFile, dst);
    this.files.set(rel, null);
  }
  copyTree(srcDir, prefix, keep = () => true) {
    for (const r of walk(srcDir)) if (keep(r)) this.copy(path.join(srcDir, r), (prefix + r).replace(/^\//, ''));
  }
  finish(extra) { // manifest, SHA256SUMS, SOURCE.txt (written last, listed in the manifest of nobody: they describe the rest)
    const meta = `_pack/${this.name}`;
    this.put(`${meta}/SOURCE.txt`, extra.source);
    const entries = [];
    let total = 0;
    for (const rel of [...this.files.keys()].sort()) {
      const buf = fs.readFileSync(path.join(this.dir, rel));
      total += buf.length;
      entries.push({ path: rel, size: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') });
    }
    this.put(`${meta}/SHA256SUMS`, entries.map((e) => `${e.sha256}  ${e.path}`).join('\n') + '\n');
    this.put(`${meta}/manifest.json`, JSON.stringify({
      layer: this.name, description: this.desc, package: NAME, version, license: extra.license, requires: extra.requires || [],
      source: { commit: commit || null, dirty, url: o.sourceUrl || null }, options: extra.options || {}, files: entries.length, bytes: total, entries,
    }, null, 1) + '\n');
    this.bytes = total;
    this.count = this.files.size;
  }
}

const brotli = (buf) => zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length } });
const sourceText = (what, lines) => [
  `${NAME} ${version} - layer "${what}"`,
  '',
  'This software is licensed under the GNU Affero General Public License (see LICENSE and NOTICE.md in the core layer).',
  'If users reach it over a network you must offer them the complete corresponding source of this exact version',
  '(AGPL-3.0 section 13), including your modifications.',
  '',
  `Source of this package: ${o.sourceUrl || '(not set: pack with --source-url <url>)'}`,
  `Commit: ${commit || '(unknown)'}${dirty ? '  (working tree had uncommitted changes)' : ''}`,
  `Packed with: node tools/pack.mjs ${argv.join(' ')}`.trim(),
  '',
  ...lines,
  '',
].join('\n');

// ---- editor filter ------------------------------------------------------------------------------------------------
const appSel = o.apps === 'all' ? Object.keys(APPS) : [...o.apps];
const keepDirs = new Set(appSel.map((a) => APPS[a][0]));
const keepSdk = new Set(appSel.map((a) => APPS[a][1]));
const allAppDirs = new Set(Object.values(APPS).map((v) => v[0]));
const allSdkDirs = new Set(Object.values(APPS).map((v) => v[1]));
function keepEditor(rel) {
  const s = rel.split('/');
  if (rel.endsWith('.map')) return false;
  if (!o.keepHelp && /^web-apps\/apps\/[^/]+\/main\/resources\/help\//.test(rel)) return false;
  if (s[0] === 'web-apps' && s[1] === 'apps' && allAppDirs.has(s[2]) && !keepDirs.has(s[2])) return false;
  if (s[0] === 'sdkjs' && allSdkDirs.has(s[1]) && !keepSdk.has(s[1])) return false;
  if (!o.keepExtras) {
    if (s[0] === 'sdkjs' && (s[1] === 'visio' || s[1] === 'pdf')) return false;
    if (s[0] === 'web-apps' && s[1] === 'vendor' && s[2] === 'monaco') return false;
    if (s[0] === 'web-apps' && s[1] === 'apps' && s[3] === 'forms') return false;
  }
  if (o.dicts !== 'all' && s[0] === 'dictionaries' && s.length > 2 && !o.dicts.has(s[1])) return false;
  const lang = /\/locale\/([^/]+?)\.json(?:\.br)?$/.exec(rel);
  if (o.langs !== 'all' && lang && !o.langs.has(lang[1])) return false;
  return true;
}

// ---- build --------------------------------------------------------------------------------------------------------
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
const layers = [];
const engineFor = Object.fromEntries(Object.keys(ENGINES).map((e) => [e, o.engines.includes(e)]));

// core
{
  const L = new Layer('core', 'viewer page, x2t client and worker, substitute math fonts, local fonts, licences');
  let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  if (o.sourceUrl) {
    const re = /(<meta name="office-wasm-viewer:source" content=")[^"]*(")/;
    if (!re.test(html)) fail('index.html has no office-wasm-viewer:source meta tag');
    html = html.replace(re, '$1' + o.sourceUrl.replace(/&/g, '&amp;').replace(/"/g, '&quot;') + '$2');
  }
  L.put('index.html', html);
  let mfHtml = fs.readFileSync(path.join(ROOT, 'metafile.html'), 'utf8');
  if (o.sourceUrl) mfHtml = mfHtml.replace(/(<meta name="office-wasm-viewer:source" content=")[^"]*(")/, '$1' + o.sourceUrl.replace(/&/g, '&amp;').replace(/"/g, '&quot;') + '$2');
  L.put('metafile.html', mfHtml);
  L.copy(path.join(ROOT, 'metafile.mjs'), 'metafile.mjs');
  for (const f of ['viewer.mjs', 'LICENSE', 'NOTICE.md', 'fonts/math-compat.mjs', 'fonts/local-fonts.mjs']) L.copy(path.join(ROOT, f), f);
  L.copyTree(path.join(ROOT, 'x2t'), 'x2t/');
  L.copyTree(path.join(ROOT, 'fonts', 'math'), 'fonts/math/');
  L.put('x2t-info.json', JSON.stringify({ coi: o.coi, prebuilt: engineFor.prebuilt, st: engineFor.st, mt: engineFor.mt, apps: appSel }) + '\n');
  L.finish({
    license: 'AGPL-3.0-or-later', options: { coi: o.coi, engines: o.engines },
    source: sourceText('core', ['Contents: index.html, viewer.mjs, x2t/, fonts/ (math-compat, local-fonts, math/), x2t-info.json.',
      'x2t-info.json says which engine layers were packed and whether the page is served cross-origin isolated (--coi at pack time',
      'only records what the server does; the headers come from your server, see deploy/).']),
  });
  layers.push(L);
}

// editor
{
  const L = new Layer('editor', 'sdkjs + web-apps + font pack + dictionaries (CryptPad build of the ONLYOFFICE/Euro-Office editor), trimmed');
  L.copyTree(editorDir, 'oo/', keepEditor);
  // The embed pages of the CryptPad build still hold `<script src="@@SRC_ROOT@@/...?__inline=true">` lines: the upstream
  // build inlines those helpers, this build neither inlines nor ships them, so every page load got three 404s. Drop the
  // lines (behaviour unchanged: the files never loaded) and rewrite the precompressed sibling so .br-first servers agree.
  for (const rel of [...L.files.keys()]) {
    if (!/^oo\/web-apps\/apps\/[^/]+\/embed\/[^/]+\.html$/.test(rel)) continue;
    const src = fs.readFileSync(path.join(L.dir, rel), 'utf8');
    if (!src.includes('@@SRC_ROOT@@')) continue;
    const html = src.split('\n').filter((line) => !line.includes('@@SRC_ROOT@@')).join('\n');
    L.put(rel, html);
    if (L.files.has(rel + '.br')) L.put(rel + '.br', brotli(Buffer.from(html)));
  }
  // The font list with the alias names (Times New Roman -> Tinos, ...): what tools/serve.cjs computes per request. The
  // precompressed sibling must follow, a server that prefers .br would otherwise hand out the old list.
  const aliased = addFontAliases(allFontsSrc);
  L.put('oo/sdkjs/common/AllFonts.js', aliased);
  L.put('oo/sdkjs/common/AllFonts.js.br', brotli(Buffer.from(aliased)));
  const fontsDir = path.join(editorDir, 'fonts', 'fonts');
  const fonts = fs.readdirSync(fontsDir).filter((f) => /\.(ttf|otf|ttc)$/i.test(f)).sort();
  L.put('fonts-manifest.json', JSON.stringify({ base: 'oo/fonts/fonts/', files: fonts }) + '\n');
  const zipSha = ['onlyoffice-editor.zip.sha512'].map((f) => (fs.existsSync(path.join(ART, f)) ? fs.readFileSync(path.join(ART, f), 'utf8').trim() : '(file missing)'));
  L.finish({
    license: 'AGPL-3.0 (ONLYOFFICE/Euro-Office sdkjs and web-apps; fonts under their own open licences, see NOTICE.md in the core layer)',
    requires: ['core'], options: { apps: appSel, langs: o.langs === 'all' ? 'all' : [...o.langs], dicts: o.dicts === 'all' ? 'all' : [...o.dicts], keepHelp: o.keepHelp, keepExtras: o.keepExtras },
    source: sourceText('editor', [
      'Origin: CryptPad build of https://github.com/cryptpad/onlyoffice-editor (sdkjs, web-apps, fonts, dictionaries).',
      `sha512 of the zip it was taken from: ${zipSha[0]}`,
      'Changes made by this project: oo/sdkjs/common/AllFonts.js (font list: Arial/Calibri removed, .VnTime fonts, metric-compatible',
      'Word fonts, alias names, hook for the fonts of the user\'s computer; see fonts/font-pack.cjs, fonts/font-aliases.cjs in the source),',
      'oo/fonts/fonts/ (fonts added/removed, see NOTICE.md). Trimmed as listed in manifest.json options.',
      'Upstream sources: https://github.com/Euro-Office/sdkjs, https://github.com/Euro-Office/web-apps,',
      'https://github.com/ONLYOFFICE/sdkjs, https://github.com/ONLYOFFICE/web-apps.',
    ]),
  });
  layers.push(L);
}

// engines
const ENGINE_FILES = /^x2t\.(js|wasm)(\.br)?$/;
const ENGINE_TEXT = {
  st: ['x2t.wasm built by build/x2t/build.mjs st from cryptpad/onlyoffice-x2t-wasm (ONLYOFFICE core 9.3.2) with the patches in build/x2t/ctx/patches/ (single-threaded).'],
  mt: ['x2t.wasm built by build/x2t/build.mjs mt from cryptpad/onlyoffice-x2t-wasm (ONLYOFFICE core 9.3.2) with the patches in build/x2t/ctx/patches/ (pthreads; used only when the page is cross-origin isolated).'],
  prebuilt: ['x2t.wasm prebuilt by CryptPad, https://github.com/cryptpad/onlyoffice-x2t-wasm (AGPL-3.0). Unmodified.'],
};
for (const e of o.engines) {
  const [artDir, urlDir] = ENGINES[e];
  const L = new Layer('engine-' + e, `x2t.wasm ${e} (${urlDir}/)`);
  L.copyTree(path.join(ART, artDir), urlDir + '/', (r) => ENGINE_FILES.test(r));
  L.finish({ license: 'AGPL-3.0', requires: ['core'], source: sourceText('engine-' + e, [...ENGINE_TEXT[e], 'Upstream: https://github.com/Euro-Office/core, https://github.com/ONLYOFFICE/core.']) });
  layers.push(L);
}

// metafile (WMF/EMF -> PNG page): files of the sibling repository at their URL paths under metafile/
if (o.metafile) {
  const MF_SRC = ['metafile-client.mjs', 'metafile-worker.js', 'metafile-core.js', 'metafile-math.js'];
  const MF_ART = /^metafile\.(js|wasm)(\.br)?$/;
  const artDir = path.join(o.metafile, 'artifacts', 'metafile-st');
  for (const f of MF_SRC) if (!fs.existsSync(path.join(o.metafile, 'src', f))) fail(`missing ${path.join(o.metafile, 'src', f)} (sibling repo metafile-wasm; --metafile <dir> or --no-metafile)`);
  if (!fs.existsSync(path.join(artDir, 'metafile.wasm'))) fail(`missing ${artDir}/metafile.wasm (npm run build in metafile-wasm)`);
  const mfSh = (args) => { const r = spawnSync('git', args, { cwd: o.metafile, encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : ''; };
  const mfCommit = mfSh(['rev-parse', 'HEAD']);
  const mfDirty = mfCommit ? mfSh(['status', '--porcelain', '--untracked-files=no', '--', 'src']) !== '' : true;
  if (mfDirty && !o.allowDirty) fail('metafile-wasm: src/ has uncommitted changes (or is not a git checkout). Commit there first, or --allow-dirty.');
  const L = new Layer('metafile', 'metafile.wasm (WMF/EMF/EMF+ -> PNG) and its worker, for metafile.html');
  for (const f of MF_SRC) L.copy(path.join(o.metafile, 'src', f), 'metafile/src/' + f);
  L.copyTree(artDir, 'metafile/artifacts/metafile-st/', (r) => MF_ART.test(r));
  L.copy(path.join(o.metafile, 'LICENSE'), 'metafile/LICENSE');
  L.finish({
    license: 'AGPL-3.0-only', requires: ['core', 'editor'],
    source: sourceText('metafile', [
      'metafile.wasm and its JS come from the metafile-wasm repository (AGPL-3.0-only, ONLYOFFICE core 9.3.2 with patches).',
      `metafile-wasm source: ${o.metafileSourceUrl || '(not set: pack with --metafile-source-url <url>)'}`,
      `metafile-wasm commit: ${mfCommit || '(unknown)'}${mfDirty ? '  (src/ had uncommitted changes)' : ''}`,
      'metafile.html (core layer) loads the fonts of the editor layer (oo/fonts/fonts/) and fonts/math/.',
    ]),
  });
  layers.push(L);
}

// ---- site (all layers merged with hard links) -----------------------------------------------------------------------
if (o.site) {
  const site = path.join(outDir, 'site');
  for (const L of layers) for (const rel of L.files.keys()) {
    const dst = path.join(site, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    const src = path.join(L.dir, rel);
    try { fs.linkSync(src, dst); } catch { fs.copyFileSync(src, dst); }
  }
}

// ---- deploy examples ------------------------------------------------------------------------------------------------
const deployDir = path.join(ROOT, 'deploy');
if (fs.existsSync(deployDir)) {
  fs.cpSync(deployDir, path.join(outDir, 'deploy'), { recursive: true });
}

// ---- archives ---------------------------------------------------------------------------------------------------------
const archives = [];
if (o.archive) {
  const targets = layers.map((L) => ({ name: L.name, dir: path.join('layers', L.name) }));
  if (o.site) targets.push({ name: 'site', dir: 'site' });
  for (const t of targets) {
    const file = `${NAME}-${t.name}-${version}.tar.gz`;
    const r = spawnSync('tar', ['-czf', file, '-C', t.dir, '.'], { cwd: outDir, stdio: ['ignore', 'inherit', 'inherit'] });
    if (r.status !== 0) fail('tar failed for ' + t.name + ' (needs tar in PATH)');
    const buf = fs.readFileSync(path.join(outDir, file));
    archives.push({ file, size: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') });
  }
  fs.writeFileSync(path.join(outDir, 'SHA256SUMS'), archives.map((a) => `${a.sha256}  ${a.file}`).join('\n') + '\n');
}
const release = {
  package: NAME, version, license: pkg.license, commit: commit || null, dirty, sourceUrl: o.sourceUrl || null,
  options: { apps: appSel, langs: o.langs === 'all' ? 'all' : [...o.langs], dicts: o.dicts === 'all' ? 'all' : [...o.dicts], engines: o.engines, coi: o.coi, keepHelp: o.keepHelp, keepExtras: o.keepExtras },
  layers: layers.map((L) => ({ name: L.name, description: L.desc, files: L.count, bytes: L.bytes })), archives,
};
fs.writeFileSync(path.join(outDir, 'release.json'), JSON.stringify(release, null, 1) + '\n');

console.log(`\n${NAME} ${version} -> ${path.relative(process.cwd(), outDir) || outDir}`);
for (const L of layers) {
  const a = archives.find((x) => x.file === `${NAME}-${L.name}-${version}.tar.gz`);
  console.log(`  ${L.name.padEnd(16)} ${String(L.count).padStart(6)} files  ${mb(L.bytes).padStart(10)}${a ? '  tar.gz ' + mb(a.size) : ''}`);
}
const site = archives.find((x) => x.file.includes('-site-'));
if (site) console.log(`  ${'site (merged)'.padEnd(16)} ${''.padStart(6)}        ${''.padStart(10)}  tar.gz ${mb(site.size)}`);
