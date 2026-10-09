#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Mutation fuzzer. Seeds are the corpus sources and the sample notes;
// mutations use Tern's own marks (and TeX's) so they reach the grammar's
// edges. For every input the engine must:
//   - not throw;
//   - take ≤ 50 ms (scaled to the machine);
//   - produce output of bounded length (≤ 50 × input + 10 KB);
//   - be deterministic (same input, same result);
//   - keep every invariant in test/lib/invariants.js.
// A failing input is saved to test/fuzz-failures/ with its seed, and replays
// with --replay=FILE.
//
//   node test/fuzz.js [--seconds=30] [--seed=N] [--replay=FILE]
'use strict';

const fs = require('fs');
const path = require('path');
const engine = require('./lib/engine');
const fixture = require('./fixtures/schema');
const { loadAll } = require('./lib/corpus');
const { checkParse } = require('./lib/invariants');
const { machineFactor } = require('./lib/calibrate');

const args = process.argv.slice(2);
const opt = (k) => (args.find((a) => a.startsWith(`--${k}=`)) || '').slice(k.length + 3) || null;
const SECONDS = Number(opt('seconds') || 30);
const SEED = Number(opt('seed') || 20261007);
const OUT = path.join(__dirname, 'fuzz-failures');

// Tern's marks, TeX's marks, line starters and a few hard characters.
const TOKENS = [
  '*', '**', '***', '_', '~~', '==', '`', '``', '```', '$', '$$', '$`', '\\', '\\\n', '[', ']', '](', '![', '[^', '[^a]', ']:',
  '{', '}', '{#a}', '{.b}', '{k=v}', '{raw}', ':', '::', ':::', ':::d', ':::/d', ':kbd[', '@', '@a', '#', '# ', '|', '| a |', '|---|',
  '>', '> ', '- ', '1. ', '+++', '---', '<', '>', '</', '<div>', '</div>', '<b>', '<!--', '-->', '<script>', '&', '&amp;', '&#x;',
  'http://', 'https://x.y/', '(', ')', '"', "'", '=', '\n', '\n\n', ' ', '    ', '\t', '\r', '\r\n', '\0', '﻿', 'é', '漢',
  '\u{1F600}', '​',
];

function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seeds() {
  const out = loadAll().cases.map((c) => c.source).filter((s) => typeof s === 'string' && s.length < 20000);
  const dir = path.join(__dirname, 'samples');
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.html') || f.endsWith('.excerpt.html')) continue;
    const s = fs.readFileSync(path.join(dir, f), 'utf8');
    out.push(s.slice(s.indexOf('\n') + 1));
  }
  if (!out.length) out.push('# Title\n\nA *paragraph* with $x$ and `code`.\n\n:::note[T]{#n}\nbody\n:::\n');
  return out;
}

function mutate(s, rnd, pool) {
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const at = () => Math.floor(rnd() * (s.length + 1));
  const n = 1 + Math.floor(rnd() * 4);
  for (let k = 0; k < n; k++) {
    const i = at();
    const j = Math.min(s.length, i + Math.floor(rnd() * 40));
    switch (Math.floor(rnd() * 8)) {
      case 0: s = s.slice(0, i) + pick(TOKENS) + s.slice(i); break; // insert a mark
      case 1: s = s.slice(0, i) + s.slice(j); break; // delete a span
      case 2: s = s.slice(0, i) + s.slice(i, j).repeat(2 + Math.floor(rnd() * 20)) + s.slice(i); break; // repeat a span
      case 3: { const o = pick(pool); const a = Math.floor(rnd() * o.length); s = s.slice(0, i) + o.slice(a, a + 200) + s.slice(i); break; } // splice
      case 4: { const l = s.split('\n'); const a = Math.floor(rnd() * l.length); const b = Math.floor(rnd() * l.length); [l[a], l[b]] = [l[b], l[a]]; s = l.join('\n'); break; } // swap lines
      case 5: s = s.slice(0, i) + pick(TOKENS).repeat(1 + Math.floor(rnd() * 200)) + s.slice(i); break; // a run of one mark
      case 6: s = s.slice(0, i) + '\n' + ' '.repeat(Math.floor(rnd() * 9)) + s.slice(i); break; // re-indent
      default: s = s.slice(0, i); // truncate
    }
  }
  return s;
}

function runOne(tern, input, limitMs) {
  const opts = { schema: fixture };
  const problems = [];
  const t = process.hrtime.bigint();
  let parsed;
  let html;
  try {
    parsed = tern.parse(input, opts);
    html = tern.toHTML(input, opts);
  } catch (e) {
    return [`threw: ${(e && e.stack) || e}`];
  }
  const ms = Number(process.hrtime.bigint() - t) / 1e6;
  if (ms > limitMs) problems.push(`took ${ms.toFixed(1)} ms (limit ${limitMs.toFixed(0)} ms) for ${input.length} chars`);
  if (html.length > 50 * input.length + 10240) problems.push(`output ${html.length} chars for ${input.length} chars of input`);
  problems.push(...checkParse(parsed, input).slice(0, 5));
  try {
    const again = tern.parse(input, opts);
    if (JSON.stringify(again) !== JSON.stringify(parsed)) problems.push('not deterministic: a second parse differs');
  } catch (e) {
    problems.push(`threw on the second parse: ${e.message}`);
  }
  return problems;
}

function main() {
  const { tern, why } = engine.load();
  if (!tern) {
    console.log(`✗ ${why}`);
    process.exit(2);
  }
  const { factor } = machineFactor();
  const limit = 50 * factor;
  const replay = opt('replay');
  if (replay) {
    const problems = runOne(tern, fs.readFileSync(replay, 'utf8'), limit);
    console.log(problems.length ? `✗ ${problems.join('\n  ')}` : '✓ passes');
    process.exit(problems.length ? 1 : 0);
  }
  const pool = seeds();
  const rnd = mulberry32(SEED);
  const end = Date.now() + SECONDS * 1000;
  let runs = 0;
  let failures = 0;
  const seen = new Set();
  while (Date.now() < end) {
    const input = mutate(pool[Math.floor(rnd() * pool.length)], rnd, pool);
    runs++;
    const problems = runOne(tern, input, limit);
    if (!problems.length) continue;
    const key = problems[0].replace(/\d+/g, 'N').slice(0, 120);
    if (seen.has(key)) continue; // report each kind of failure once
    seen.add(key);
    failures++;
    fs.mkdirSync(OUT, { recursive: true });
    const file = path.join(OUT, `seed${SEED}-run${runs}.txt`);
    fs.writeFileSync(file, input);
    console.log(`✗ run ${runs}: ${problems[0]}\n  saved ${path.relative(process.cwd(), file)}; replay: node test/fuzz.js --replay=${path.relative(process.cwd(), file)}`);
    for (const p of problems.slice(1, 4)) console.log(`  ${p}`);
  }
  console.log(`\n${runs} inputs in ${SECONDS} s from ${pool.length} seeds (seed ${SEED}); ${failures ? `${failures} distinct failure(s)` : 'no failures'}`);
  process.exit(failures ? 1 : 0);
}

main();
