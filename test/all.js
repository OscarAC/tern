#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// `npm test`: every Node harness in turn, with one summary line each.
// Browser smoke tests are separate (`npm run smoke`): they need Playwright.
'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const STEPS = [
  ['build check', ['../tools/concat.js', '--check']],
  ['corpus lint', ['run.js', '--lint']],
  ['conformance', ['run.js']],
  ['api', ['api.js']],
  ['samples', ['samples.js']],
  ['perf', ['perf.js']],
  ['fuzz', ['fuzz.js', '--seconds=10']],
  ['cli', ['cli.js']],
  ['language', ['language.js']],
  ['lsp', ['lsp.js']],
  ['docs', ['docs.js']],
];
const STATUS = { 0: 'pass', 1: 'FAIL', 2: 'no engine' };

let worst = 0;
const rows = [];
for (const [name, argv] of STEPS) {
  const t = Date.now();
  const r = spawnSync(process.execPath, [path.join(__dirname, argv[0]), ...argv.slice(1)], { stdio: 'inherit' });
  const code = r.status === null ? 1 : r.status;
  worst = Math.max(worst, code ? 1 : 0);
  rows.push(`${(STATUS[code] || `exit ${code}`).padEnd(10)} ${name.padEnd(12)} ${((Date.now() - t) / 1000).toFixed(1)} s`);
  console.log('');
}
console.log(rows.join('\n'));
process.exit(worst);
