// Run ONE x2t conversion in a fresh process (an abort inside the wasm must not poison later runs).
// usage: node x2t-run.cjs --x2t <dir with x2t.js/x2t.wasm> --fonts <dir> --in <file> --out <file>
//                         [--to <formatId>] [--preload <hostDir copied into /working>] [--xml '<extra/>']
// Prints one JSON line on stdout prefixed with "RESULT ".
// SPDX-License-Identifier: AGPL-3.0-or-later
const path = require('node:path');
const fs = require('node:fs');

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
for (const k of ['x2t', 'fonts', 'in', 'out']) {
  if (!args[k]) { console.error('missing --' + k); process.exit(2); }
}

const t0 = performance.now();
const x2t = require(path.resolve(args.x2t, 'x2t.js'));

function mkdirp(p) {
  let cur = '';
  for (const part of p.split('/').filter(Boolean)) {
    cur += '/' + part;
    if (!x2t.FS.analyzePath(cur).exists) x2t.FS.mkdir(cur);
  }
}
function copyIn(hostPath, fsPath) {
  if (fs.statSync(hostPath).isDirectory()) {
    mkdirp(fsPath);
    for (const f of fs.readdirSync(hostPath)) copyIn(path.join(hostPath, f), fsPath + '/' + f);
  } else {
    x2t.FS.writeFile(fsPath, fs.readFileSync(hostPath));
  }
}
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

x2t.onRuntimeInitialized = function () {
  const tInit = performance.now();
  const result = { in: args.in, out: args.out, to: args.to || null, initMs: Math.round(tInit - t0) };
  try {
    for (const d of ['/tmp', '/working', '/working/media', '/working/fonts', '/working/themes']) mkdirp(d);
    copyIn(path.resolve(args.fonts), '/working/fonts');
    if (args.preload) copyIn(path.resolve(args.preload), '/working');
    const inName = path.basename(args.in);
    const outName = path.basename(args.out);
    x2t.FS.writeFile('/working/' + inName, fs.readFileSync(args.in));
    const params = '<?xml version="1.0" encoding="utf-8"?>'
      + '<TaskQueueDataConvert xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">'
      + '<m_sFontDir>/working/fonts/</m_sFontDir>'
      + '<m_sThemeDir>/working/themes</m_sThemeDir>'
      + '<m_sFileFrom>/working/' + esc(inName) + '</m_sFileFrom>'
      + '<m_sFileTo>/working/' + esc(outName) + '</m_sFileTo>'
      + (args.to ? '<m_nFormatTo>' + Number(args.to) + '</m_nFormatTo>' : '')
      + '<m_bIsNoBase64>false</m_bIsNoBase64>'
      + '<m_nCsvTxtEncoding>46</m_nCsvTxtEncoding>'
      + '<m_nCsvDelimiter>4</m_nCsvDelimiter>'
      + (args.xml || '')
      + '</TaskQueueDataConvert>';
    x2t.FS.writeFile('/working/params.xml', params);
    const tFs = performance.now();
    result.fsSetupMs = Math.round(tFs - tInit);
    result.exitCode = x2t.ccall('main1', 'number', ['string'], ['/working/params.xml']);
    result.convertMs = Math.round(performance.now() - tFs);
    const outFs = '/working/' + outName;
    if (x2t.FS.analyzePath(outFs).exists) {
      const st = x2t.FS.stat(outFs);
      if (x2t.FS.isDir(st.mode)) {
        result.outIsDir = true;
        result.outEntries = x2t.FS.readdir(outFs).filter((e) => e !== '.' && e !== '..');
      } else {
        const data = x2t.FS.readFile(outFs);
        fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
        fs.writeFileSync(args.out, data);
        result.outBytes = data.length;
        result.outHead = Buffer.from(data.subarray(0, 24)).toString('latin1').replace(/[^\x20-\x7e]/g, '.');
      }
    } else {
      result.outBytes = null;
    }
    result.workingAfter = x2t.FS.readdir('/working').filter((e) => !['.', '..', 'fonts'].includes(e));
  } catch (e) {
    result.error = String(e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e);
  }
  console.log('RESULT ' + JSON.stringify(result));
  process.exit(result.error ? 1 : 0);
};
