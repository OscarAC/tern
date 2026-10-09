#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// The conformance harness. Zero dependencies.
//
//   node test/run.js            run the corpus against the engine (tern.js, or $TERN_ENGINE)
//   node test/run.js --lint     check the corpus itself (test/lib/spec.js): its format,
//                               that every `spec:` anchor names an id of its docs page,
//                               codes and severities against the engine's, and coverage
//                               of every reference section and engine code
//   node test/run.js --open     list every "Open:" question the cases flag
//   --filter=TEXT               only cases whose id contains TEXT
//   --verbose                   print every failure in full (default: the first 20)
//
// Besides each case's own expectations, every parse must satisfy the
// invariants in test/lib/invariants.js (serialisable, positioned, nested).
//
// Exit status: 0 green, 1 failures or lint errors, 2 no engine.
'use strict';

const path = require('path');
const { loadAll } = require('./lib/corpus');
const spec = require('./lib/spec').load();
const { normalize, firstDifference } = require('./lib/html');
const engine = require('./lib/engine');
const fixture = require('./fixtures/schema');
const extended = require('./fixtures/schema-extended');
const { checkParse } = require('./lib/invariants');

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const opt = (k) => (args.find((a) => a.startsWith(`--${k}=`)) || '').slice(k.length + 3) || null;

const { cases: all, errors } = loadAll();
const filter = opt('filter');
const cases = filter ? all.filter((c) => c.id.includes(filter)) : all;

// ---------------------------------------------------------------- lint

function lint() {
  const problems = [...spec.problems, ...errors.map((e) => e.message)];
  const known = new Set([...spec.codes.keys(), ...spec.runtimeCodes]);
  for (const c of all) {
    for (const s of c.spec) {
      const r = spec.resolve(s);
      if (r.error) problems.push(`${c.file}:${c.line}: ${c.id}: spec ${s}: ${r.error}`);
    }
    for (const d of expectedDiagnostics(c) || []) {
      if (!known.has(d.code)) problems.push(`${c.file}:${c.line}: ${c.id}: unknown diagnostic code ${d.code}`);
      else if (spec.codes.has(d.code) && d.severity && d.severity !== spec.codes.get(d.code))
        problems.push(`${c.file}:${c.line}: ${c.id}: ${d.code} is ${spec.codes.get(d.code)} in the engine (src/diag.js), not ${d.severity}`);
      if (spec.runtimeCodes.has(d.code)) problems.push(`${c.file}:${c.line}: ${c.id}: ${d.code} is a runtime or tool code; test it in test/smoke.js or test/cli.js`);
    }
  }
  const cited = new Set(all.flatMap((c) => c.spec));
  const usedCodes = new Set(all.flatMap((c) => (expectedDiagnostics(c) || []).filter((d) => !d.optional).map((d) => d.code)));
  const gaps = {
    sections: spec.required.filter((r) => ![...r.covers].some((a) => cited.has(a))).map((r) => r.anchor),
    codes: [...spec.codes.keys()].filter((k) => !usedCodes.has(k)),
  };
  return { problems, gaps, cited };
}

// Both the line form and `json diagnostics` land in c.diagnostics; a case
// without either expects no diagnostics at all.
function expectedDiagnostics(c) {
  return c.diagnostics;
}

function printLint({ problems, gaps, cited }) {
  for (const p of problems) console.log(`  ✗ ${p}`);
  const covered = spec.required.length - gaps.sections.length;
  console.log(
    `corpus: ${all.length} cases in ${new Set(all.map((c) => c.file)).size} files citing ${cited.size} anchors; ` +
      `reference sections ${covered}/${spec.required.length}, engine codes ${spec.codes.size - gaps.codes.length}/${spec.codes.size}`,
  );
  if (gaps.sections.length) console.log(`  uncovered sections: ${gaps.sections.join(' ')}`);
  if (gaps.codes.length) console.log(`  codes with no case: ${gaps.codes.join(' ')}`);
  if (problems.length) console.log(`  ${problems.length} lint problem(s)`);
}

// ---------------------------------------------------------------- matching

// Expected is a subset of actual: every key given must match; arrays match
// element by element and must have the same length. Returns null or a path.
// The string "$absent" asserts that a key is missing (or undefined).
function subset(exp, act, at = '') {
  if (exp === '$absent') return act === undefined ? null : `${at || '.'}: expected no value, got ${JSON.stringify(act)}`;
  if (exp === null || typeof exp !== 'object') {
    return Object.is(exp, act) ? null : `${at || '.'}: expected ${JSON.stringify(exp)}, got ${JSON.stringify(act)}`;
  }
  if (Array.isArray(exp)) {
    if (!Array.isArray(act)) return `${at || '.'}: expected an array, got ${JSON.stringify(act)}`;
    if (exp.length !== act.length) return `${at || '.'}: expected ${exp.length} item(s), got ${act.length}`;
    for (let i = 0; i < exp.length; i++) {
      const r = subset(exp[i], act[i], `${at}[${i}]`);
      if (r) return r;
    }
    return null;
  }
  if (act === null || typeof act !== 'object') return `${at || '.'}: expected an object, got ${JSON.stringify(act)}`;
  for (const k of Object.keys(exp)) {
    const r = subset(exp[k], act[k], `${at}.${k}`);
    if (r) return r;
  }
  return null;
}

const pos = (d) => (d && d.position && d.position.start) || {};
const order = (a, b) => (pos(a).line || 0) - (pos(b).line || 0) || (pos(a).column || 0) - (pos(b).column || 0) || String(a.code).localeCompare(String(b.code));
const fmt = (d) => `${pos(d).line}:${pos(d).column} ${d.severity} ${d.code}${d.message ? ` — ${d.message}` : ''}`;

function compareDiagnostics(expected, actual, partial = false) {
  const left = [...actual].sort(order);
  const missing = [];
  // Required expectations first, so an optional one never takes their match.
  const sorted = [...expected].sort((a, b) => (a.optional ? 1 : 0) - (b.optional ? 1 : 0) || order(a, b));
  for (const e of sorted) {
    const i = left.findIndex((a) => {
      if (a.code !== e.code) return false;
      const { text, optional, ...rest } = e;
      if (subset(rest, a)) return false;
      return text === undefined || `${a.message || ''}\n${a.hint || ''}`.includes(text);
    });
    if (i >= 0) left.splice(i, 1);
    else if (!e.optional) missing.push(e);
  }
  if (partial) left.length = 0;
  if (!missing.length && !left.length) return null;
  return [
    ...missing.map((d) => `missing    ${fmt(d)}${d.text ? ` "${d.text}"` : ''}`),
    ...left.map((d) => `unexpected ${fmt(d)}`),
  ].join('\n');
}

// ---------------------------------------------------------------- running

function runCase(c, tern) {
  let schema = c.options.has('schema=none') ? { block: {}, leaf: {}, inline: {} } : c.options.has('schema=extended') ? extended : fixture;
  if (c.options.has('strict')) schema = { ...schema, strict: true };
  const opts = { schema, head: c.head };
  if (c.options.has('safe')) opts.safe = true;
  const fails = [];

  try {
    const parsed = tern.parse(c.source, opts);
    const broken = checkParse(parsed, c.source);
    if (broken.length) fails.push(`invariants (test/lib/invariants.js)\n${broken.slice(0, 8).join('\n')}`);
    if (c.ast !== undefined) {
      const r = subset(c.ast, parsed.ast);
      if (r) fails.push(`json ast ${r}`);
    }
    if (c.transformed !== undefined) {
      const ast = tern.transform(tern.parse(c.source, opts).ast, opts);
      const r = subset(c.transformed, ast);
      if (r) fails.push(`json transformed ${r}`);
    }
    if (c.forbidden && c.forbidden.length) {
      const bad = tern.check(c.source, opts).filter((d) => c.forbidden.includes(d.code));
      if (bad.length) fails.push(`diagnostics: forbidden ${bad.map(fmt).join('; ')}`);
    }
    if (!c.options.has('diagnostics=any')) {
      const r = compareDiagnostics(expectedDiagnostics(c) || [], tern.check(c.source, opts), c.options.has('diagnostics=partial'));
      if (r) fails.push(`diagnostics\n${r}`);
    }
    if (c.html !== undefined) {
      const got = normalize(tern.toHTML(c.source, { ...opts, positions: false }));
      const want = normalize(c.html);
      if (got !== want) {
        const i = firstDifference(want, got);
        fails.push(`html\n  expected: ${want}\n  actual:   ${got}\n            ${' '.repeat(Math.min(i, 200))}^ first difference at ${i}`);
      }
    }
  } catch (e) {
    fails.push(`threw: ${(e && e.stack) || e}`);
  }
  return fails;
}

function main() {
  const report = lint();
  if (flag('--open')) {
    for (const c of cases) for (const p of c.prose) if (/^Open:/.test(p)) console.log(`${c.id}  (${c.file}:${c.line})\n    ${p}`);
    process.exit(0);
  }
  if (flag('--lint')) {
    printLint(report);
    const gaps = report.gaps.sections.length + report.gaps.codes.length;
    process.exit(report.problems.length || gaps ? 1 : 0);
  }
  if (report.problems.length) {
    printLint(report);
    console.log('fix the corpus before running it (node test/run.js --lint)');
    process.exit(1);
  }
  const { tern, why } = engine.load();
  if (!tern) {
    console.log(`✗ ${why}`);
    console.log(`  ${cases.length} case(s) not run; node test/run.js --lint checks the corpus alone`);
    process.exit(2);
  }
  const failed = [];
  const t0 = Date.now();
  for (const c of cases) {
    const fails = runCase(c, tern);
    if (fails.length) failed.push({ c, fails });
  }
  const ms = Date.now() - t0;
  const shown = flag('--verbose') ? failed : failed.slice(0, 20);
  for (const { c, fails } of shown) {
    console.log(`\n✗ ${c.id}  (${c.file}:${c.line}; spec ${c.spec.join(' ')})`);
    for (const f of fails) console.log('  ' + f.replace(/\n/g, '\n  '));
  }
  if (failed.length > shown.length) console.log(`\n… and ${failed.length - shown.length} more (--verbose shows all)`);
  const byFile = {};
  for (const { c } of failed) byFile[c.file] = (byFile[c.file] || 0) + 1;
  console.log(
    `\n${cases.length - failed.length}/${cases.length} passed in ${ms} ms` +
      (failed.length ? `; failing by file: ${Object.entries(byFile).map(([f, n]) => `${path.basename(f)} ${n}`).join(', ')}` : ''),
  );
  process.exit(failed.length ? 1 : 0);
}

main();
