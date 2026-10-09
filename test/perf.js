#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Performance budgets. Two checks per case:
//
// 1. Budget. Time ≤ max(FLOOR, RATE × KB × FACTOR × machine). RATE is the
//    previous renderer's slowest good case (tag v0.1-legacy, its index.html:
//    0.19 ms/KB); FACTOR is 2; `machine` scales for a slower computer by
//    timing a fixed calibration workload against the reference machine's
//    time (test/lib/calibrate.js).
// 2. Linearity, for generated inputs. 4× the input may cost at most 6× the
//    time (linear is 4×; quadratic is 16×). A step over 6× is re-measured
//    from 4× to 16×, and fails only if that step is over 6× too. Growth is
//    measured in a child process with a larger young generation (see
//    growthChild), so that it measures the parser and not V8's heap sizing.
//
// The cases are inputs known to make Markdown-like parsers slow, plus one
// generator per linear-time claim of the inline parser
// (docs/syntax-inline.html#properties).
//
//   node test/perf.js [--filter=TEXT] [--factor=N]
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const engine = require('./lib/engine');
const fixture = require('./fixtures/schema');
const calibration = require('./lib/calibrate');

const RATE_MS_PER_KB = 0.19;
const FLOOR_MS = 10;
const args = process.argv.slice(2);
const opt = (k) => (args.find((a) => a.startsWith(`--${k}=`)) || '').slice(k.length + 3) || null;
const FACTOR = Number(opt('factor') || process.env.PERF_FACTOR || 2);

const rep = (s, n) => s.repeat(n);
const note = (f) => {
  const s = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  const i = s.indexOf('\n', s.search(/<script\b[^>]*tern\.js/));
  return s.slice(i + 1);
};
const samples = () =>
  fs
    .readdirSync(path.join(__dirname, 'samples'))
    .filter((f) => f.endsWith('.html') && !f.endsWith('.excerpt.html'))
    .sort()
    .map((f) => note(path.join('test', 'samples', f)))
    .join('\n');

// gen(n) builds the input; n is the base size for the linearity check.
const CASES = [
  // Exponential emphasis, deep stacks, long runs, the depth cap.
  { name: 'emphasis *a **b (audit: exponential)', gen: (n) => rep('*a **b ', n), n: 4000 },
  { name: 'emphasis *a **b ×26 (audit repro)', input: () => rep('*a **b ', 26) },
  { name: 'emphasis **a* unclosed (audit: stack)', gen: (n) => rep('**a*', n), n: 4000 },
  { name: 'prices $5 and $10 (audit: 100 KB)', gen: (n) => rep('$5 and $10 ', n), n: 2400 },
  { name: 'star sandwich *×N x *×N', gen: (n) => rep('*', n) + ' x ' + rep('*', n), n: 10000 },
  { name: 'inline element :a[ unclosed', gen: (n) => rep(':a[', n), n: 5000 },
  { name: 'quote markers >>> (paragraph)', gen: (n) => rep('>', n), n: 6000 },
  { name: 'nested quotes > > > (depth cap)', gen: (n) => rep('> ', n) + 'x\n', n: 3000 },
  { name: 'flat list of items', gen: (n) => rep('- item\n', n), n: 12500 },
  { name: 'one long fence line', gen: (n) => '```\n' + rep('x', n) + '\n```\n', n: 50000 },
  { name: 'containers at the depth cap', input: () => rep(':::d\n', 64) + 'x\n' + rep(':::\n', 64) },
  { name: 'container openers past the cap', gen: (n) => rep(':::d\n', n), n: 5000 },
  // Openers that never close, and prose that looks like markup.
  { name: 'emphasis *.c **/*.h (globs)', gen: (n) => rep('*.c **/*.h ', n), n: 3000 },
  { name: 'emphasis **a *a', gen: (n) => rep('**a *a ', n), n: 4000 },
  { name: 'prose with *args and **kwargs', gen: (n) => rep('In Python, *args collects positional arguments and **kwargs collects keyword arguments. ', n), n: 300 },
  { name: 'unclosed *word openers', gen: (n) => rep('*word ', n), n: 8000 },
  { name: 'unclosed [a openers', gen: (n) => rep('[a ', n), n: 8000 },
  { name: 'unclosed ~~a openers', gen: (n) => rep('~~a ', n), n: 4000 },
  { name: 'unclosed ==a openers', gen: (n) => rep('==a ', n), n: 4000 },
  { name: 'one 100 KB paragraph of prices', gen: (n) => rep('costs $5 and $10 ', n), n: 1500 },
  { name: 'a lone $ every 100 chars', gen: (n) => rep('x'.repeat(98) + ' $', n), n: 250 },
  { name: 'unclosed ``` code span with a long tail', gen: (n) => '```' + rep('a', n) + '`', n: 50000 },
  { name: 'shell lines with $HOME (baseline)', gen: (n) => rep('export PATH=$HOME/bin:$PATH\n', n), n: 1000 },
  { name: 'log lines with [brackets] (baseline)', gen: (n) => rep('[2024-01-01 12:00:00] [INFO] served\n', n), n: 2000 },
  { name: 'container openers, never closed', gen: (n) => rep(':::a\n', n), n: 2000 },
  { name: 'nested :a[ … ] elements', gen: (n) => rep(':a[', n) + 'x' + rep(']', n), n: 1250 },
  { name: 'list nested by indentation', gen: (n) => Array.from({ length: n }, (_, i) => ' '.repeat(2 * (i % 500)) + '- x').join('\n'), n: 500 },
  // One per linear-time claim of the inline parser.
  { name: 'backtick runs of growing length', gen: (n) => Array.from({ length: n }, (_, i) => rep('`', (i % 200) + 1)).join(' '), n: 400 },
  { name: 'unclosed $ openers', gen: (n) => rep('$a ', n), n: 8000 },
  { name: 'unclosed $\\ openers (info each)', gen: (n) => rep('$\\a ', n), n: 6000 },
  { name: 'verbatim math $` unclosed', gen: (n) => rep('$` ', n), n: 8000 },
  { name: 'angle brackets < without >', gen: (n) => rep('<a ', n), n: 8000 },
  { name: 'inline comments <!-- unclosed', gen: (n) => rep('<!-- ', n), n: 5000 },
  { name: 'open braces {{{{', gen: (n) => rep('{', n), n: 20000 },
  { name: 'attribute candidates {#a .b', gen: (n) => rep('[x]{#a .b ', n), n: 3000 },
  { name: 'open brackets [[[[', gen: (n) => rep('[', n), n: 20000 },
  { name: 'link openers [a](', gen: (n) => rep('[a](', n), n: 5000 },
  { name: 'nested parens in a destination', gen: (n) => '[a](' + rep('(', n) + ')', n: 20000 },
  { name: 'references @a (dangling each)', gen: (n) => rep('@a ', n), n: 8000 },
  { name: 'footnote references', gen: (n) => rep('x[^a] ', n) + '\n\n[^a]: note\n', n: 5000 },
  { name: 'bare URLs', gen: (n) => rep('https://a.b/c ', n), n: 3000 },
  { name: 'table with continued rows', gen: (n) => '| a | b |\n|---|---|\n' + rep('| $x | y\\\n', n) + '| z |\n', n: 3000 },
  { name: 'unclosed raw <div> lines', gen: (n) => rep('<div>\n', n), n: 6000 },
  { name: 'raw <div> nesting on one line', gen: (n) => rep('<div>', n) + rep('</div>', n) + '\n', n: 5000 },
  { name: 'alternating $$ lines', gen: (n) => rep('$$\nx\n', n), n: 6000 },
  { name: 'attribute lines', gen: (n) => rep('{.a}\n', n) + 'x\n', n: 6000 },
  // Documents.
  { name: 'the five sample notes', input: samples },
  { name: '10k lines of sample notes (≤ 100 ms)', input: () => { const s = samples(); return rep(s + '\n', Math.ceil(10000 / s.split('\n').length)); }, budget: 100 },
];

// The fastest of several runs after a warm-up: the engine's own cost. On a
// shared or throttled machine the median can be twice the minimum, so a
// median budget would measure the machine.
function timeIt(run, input) {
  run(input); // warm up
  const reps = input.length > 500000 ? 5 : 9;
  let best = Infinity;
  for (let i = 0; i < reps; i++) {
    const t = process.hrtime.bigint();
    run(input);
    best = Math.min(best, Number(process.hrtime.bigint() - t) / 1e6);
  }
  return best;
}

// The growth check for one generated case: 4× the input, and when that step
// costs over 6×, the next 4× step too (a one-off step is not growth).
function growth(run, c) {
  const small = timeIt(run, c.gen(c.n));
  const big = timeIt(run, c.gen(c.n * 4));
  const ratio = big / Math.max(small, 0.25);
  if (small < 1 || ratio <= 6) return { ratio };
  const next = timeIt(run, c.gen(c.n * 16)) / big;
  return { ratio, next, problem: next > 6 ? `4× the input took ${ratio.toFixed(1)}× the time, then ${next.toFixed(1)}× (superlinear)` : null };
}

// Growth is measured in a child process with a 64 MB young generation, so it
// measures the parser: with V8's default, a single paragraph of a few hundred
// KB outgrows the young generation and the copying it then does raises the
// cost per KB once, by up to 3×. Budgets are measured here, with V8's
// defaults, which is what users get.
const GROWTH_FLAG = '--max-semi-space-size=64';

function growthChild(filter) {
  const argv = [GROWTH_FLAG, __filename, '--growth', ...(filter ? [`--filter=${filter}`] : [])];
  const r = spawnSync(process.execPath, argv, { encoding: 'utf8', maxBuffer: 1 << 24 });
  if (r.status !== 0) throw new Error(`growth child failed: ${r.stderr || r.stdout}`);
  return JSON.parse(r.stdout);
}

function main() {
  const { tern, why } = engine.load();
  if (!tern) {
    console.log(`✗ ${why}`);
    process.exit(2);
  }
  const opts = { schema: fixture };
  const run = (s) => tern.toHTML(s, opts);
  const filter = opt('filter');
  const cases = CASES.filter((c) => !filter || c.name.includes(filter));
  if (args.includes('--growth')) {
    const out = {};
    for (const c of cases) if (c.gen) out[c.name] = growth(run, c);
    process.stdout.write(JSON.stringify(out));
    return;
  }
  const { ms: cal, factor: machine } = calibration.machineFactor();
  console.log(`engine: parse+transform+emit; budget ${FACTOR}× the legacy rate, machine factor ${machine.toFixed(2)} (calibration ${cal.toFixed(1)} ms)`);
  const grown = growthChild(filter);
  let failed = 0;
  for (const c of cases) {
    const input = c.input ? c.input() : c.gen(c.n * 4);
    const kb = input.length / 1024;
    const budget = (c.budget || Math.max(FLOOR_MS, RATE_MS_PER_KB * kb * FACTOR)) * machine;
    const problems = [];
    let ms = NaN;
    try {
      ms = timeIt(run, input);
      if (ms > budget) problems.push(`${ms.toFixed(1)} ms > budget ${budget.toFixed(1)} ms`);
    } catch (e) {
      problems.push(`threw: ${(e && e.message) || e}`);
    }
    const g = grown[c.name];
    if (g && g.problem) problems.push(g.problem);
    if (problems.length) failed++;
    console.log(
      `${problems.length ? '✗' : '✓'} ${c.name.padEnd(52)} ${(kb.toFixed(0) + ' KB').padStart(8)} ${(isNaN(ms) ? '—' : ms.toFixed(1) + ' ms').padStart(10)}` +
        `${g ? `  ×${g.ratio.toFixed(1)}${g.next ? `→${g.next.toFixed(1)}` : ''}` : ''}${problems.length ? '  ' + problems.join('; ') : ''}`,
    );
  }
  console.log(failed ? `\n${failed} case(s) over budget` : '\nall within budget');
  process.exit(failed ? 1 : 0);
}

if (process.argv.includes('--calibrate')) console.log(calibration.measure().toFixed(2));
else main();
