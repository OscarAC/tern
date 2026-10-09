#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// cli/language.js, the language features `tern lsp` and editors share,
// called directly. Expectations are stated from the note's text (positions
// found by searching it, in UTF-16 code units) and from the engine, never
// from the module:
//   - the module loads and answers with no Node built-ins and no `process`
//     (a bare vm context, as a browser worker has), and from an analysis
//     built by hand (parse + transform), as an editor builds it;
//   - positions: a head of several lines, line and column edges, astral
//     characters before an id;
//   - definition, references, highlights, hover, prepareRename, rename and
//     its errors, completion and where it offers nothing, symbols, folds,
//     the outline.
//
//   node test/language.js [--verbose]
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const note = require('../cli/note');
const language = require('../cli/language');

const ROOT = path.join(__dirname, '..');
const verbose = process.argv.includes('--verbose');
const { tern } = note;

// ---------------------------------------------------------------- fixtures

// A note with a nine-line head that declares its vocabulary, astral
// characters before references, a nested container, a slug heading with an
// attribute group, fragment links, a footnote, and `@rn` inside a table
// cell's code, a fence, display math, raw HTML and :::meta, where nothing
// is a reference.
const TEXT = `<!doctype html><meta charset="utf-8">
<title>Language</title>
<script>
window.TERN = { schema: {
  block: { theorem: { tag: 'section', counter: 'theorem', label: 'Theorem' }, proof: { label: 'Proof' } },
  inline: { hl: { tag: 'mark' } },
} };
</script>
<script src="tern.js"></script>
:::meta
description: @rn in meta
:::

# Notes

## Kernel {#kernel}

:::theorem[Rank–nullity]{#rn}
𝔸𝔹 @kernel and 😀 @rn.

:::proof
By :hl[hand], see [the theorem](#rn) and [again](<#rn>).
:::/proof
:::/theorem

## Image {.big}

See @rn, @image, @nowhere and a note.[^n]

### Deeper

::toc

## Plain

| A | B |
|---|---|
| @rn | \`@rn\` |

\`\`\`js
@rn
\`\`\`

$$
@rn = 1
$$ {#eq}

<div>
x @rn
</div>

{#para}
A paragraph with an id.

[^n]: About @eq
`;

const HEAD = 9; // file lines before the note: note line 0 is file line 9

// The file position of the nth `needle` in `text`, plus `plus` code units:
// a 0-based line and a UTF-16 column, from JS string indices.
function locate(text, needle, { nth = 0, plus = 0 } = {}) {
  let i = -1;
  for (let k = 0; k <= nth; k++) if ((i = text.indexOf(needle, i + 1)) < 0) throw new Error(`"${needle}" #${nth} not in the text`);
  const before = text.slice(0, i + plus);
  return { line: before.split('\n').length - 1, character: before.length - before.lastIndexOf('\n') - 1 };
}
const at = (needle, opts) => locate(TEXT, needle, opts);
// A range from `needle` (plus `from`) to `to` code units after its start.
const R = (needle, from, to, nth = 0) => {
  const s = at(needle, { nth, plus: from });
  return { start: s, end: { line: s.line, character: s.character + to - from } };
};
const sorted = (list) => list.map((x) => JSON.stringify(x)).sort();
const throws = (fn, code, re) =>
  assert.throws(fn, (e) => {
    assert.ok(e instanceof language.LanguageError && e instanceof Error, `a LanguageError: ${e}`);
    assert.strictEqual(e.name, 'LanguageError');
    assert.strictEqual(e.code, code, e.message);
    if (re) assert.match(e.message, re);
    return true;
  });

const A = note.analyse(TEXT, null);
const D = language.index(A);

// ---------------------------------------------------------------- checks

const checks = [];
const check = (name, fn) => checks.push([name, fn]);

check('the fixture is what the checks assume', () => {
  assert.strictEqual(A.line, HEAD);
  assert.strictEqual(TEXT.split('\n')[HEAD], ':::meta');
  assert.deepStrictEqual(
    A.diagnostics.map((d) => d.code),
    ['ref.dangling'],
    'only @nowhere',
  );
  assert.ok(A.schema.block.theorem && A.schema.inline.hl, 'the head declares the vocabulary');
  assert.ok('😀'.length === 2 && '𝔸𝔹'.length === 4, 'astral characters are two code units');
});

check('no Node built-ins: the module runs in a bare context, from an analysis built by hand', () => {
  // A CommonJS loader over a vm context with no process, Buffer, require or
  // timers: a require of anything but a repository file fails.
  const context = vm.createContext({});
  const cache = new Map();
  const load = (file) => {
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} };
    cache.set(file, module);
    const fn = vm.runInContext(`(function (module, exports, require) {${fs.readFileSync(file, 'utf8')}\n})`, context, { filename: file });
    fn(module, module.exports, (name) => {
      if (!/^\.\.?\//.test(name)) throw new Error(`${path.relative(ROOT, file)} requires "${name}", which is not a file of the repository`);
      return load(require.resolve(path.resolve(path.dirname(file), name)));
    });
    return module.exports;
  };
  const L = load(path.join(ROOT, 'cli', 'language.js'));
  const files = [...cache.keys()].map((f) => path.relative(ROOT, f).split(path.sep).join('/'));
  assert.deepStrictEqual(files.sort(), ['cli/language.js', 'src/scan.js', 'src/schema.js', 'tern.js']);
  // An editor's analysis: the text after the tern.js line, parsed and
  // transformed with the vocabulary, in the context's own engine.
  const T = load(path.join(ROOT, 'tern.js'));
  const split = note.split(TEXT);
  const opts = { schema: JSON.parse(JSON.stringify(A.schema)), head: split.head };
  const { ast, diagnostics } = T.parse(split.note, opts);
  T.transform(ast, opts);
  const a = { note: split.note, line: split.line, ast, diagnostics: diagnostics.concat(ast.data.tern.diagnostics), schema: opts.schema };
  const d = L.index(a);
  const same = (name, x, y) => assert.strictEqual(JSON.stringify(x), JSON.stringify(y), name);
  const call = (fn) => {
    try {
      return fn();
    } catch (e) {
      return { error: e.name, code: e.code, message: e.message };
    }
  };
  for (const [needle, plus] of [['@rn.', 1], ['#rn}', 1], [':::theorem', 4], [':::/proof', 5], ['[^n]', 1], ['See @', 5], ['By :', 4], ['```js\n@', 7]]) {
    const p = at(needle, { plus });
    for (const f of ['definition', 'highlights', 'hover', 'prepareRename', 'completion']) same(`${f} at ${needle}`, call(() => L[f](d, p)), call(() => language[f](D, p)));
    same(`references at ${needle}`, L.references(d, p, { includeDeclaration: true }), language.references(D, p, { includeDeclaration: true }));
  }
  assert.strictEqual(call(() => L.prepareRename(d, at('[^n]', { plus: 1 }))).code, 'refused');
  same('rename', L.rename(d, at('@rn.', { plus: 1 }), 'rank'), language.rename(D, at('@rn.', { plus: 1 }), 'rank'));
  same('symbols', L.symbols(d), language.symbols(D));
  same('folds', L.folds(d), language.folds(D));
  same('outline', L.outline(a), language.outline(A));
  assert.throws(() => L.rename(d, at('@rn.', { plus: 1 }), '9x'), (e) => e instanceof L.LanguageError && e.code === 'invalid');
});

// With esbuild resolvable (NODE_PATH=…/node_modules), the module bundles
// for a browser worker, as an editor builds it (a Node built-in would be an
// error there), and the bundle answers in a bare context.
check('esbuild bundles it for the browser', () => {
  let esbuild;
  try {
    esbuild = require(require.resolve('esbuild'));
  } catch {
    return 'esbuild is not installed';
  }
  const r = esbuild.buildSync({
    stdin: { contents: "self.tern = require('./tern.js'); self.language = require('./cli/language.js');", resolveDir: ROOT, sourcefile: 'worker.js' },
    bundle: true,
    platform: 'browser',
    format: 'iife',
    write: false,
    metafile: true,
    logLevel: 'silent',
  });
  const inputs = Object.keys(r.metafile.inputs).filter((f) => f !== 'worker.js');
  assert.deepStrictEqual(inputs.map((f) => path.relative(ROOT, path.resolve(f)).split(path.sep).join('/')).sort(), ['cli/language.js', 'src/scan.js', 'src/schema.js', 'tern.js']);
  const context = vm.createContext({});
  context.self = context;
  vm.runInContext(r.outputFiles[0].text, context);
  const out = vm.runInContext(
    `const note = '# Top\\n\\nSee @top.\\n';
    const { ast, diagnostics } = tern.parse(note);
    tern.transform(ast);
    JSON.stringify(language.highlights(language.index({ note, line: 3, ast, diagnostics }), { line: 5, character: 5 }));`,
    context,
  );
  assert.deepStrictEqual(JSON.parse(out), [
    { range: { start: { line: 3, character: 0 }, end: { line: 3, character: 5 } }, kind: 'write' },
    { range: { start: { line: 5, character: 4 }, end: { line: 5, character: 8 } }, kind: 'read' },
  ]);
});

check('an analysis by hand of a bare note: no head, line 0, the engine’s registry when no schema is given', () => {
  const src = '# Top\n\nSee @top and :::x\n';
  const { ast, diagnostics } = tern.parse(src);
  tern.transform(ast);
  const d = language.index({ note: src, line: 0, ast, diagnostics });
  assert.deepStrictEqual(language.definition(d, { line: 2, character: 5 }), { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } });
  assert.deepStrictEqual(language.outline({ note: src, line: 0, ast, diagnostics }).headings[0].line, 1);
  assert.ok(language.completion(d, { line: 2, character: 5 }).some((i) => i.label === 'top'));
});

check('a file that is not a note: null everywhere', () => {
  const p = { line: 0, character: 0 };
  assert.strictEqual(language.index(null), null);
  for (const f of ['definition', 'references', 'highlights', 'hover', 'prepareRename', 'rename']) assert.strictEqual(language[f](null, p, 'x'), null, f);
  assert.deepStrictEqual(language.completion(null, p), []);
  assert.deepStrictEqual(language.symbols(null), []);
  assert.deepStrictEqual(language.folds(null), []);
  const o = language.outline(null);
  assert.deepStrictEqual(Object.keys(o).sort(), ['blocks', 'headings', 'inline', 'math', 'raw', 'refs', 'tables']);
  assert.ok(Object.values(o).every((v) => Array.isArray(v) && !v.length));
});

check('positions: file lines past a head of several lines, line and column edges', () => {
  const rn = R('#rn}', 0, 3); // the declaration
  // The first and last characters of `@rn` both hit it, the end included.
  for (const plus of [0, 1, 3]) assert.deepStrictEqual(language.definition(D, at('@rn.', { plus })), rn, `@rn + ${plus}`);
  assert.strictEqual(language.definition(D, at('@rn.', { plus: 4 })), null, 'past the end of `@rn` is the `.`');
  // A column past the end of a line is its end: `@eq` ends the footnote line.
  const end = at('About @eq', { plus: 9 });
  assert.deepStrictEqual(language.definition(D, { ...end, character: 9999 }), R('$$ {#eq}', 4, 7));
  // A negative column is the line's start; a fractional or missing position is none.
  assert.deepStrictEqual(language.hover(D, { line: at('@kernel').line, character: -5 }), null);
  assert.deepStrictEqual(language.hover(D, { line: at('## Kernel').line, character: -5 }).range.start, at('## Kernel'));
  assert.strictEqual(language.definition(D, { line: at('@rn.').line + 0.5, character: 5 }), null);
  assert.strictEqual(language.definition(D, undefined), null);
  assert.strictEqual(language.definition(D, {}), null);
  // Head lines and lines past the end are outside the note.
  for (const line of [0, HEAD - 1, -1, TEXT.split('\n').length, 1e9]) {
    assert.strictEqual(language.hover(D, { line, character: 0 }), null, `line ${line}`);
    assert.deepStrictEqual(language.completion(D, { line, character: 0 }), [], `line ${line}`);
  }
  // The note's first line is file line HEAD.
  assert.strictEqual(language.hover(D, { line: HEAD, character: 4 }).markdown, '`:::meta`, a core block');
});

check('UTF-16: columns after astral characters are code units', () => {
  // `𝔸𝔹 @kernel`: the `@` is at code unit 5 of its line, code point 3.
  const k = at('@kernel');
  assert.strictEqual(k.character, 5);
  assert.deepStrictEqual(language.hover(D, { ...k, character: 6 }).range, R('@kernel', 0, 7));
  assert.deepStrictEqual(language.definition(D, { ...k, character: 6 }), R('{#kernel}', 1, 8));
  const rn = at('😀 @rn');
  assert.deepStrictEqual(language.prepareRename(D, { ...rn, character: rn.character + 4 }), { range: R('😀 @rn', 4, 6), placeholder: 'rn' });
  assert.deepStrictEqual(language.references(D, { ...rn, character: rn.character + 3 }, {})[0], R('😀 @rn', 3, 6));
});

check('definition: from a ref, a fragment link, a footnote reference, a closer; none when dangling', () => {
  const decl = R('#rn}', 0, 3);
  assert.deepStrictEqual(language.definition(D, at('@rn.', { plus: 2 })), decl);
  assert.deepStrictEqual(language.definition(D, at('(#rn)', { plus: 2 })), decl);
  assert.deepStrictEqual(language.definition(D, at('the theorem]')), decl, 'anywhere on the link');
  assert.deepStrictEqual(language.definition(D, at('(<#rn>)', { plus: 3 })), decl);
  assert.deepStrictEqual(language.definition(D, at('[^n]', { plus: 1 })), R('[^n]:', 0, 5));
  assert.deepStrictEqual(language.definition(D, at(':::/theorem', { plus: 6 })), R(':::theorem[', 3, 10));
  assert.deepStrictEqual(language.definition(D, at(':::/proof', { plus: 4 })), R(':::proof\n', 3, 8));
  assert.deepStrictEqual(language.definition(D, at('@image', { plus: 1 })), R('## Image {.big}', 0, 15), 'a slug: its heading');
  assert.strictEqual(language.definition(D, at('@nowhere', { plus: 2 })), null);
  assert.strictEqual(language.definition(D, at('A paragraph')), null);
  assert.strictEqual(language.definition(D, at(':::theorem', { plus: 5 })), null, 'an opener is its own definition');
});

check('references: every use, the declaration first on request; none inside code, math or raw HTML', () => {
  const p = at('#rn}', { plus: 1 });
  const uses = language.references(D, p, { includeDeclaration: false });
  const all = language.references(D, p, { includeDeclaration: true });
  const want = [R('😀 @rn', 3, 6), R('[the theorem](#rn)', 0, 18), R('[again](<#rn>)', 0, 14), R('See @rn', 4, 7), R('| @rn', 2, 5)];
  assert.deepStrictEqual(sorted(uses), sorted(want), 'the refs and the whole fragment links');
  assert.deepStrictEqual(all, [R('#rn}', 0, 3), ...uses]);
  assert.deepStrictEqual(language.references(D, p), uses, 'no options: no declaration');
  assert.deepStrictEqual(language.references(D, at('@eq', { plus: 1 }), { includeDeclaration: true }), [R('$$ {#eq}', 4, 7), R('About @eq', 6, 9)]);
  assert.deepStrictEqual(language.references(D, at('@nowhere'), { includeDeclaration: true }), [R('@nowhere', 0, 8)], 'a dangling id: its uses');
  assert.strictEqual(language.references(D, at(':::theorem', { plus: 4 }), {}), null, 'an element name has no references');
  assert.strictEqual(language.references(D, at('A paragraph'), {}), null);
});

check('highlights: an id’s declaration (write) and uses (read); an element’s name (write) and its closer (read)', () => {
  const want = [
    { range: R('#rn}', 0, 3), kind: 'write' },
    { range: R('😀 @rn', 3, 6), kind: 'read' },
    { range: R('(#rn)', 1, 4), kind: 'read' }, // a fragment link: its `#id`
    { range: R('(<#rn>)', 2, 5), kind: 'read' },
    { range: R('See @rn', 4, 7), kind: 'read' },
    { range: R('| @rn', 2, 5), kind: 'read' },
  ];
  for (const [needle, plus] of [['#rn}', 2], ['@rn.', 0], ['again]', 0], ['| @rn', 4]]) assert.deepStrictEqual(sorted(language.highlights(D, at(needle, { plus }))), sorted(want), needle);
  assert.deepStrictEqual(language.highlights(D, at('[^n]', { plus: 2 })), [
    { range: R('[^n]:', 0, 5), kind: 'write' },
    { range: R('[^n]', 0, 4), kind: 'read' },
  ]);
  assert.deepStrictEqual(language.highlights(D, at('@nowhere')), [{ range: R('@nowhere', 0, 8), kind: 'read' }], 'dangling: its uses only');
  const theorem = [
    { range: R(':::theorem[', 3, 10), kind: 'write' },
    { range: R(':::/theorem', 4, 11), kind: 'read' },
  ];
  assert.deepStrictEqual(language.highlights(D, at(':::theorem', { plus: 3 })), theorem);
  assert.deepStrictEqual(language.highlights(D, at(':::/theorem', { plus: 11 })), theorem);
  assert.deepStrictEqual(language.highlights(D, at(':hl[', { plus: 2 })), [{ range: R(':hl[', 1, 3), kind: 'write' }], 'an inline element: its name');
  assert.deepStrictEqual(language.highlights(D, at('::toc', { plus: 3 })), [{ range: R('::toc', 2, 5), kind: 'write' }], 'a leaf');
  assert.strictEqual(language.highlights(D, at('A paragraph')), null);
  assert.strictEqual(language.highlights(D, at('```js\n@rn', { plus: 7 })), null, 'in a fence');
});

check('hover: label, title, kind and file line; element names; dangling ids', () => {
  const h = language.hover(D, at('| @rn', { plus: 3 }));
  assert.strictEqual(h.markdown, `**Theorem 1 — Rank–nullity**\n\ntheorem · \`#rn\` · line ${at(':::theorem').line + 1}`);
  assert.deepStrictEqual(h.range, R('| @rn', 2, 5));
  assert.strictEqual(language.hover(D, at('About @eq', { plus: 7 })).markdown, `**(1)**\n\nmath · \`#eq\` · line ${at('$$\n@rn').line + 1}`);
  assert.strictEqual(language.hover(D, at('@image', { plus: 1 })).markdown, `**Image**\n\nheading · \`#image\` · line ${at('## Image').line + 1}`);
  assert.strictEqual(language.hover(D, at('[^n]', { plus: 1 })).markdown, `**Footnote 1 — About (1)**\n\nfootnoteDefinition · \`#fn-n\` · line ${at('[^n]:').line + 1}`);
  assert.strictEqual(language.hover(D, at('@nowhere')).markdown, '`@nowhere` names no id in this note');
  assert.strictEqual(language.hover(D, at(':::theorem', { plus: 4 })).markdown, '`:::theorem` → `<section>`, declared in the schema · Theorem 1');
  assert.strictEqual(language.hover(D, at(':hl[', { plus: 1 })).markdown, '`:hl` → `<mark>`, declared in the schema');
  assert.strictEqual(language.hover(D, at('::toc', { plus: 2 })).markdown, '`::toc` → `<div>`, no schema entry');
  assert.strictEqual(language.hover(D, at('A paragraph')), null);
});

check('prepareRename: the characters renamed and their name', () => {
  assert.deepStrictEqual(language.prepareRename(D, at('@rn.', { plus: 2 })), { range: R('@rn.', 1, 3), placeholder: 'rn' });
  assert.deepStrictEqual(language.prepareRename(D, at('#rn}', { plus: 1 })), { range: R('#rn}', 1, 3), placeholder: 'rn' });
  assert.deepStrictEqual(language.prepareRename(D, at('(<#rn>)', { plus: 3 })), { range: R('(<#rn>)', 3, 5), placeholder: 'rn' });
  assert.deepStrictEqual(language.prepareRename(D, at(':::/proof', { plus: 5 })), { range: R(':::/proof', 4, 9), placeholder: 'proof' });
  throws(() => language.prepareRename(D, at('[^n]', { plus: 2 })), 'refused', /generated from a footnote label/);
  throws(() => language.prepareRename(D, at('[^n]:', { plus: 1 })), 'refused');
  assert.strictEqual(language.prepareRename(D, at('A paragraph')), null);
});

check('rename: an id with its declaration and every reference, none in code, math or raw HTML', () => {
  const want = [R('#rn}', 1, 3), R('😀 @rn', 4, 6), R('(#rn)', 2, 4), R('(<#rn>)', 3, 5), R('See @rn', 5, 7), R('| @rn', 3, 5)].map((range) => ({ range, newText: 'rank' }));
  for (const [needle, plus] of [['#rn}', 1], ['@rn.', 1], ['the theorem', 0], ['| @rn', 5]]) assert.deepStrictEqual(sorted(language.rename(D, at(needle, { plus }), 'rank')), sorted(want), needle);
  // Applied, every reference resolves to the new id; the five `@rn` that
  // are not references are untouched.
  const lines = TEXT.split('\n');
  for (const e of want.slice().sort((x, y) => y.range.start.line - x.range.start.line || y.range.start.character - x.range.start.character)) {
    const l = lines[e.range.start.line];
    lines[e.range.start.line] = l.slice(0, e.range.start.character) + e.newText + l.slice(e.range.end.character);
  }
  const b = note.analyse(lines.join('\n'), null);
  assert.ok(b.ast.data.tern.ids.rank && !b.ast.data.tern.ids.rn);
  assert.deepStrictEqual(b.diagnostics.map((d) => d.code), ['ref.dangling']);
  assert.strictEqual((lines.join('\n').match(/@rn\b/g) || []).length, 5, 'meta, a code span, the fence, the math, raw HTML');
  // The same name is allowed; a heading slug gains an explicit id.
  assert.strictEqual(language.rename(D, at('@rn.', { plus: 1 }), 'rn').length, want.length);
  const pos = at('## Kernel', { plus: 4 });
  assert.deepStrictEqual(sorted(language.rename(D, pos, 'ker')), sorted([R('{#kernel}', 2, 8), R('@kernel', 1, 7)].map((range) => ({ range, newText: 'ker' }))), 'an explicit heading id');
  const slug = '# Top\n\nSee @top.\n';
  const s = tern.parse(slug);
  tern.transform(s.ast);
  const d = language.index({ note: slug, line: 0, ast: s.ast, diagnostics: s.diagnostics });
  assert.deepStrictEqual(sorted(language.rename(d, { line: 0, character: 3 }, 'head')), sorted([
    { range: { start: { line: 0, character: 5 }, end: { line: 0, character: 5 } }, newText: ' {#head}' },
    { range: { start: { line: 2, character: 5 }, end: { line: 2, character: 8 } }, newText: 'head' },
  ]));
});

check('rename: an element’s name with its named closer, never other elements of that name', () => {
  const want = [R(':::theorem[', 3, 10), R(':::/theorem', 4, 11)].map((range) => ({ range, newText: 'lemma' }));
  assert.deepStrictEqual(language.rename(D, at(':::theorem', { plus: 5 }), 'lemma'), want);
  assert.deepStrictEqual(language.rename(D, at(':::/theorem', { plus: 6 }), 'lemma'), want);
  assert.deepStrictEqual(language.rename(D, at(':hl[', { plus: 1 }), 'kbd'), [{ range: R(':hl[', 1, 3), newText: 'kbd' }]);
  throws(() => language.rename(D, at(':::theorem', { plus: 5 }), '1st'), 'invalid', /not an element name/);
  throws(() => language.rename(D, at(':::theorem', { plus: 5 }), '_x'), 'invalid');
});

check('rename errors: invalid names, a taken id, a generated id, a slug with other attributes', () => {
  const p = at('@rn.', { plus: 1 });
  for (const bad of ['9x', 'a b', 'a-', 'x:y', 'x.y', '', '-x']) throws(() => language.rename(D, p, bad), 'invalid', /is not an id @ can reach/);
  throws(() => language.rename(D, p, undefined), 'invalid', /needs a newName/);
  throws(() => language.rename(D, p, 42), 'invalid');
  throws(() => language.rename(D, p, 'kernel'), 'invalid', /the id "kernel" is already used in this note/);
  throws(() => language.rename(D, p, 'fn-n'), 'invalid', /already used/);
  throws(() => language.rename(D, at('[^n]', { plus: 1 }), 'note'), 'refused', /"fn-n" is generated from a footnote label/);
  throws(() => language.rename(D, at('@image', { plus: 1 }), 'img'), 'refused', /the heading's id is its slug; write \{#image\} in its attribute group first/);
  throws(() => language.rename(D, at('## Image', { plus: 4 }), 'img'), 'refused');
  assert.strictEqual(language.rename(D, at('A paragraph'), 'x'), null, 'nothing to rename: null before the name is checked');
  assert.strictEqual(language.rename(D, { line: 9999, character: 0 }), null);
});

check('completion: names by level and kind, closers, ids, with the range they replace', () => {
  // Insert a trigger into the fixture, on its own line after `needle`.
  const complete = (needle, typed) => {
    const i = TEXT.indexOf(needle) + needle.length;
    const text = `${TEXT.slice(0, i)}\n${typed}\n${TEXT.slice(i)}`;
    const p = { line: at(needle).line + 1, character: typed.length };
    const a = note.analyse(text, null);
    return { p, items: language.completion(language.index(a), p) };
  };
  const label = (items) => items.map((i) => i.label);
  const { p, items } = complete('By :hl[hand], see [the theorem](#rn) and [again](<#rn>).', ':::');
  const kinds = {};
  for (const i of items) kinds[i.label] = i.kind;
  assert.deepStrictEqual(label(items).slice(0, 2), ['/proof', '/theorem'], 'closers first, innermost first');
  assert.deepStrictEqual([kinds['/proof'], kinds.theorem, kinds.proof, kinds.meta, kinds.macros, kinds.section, kinds.details], ['closer', 'name', 'name', 'core', 'core', 'element', 'element']);
  const close = items[0];
  // An item replaces what is typed after the colons: here, nothing.
  assert.deepStrictEqual(close, { label: '/proof', kind: 'closer', detail: `closes :::proof (line ${at(':::proof\n').line + 1})`, sortText: '0/proof', filterText: '/proof', range: { start: p, end: p }, newText: '/proof' });
  assert.deepStrictEqual(items.find((i) => i.label === 'theorem'), { label: 'theorem', kind: 'name', detail: 'schema → <section>', sortText: '1theorem', filterText: 'theorem', range: { start: p, end: p }, newText: 'theorem' });
  const typed = complete('By :hl[hand], see [the theorem](#rn) and [again](<#rn>).', '> :::/th');
  assert.deepStrictEqual(typed.items[0].range, { start: { line: typed.p.line, character: 5 }, end: typed.p }, 'from the `/`, in a quote');
  assert.strictEqual(items.find((i) => i.label === 'meta').sortText, '2meta');
  assert.strictEqual(items.find((i) => i.label === 'aside').detail, '<aside>');
  assert.ok(items.every((i, k) => !k || items[k - 1].sortText[0] <= i.sortText[0]), 'in the order closers, the schema, core, the allowlist');
  assert.deepStrictEqual(label(complete('By :hl[hand], see [the theorem](#rn) and [again](<#rn>).', ':::/').items), ['/proof', '/theorem'], 'only the closers');
  assert.deepStrictEqual(label(complete('By :hl[hand], see [the theorem](#rn) and [again](<#rn>).', ':::/the').items), ['/proof', '/theorem'], 'closers, the client filters');
  const leaf = complete('A paragraph with an id.', '::').items;
  assert.ok(label(leaf).includes('video') && !label(leaf).includes('theorem') && !label(leaf).includes('/theorem'), 'leaf names');
  const inline = complete('A paragraph with an id.', 'Press :k').items;
  assert.deepStrictEqual(inline[0], { label: 'hl', kind: 'name', detail: 'schema → <mark>', sortText: '1hl', filterText: 'hl', range: { start: { line: at('A paragraph').line + 1, character: 7 }, end: { line: at('A paragraph').line + 1, character: 8 } }, newText: 'hl' });
  assert.ok(label(inline).includes('kbd') && !label(inline).includes('section'), 'inline names');
  const ids = complete('A paragraph with an id.', 'See @r').items;
  assert.deepStrictEqual(ids.find((i) => i.label === 'rn'), { label: 'rn', kind: 'id', detail: 'Theorem 1 — Rank–nullity', sortText: 'rn', filterText: 'rn', range: { start: { line: at('A paragraph').line + 1, character: 5 }, end: { line: at('A paragraph').line + 1, character: 6 } }, newText: 'rn' });
  assert.deepStrictEqual(label(ids).sort(), ['eq', 'fn-n', 'image', 'kernel', 'notes', 'para', 'plain', 'deeper', 'rn'].sort(), 'every id @ can reach, no fnref-');
  assert.ok(label(complete('A paragraph with an id.', 'Go [there](#').items).includes('rn'), 'after ](#');
  assert.deepStrictEqual(complete('A paragraph with an id.', 'mail x@').items, [], 'not after a letter');
  assert.deepStrictEqual(complete('A paragraph with an id.', 'http:').items, [], 'not after a letter');
});

check('completion: nothing inside code, math, raw HTML or a raw body', () => {
  const none = (needle, plus) => assert.deepStrictEqual(language.completion(D, at(needle, { plus })), [], needle);
  none('```js\n@', 7); // after the `@` in the fence
  none('$$\n@rn', 4); // display math
  none('`@rn`', 2); // a code span
  none('x @rn\n</div>', 3); // raw HTML
  none('description: @', 14); // :::meta's raw body
  // And it does offer, just outside them.
  assert.ok(language.completion(D, at('| @rn', { plus: 3 })).some((i) => i.label === 'rn'), 'a table cell is not code');
  const math = 'x $a @' ;
  const s = tern.parse(math);
  tern.transform(s.ast);
  assert.deepStrictEqual(language.completion(language.index({ note: math, line: 0, ast: s.ast, diagnostics: s.diagnostics }), { line: 0, character: 6 }), [], 'unclosed inline math is text, still not offered');
});

check('symbols: headings nest by depth, containers hold what they contain, leaves', () => {
  const syms = language.symbols(D);
  const tree = (list) => list.map((s) => [s.name, s.detail, s.kind, s.range.start.line, s.range.end.line, ...(s.children.length ? [tree(s.children)] : [])]);
  const L = (needle) => at(needle).line;
  assert.deepStrictEqual(tree(syms), [
    ['meta', ':::meta', 'container', L(':::meta'), L(':::meta') + 2],
    ['Notes', '# #notes', 'heading', L('# Notes'), L('[^n]:'), [
      ['Kernel', '## #kernel', 'heading', L('## Kernel'), L(':::/theorem'), [
        ['Theorem 1 — Rank–nullity', ':::theorem #rn', 'container', L(':::theorem'), L(':::/theorem'), [
          ['Proof', ':::proof', 'container', L(':::proof\n'), L(':::/proof')],
        ]],
      ]],
      ['Image', '## #image', 'heading', L('## Image'), L('::toc'), [
        ['Deeper', '### #deeper', 'heading', L('### Deeper'), L('::toc'), [
          ['toc', '::toc', 'leaf', L('::toc'), L('::toc')],
        ]],
      ]],
      ['Plain', '## #plain', 'heading', L('## Plain'), L('[^n]:')],
    ]],
  ]);
  // selectionRange is the element; a heading's range is its section.
  const walk = (list) => list.every((s) => JSON.stringify(s.selectionRange) === JSON.stringify(s.kind === 'heading' ? { start: s.range.start, end: { line: s.range.start.line, character: TEXT.split('\n')[s.range.start.line].length } } : s.range) && walk(s.children));
  assert.ok(walk(syms), 'selectionRange');
  assert.deepStrictEqual(syms[1].children[0].range.start, at('## Kernel'));
  assert.deepStrictEqual(syms[1].children[0].children[0].range.end, at(':::/theorem', { plus: 11 }), 'a section ends at the end of its last block');
});

check('folds: blocks over two lines or more, and heading sections, in 0-based file lines', () => {
  const L = (needle, nth) => at(needle, { nth }).line;
  const folds = language.folds(D).map((f) => `${f.startLine}-${f.endLine}`);
  const want = {
    meta: `${L(':::meta')}-${L(':::meta') + 2}`,
    theorem: `${L(':::theorem')}-${L(':::/theorem')}`,
    proof: `${L(':::proof\n')}-${L(':::/proof')}`,
    table: `${L('| A')}-${L('| @rn')}`,
    fence: `${L('```js')}-${L('```', 1)}`,
    math: `${L('$$\n')}-${L('$$ {#eq}')}`,
    html: `${L('<div>')}-${L('</div>')}`,
    notes: `${L('# Notes')}-${L('[^n]:')}`,
    kernel: `${L('## Kernel')}-${L(':::/theorem')}`,
    image: `${L('## Image')}-${L('::toc')}`,
    deeper: `${L('### Deeper')}-${L('::toc')}`,
    plain: `${L('## Plain')}-${L('[^n]:')}`,
  };
  assert.deepStrictEqual(folds.slice().sort(), Object.values(want).sort());
  assert.ok(language.folds(D).every((f) => Object.keys(f).join() === 'startLine,endLine'));
});

check('outline: tern.outline with 1-based file lines', () => {
  const o = language.outline(A);
  const raw = tern.outline(A.ast);
  assert.deepStrictEqual(Object.keys(o), Object.keys(raw));
  assert.deepStrictEqual(o.headings.map((h) => [h.text, h.line]), [['Notes', L1('# Notes')], ['Kernel', L1('## Kernel')], ['Image', L1('## Image')], ['Deeper', L1('### Deeper')], ['Plain', L1('## Plain')]]);
  const theorem = o.blocks.find((b) => b.name === 'theorem');
  assert.deepStrictEqual([theorem.line, theorem.endLine], [L1(':::theorem'), L1(':::/theorem')]);
  for (const k in raw) for (let i = 0; i < raw[k].length; i++) assert.strictEqual(o[k][i].line, raw[k][i].line + HEAD, `${k}[${i}]`);
  const ref = o.refs.find((r) => r.id === 'kernel');
  assert.deepStrictEqual([ref.line, ref.col, ref.end], [L1('@kernel'), at('@kernel').character + 1, at('@kernel').character + 8], 'columns are 1-based UTF-16');
});
function L1(needle) {
  return at(needle).line + 1;
}

// ---------------------------------------------------------------- run

let failed = 0;
for (const [name, fn] of checks) {
  try {
    const skipped = fn();
    console.log(skipped ? `- ${name}: skipped, ${skipped}` : `✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`✗ ${name}\n    ${String((e && e.message) || e).split('\n').join('\n    ')}`);
    if (verbose && e && e.stack) console.log(e.stack);
  }
}
console.log(`\n${checks.length - failed}/${checks.length} language checks pass`);
process.exit(failed ? 1 : 0);
