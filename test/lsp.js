#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// The language server over stdio: spawns `node tern-cli.js lsp` and drives
// it as an editor would. Expectations come from the engine (cli/note.js
// `analyse`, the AST), never from the server:
//   - published diagnostics equal the engine's, mapped to LSP;
//   - rename edits equal the engine's reference set, none in code or math;
//   - definition, references, hover, completion, documentSymbol,
//     foldingRange, documentHighlight, the `tern/outline` notification, the
//     150 ms debounce;
//   - a single-file note's own vocabulary (window.TERN.schema);
//   - add-on transforms run for their own note only, data-lang's label
//     language, addon.remote;
//   - a non-note .html file, add-on caching, malformed input, shutdown, exit.
//
//   node test/lsp.js [--verbose]
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');
const note = require('../cli/note');
const fixture = require('./fixtures/schema');

const CLI = path.join(__dirname, '..', 'tern-cli.js');
const SAMPLES = path.join(__dirname, 'samples');
const verbose = process.argv.includes('--verbose');

// ---------------------------------------------------------------- client

class Client {
  constructor() {
    this.proc = spawn(process.execPath, [CLI, 'lsp'], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.buf = Buffer.alloc(0);
    this.id = 0;
    this.pending = new Map();
    this.inbox = []; // notifications, and responses to no request (id null)
    this.log = []; // every notification, in order, with its arrival time
    this.waiters = [];
    this.garbage = ''; // anything on stdout that is not a framed message
    this.stderr = '';
    this.proc.stdout.on('data', (c) => this.data(c));
    this.proc.stderr.on('data', (c) => (this.stderr += c));
    this.exited = new Promise((resolve) => this.proc.on('exit', (code) => resolve(code)));
  }
  data(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (let sep; (sep = this.buf.indexOf('\r\n\r\n')) >= 0; ) {
      const m = /^Content-Length: (\d+)$/.exec(this.buf.toString('ascii', 0, sep));
      if (!m) {
        this.garbage += this.buf.toString('utf8', 0, sep + 4);
        this.buf = this.buf.subarray(sep + 4);
        continue;
      }
      const end = sep + 4 + Number(m[1]);
      if (this.buf.length < end) return;
      const msg = JSON.parse(this.buf.toString('utf8', sep + 4, end));
      this.buf = this.buf.subarray(end);
      const done = msg.id != null && !msg.method && this.pending.get(msg.id);
      if (done) this.pending.delete(msg.id), done(msg);
      else {
        if (msg.method) this.log.push({ msg, at: Date.now() });
        this.inbox.push(msg);
        this.waiters = this.waiters.filter((w) => !w());
      }
    }
  }
  write(text) {
    this.proc.stdin.write(`Content-Length: ${Buffer.byteLength(text)}\r\n\r\n${text}`);
  }
  notify(method, params) {
    this.write(JSON.stringify({ jsonrpc: '2.0', method, params }));
  }
  // The whole response: {result} or {error}.
  send(method, params) {
    const id = ++this.id;
    this.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method}: no response`)), 5000);
      this.pending.set(id, (msg) => (clearTimeout(timer), resolve(msg)));
    });
  }
  async call(method, params) {
    const r = await this.send(method, params);
    if (r.error) throw new Error(`${method}: ${r.error.code} ${r.error.message}`);
    return r.result;
  }
  // The first message in the inbox matching `pred`, taken out of it.
  next(pred, ms = 5000) {
    return new Promise((resolve, reject) => {
      const take = () => {
        const i = this.inbox.findIndex(pred);
        return i >= 0 && (resolve(this.inbox.splice(i, 1)[0]), true);
      };
      if (take()) return;
      const timer = setTimeout(() => reject(new Error('timed out waiting for a message')), ms);
      this.waiters.push(() => take() && (clearTimeout(timer), true));
    });
  }
  published(uri, ms) {
    return this.next((m) => m.method === 'textDocument/publishDiagnostics' && m.params.uri === uri, ms).then((m) => m.params);
  }
  outline(uri, ms) {
    return this.next((m) => m.method === 'tern/outline' && m.params.uri === uri, ms).then((m) => m.params);
  }
  async open(file, text, version = 1) {
    const uri = pathToFileURL(file).href;
    this.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'html', version, text } });
    return { uri, diagnostics: (await this.published(uri)).diagnostics };
  }
}

// ---------------------------------------------------------------- helpers

// The LSP form of an engine diagnostic, stated independently of the server:
// 0-based file range, severity number, code, source, the hint after the
// message and in `data`.
function expected(d) {
  const p = d.filePosition;
  const at = (q) => ({ line: Math.max(q.line - 1, 0), character: Math.max(q.column - 1, 0) });
  const out = { range: { start: at(p.start), end: at(p.end) }, severity: { error: 1, warning: 2, info: 3 }[d.severity], code: d.code, source: 'tern' };
  out.message = d.hint ? `${d.message}\n${d.hint}` : d.message;
  if (d.hint) out.data = { hint: d.hint };
  return out;
}
const sorted = (list) => list.map((x) => JSON.stringify(x)).sort();

// The position of the nth `needle` in the text, plus `plus` code units.
function locate(text, needle, { nth = 0, plus = 0 } = {}) {
  let i = -1;
  for (let k = 0; k <= nth; k++) if ((i = text.indexOf(needle, i + 1)) < 0) throw new Error(`"${needle}" #${nth} not in the note`);
  const before = text.slice(0, i + plus);
  return { line: before.split('\n').length - 1, character: before.length - before.lastIndexOf('\n') - 1 };
}

// A note position (1-based, note lines) as an LSP range in the file.
const fileRange = (a, p) => ({
  start: { line: p.start.line + a.line - 1, character: p.start.column - 1 },
  end: { line: p.end.line + a.line - 1, character: p.end.column - 1 },
});
const tn = (n) => (n.data && n.data.tern) || {};
// note.analyse, with what the add-on logs (to stderr) kept out of this
// harness's output.
function analyse(text, file) {
  const write = process.stderr.write;
  process.stderr.write = () => true;
  try {
    return note.analyse(text, file);
  } finally {
    process.stderr.write = write;
  }
}
// tern.outline with every line a file line.
function outlineOf(a) {
  const o = note.tern.outline(a.ast);
  for (const k in o) for (const e of o[k]) (e.line += a.line), e.endLine && (e.endLine += a.line);
  return o;
}
const doc = (uri) => ({ textDocument: { uri } });
const before = (p, q) => p.line < q.line || (p.line === q.line && p.character <= q.character);

// ---------------------------------------------------------------- fixtures

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tern-lsp-'));
const ADDON = path.join(DIR, 'addon.js');
const writeAddon = (extra = '') =>
  fs.writeFileSync(
    ADDON,
    `// the fixture vocabulary (test/fixtures/schema.js) as an add-on
const S = ${JSON.stringify(fixture)};
for (const level of ['block', 'leaf', 'inline']) for (const name in S[level]) tern[level](name, S[level][name]);
tern.inline('hl', { tag: 'mark' });
console.log('addon-ran: this must reach stderr, not the protocol');
${extra}`,
  );
writeAddon();

// The reference note: a three-line head, a heading id, a theorem with a
// named closer, references in a paragraph, a heading, a table cell, two
// fragment links and a footnote, and `@rn` inside code and math, which no
// edit may touch. The emoji makes UTF-16 columns differ from code points.
const REFS = `<!doctype html><meta charset="utf-8">
<title>LSP test</title>
<script src="tern.js" data-use="addon.js"></script>
:::meta
title: LSP test
:::

## Kernel {#kernel}

:::theorem[Rank–nullity]{#rn}
By 😀 @kernel, see $@rn$ and \`@rn\` and @rn.
:::/theorem

## About @rn

| Name | Where |
|---|---|
| @rn | \`@rn\` |

Link: [the theorem](#rn), [again](<#rn> "t"){.x} and :kbd[C]{#k}.[^n]

[^n]: A footnote about @rn.

\`\`\`js
@rn
\`\`\`

$$
@rn = 1
$$ {#eq}

:::proof
See @eq and @nowhere.
:::

{#intro}
A paragraph with an id.

::toc
`;

const COMPLETE = `<script src="tern.js" data-use="addon.js"></script>
:::theorem[T]{#t1}
See @
::
Press :
\`\`\`js
@
\`\`\`
Math $x @y$ and code \`x @\` here.
Go [there](#
:::/
:::
`;

const ERRORS = `<!doctype html><meta charset="utf-8"><script src="tern.js" data-use="missing.js"></script>
# Errors

:::theorem[T] #rn .big
$$
x

y
$$

{#k!}
Text @dangling and [x](#nope).

:::proof
unclosed
`;

// ---------------------------------------------------------------- checks

const checks = [];
const check = (name, fn) => checks.push([name, fn]);
const c = new Client();
let refs; // {uri, text, a}

check('a request before initialize is refused', async () => {
  const r = await c.send('textDocument/hover', { ...doc('file:///x.html'), position: { line: 0, character: 0 } });
  assert.strictEqual(r.error && r.error.code, -32002);
});

check('initialize: UTF-16 positions, full sync, the features', async () => {
  const r = await c.call('initialize', { processId: process.pid, rootUri: null, capabilities: { general: { positionEncodings: ['utf-16'] } } });
  const k = r.capabilities;
  assert.strictEqual(k.positionEncoding, 'utf-16');
  assert.strictEqual(k.textDocumentSync.change, 1);
  for (const f of ['hoverProvider', 'definitionProvider', 'referencesProvider', 'documentSymbolProvider', 'foldingRangeProvider']) assert.ok(k[f], f);
  assert.ok(k.renameProvider.prepareProvider);
  assert.ok(k.completionProvider.triggerCharacters.includes('@'));
  c.notify('initialized', {});
});

check('published diagnostics and outlines equal the engine’s', async () => {
  const notes = fs
    .readdirSync(SAMPLES)
    .filter((f) => f.endsWith('.html') && !f.endsWith('.excerpt.html'))
    .map((f) => [path.join(SAMPLES, f), fs.readFileSync(path.join(SAMPLES, f), 'utf8')]);
  notes.push([path.join(DIR, 'refs.html'), REFS], [path.join(DIR, 'errors.html'), ERRORS], [path.join(DIR, 'crlf.html'), ERRORS.replace(/\n/g, '\r\n')]);
  let total = 0;
  for (const [file, text] of notes) {
    const { uri, diagnostics } = await c.open(file, text);
    const a = analyse(text, file);
    const want = a.diagnostics.map(expected);
    assert.deepStrictEqual(diagnostics, want, path.basename(file)); // in order: the server runs what note.analyse runs
    assert.deepStrictEqual(await c.outline(uri), { uri, version: 1, ...outlineOf(a) }, `${path.basename(file)} outline`);
    total += want.length;
    if (verbose) console.log(`    ${path.basename(file)}: ${want.length} diagnostics`);
  }
  const errors = analyse(ERRORS, path.join(DIR, 'errors.html')).diagnostics;
  for (const code of ['addon.failed', 'block.opener-junk', 'math.unclosed', 'attr.malformed', 'ref.dangling', 'block.unclosed'])
    assert.ok(errors.some((d) => d.code === code), `the error note reports ${code}`);
  assert.ok(total > 10);
});

check('tern/outline after analysis, with file lines', async () => {
  const file = path.join(DIR, 'outline.html');
  const uri = pathToFileURL(file).href;
  c.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'html', version: 7, text: REFS } });
  const o = await c.outline(uri);
  assert.deepStrictEqual(o, { uri, version: 7, ...outlineOf(analyse(REFS, file)) });
  assert.strictEqual(o.headings[0].line, locate(REFS, '## Kernel').line + 1, 'a heading line is its 1-based file line');
  // Columns are 1-based UTF-16 file columns (JS string indices + 1), past the emoji.
  const lines = REFS.split('\n');
  const at = (line, col) => lines.slice(0, line - 1).join('\n').length + 1 + col - 1;
  const text = (e) => REFS.slice(at(e.line, e.col), at(e.endLine || e.line, e.end));
  assert.strictEqual(text(o.refs.find((r) => r.id === 'kernel')), '@kernel', 'a reference’s col and end');
  const inline = o.math.find((m) => !m.display);
  assert.deepStrictEqual([inline.tex, inline.line, inline.endLine, text(inline)], ['@rn', locate(REFS, '$@rn$').line + 1, locate(REFS, '$@rn$').line + 1, '$@rn$'], 'inline math: col and end');
  const display = o.math.find((m) => m.display);
  assert.deepStrictEqual([display.number, display.line, display.endLine, text(display)], ['(1)', locate(REFS, '$$\n@rn').line + 1, locate(REFS, '$$ {#eq}').line + 1, '$$\n@rn = 1\n$$ {#eq}'], 'display math: from the opener to after the closer’s attributes');
});

check('rename: edits equal the engine’s reference set, none in code or math', async () => {
  const file = path.join(DIR, 'refs.html');
  const uri = pathToFileURL(file).href;
  const a = analyse(REFS, file);
  refs = { uri, text: REFS, a };
  // The engine's reference set for `rn`: each ref's id, each fragment
  // link's `#rn`, and the declaration's `#rn`; never inside code or math.
  const lines = REFS.split('\n');
  const want = [];
  const chars = (line, col, n) => ({ range: { start: { line, character: col }, end: { line, character: col + n } }, newText: 'rank' });
  const atoms = [];
  note.tern.visit(a.ast, (n) => {
    if (!n.position) return false;
    const r = fileRange(a, n.position);
    if (n.type === 'ref' && n.id === 'rn') want.push(chars(r.start.line, r.start.character + 1, 2));
    if (n.type === 'link' && n.url === '#rn') want.push(chars(r.start.line, lines[r.start.line].indexOf('#rn', r.start.character) + 1, 2));
    if (n.attributes && n.attributes.id === 'rn') {
      const ip = fileRange(a, tn(n).idPosition);
      want.push(chars(ip.start.line, ip.start.character + 1, 2));
    }
    if (['code', 'inlineCode', 'math', 'inlineMath'].includes(n.type)) atoms.push(r);
  });
  assert.strictEqual(want.length, 7, 'four references, two fragment links, one declaration');
  for (const [needle, opts] of [['#rn}', { plus: 1 }], ['| @rn', { plus: 3 }], ['About @rn', { plus: 7 }], ['(<#rn>', { plus: 3 }]]) {
    const edit = await c.call('textDocument/rename', { ...doc(uri), position: locate(REFS, needle, opts), newName: 'rank' });
    assert.deepStrictEqual(sorted(edit.changes[uri]), sorted(want), `from ${needle}`);
  }
  const edits = want;
  for (const e of edits) for (const r of atoms) assert.ok(before(e.range.end, r.start) || before(r.end, e.range.start), 'an edit inside code or math');
  // Applied, the note resolves every reference to the new id, and the
  // `@rn` in code and math is untouched.
  const out = lines.slice();
  for (const e of edits.slice().sort((x, y) => y.range.start.line - x.range.start.line || y.range.start.character - x.range.start.character)) {
    const l = out[e.range.start.line];
    out[e.range.start.line] = l.slice(0, e.range.start.character) + e.newText + l.slice(e.range.end.character);
  }
  const b = analyse(out.join('\n'), file);
  assert.ok(b.ast.data.tern.ids.rank && !b.ast.data.tern.ids.rn);
  const uses = [];
  note.tern.visit(b.ast, (n) => {
    if (n.position && ((n.type === 'ref' && n.id === 'rank') || (n.type === 'link' && n.url === '#rank'))) uses.push(tn(n).resolved);
  });
  assert.deepStrictEqual(uses, [true, true, true, true, true, true], 'every reference resolves to the new id');
  assert.strictEqual((out.join('\n').match(/\$@rn\$|`@rn`|\n@rn\n|@rn = 1/g) || []).length, 5);
});

check('prepareRename and the names rename refuses', async () => {
  const { uri } = refs;
  const p = await c.call('textDocument/prepareRename', { ...doc(uri), position: locate(REFS, 'About @rn', { plus: 7 }) });
  assert.deepStrictEqual(p, { range: { start: locate(REFS, 'About @rn', { plus: 7 }), end: locate(REFS, 'About @rn', { plus: 9 }) }, placeholder: 'rn' });
  for (const bad of ['9x', 'a b', 'a-', 'x:y', 'kernel', '']) {
    const r = await c.send('textDocument/rename', { ...doc(uri), position: locate(REFS, '| @rn', { plus: 3 }), newName: bad });
    assert.ok(r.error, `"${bad}" is refused`);
  }
  const fn = await c.send('textDocument/prepareRename', { ...doc(uri), position: locate(REFS, '[^n]', { plus: 2 }) });
  assert.ok(fn.error && /footnote/.test(fn.error.message), 'a footnote id is generated');
  assert.strictEqual(await c.call('textDocument/prepareRename', { ...doc(uri), position: locate(REFS, 'A paragraph') }), null);
});

check('rename: a container name with its named closer', async () => {
  const { uri } = refs;
  const opener = locate(REFS, ':::theorem', { plus: 3 });
  const closer = locate(REFS, ':::/theorem', { plus: 4 });
  const want = [opener, closer].map((s) => ({ range: { start: s, end: { line: s.line, character: s.character + 7 } }, newText: 'lemma' }));
  for (const at of [opener, { ...closer, character: closer.character + 3 }]) {
    const edit = await c.call('textDocument/rename', { ...doc(uri), position: at, newName: 'lemma' });
    assert.deepStrictEqual(sorted(edit.changes[uri]), sorted(want));
  }
  const r = await c.send('textDocument/rename', { ...doc(uri), position: opener, newName: '1st' });
  assert.ok(r.error, 'a NAME starts with a letter');
});

check('rename: a heading slug gains an explicit id', async () => {
  const { uri } = refs;
  const edit = await c.call('textDocument/rename', { ...doc(uri), position: locate(REFS, '## About', { plus: 4 }), newName: 'about' });
  const end = locate(REFS, '## About @rn', { plus: 12 });
  assert.deepStrictEqual(edit.changes[uri], [{ range: { start: end, end }, newText: ' {#about}' }]);
});

check('definition: from a ref, a fragment link, a footnote reference, a closer', async () => {
  const { uri, a } = refs;
  const go = (needle, opts) => c.call('textDocument/definition', { ...doc(uri), position: locate(REFS, needle, opts) });
  const kernel = a.ast.children.find((n) => n.type === 'heading');
  assert.deepStrictEqual(await go('@kernel', { plus: 2 }), { uri, range: fileRange(a, tn(kernel).idPosition) });
  const rn = { uri, range: { start: locate(REFS, '#rn}'), end: locate(REFS, '#rn}', { plus: 3 }) } };
  assert.deepStrictEqual(await go('(#rn)', { plus: 2 }), rn);
  assert.deepStrictEqual(await go('@rn.', { plus: 1 }), rn);
  const def = await go('[^n]', { plus: 1 });
  assert.deepStrictEqual(def.range.start, locate(REFS, '[^n]:'));
  const opener = await go(':::/theorem', { plus: 6 });
  assert.deepStrictEqual(opener.range, { start: locate(REFS, ':::theorem', { plus: 3 }), end: locate(REFS, ':::theorem', { plus: 10 }) });
  assert.strictEqual(await go('@nowhere', { plus: 2 }), null);
});

check('references: every use, the declaration on request', async () => {
  const { uri } = refs;
  const at = { ...doc(uri), position: locate(REFS, '#rn}', { plus: 1 }) };
  const uses = await c.call('textDocument/references', { ...at, context: { includeDeclaration: false } });
  const all = await c.call('textDocument/references', { ...at, context: { includeDeclaration: true } });
  assert.strictEqual(uses.length, 6);
  assert.strictEqual(all.length, 7);
  assert.ok(uses.every((l) => l.uri === uri));
  const lines = new Set(uses.map((l) => l.range.start.line));
  for (const needle of ['By 😀', '## About', '| @rn', 'Link:', '[^n]: A']) assert.ok(lines.has(locate(REFS, needle).line), needle);
  const k = await c.call('textDocument/references', { ...doc(uri), position: locate(REFS, '## Kernel'), context: { includeDeclaration: false } });
  assert.deepStrictEqual(k.map((l) => l.range.start), [locate(REFS, '@kernel')]);
});

// The engine's reference set again, as highlights: the declaration's `#rn`
// is written (3), each ref's extent and each fragment link's `#rn` read (2).
check('documentHighlight: an id’s declaration and uses, an element’s name and closer', async () => {
  const { uri, a } = refs;
  const lines = REFS.split('\n');
  const want = [];
  note.tern.visit(a.ast, (n) => {
    if (!n.position) return false;
    const r = fileRange(a, n.position);
    if (n.type === 'ref' && n.id === 'rn') want.push({ range: r, kind: 2 });
    if (n.type === 'link' && n.url === '#rn') {
      const k = lines[r.start.line].indexOf('#rn', r.start.character);
      want.push({ range: { start: { line: r.start.line, character: k }, end: { line: r.start.line, character: k + 3 } }, kind: 2 });
    }
    if (n.attributes && n.attributes.id === 'rn') want.push({ range: fileRange(a, tn(n).idPosition), kind: 3 });
  });
  assert.strictEqual(want.length, 7, 'four references, two fragment links, one declaration');
  const hl = (needle, opts) => c.call('textDocument/documentHighlight', { ...doc(uri), position: locate(REFS, needle, opts) });
  for (const [needle, opts] of [['#rn}', { plus: 1 }], ['| @rn', { plus: 3 }], ['the theorem]', {}], ['(<#rn>', { plus: 3 }]]) {
    const got = await hl(needle, opts);
    assert.deepStrictEqual(sorted(got), sorted(want), `from ${needle}`);
    assert.strictEqual(got[0].kind, 3, 'the declaration first');
  }
  const name = (s, n) => ({ start: s, end: { line: s.line, character: s.character + n } });
  const theorem = [
    { range: name(locate(REFS, ':::theorem', { plus: 3 }), 7), kind: 3 },
    { range: name(locate(REFS, ':::/theorem', { plus: 4 }), 7), kind: 2 },
  ];
  assert.deepStrictEqual(await hl(':::/theorem', { plus: 5 }), theorem);
  assert.deepStrictEqual(await hl(':::theorem', { plus: 5 }), theorem);
  assert.deepStrictEqual(await hl('@nowhere', { plus: 1 }), [{ range: name(locate(REFS, '@nowhere'), 8), kind: 2 }], 'a dangling reference: its uses');
  assert.strictEqual(await hl('A paragraph'), null);
  // The capability, from a server of its own.
  const other = new Client();
  const r = await other.call('initialize', { processId: process.pid, rootUri: null, capabilities: {} });
  assert.strictEqual(r.capabilities.documentHighlightProvider, true);
  other.proc.kill();
});

check('hover: label, title, kind and file line', async () => {
  const { uri } = refs;
  const h = await c.call('textDocument/hover', { ...doc(uri), position: locate(REFS, '| @rn', { plus: 3 }) });
  const line = locate(REFS, ':::theorem').line + 1;
  assert.ok(h.contents.value.includes('Theorem 1 — Rank–nullity'), h.contents.value);
  assert.ok(h.contents.value.includes('theorem') && h.contents.value.includes(`line ${line}`), h.contents.value);
  assert.deepStrictEqual(h.range, { start: locate(REFS, '| @rn', { plus: 2 }), end: locate(REFS, '| @rn', { plus: 5 }) });
  const eq = await c.call('textDocument/hover', { ...doc(uri), position: locate(REFS, '@eq', { plus: 1 }) });
  assert.ok(eq.contents.value.includes('(1)'), eq.contents.value);
  const head = await c.call('textDocument/hover', { ...doc(uri), position: locate(REFS, '@kernel', { plus: 1 }) });
  assert.ok(head.contents.value.includes('Kernel') && head.contents.value.includes('heading'), head.contents.value);
  assert.strictEqual(await c.call('textDocument/hover', { ...doc(uri), position: locate(REFS, 'A paragraph') }), null);
});

check('completion: names by level, closers, ids; never in code or math', async () => {
  const file = path.join(DIR, 'complete.html');
  const { uri } = await c.open(file, COMPLETE);
  const labels = async (needle, opts) => (await c.call('textDocument/completion', { ...doc(uri), position: locate(COMPLETE, needle, opts) })).map((i) => i.label);
  const ids = await c.call('textDocument/completion', { ...doc(uri), position: locate(COMPLETE, 'See @', { plus: 5 }) });
  const t1 = ids.find((i) => i.label === 't1');
  assert.ok(t1 && t1.detail === 'Theorem 1 — T', JSON.stringify(t1));
  assert.deepStrictEqual(t1.textEdit.range, { start: locate(COMPLETE, 'See @', { plus: 5 }), end: locate(COMPLETE, 'See @', { plus: 5 }) });
  const leaf = await labels('\n::\n', { plus: 3 });
  assert.ok(leaf.includes('toc') && leaf.includes('video') && !leaf.includes('theorem'), 'leaf names');
  const inline = await labels('Press :', { plus: 7 });
  assert.ok(inline.includes('hl') && inline.includes('kbd') && !inline.includes('section'), 'inline names');
  const block = await labels('\n:::\n', { plus: 4 });
  for (const n of ['theorem', 'proof', 'section', 'details', 'meta', 'macros', '/theorem']) assert.ok(block.includes(n), `:::${n}`);
  assert.deepStrictEqual(await labels(':::/', { plus: 4 }), ['/theorem']);
  assert.ok((await labels('(#', { plus: 2 })).includes('t1'), 'ids in a fragment link');
  assert.deepStrictEqual(await labels('```js\n@', { plus: 7 }), [], 'in a fence');
  assert.deepStrictEqual(await labels('$x @', { plus: 4 }), [], 'in math');
  assert.deepStrictEqual(await labels('`x @', { plus: 4 }), [], 'in a code span');
});

check('documentSymbol: headings by depth, containers and leaves', async () => {
  const { uri } = refs;
  const syms = await c.call('textDocument/documentSymbol', doc(uri));
  const names = (list) => list.map((s) => s.name);
  assert.deepStrictEqual(names(syms), ['meta', 'Kernel', 'About Theorem 1']);
  const [, kernel, about] = syms;
  assert.deepStrictEqual(names(kernel.children), ['Theorem 1 — Rank–nullity']);
  assert.strictEqual(kernel.children[0].detail, ':::theorem #rn');
  assert.deepStrictEqual(names(about.children), ['Proof', 'toc']);
  assert.strictEqual(kernel.range.end.line, locate(REFS, ':::/theorem').line, 'a section ends at its last block');
  assert.strictEqual(about.range.end.line, locate(REFS, '::toc').line);
});

check('foldingRange: blocks and heading sections', async () => {
  const { uri } = refs;
  const folds = (await c.call('textDocument/foldingRange', doc(uri))).map((f) => `${f.startLine}-${f.endLine}`);
  const L = (needle, nth) => locate(REFS, needle, { nth }).line;
  const want = {
    theorem: `${L(':::theorem')}-${L(':::/theorem')}`,
    table: `${L('| Name')}-${L('| @rn')}`,
    fence: `${L('```js')}-${L('```', 1)}`,
    math: `${L('$$\n')}-${L('$$ {#eq}')}`,
    proof: `${L(':::proof')}-${L(':::\n', 1)}`,
    kernel: `${L('## Kernel')}-${L(':::/theorem')}`,
    about: `${L('## About')}-${L('::toc')}`,
  };
  for (const k in want) assert.ok(folds.includes(want[k]), `${k} ${want[k]} in ${folds}`);
});

check('didChange is debounced: one analysis, of the last text', async () => {
  const file = path.join(DIR, 'debounce.html');
  const head = '<script src="tern.js"></script>\n';
  const { uri } = await c.open(file, `${head}# Fine\n`);
  await c.outline(uri);
  const mark = c.log.length;
  let last;
  for (let v = 2; v <= 4; v++) {
    if (v > 2) await new Promise((r) => setTimeout(r, 30));
    c.notify('textDocument/didChange', { textDocument: { uri, version: v }, contentChanges: [{ text: `${head}# Fine\n\n${':::proof\n'.repeat(v - 1)}` }] });
    last = Date.now();
  }
  const p = await c.published(uri);
  const o = await c.outline(uri);
  assert.strictEqual(p.version, 4);
  assert.strictEqual(o.version, 4);
  assert.strictEqual(p.diagnostics.filter((d) => d.code === 'block.unclosed').length, 3, 'the last text');
  await new Promise((r) => setTimeout(r, 250));
  const later = c.log.slice(mark).filter((m) => m.msg.params.uri === uri && m.msg.method === 'textDocument/publishDiagnostics');
  assert.strictEqual(later.length, 1, `one publication for three changes: ${JSON.stringify(later.map((m) => m.msg.params.version))}`);
  assert.ok(later[0].at - last >= 140, `published ${later[0].at - last} ms after the last change`);
});

check('a non-note .html file gets no diagnostics and no outline', async () => {
  const file = path.join(DIR, 'page.html');
  const { uri, diagnostics } = await c.open(file, '<!doctype html>\n<p>Hello @x and :::nope</p>\n<script src="app.js"></script>\n');
  assert.deepStrictEqual(diagnostics, []);
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(!c.log.some((m) => m.msg.method === 'tern/outline' && m.msg.params.uri === uri));
  assert.deepStrictEqual(await c.call('textDocument/documentSymbol', doc(uri)), []);
  assert.strictEqual(await c.call('textDocument/hover', { ...doc(uri), position: { line: 1, character: 10 } }), null);
});

check('add-ons are cached by mtime and reloaded when they change', async () => {
  const uri = pathToFileURL(path.join(DIR, 'complete.html')).href;
  const at = { ...doc(uri), position: locate(COMPLETE, '\n:::\n', { plus: 4 }) };
  assert.ok(!(await c.call('textDocument/completion', at)).some((i) => i.label === 'remark'));
  writeAddon("tern.block('remark', {});");
  const t = new Date(Date.now() + 5000);
  fs.utimesSync(ADDON, t, t);
  c.notify('textDocument/didChange', { textDocument: { uri, version: 2 }, contentChanges: [{ text: COMPLETE }] });
  assert.ok((await c.call('textDocument/completion', at)).some((i) => i.label === 'remark'));
});

// A head script before the tern.js line declares the note's vocabulary.
const theorem = (label, more = '') =>
  `<!doctype html><meta charset="utf-8">
<script>
window.TERN = { schema: { block: { theorem: { tag: 'section', counter: 'theorem', label: '${label}', ref: '{label} {n}' }${more} } } };
</script>
<script src="tern.js"></script>
:::theorem[Main]{#main}
Body.
:::

See @main.
`;

check('a single-file note declares its vocabulary in window.TERN.schema', async () => {
  const file = path.join(DIR, 'single.html');
  const SINGLE = theorem('Theorem');
  const { uri, diagnostics } = await c.open(file, SINGLE);
  assert.deepStrictEqual(diagnostics, [], 'no head.script, addon.failed or name noise');
  assert.deepStrictEqual(analyse(SINGLE, file).diagnostics, []);
  const names = async (text) => (await c.call('textDocument/completion', { ...doc(uri), position: locate(text, '\n:::\n', { plus: 4 }) })).filter((i) => i.detail.startsWith('schema'));
  assert.deepStrictEqual((await names(SINGLE)).map((i) => [i.label, i.detail]), [['theorem', 'schema → <section>']]);
  const hover = async (text) => (await c.call('textDocument/hover', { ...doc(uri), position: locate(text, '@main', { plus: 2 }) })).contents.value;
  assert.ok((await hover(SINGLE)).includes('Theorem 1 — Main'), await hover(SINGLE));
  // A didChange to the head script changes the vocabulary.
  const NEXT = theorem('Satz', ", lemma: { counter: 'theorem', label: 'Lemma' }");
  c.notify('textDocument/didChange', { textDocument: { uri, version: 2 }, contentChanges: [{ text: NEXT }] });
  assert.ok((await hover(NEXT)).includes('Satz 1 — Main'), await hover(NEXT));
  assert.deepStrictEqual((await names(NEXT)).map((i) => i.label), ['theorem', 'lemma']);
  assert.deepStrictEqual((await c.published(uri)).diagnostics, []);
  // A local head script is stamped like an add-on: an edit on disk is seen.
  const VOCAB = path.join(DIR, 'vocab.js');
  fs.writeFileSync(VOCAB, "window.TERN = { schema: { block: { claim: { label: 'Claim' } } } };");
  const SRC = '<script src="vocab.js"></script>\n<script src="tern.js"></script>\n:::claim\nx\n:::\n';
  const src = await c.open(path.join(DIR, 'single-src.html'), SRC);
  const labels = async () => (await c.call('textDocument/completion', { ...doc(src.uri), position: locate(SRC, '\n:::\n', { plus: 4 }) })).map((i) => i.label);
  assert.ok((await labels()).includes('claim') && !(await labels()).includes('axiom'));
  fs.writeFileSync(VOCAB, "window.TERN = { schema: { block: { claim: { label: 'Claim' }, axiom: {} } } };");
  const t = new Date(Date.now() + 5000);
  fs.utimesSync(VOCAB, t, t);
  c.notify('textDocument/didChange', { textDocument: { uri: src.uri, version: 2 }, contentChanges: [{ text: SRC }] });
  assert.ok((await labels()).includes('axiom'));
});

// An add-on's tern.transform runs for its own note, on every analysis (the
// add-ons are cached), and never for another note in the same process; the
// label language is data-lang's, as in tern.js; a remote add-on is an info.
check('add-on transforms run for their note only; data-lang sets the label language; a remote add-on is addon.remote', async () => {
  fs.writeFileSync(path.join(DIR, 'stamp.js'), "tern.transform('stamp', (ast, ctx) => ctx.report('stamp.ran', ast.children[0], `stamped in ${ctx.lang}`, null, 'info'));\n");
  const A = `<!doctype html><meta charset="utf-8"><script>window.TERN = { lang: 'fr', schema: { block: { theorem: { counter: 'theorem', label: { de: 'Satz', fr: 'Théorème', en: 'Theorem' } } } } };</script>
<script src="tern.js" data-lang="de" data-use="stamp.js https://cdn.example/remote.js"></script>
:::theorem{#t}
x
:::

See @t.
`;
  const B = A.replace(' data-use="stamp.js https://cdn.example/remote.js"', '');
  const fa = path.join(DIR, 'stamped.html');
  const a = await c.open(fa, A);
  assert.deepStrictEqual(a.diagnostics, analyse(A, fa).diagnostics.map(expected));
  assert.deepStrictEqual(
    a.diagnostics.map((d) => [d.code, d.severity, d.range.start.line, d.message]),
    [
      ['addon.remote', 3, 1, 'the add-on https://cdn.example/remote.js is not loaded under node; names it declares are unknown to tern check'],
      ['stamp.ran', 3, 2, 'stamped in de'],
    ],
  );
  const b = await c.open(path.join(DIR, 'unstamped.html'), B);
  assert.deepStrictEqual(b.diagnostics, [], 'the other note gets no stamp');
  c.notify('textDocument/didChange', { textDocument: { uri: a.uri, version: 2 }, contentChanges: [{ text: `${A}\nMore.\n` }] });
  assert.ok((await c.published(a.uri)).diagnostics.some((d) => d.code === 'stamp.ran'), 'the cached add-on’s transform runs again');
  const hover = (await c.call('textDocument/hover', { ...doc(b.uri), position: locate(B, '@t', { plus: 1 }) })).contents.value;
  assert.ok(hover.includes('Satz 1'), hover);
});

check('malformed input and unknown documents get errors, not a crash', async () => {
  c.write('{not json');
  const e = await c.next((m) => m.id === null && m.error);
  assert.strictEqual(e.error.code, -32700);
  c.proc.stdin.write('X-Nothing: 1\r\n\r\n');
  c.notify('tern/unknown', {});
  c.notify('textDocument/didChange', { textDocument: { uri: 'file:///never-opened.html', version: 1 }, contentChanges: [{ text: 'x' }] });
  assert.strictEqual((await c.send('tern/unknown', {})).error.code, -32601);
  assert.strictEqual((await c.send('textDocument/hover', { ...doc('file:///never-opened.html'), position: { line: 0, character: 0 } })).error.code, -32602);
  assert.ok((await c.send('textDocument/definition', null)).error);
  assert.ok((await c.send('textDocument/rename', { ...doc(refs.uri), position: { line: 9999, character: 0 } })).result === null);
  assert.ok((await c.call('textDocument/documentSymbol', doc(refs.uri))).length, 'still serving');
});

check('stdout carries only protocol messages', async () => {
  assert.strictEqual(c.garbage, '');
  assert.ok(c.stderr.includes('addon-ran'), 'the add-on’s console.log went to stderr');
});

check('shutdown, then exit with code 0', async () => {
  assert.strictEqual(await c.call('shutdown', null), null);
  assert.strictEqual((await c.send('textDocument/hover', { ...doc(refs.uri), position: { line: 0, character: 0 } })).error.code, -32600);
  c.notify('exit', null);
  const code = await Promise.race([c.exited, new Promise((r) => setTimeout(() => r('timeout'), 3000))]);
  assert.strictEqual(code, 0);
});

async function main() {
  let failed = 0;
  for (const [name, fn] of checks) {
    try {
      await fn();
      console.log(`✓ ${name}`);
    } catch (e) {
      failed++;
      console.log(`✗ ${name}\n    ${String((e && e.message) || e).split('\n').join('\n    ')}`);
      if (verbose && e && e.stack) console.log(e.stack);
    }
  }
  if (c.proc.exitCode === null) c.proc.kill();
  fs.rmSync(DIR, { recursive: true, force: true });
  if (failed && c.stderr) console.log(`\nserver stderr:\n${c.stderr.replace(/^.*addon-ran.*\n/gm, '')}`);
  console.log(`\n${checks.length - failed}/${checks.length} LSP checks pass`);
  process.exit(failed ? 1 : 0);
}

main();
