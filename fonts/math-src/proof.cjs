// Proof sheet of the substitute math fonts: one cell per byte code with our glyph and the description of the
// official Design Science table next to it, so that every glyph can be checked against the documented character.
//   node fonts/math-src/proof.cjs <out.png> [fontKey ...]      (fontKey: extra symbol blackboard script fraktur)
// Needs playwright (the repository's devDependency or any Chromium given in PW_CHROMIUM).
'use strict';
const fs = require('fs');
const path = require('path');
const math = path.join(__dirname, '..', 'math');
const info = JSON.parse(fs.readFileSync(path.join(math, 'math-fonts.json'), 'utf8')).fonts;
const tables = JSON.parse(fs.readFileSync(path.join(__dirname, 'encodings', 'design-science.json'), 'utf8')).tables;
const tableOf = { extra: 'mtextra', symbol: 'symbol', blackboard: 'eumat2', script: 'eumat1', fraktur: 'eufrak' };
const [out, ...keys] = process.argv.slice(2);
const chosen = keys.length ? keys : Object.keys(info);
let css = '';
let body = '';
for (const k of chosen) {
  const f = info[k];
  css += `@font-face{font-family:"${f.family}";src:url(data:font/woff2;base64,${fs.readFileSync(path.join(math, f.woff2)).toString('base64')})}`;
  body += `<h3>${f.family}: ${f.codes.length} glyphs; not covered: ${(f.uncovered || []).join(' ') || '-'}</h3><div class=g>`;
  for (const c of f.codes) {
    const desc = (tables[tableOf[k]][c] || ['', ''])[1];
    body += `<div class=c><span class=l>${c}</span><span class=o style="font-family:'${f.family}'">&#x${(0xf000 + parseInt(c, 16)).toString(16)};</span><span class=d>${desc}</span></div>`;
  }
  body += '</div>';
}
const html = `<meta charset=utf-8><style>${css}body{font:12px sans-serif;margin:8px}.g{display:flex;flex-wrap:wrap;gap:2px}.c{width:96px;height:78px;border:1px solid #ccc;position:relative;overflow:hidden}.l{position:absolute;left:2px;top:1px;color:#888;font-size:9px}.o{position:absolute;left:6px;top:12px;font-size:34px;line-height:1.1;white-space:pre}.d{position:absolute;left:2px;bottom:1px;right:2px;font-size:8px;line-height:9px;height:18px;overflow:hidden;color:#444}h3{margin:6px 0 2px}</style>${body}`;
(async () => {
  const { chromium } = require(path.resolve('node_modules/playwright'));
  const exe = process.env.PW_CHROMIUM || path.join(process.env.LOCALAPPDATA || '', 'ms-playwright', 'chromium-1248', 'chrome-win64', 'chrome.exe');
  const b = await chromium.launch({ executablePath: exe });
  const p = await b.newPage({ viewport: { width: 1250, height: 900 } });
  await p.setContent(html);
  await p.evaluate(() => document.fonts.ready);
  await p.screenshot({ path: out, fullPage: true });
  await b.close();
})().catch((e) => { console.error(String(e)); process.exit(1); });
