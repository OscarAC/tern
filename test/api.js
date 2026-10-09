#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Engine API behaviour that the corpus cannot express: a case cannot
// register a transform, and the corpus lint keeps runtime codes such as
// addon.failed out of it (test/run.js). Runs on tern.js, or $TERN_ENGINE.
//
//   node test/api.js
'use strict';

const engine = require('./lib/engine');

const { tern, why } = engine.load();
if (!tern) {
  console.log(`✗ ${why}`);
  process.exit(2);
}

let failed = 0;
const results = [];
function test(name, fn) {
  try {
    fn();
    results.push(`✓ ${name}`);
  } catch (e) {
    failed++;
    results.push(`✗ ${name}\n  ${(e && e.message) || e}`);
  }
}
function eq(a, b, what) {
  const x = JSON.stringify(a);
  const y = JSON.stringify(b);
  if (x !== y) throw new Error(`${what}: got ${x}, want ${y}`);
}
// Registers transforms for one test and removes them after it.
function withTransforms(list, fn) {
  const off = list.map(([name, f, where]) => tern.transform(name, f, where));
  try {
    fn();
  } finally {
    for (const o of off.reverse()) o();
  }
}
const HEAD = { start: { line: 0, column: 0, offset: 0 }, end: { line: 0, column: 0, offset: 0 } };

test('a registered transform that throws is addon.failed at line 0; the others still run', () => {
  withTransforms(
    [
      ['boom', () => { throw new Error('kaput'); }, { before: 'ids' }],
      ['after', (ast, ctx) => ctx.report('api.ran', ast, 'ran', null, 'info')],
    ],
    () => {
      const ds = tern.check('## A\n\nSee @a.\n');
      eq(ds.map((d) => d.code), ['addon.failed', 'api.ran'], 'codes (ids and refs ran: no ref.dangling)');
      const d = ds[0];
      eq([d.severity, d.message], ['error', 'the transform "boom" threw: kaput; the note renders without it'], 'severity and message');
      eq(d.position, HEAD, 'position: line 0, as the runtime positions add-on problems');
      eq(tern.toHTML('## A\n\nSee @a.\n', { positions: false }), '<h2 id="a">A</h2>\n<p>See <a class="t-ref" href="#a">A</a>.</p>\n', 'the note renders');
    },
  );
});

test('a thrown non-Error is shown as a string', () => {
  withTransforms([['str', () => { throw 'plain'; }]], () => {
    eq(tern.check('x\n').map((d) => d.message), ['the transform "str" threw: plain; the note renders without it'], 'message');
  });
});

test('one report per throw, each transform on its own', () => {
  withTransforms(
    [
      ['one', () => { throw new Error('a'); }],
      ['two', () => { throw new Error('b'); }],
    ],
    () => eq(tern.check('x\n').map((d) => d.message.slice(0, 26)), ['the transform "one" threw:', 'the transform "two" threw:'], 'two reports'),
  );
});

test('a function that catches its own error (as the CLI wraps add-on transforms) leaves nothing to report', () => {
  const seen = [];
  const wrap = (f) => (ast, ctx) => {
    try {
      return f(ast, ctx);
    } catch (e) {
      seen.push(e.message);
    }
  };
  withTransforms([['wrapped', wrap(() => { throw new Error('w'); })]], () => {
    eq(tern.check('x\n'), [], 'no engine diagnostic');
    eq(seen, ['w'], 'the wrapper saw the error once');
  });
});

console.log(results.join('\n'));
console.log(`\n${results.length - failed}/${results.length} API checks pass`);
process.exit(failed ? 1 : 0);
