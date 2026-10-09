#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// The samples gate: the five sample notes (test/samples/NAME.html) render
// with zero error diagnostics, and their HTML contains the expected excerpt
// (test/samples/NAME.excerpt.html). An excerpt elides with "…" (optionally
// followed by a parenthetical remark); every fragment between elisions must
// appear, normalised, in the output, in order.
//
//   node test/samples.js [--verbose]
'use strict';

const fs = require('fs');
const path = require('path');
const { normalize } = require('./lib/html');
const engine = require('./lib/engine');
const fixture = require('./fixtures/schema');

const DIR = path.join(__dirname, 'samples');
const verbose = process.argv.includes('--verbose');

// The note is everything after the line holding the tern.js script tag; the
// head is everything before the tag.
function splitFile(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const i = lines.findIndex((l) => /<script\b[^>]*\bsrc=["']?[^"' >]*tern\.js/i.test(l));
  if (i < 0) return { head: '', note: text };
  const tag = lines[i].search(/<script\b/i);
  return { head: [...lines.slice(0, i), lines[i].slice(0, tag)].join('\n'), note: lines.slice(i + 1).join('\n') };
}

function fragments(excerpt) {
  return excerpt
    .replace(/<!--\s*head after mount[\s\S]*?-->/g, '')
    .split(/…(?:\s*\([^)]*\))?/)
    .map((f) => normalize(f))
    .filter((f) => /[\p{L}\p{N}<>]/u.test(f));
}

function main() {
  const { tern, why } = engine.load();
  if (!tern) {
    console.log(`✗ ${why}`);
    process.exit(2);
  }
  const names = fs
    .readdirSync(DIR)
    .filter((f) => f.endsWith('.html') && !f.endsWith('.excerpt.html'))
    .map((f) => f.slice(0, -5))
    .sort();
  let failed = 0;
  for (const name of names) {
    const { head, note } = splitFile(fs.readFileSync(path.join(DIR, `${name}.html`), 'utf8'));
    const opts = { schema: fixture, head };
    const problems = [];
    const errors = tern.check(note, opts).filter((d) => d.severity === 'error');
    for (const d of errors) problems.push(`error ${d.code} at ${d.position.start.line}:${d.position.start.column}: ${d.message}`);
    const out = normalize(tern.toHTML(note, { ...opts, positions: false }));
    let at = 0;
    for (const f of fragments(fs.readFileSync(path.join(DIR, `${name}.excerpt.html`), 'utf8'))) {
      const k = out.indexOf(f, at);
      if (k < 0) {
        problems.push(`excerpt fragment not found after offset ${at}:\n      ${f.slice(0, 300)}`);
        if (!verbose) break;
      } else at = k + f.length;
    }
    if (problems.length) failed++;
    console.log(`${problems.length ? '✗' : '✓'} ${name}`);
    for (const p of problems) console.log(`    ${p}`);
  }
  console.log(`\n${names.length - failed}/${names.length} samples clean`);
  process.exit(failed ? 1 : 0);
}

main();
