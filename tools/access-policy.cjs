// Which pages may embed the viewer: the list of allowed origins (domains) in one small file, checked before it reaches a header.
//
//   { "frameAncestors": ["https://educora.vn", "https://*.educora.vn", "https://mschool.vn"], "tokenScope": "viewer" }
//
// An entry is scheme://host[:port] with an optional leading "*." on the host (a subdomain wildcard) and ":*" for any port.
//   - "https://*.educora.vn" matches every subdomain (a.educora.vn, a.b.educora.vn) but NOT educora.vn itself: list both.
//   - the scheme is https, except http for localhost and 127.0.0.1 (development).
//   - a wildcard needs a registrable domain after "*." (at least two labels): "*.vn" or "*" are refused, they would let in the world.
//   - nothing else is accepted (no paths, quotes, spaces or semicolons: the value goes into a Content-Security-Policy header).
// 'self' is always added (the editor runs in a frame of the viewer page).
// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';
const fs = require('node:fs');

const LABEL = '[a-z0-9](?:[a-z0-9-]*[a-z0-9])?';
const ORIGIN_RE = new RegExp(`^(https?)://((?:\\*\\.)?${LABEL}(?:\\.${LABEL})*)(?::(\\d{1,5}|\\*))?$`);
const DEV_HOSTS = /^(?:\*\.)?localhost$|^127\.0\.0\.1$/;

/**
 * @param {string[]} list allowed origins
 * @returns {{sources: string[], value: string, warnings: string[]}} value: the frame-ancestors source list, 'self' first
 * @throws {Error} on an entry that is not an origin this module accepts
 */
function parseOrigins(list) {
  if (!Array.isArray(list)) throw new Error('frameAncestors must be an array of origins');
  const sources = [];
  const warnings = [];
  for (const raw of list) {
    const entry = String(raw).trim().toLowerCase();
    const m = ORIGIN_RE.exec(entry);
    if (!m) throw new Error(`not an origin: "${raw}" (expected https://host, https://*.domain or https://host:port)`);
    const [, scheme, host, port] = m;
    if (scheme === 'http' && !DEV_HOSTS.test(host)) throw new Error(`"${raw}": http is only accepted for localhost and 127.0.0.1`);
    if (host.startsWith('*.')) {
      const base = host.slice(2);
      if (!base.includes('.') && base !== 'localhost') throw new Error(`"${raw}": a wildcard needs a registrable domain after "*." (for example *.example.com)`);
    }
    if (port !== undefined && port !== '*' && Number(port) > 65535) throw new Error(`"${raw}": port out of range`);
    if (!sources.includes(entry)) sources.push(entry);
  }
  for (const s of sources) {
    const m = ORIGIN_RE.exec(s);
    if (m[2].startsWith('*.') && !sources.includes(`${m[1]}://${m[2].slice(2)}${m[3] ? ':' + m[3] : ''}`)) {
      warnings.push(`${s} does not cover ${m[2].slice(2)} itself; add ${m[1]}://${m[2].slice(2)}${m[3] ? ':' + m[3] : ''} if pages there embed the viewer`);
    }
  }
  return { sources, value: ["'self'", ...sources].join(' '), warnings };
}

/**
 * Reads the policy file.
 * @returns {{frameAncestors?: string, sources?: string[], tokenScope?: string, warnings: string[]}}
 */
function readConfig(file) {
  let json;
  try {
    json = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`${file}: ${e.message}`);
  }
  const out = { warnings: [] };
  for (const k of Object.keys(json)) if (!['frameAncestors', 'tokenScope'].includes(k)) out.warnings.push(`unknown key "${k}" ignored`);
  if (json.frameAncestors !== undefined) {
    const p = parseOrigins(json.frameAncestors);
    out.frameAncestors = p.value;
    out.sources = p.sources;
    out.warnings.push(...p.warnings);
  }
  if (json.tokenScope !== undefined) {
    if (typeof json.tokenScope !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(json.tokenScope)) throw new Error('tokenScope must be 1-32 characters: letters, digits, _ or -');
    out.tokenScope = json.tokenScope;
  }
  return out;
}

module.exports = { parseOrigins, readConfig };
