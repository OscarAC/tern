#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Engine API behaviour that the corpus cannot express: a case cannot
// register a transform, and the corpus lint keeps runtime codes such as
// addon.failed out of it (test/run.js); nor can it bring a schema the
// fixtures don't hold (equations within sections, a label function under
// `within`, conflicting or invalid values). Runs on tern.js, or $TERN_ENGINE.
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

// ---------------------------------------------------------------- within

// The labels of a note's counted elements and equations, in document order.
const labels = (src, schema) =>
  [...tern.toHTML(src, { schema }).matchAll(/<span class="t-(?:label|eqno)">([^<]*)<\/span>/g)].map((m) => m[1]);
const thm = (extra) => ({ block: { theorem: Object.assign({ counter: 'theorem', label: 'Theorem' }, extra) } });

test('within: equations follow an entry on the equation counter', () => {
  const schema = { block: { theorem: { counter: 'theorem', label: 'Theorem' }, eq: { counter: 'equation', within: 'h2' } } };
  const src = '$$ a $$ {#a}\n\n## One\n\n$$ b $$ {#b}\n\n$$ c $$ {#c}\n\n## Two\n\n$$ d $$ {#d}\n\nSee @c.\n';
  eq(labels(src, schema), ['(0.1)', '(1.1)', '(1.2)', '(2.1)'], 'equation numbers');
  eq(/href="#c">\(1\.2\)</.test(tern.toHTML(src, { schema })), true, 'the reference reads (1.2)');
});

test('within: a label function gets the number as shown', () => {
  const seen = [];
  const schema = thm({ within: 'h2', label: (n) => (seen.push(n), `Satz ${n}`) });
  eq(labels('## A\n\n:::theorem\n:::\n', schema), ['Satz 1.1'], 'label');
  eq(seen.includes('1.1'), true, 'n is "1.1"');
  const plain = [];
  labels(':::theorem\n:::\n', thm({ label: (n) => (plain.push(n), 'x') }));
  eq(plain.includes(1), true, 'without within, n stays a number');
});

test('within: entries that share a counter and disagree take the first', () => {
  const schema = { block: { theorem: { counter: 'theorem', label: 'Theorem', within: 'h2' }, lemma: { counter: 'theorem', label: 'Lemma', within: 'h3' } } };
  eq(labels('## A\n\n### a\n\n:::theorem\n:::\n\n:::lemma\n:::\n', schema), ['Theorem 1.1', 'Lemma 1.2'], 'labels');
});

test('within: a value other than h1-h6, or an entry with no counter, changes nothing', () => {
  for (const within of ['section', 'h7', 2, '', null, 'H2 '])
    eq(labels('## A\n\n:::theorem\n:::\n', thm({ within })), [within === 'H2 ' ? 'Theorem 1.1' : 'Theorem 1'], `within ${JSON.stringify(within)}`);
  eq(labels('## A\n\n:::proof\n:::\n', { block: { proof: { label: 'Proof', within: 'h2' } } }), ['Proof'], 'no counter');
});

test('within: a heading inside a dropped footnote definition counts for nothing', () => {
  const src = 'A[^a].\n\n[^a]: First.\n\n[^a]:\n    ## Dropped\n\n## One\n\n:::theorem\n:::\n';
  eq(labels(src, thm({ within: 'h2' })), ['Theorem 1.1'], 'labels');
});

console.log(results.join('\n'));
console.log(`\n${results.length - failed}/${results.length} API checks pass`);
process.exit(failed ? 1 : 0);
