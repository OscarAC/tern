// SPDX-License-Identifier: MIT
// A fixed workload shaped like a parser's (scanning, splitting, regex,
// allocation), timed so budgets can scale to the machine running them.
'use strict';

const REFERENCE_MS = 53.5; // the reference machine (8 CPUs, idle), 2026-10-07

function calibrate() {
  const s = 'word *em* `code` $x$ [link](u) '.repeat(20000);
  const t = process.hrtime.bigint();
  let k = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 42) k++;
  const parts = s.split(/(?=[*`$[])/);
  const out = parts.map((p) => p.replace(/[&<>]/g, (c) => '&#' + c.charCodeAt(0) + ';')).join('');
  return Number(process.hrtime.bigint() - t) / 1e6 + (k + out.length) * 0;
}

// Best of five, so a busy moment does not inflate the factor.
function measure() {
  return Math.min(...[0, 1, 2, 3, 4].map(calibrate));
}

// ≥ 1: how much slower this machine is than the reference.
function machineFactor() {
  const ms = measure();
  return { ms, factor: Math.max(1, ms / REFERENCE_MS) };
}

module.exports = { measure, machineFactor };
