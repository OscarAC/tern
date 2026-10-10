#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// The colour themes (docs/schema.html#themes), read from the files in
// themes/: they are the current build of tools/themes.js; each mode of each
// file sets every colour property and its color-scheme; each prints as
// tern.css prints; every text colour reaches its family's contrast (4.5:1,
// 7:1 for high-contrast) against what it is drawn on, as tern.css's own
// palettes do; and the documentation lists every file.
//
//   node test/themes.js
'use strict';

const fs = require('fs');
const path = require('path');
const T = require('../tools/themes');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'themes');

let failed = 0;
const results = [];
function test(name, fn) {
  const problems = [];
  try {
    fn(problems);
  } catch (e) {
    problems.push((e && e.message) || String(e));
  }
  if (problems.length) failed++;
  results.push(problems.length ? `✗ ${name}\n  ${problems.join('\n  ')}` : `✓ ${name}`);
}

// A file's modes: {light|dark|auto-light|auto-dark|print: {scheme, colours}}.
const props = (block) => Object.fromEntries([...block.matchAll(/(?<![\w-])(--t-[a-z-]+|color-scheme):\s*([^;]+);/g)].map((m) => [m[1].replace(/^--t-/, ''), m[2].trim()]));
function modes(css) {
  const at = (re) => {
    const m = re.exec(css);
    return m ? props(css.slice(m.index, css.indexOf('}', css.indexOf(':root {', m.index)))) : null;
  };
  const top = props(css.slice(css.indexOf(':root {'), css.indexOf('}', css.indexOf(':root {'))));
  const dark = at(/@media \(prefers-color-scheme: dark\)/);
  const print = at(/@media print/);
  if (dark) return { 'auto-light': top, 'auto-dark': { ...top, ...dark }, print };
  return { [top['color-scheme']]: top, print };
}

const files = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((n) => n.endsWith('.css')).sort() : [];
const family = (file) => T.FAMILIES.find((f) => file === `${f.name}.css` || file === `${f.name}-light.css` || file === `${f.name}-dark.css`);

test('themes/ is the current build of tools/themes.js', (p) => {
  const built = T.build();
  for (const n of Object.keys(built)) {
    if (!files.includes(n)) p.push(`${n} is missing: run node tools/themes.js`);
    else if (fs.readFileSync(path.join(DIR, n), 'utf8') !== built[n]) p.push(`${n} is stale: run node tools/themes.js`);
  }
  for (const n of files) if (!(n in built)) p.push(`${n} is not built by tools/themes.js`);
});

test('every mode sets every colour property and its color-scheme; every file prints as tern.css does', (p) => {
  const print = T.printPalette();
  for (const n of files) {
    const m = modes(fs.readFileSync(path.join(DIR, n), 'utf8'));
    const want = n.endsWith('-light.css') ? ['light'] : n.endsWith('-dark.css') ? ['dark'] : null;
    const got = Object.keys(m).filter((k) => k !== 'print');
    if (want && got.join() !== want.join()) p.push(`${n}: modes ${got.join(', ')}, want ${want.join(', ')}`);
    if (!want && !(got.join() === 'auto-light,auto-dark' || got.join() === 'light' || got.join() === 'dark')) p.push(`${n}: modes ${got.join(', ')}`);
    if (m['auto-light'] && m['auto-light']['color-scheme'] !== 'light dark') p.push(`${n}: color-scheme ${m['auto-light']['color-scheme']}, want "light dark"`);
    for (const [mode, c] of Object.entries(m)) {
      const missing = T.COLOURS.filter((k) => !/^#[0-9a-f]{3}([0-9a-f]{3})?$/.test(c[k] || ''));
      if (missing.length) p.push(`${n} (${mode}): no colour for ${missing.join(', ')}`);
    }
    if (!m.print) p.push(`${n}: no print block`);
    else {
      if (m.print['color-scheme'] !== 'light') p.push(`${n}: prints with color-scheme ${m.print['color-scheme']}`);
      for (const k of T.COLOURS) if (m.print[k] !== print[k]) p.push(`${n}: prints --t-${k} ${m.print[k]}, tern.css ${print[k]}`);
    }
  }
});

// What each colour is drawn on: text pairs need the family's contrast; the
// rest only need to be told apart from the page.
const TEXT = [
  ['fg', 'bg'], ['fg', 'soft'], ['fg', 'mark'],
  ['muted', 'bg'], ['muted', 'soft'],
  ['link', 'bg'], ['link', 'soft'],
  ['error', 'error-bg'], ['error', 'bg'],
  ['warn', 'bg'],
];
const APART = [['line', 'bg', 1.15], ['soft', 'bg', 1.03], ['mark', 'bg', 1.05], ['error-bg', 'bg', 1.05]];
const expand = (h) => (h.length === 4 ? '#' + [...h.slice(1)].map((c) => c + c).join('') : h);
function pairs(name, c, min, p) {
  const x = Object.fromEntries(T.COLOURS.map((k) => [k, expand(c[k])]));
  for (const [a, b] of TEXT) {
    const r = T.contrast(x[a], x[b]);
    if (r < min) p.push(`${name}: --t-${a} on --t-${b} is ${r.toFixed(2)}:1, under ${min}:1`);
  }
  for (const [a, b, least] of APART) {
    const r = T.contrast(x[a], x[b]);
    if (r < least) p.push(`${name}: --t-${a} and --t-${b} are ${r.toFixed(2)}:1 apart, under ${least}:1`);
  }
}

test('every text colour reaches its contrast against what it is drawn on (4.5:1, high-contrast 7:1)', (p) => {
  for (const n of files) {
    const f = family(n);
    const min = (f && f.min) || 4.5;
    for (const [mode, c] of Object.entries(modes(fs.readFileSync(path.join(DIR, n), 'utf8')))) if (mode !== 'print') pairs(`${n} (${mode})`, c, min, p);
  }
});

test("tern.css's own light and dark palettes pass the same checks", (p) => {
  const { css } = require('../src/css');
  const block = (from) => props(css.slice(from, css.indexOf('}', from)));
  const light = block(css.indexOf(':root {'));
  const dark = block(css.indexOf(':root {', css.indexOf('@media (prefers-color-scheme: dark)')));
  pairs('tern.css (light)', light, 4.5, p);
  pairs('tern.css (dark)', dark, 4.5, p);
});

test('docs/schema.html#themes lists every file', (p) => {
  const doc = fs.readFileSync(path.join(ROOT, 'docs', 'schema.html'), 'utf8');
  const start = doc.indexOf('### Themes {#themes}');
  if (start < 0) return p.push('docs/schema.html has no "### Themes {#themes}" section');
  const section = doc.slice(start, doc.indexOf('\n### ', start + 1));
  for (const n of files) if (!section.includes(`(../themes/${n})`)) p.push(`${n} is not linked from the Themes section`);
});

console.log(results.join('\n'));
console.log(`\n${results.length - failed}/${results.length} theme checks pass; ${files.length} files`);
process.exit(failed ? 1 : 0);
