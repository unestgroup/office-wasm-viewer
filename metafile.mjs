// office-wasm metafile page: WMF / EMF / EMF+ pictures -> PNG with metafile.wasm, inside an <iframe>.
// Lets an application turn the metafiles of a Word file into PNG without linking the AGPL converter: the page runs on
// the viewer's origin and the application talks to it only with postMessage.
//
//   host -> page   {target: 'office-wasm-metafile', id, method, params}
//   page -> host   {source: 'office-wasm-metafile', id, ok: true, result} | {source, id, ok: false, error}
//   page -> host   {source: 'office-wasm-metafile', type: 'event', event: 'ready', data: {version, source}}
//                  (after the converter has started) | event: 'error', data: {version, source, error}
// Methods: convert {data: ArrayBuffer, scale?: number (PNG px per CSS px, default 2), background?: 0xAARRGGBB}
//            -> {format, width, height, png: ArrayBuffer (transferred), pngWidth, pngHeight, fonts: [names asked for]}
//          getState {}
// Fonts: the metafile is first drawn as SVG to learn the fonts it asks for; the matching files of the font pack
// (Times New Roman -> Tinos, .VnTime, ...) and the MathType substitutes are loaded into the converter, then the PNG is
// drawn. Font files stay loaded for the following conversions.
//
// metafile.wasm and its JS are served under metafile/ (layer `metafile` of tools/pack.mjs, from the metafile-wasm repo).
// SPDX-License-Identifier: AGPL-3.0-or-later
const VERSION = '0.2.0';
const TAG = 'office-wasm-metafile';
const ROOT = new URL('./', import.meta.url);
const embedded = window.parent !== window;
const sourceUrl = document.querySelector('meta[name="office-wasm-viewer:source"]')?.content || '';
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_SIDE = 4096;
const MAX_PIXELS = 16e6;

// Document font name (lower case) -> font files of the pack (oo/fonts/fonts/). Metric-compatible pairs as in
// fonts/font-aliases.cjs, plus the Vietnamese TCVN3 fonts of the pack.
const FAMILIES = {
  tinos: ['Tinos-Regular.ttf', 'Tinos-Bold.ttf', 'Tinos-Italic.ttf', 'Tinos-BoldItalic.ttf'],
  arimo: ['Arimo-Regular.ttf', 'Arimo-Bold.ttf', 'Arimo-Italic.ttf', 'Arimo-BoldItalic.ttf'],
  carlito: ['Carlito-Regular.ttf', 'Carlito-Bold.ttf', 'Carlito-Italic.ttf', 'Carlito-BoldItalic.ttf'],
  cousine: ['Cousine-Regular.ttf', 'Cousine-Bold.ttf', 'Cousine-Italic.ttf', 'Cousine-BoldItalic.ttf'],
  caladea: ['WasmCaladea-Regular.ttf', 'WasmCaladea-Bold.ttf', 'WasmCaladea-Italic.ttf', 'WasmCaladea-BoldItalic.ttf'],
  vntime: ['VNTIME.TTF', 'VNTIMEB.TTF', 'VNTIMEI.TTF', 'VNTIMEBI.TTF'],
};
const NAME_TO_FAMILY = {
  'times new roman': 'tinos', times: 'tinos', tinos: 'tinos', 'liberation serif': 'tinos',
  arial: 'arimo', helvetica: 'arimo', arimo: 'arimo', 'liberation sans': 'arimo', 'microsoft sans serif': 'arimo', tahoma: 'arimo', verdana: 'arimo',
  calibri: 'carlito', 'calibri light': 'carlito', carlito: 'carlito', 'trebuchet ms': 'carlito',
  'courier new': 'cousine', courier: 'cousine', consolas: 'cousine', 'lucida console': 'cousine', cousine: 'cousine',
  cambria: 'caladea',
  '.vntime': 'vntime', '.vntimeh': 'vntime', vntime: 'vntime',
};
// Family drawn for a name the pack has nothing for (the core takes the first font it has otherwise).
const DEFAULT_FAMILY = 'tinos';

const state = { phase: 'starting', error: null, converted: 0 };
// Origin of the embedding page: ?host=<origin>, else the origin of the first request accepted (as viewer.mjs).
let hostOrigin = new URLSearchParams(location.search).get('host') || null;

function post(msg, transfer = []) {
  if (!embedded) return;
  window.parent.postMessage({ source: TAG, ...msg }, hostOrigin && hostOrigin !== 'null' ? hostOrigin : '*', transfer);
}

const fontBytes = new Map(); // file -> Promise<ArrayBuffer>
const loadedFamilies = new Set();
function fetchFont(url) {
  if (!fontBytes.has(url)) {
    fontBytes.set(url, fetch(url).then((r) => {
      if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
      return r.arrayBuffer();
    }));
  }
  return fontBytes.get(url);
}

let poolPromise = null;
function pool() {
  poolPromise ??= (async () => {
    const [{ MetafilePool }, math] = await Promise.all([
      import(new URL('metafile/src/metafile-client.mjs', ROOT).href),
      mathFonts(),
    ]);
    const p = await MetafilePool.create({ size: 1, fonts: math });
    await loadFamily(p, DEFAULT_FAMILY);
    return p;
  })();
  poolPromise.catch(() => { poolPromise = null; });
  return poolPromise;
}

// MathType substitutes (fonts/math/) under the names MathType writes (MT Extra, Symbol, Euclid ...).
async function mathFonts() {
  // metafile-math.js is a classic script that sets self.MetafileMath
  if (!globalThis.MetafileMath) {
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = new URL('metafile/src/metafile-math.js', ROOT).href;
      s.onload = resolve;
      s.onerror = () => reject(new Error('metafile-math.js not found'));
      document.head.append(s);
    });
  }
  return Promise.all(globalThis.MetafileMath.FONTS.map(async (f) => ({
    name: f.file,
    data: await fetchFont(new URL('fonts/math/' + f.file, ROOT).href),
    aliases: f.aliases,
    family: f.family,
  })));
}

// Loads the files of `family` (once) and makes `names` (as the metafile spells them) answer to it. A name met later
// for a family already loaded re-sends one file of the family with the new aliases (the worker only takes aliases
// with a font file).
const aliased = new Set();
async function loadFamily(p, family, names = []) {
  const fresh = names.filter((n) => !aliased.has(n));
  if (loadedFamilies.has(family) && !fresh.length) return;
  const files = loadedFamilies.has(family)
    ? [{ name: FAMILIES[family][0], data: await fetchFont(new URL('oo/fonts/fonts/' + FAMILIES[family][0], ROOT).href) }]
    : (await Promise.all(FAMILIES[family].map(async (file) => {
        try {
          return { name: file, data: await fetchFont(new URL('oo/fonts/fonts/' + file, ROOT).href) };
        } catch {
          return null; // a style missing from the pack: the core makes it synthetic
        }
      }))).filter(Boolean);
  if (!files.length) throw new Error('no font file of ' + family);
  // the family is read from the file, so one file carries the aliases for all styles of the family
  if (fresh.length) files[0].aliases = fresh;
  await p.addFonts(files);
  loadedFamilies.add(family);
  for (const n of fresh) aliased.add(n);
}

// Names asked for, grouped by the family of the pack that answers them.
function familiesFor(names) {
  const out = new Map();
  for (const n of names) {
    const fam = NAME_TO_FAMILY[String(n).trim().toLowerCase()];
    if (!fam) continue;
    if (!out.has(fam)) out.set(fam, []);
    out.get(fam).push(n);
  }
  return out;
}

async function convert({ data, scale, background }) {
  if (!(data instanceof ArrayBuffer)) throw new Error('convert: data must be an ArrayBuffer');
  if (data.byteLength > MAX_BYTES) throw new Error('convert: file too large');
  const p = await pool();
  // SVG pass: fonts the file asks for (cheap, no raster)
  const probe = await p.convert(data, { output: 'svg' });
  if (probe.error) throw new Error(probe.error);
  const names = [...new Set((probe.fonts || []).map((f) => f.name).filter(Boolean))];
  for (const [fam, asked] of familiesFor(names)) await loadFamily(p, fam, asked);
  // PNG size: scale x natural size, capped like the converter's own 'auto' fallback (4096 px a side, 16 MP), so an
  // odd or hostile frame size cannot exhaust the worker's memory
  const w = probe.width > 0 ? probe.width : 1;
  const h = probe.height > 0 ? probe.height : 1;
  const s = Math.min(scale > 0 && scale <= 8 ? scale : 2, MAX_SIDE / w, MAX_SIDE / h, Math.sqrt(MAX_PIXELS / (w * h)));
  const r = await p.convert(data, {
    output: 'png',
    pngWidth: Math.max(1, Math.round(w * s)),
    pngHeight: Math.max(1, Math.round(h * s)),
    background: background === undefined ? 0x00ffffff : background >>> 0,
  });
  if (r.error) throw new Error(r.error);
  if (!r.png) throw new Error('convert: no PNG produced');
  state.converted++;
  return [{
    format: r.format, width: r.width, height: r.height, png: r.png, pngWidth: r.pngWidth, pngHeight: r.pngHeight, fonts: names,
  }, [r.png]];
}

const methods = {
  convert,
  async getState() {
    return [{ ...state, version: VERSION }];
  },
};

window.addEventListener('message', async (ev) => {
  if (!embedded || ev.source !== window.parent) return;
  const m = ev.data;
  if (!m || m.target !== TAG || typeof m.method !== 'string') return;
  if (hostOrigin === null) hostOrigin = ev.origin;
  else if (ev.origin !== hostOrigin) return;
  const fn = Object.hasOwn(methods, m.method) ? methods[m.method] : null;
  try {
    if (!fn) throw new Error('unknown method: ' + m.method);
    const [result, transfer] = await fn(m.params || {});
    post({ id: m.id, ok: true, result }, transfer || []);
  } catch (e) {
    post({ id: m.id, ok: false, error: String(e && e.message ? e.message : e) });
  }
});

// Start the converter right away; "ready" once the wasm and the math fonts are loaded, so the host's per-file timeouts
// do not include the first download. A failed start is reported as "error" (requests after it retry the start).
pool().then(() => {
  state.phase = 'ready';
  post({ type: 'event', event: 'ready', data: { version: VERSION, source: sourceUrl } });
}, (e) => {
  state.phase = 'error';
  state.error = String(e && e.message ? e.message : e);
  post({ type: 'event', event: 'error', data: { version: VERSION, source: sourceUrl, error: state.error } });
});
