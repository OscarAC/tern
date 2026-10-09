#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// The command line: `node tern-cli.js` new, check, parse, build and corpus,
// spawned in a temporary directory, and the note-detection regex against
// test/fixtures/detect.json. Zero dependencies.
// `build --katex` is tested when the smoke tests' KaTeX copy exists
// (node_modules/.cache/tern-smoke/katex-*/dist), through a `katex` package
// on NODE_PATH; otherwise that part is skipped and says so.
//
//   node test/cli.js [--filter=TEXT]
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { tokenize, normalize, firstDifference } = require('./lib/html');
const { loadAll } = require('./lib/corpus');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'tern-cli.js');
const tern = require(path.join(ROOT, 'tern.js'));
const { DETECT, detect, split } = require(path.join(ROOT, 'cli', 'note.js'));
const { decodeSource } = require(path.join(ROOT, 'cli', 'build.js'));
const { KATEX } = require(path.join(ROOT, 'src', 'runtime.js'));
const FILTER = (process.argv.find((a) => a.startsWith('--filter=')) || '').slice(9);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tern-cli-'));
const at = (...p) => path.join(TMP, ...p);
function write(rel, text) {
  fs.mkdirSync(path.dirname(at(rel)), { recursive: true });
  fs.writeFileSync(at(rel), text);
}
const read = (rel) => fs.readFileSync(at(rel), 'utf8');
function run(args, { cwd = TMP, env } = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', env: { ...process.env, NODE_PATH: '', ...env } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

class Skip extends Error {}
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
function eq(actual, expected, what) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${what}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}
function ok(cond, what) {
  if (!cond) throw new Error(what);
}
const exits = (r, code, what) => ok(r.code === code, `${what}: exit ${r.code}, expected ${code}${r.err ? `; stderr: ${r.err.trim().split('\n')[0]}` : ''}`);
const FIRST = '<!doctype html><meta charset="utf-8">';

// Well-formed HTML: a doctype first; every element closed in order, except
// those whose tags are optional here (html, head, body).
function wellFormed(html) {
  const toks = tokenize(html);
  ok(toks[0] && toks[0].t === 'decl' && /^<!doctype html>$/i.test(toks[0].v), 'the page starts with <!doctype html>');
  const VOID = new Set('area base br col embed hr img input link meta source track wbr'.split(' '));
  const OPTIONAL = new Set(['html', 'head', 'body']);
  const stack = [];
  for (const t of toks) {
    if (t.t === 'open' && !VOID.has(t.name) && !OPTIONAL.has(t.name) && !t.selfClosed) stack.push(t.name);
    if (t.t === 'close' && !OPTIONAL.has(t.name)) {
      const top = stack.pop();
      ok(top === t.name, `</${t.name}> closes <${top}>`);
    }
  }
  ok(!stack.length, `unclosed: ${stack.join(', ')}`);
}

// The parts of a built page.
function pageParts(html) {
  const main = /<main class="tern">([\s\S]*)<\/main>\n<script type="text\/tern"/.exec(html);
  const src = /<script type="text\/tern" id="tern-source" data-line="(\d+)">([\s\S]*?)<\/script>/.exec(html);
  const diags = /<script type="application\/json" id="tern-diagnostics">([\s\S]*?)<\/script>/.exec(html);
  const head = html.slice(0, html.indexOf('<main class="tern">'));
  return { head, main: main && main[1], line: src && Number(src[1]), source: src && src[2], diagnostics: diags && JSON.parse(diags[1]) };
}

// ---------------------------------------------------------------- DETECT

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'detect.json'), 'utf8'));

test('detect.json: its pattern is cli/note.js DETECT', () => {
  eq(fixture.pattern, DETECT.source, 'pattern');
  eq(fixture.flags, DETECT.flags, 'flags');
});

test('detect.json: every case holds, for the published pattern and for detect()', () => {
  const re = new RegExp(fixture.pattern, fixture.flags); // as an editor builds it
  ok(fixture.match.length >= 15 && fixture.noMatch.length >= 15, 'the fixtures have their cases');
  for (const c of fixture.match) {
    const m = re.exec(c.line);
    ok(m && m[fixture.tagGroup] === c.tag, `${c.why}: ${m ? `captured ${m[fixture.tagGroup]}` : 'no match'} for ${c.line}`);
    const d = detect(c.line);
    ok(d && d.tag === c.tag && c.line.slice(d.index, d.index + d.tag.length) === c.tag, `detect(): ${c.why}`);
  }
  for (const c of fixture.noMatch) ok(!re.test(c.line) && !detect(c.line), `${c.why}: matched ${c.line}`);
  const covered = ['quotes', 'query', 'defer', 'async', 'upper case', 'mytern.js', 'tern.json', 'commented-out', 'middle of the line'];
  const whys = [...fixture.match, ...fixture.noMatch].map((c) => c.why).join('\n');
  for (const w of covered) ok(whys.includes(w), `a case about ${w}`);
});

test('DETECT takes linear time on pathological lines', () => {
  for (const line of ['<script '.repeat(40000), `${'<script '.repeat(40000)}src=tern.js>`, `<!-- ${'x - '.repeat(100000)}`, '<a>'.repeat(200000), `${'<script src="'.repeat(40000)}`]) {
    const t = process.hrtime.bigint();
    DETECT.test(line);
    const ms = Number(process.hrtime.bigint() - t) / 1e6;
    ok(ms < 250, `${ms.toFixed(0)} ms on a ${line.length}-character line starting ${JSON.stringify(line.slice(0, 20))}`);
  }
});

// ---------------------------------------------------------------- new

const GUARDED = /<\/script>(<noscript>[\s\S]*<plaintext>)$/;

test('new: the canonical first line, loading the nearest tern.js above', () => {
  write('w/tern.js', '// stand-in\n');
  fs.mkdirSync(at('w/a/b'), { recursive: true });
  const r = run(['new', 'w/a/b/note.html']);
  exits(r, 0, 'new');
  eq(read('w/a/b/note.html'), `${FIRST}<script src="../../tern.js"></script>\n`, 'the file');
  ok(/created w\/a\/b\/note\.html, loading \.\.\/\.\.\/tern\.js/.test(r.out), `stdout: ${r.out}`);
  exits(run(['new', 'w/same.html']), 0, 'new next to tern.js');
  eq(read('w/same.html'), `${FIRST}<script src="tern.js"></script>\n`, 'tern.js in the same directory');
});

test('new: without a tern.js above, src="tern.js" and a note on stderr', () => {
  let found = false;
  for (let d = TMP; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, 'tern.js'))) found = true;
    if (path.dirname(d) === d) break;
  }
  if (found) throw new Skip(`a tern.js exists above ${TMP}`);
  const r = run(['new', 'lone.html']);
  exits(r, 0, 'new');
  eq(read('lone.html'), `${FIRST}<script src="tern.js"></script>\n`, 'the file');
  ok(/no tern\.js in \. or above/.test(r.err), `stderr: ${r.err}`);
});

test('new: --tern, --use (commas, spaces, repeated) and --title', () => {
  write('o/a.js', '');
  const r = run(['new', 'o/n.html', '--tern=https://cdn.example/x/tern.js', '--use=a.js,b.css', '--use', 'c.js d.css', '--title=Linear maps: kernel & image']);
  exits(r, 0, 'new');
  eq(read('o/n.html'), `${FIRST}<script src="https://cdn.example/x/tern.js" data-use="a.js b.css c.js d.css"></script>\n:::meta\ntitle: Linear maps: kernel & image\n:::\n\n`, 'the file');
  ok(/data-use names b\.css, which does not exist yet/.test(r.err) && !/names a\.js/.test(r.err), `stderr: ${r.err}`);
  const ast = JSON.parse(run(['parse', 'o/n.html', '--transformed']).out);
  eq(ast.data.tern.meta.title, 'Linear maps: kernel & image', 'the title read back');
});

test('new --guarded: the guard follows the tag on the tern.js line, and the file is still a note', () => {
  write('g/tern.js', '');
  exits(run(['new', 'g/n.html', '--guarded', '--title=Guarded']), 0, 'new --guarded');
  const text = read('g/n.html');
  const first = text.split('\n')[0];
  ok(first.startsWith(`${FIRST}<script src="tern.js"></script><noscript>`), `first line: ${first}`);
  ok(GUARDED.test(first) && /self\.tern\|\|document\.write\(/.test(first), 'the guard script and its <plaintext>');
  ok(fixture.match.some((c) => c.line === first), 'detect.json holds the line tern new --guarded writes');
  const parts = split(text);
  ok(parts && parts.line === 1 && parts.tag === '<script src="tern.js">' && parts.head === FIRST, 'split() finds the tag on line 1');
  ok(parts.note.startsWith(':::meta\ntitle: Guarded'), 'the note starts on line 2');
  const c = run(['check', 'g/n.html']);
  exits(c, 0, 'check');
  ok(/1 note: 0 errors/.test(c.err), `check: ${c.err}`);
});

test('new: refusals and usage errors', () => {
  write('r/tern.js', '');
  write('r/old.html', 'keep me');
  fs.mkdirSync(at('r/dir.html'), { recursive: true });
  exits(run(['new', 'r/old.html']), 1, 'an existing file');
  eq(read('r/old.html'), 'keep me', 'the existing file');
  exits(run(['new', 'r/old.html', '--force']), 0, 'an existing file with --force');
  eq(read('r/old.html'), `${FIRST}<script src="tern.js"></script>\n`, 'the overwritten file');
  exits(run(['new', 'r/dir.html']), 1, 'a directory');
  exits(run(['new', 'r/nowhere/n.html']), 1, 'a missing directory');
  const notTern = run(['new', 'r/min.html', '--tern=lib/tern.min.js']);
  exits(notTern, 1, '--tern naming another file');
  ok(/must name a file called tern\.js/.test(notTern.err) && !fs.existsSync(at('r/min.html')), 'nothing written for --tern=lib/tern.min.js');
  for (const args of [['new'], ['new', 'r/'], ['new', '.'], ['new', 'r/..'], ['new', 'a.html', 'b.html'], ['new', 'r/t.html', '--title='], ['new', 'r/t.html', '--bogus']]) {
    const r = run(args);
    exits(r, 2, args.join(' '));
    ok(/usage: tern new FILE/.test(r.err), `${args.join(' ')} prints the synopsis`);
  }
});

// ---------------------------------------------------------------- check

// Note line n is file line n + 1 below the canonical first line.
const PROBLEMS = `${FIRST}<script src="tern.js"></script>
# Problems

See @nowhere.

:::aside
never closed
`;

test('check: file:line:col, severity, code, message, the hint indented; exit 1 on an error', () => {
  write('c/p.html', PROBLEMS);
  const r = run(['check', 'c/p.html']);
  exits(r, 1, 'check');
  const lines = r.out.trimEnd().split('\n');
  eq(lines.length, 4, `lines of output (${r.out})`);
  ok(/^c\/p\.html:4:5: warning ref\.dangling: \S/.test(lines[0]), `line 1: ${lines[0]}`);
  ok(/^ {4}\S/.test(lines[1]), `the hint, indented: ${lines[1]}`);
  ok(/^c\/p\.html:6:1: error block\.unclosed: /.test(lines[2]), `line 3: ${lines[2]}`);
  ok(/1 note: 1 error, 1 warning, 0 infos/.test(r.err), `summary: ${r.err}`);
});

test('check --fail-on and --quiet', () => {
  write('c/warn.html', `${FIRST}<script src="tern.js"></script>\nSee @nowhere.\n`);
  write('c/info.html', `${FIRST}<script src="tern.js"></script>\nA \\(x\\) here.\n`);
  exits(run(['check', 'c/warn.html']), 0, 'a warning, default --fail-on=error');
  exits(run(['check', 'c/warn.html', '--fail-on=warning']), 1, 'a warning, --fail-on=warning');
  exits(run(['check', 'c/info.html', '--fail-on=warning']), 0, 'an info, --fail-on=warning');
  exits(run(['check', 'c/info.html', '--fail-on=info']), 1, 'an info, --fail-on=info');
  exits(run(['check', 'c/info.html', '--fail-on=fatal']), 2, '--fail-on=fatal');
  const q = run(['check', 'c/p.html', 'c/warn.html', '--quiet']);
  exits(q, 1, '--quiet');
  eq(q.out.trimEnd().split('\n').filter((l) => !l.startsWith(' ')).length, 1, `--quiet prints only errors: ${q.out}`);
  eq(q.err, '', '--quiet stderr');
  eq(run(['check', 'c/warn.html', '--quiet']).out, '', '--quiet with only a warning');
});

test('check --json: the diagnostics array, with file and filePosition', () => {
  const r = run(['check', 'c/p.html', 'c/warn.html', '--json']);
  exits(r, 1, 'check --json');
  const list = JSON.parse(r.out);
  eq(list.map((d) => [d.file, d.code, d.severity, d.filePosition.start.line, d.position.start.line]), [
    ['c/p.html', 'ref.dangling', 'warning', 4, 3],
    ['c/p.html', 'block.unclosed', 'error', 6, 5],
    ['c/warn.html', 'ref.dangling', 'warning', 2, 1],
  ], 'diagnostics');
  ok(list.every((d) => d.message && d.hint && d.position.start.offset >= 0), 'message, hint and position on each');
  eq(JSON.parse(run(['check', 'c/warn.html', '--json', '--quiet']).out), [], '--json --quiet with only a warning');
});

test('check: directories are searched; non-notes skipped, with a note when named', () => {
  write('d/a.html', `${FIRST}<script src="../tern.js"></script>\nSee @x.\n`);
  write('d/sub/b.htm', `${FIRST}<script src="../../tern.js"></script>\n:::x\n`);
  write('d/sub/plain.html', '<!doctype html><p>not a note</p>\n');
  write('d/sub/notes.txt', `${FIRST}<script src="tern.js"></script>\n:::x\n`);
  write('d/node_modules/m.html', `${FIRST}<script src="tern.js"></script>\n:::x\n`);
  write('d/.cache/h.html', `${FIRST}<script src="tern.js"></script>\n:::x\n`);
  write('d/deferred.html', `${FIRST}<script defer src="tern.js"></script>\n# x\n`);
  const r = run(['check', 'd', '--json']);
  exits(r, 1, 'check d');
  eq([...new Set(JSON.parse(r.out).map((d) => d.file))], ['d/a.html', path.join('d', 'sub', 'b.htm')], 'files with diagnostics');
  ok(!/skipped/.test(r.err) && /2 notes/.test(r.err), `no notes about files found in a directory: ${r.err}`);
  const named = run(['check', 'd/sub/plain.html', 'd/deferred.html']);
  exits(named, 0, 'named non-notes');
  ok(/d\/sub\/plain\.html is not a note \(no line loads tern\.js\); skipped/.test(named.err), `stderr: ${named.err}`);
  ok(/d\/deferred\.html is not a note \(it loads tern\.js with defer/.test(named.err), `stderr: ${named.err}`);
  ok(/no notes found/.test(named.err), 'no notes found');
  exits(run(['check', 'd/missing.html']), 2, 'a missing path');
  exits(run(['check']), 2, 'no path');
});

// An add-on that declares vocabulary, touches browser globals while it
// loads, and logs (to stderr: stdout carries JSON).
const ADDON = `
tern.block('box', { tag: 'aside', counter: 'box', label: 'Box', css: '.box { border: 1px solid }', dom(el) { el.dataset.ran = 'yes'; } });
tern.block('blinker', { tag: 'blink' });
customElements.define('x-box', class extends HTMLElement {});
document.addEventListener('DOMContentLoaded', () => {});
console.log('the add-on loaded');
`;

test('check: add-ons load through data-use, and their schema reaches the diagnostics', () => {
  write('a/box.js', ADDON);
  write('a/n.html', `${FIRST}<script src="tern.js" data-use="box.js?x=1 theme.css"></script>\n:::blinker\nhi\n:::\n`);
  const r = run(['check', 'a/n.html', '--json']);
  exits(r, 0, 'check');
  const list = JSON.parse(r.out); // the add-on's console.log went to stderr
  eq(list.map((d) => [d.code, d.filePosition.start.line, d.filePosition.start.column]), [['tag.not-allowed', 2, 4]], 'the schema gives blinker <blink>');
  ok(/the add-on loaded/.test(r.err), 'the add-on ran (its log on stderr)');
  const ast = JSON.parse(run(['parse', 'a/n.html', '--transformed']).out);
  write('a/box.html', `${FIRST}<script src="tern.js" data-use="box.js"></script>\n:::box[T]\nx\n:::\n`);
  eq(JSON.parse(run(['parse', 'a/box.html', '--transformed']).out).children[0].data.tern.text, 'Box 1', 'the label from the add-on');
  ok(ast.type === 'root', 'parse');
});

test('check: a missing or failing add-on is addon.failed at the tern.js line', () => {
  write('a/missing.html', `<html lang="en">\n${FIRST}<script src="tern.js" data-use="nope.js"></script>\n# x\n`);
  write('a/throws.js', "tern.block('ok', {});\nthrow new Error('boom');\n");
  write('a/throws.html', `${FIRST}<script src="tern.js" data-use="throws.js"></script>\n# x\n`);
  const r = run(['check', 'a/missing.html', 'a/throws.html']);
  exits(r, 1, 'check');
  const lines = r.out.trimEnd().split('\n');
  ok(/^a\/missing\.html:2:1: error addon\.failed: the add-on nope\.js did not load: cannot read /.test(lines[0]), `line 1: ${lines[0]}`);
  ok(/^a\/throws\.html:1:1: error addon\.failed: the add-on throws\.js did not load: it threw: boom/.test(lines[1]), `line 2: ${lines[1]}`);
});

// A single-file note's vocabulary, from a head script.
test('check: a single-file note declares its vocabulary in window.TERN.schema', () => {
  write('s/n.html', `${FIRST}<script>window.TERN = { schema: { block: { theorem: { tag: 'section', counter: 'theorem', label: 'Theorem' } }, leaf: { toc: { tag: 'nav', transform: 'toc' } } } };</script>
<script src="tern.js"></script>
::toc

## Results

:::theorem[Rank-nullity]{#rn}
x
:::

By @rn.
`);
  const r = run(['check', 's/n.html']);
  exits(r, 0, 'check');
  eq(r.out, '', 'no diagnostics');
  const main = pageParts(run(['build', 's/n.html']).out).main;
  ok(main.includes('<a class="t-ref" href="#rn">Theorem 1</a>') && main.includes('<span class="t-label">Theorem 1</span>'), `the reference reads Theorem 1: ${main}`);
  ok(/<nav class="toc"[^>]*><ol><li><a href="#results">Results<\/a>/.test(main), 'the toc from the head');
});

test("check: window.TERN.schema wins over an add-on's entry; head scripts run in order, remote ones are not", () => {
  write('s/satz.js', "tern.block('theorem', { counter: 'theorem', label: 'Satz' });\ntern.block('lemma', { counter: 'theorem', label: 'Lemma' });\n");
  write('s/vocab.js', "window.TERN = { schema: { block: { theorem: { counter: 'theorem', label: (n) => `Theorem ${n}` } } } };\n");
  write('s/o.html', `${FIRST}
<script src="vocab.js"></script>
<script src="https://cdn.example/x.js"></script>
  <script>window.TERN.seen = typeof tern; nope();</script>
<script src="tern.js" data-use="satz.js"></script>
:::theorem{#a}
x
:::

:::lemma{#b}
y
:::

See @a and @b.
`);
  const r = run(['check', 's/o.html', '--json']);
  exits(r, 0, 'check');
  eq(JSON.parse(r.out).map((d) => [d.code, d.severity, d.filePosition.start.line, d.filePosition.start.column]), [
    ['head.script', 'info', 3, 1],
    ['head.script', 'warning', 4, 3],
  ], 'the remote head script, and the one that threw');
  const b = run(['build', 's/o.html']);
  const main = pageParts(b.out).main;
  ok(main.includes('href="#a">Theorem 1</a>') && main.includes('href="#b">Lemma 2</a>'), `the head's theorem, the add-on's lemma, one counter: ${main}`);
  ok(/the head script inline script on line 4 threw under node: nope is not defined/.test(b.err), `build warns: ${b.err}`);
});

// The label language, in src/runtime.js's order: data-lang on the tag (even
// empty), else window.TERN.lang, is the transforms' `lang`; then the engine
// tries :::meta lang, then <html lang> (a head that sets lang wins over
// :::meta, so the two are not combined here).
const LANGS = "{ de: 'Satz', fr: 'Théorème', es: 'Teorema', it: 'Teorema (it)', en: 'Theorem' }";
function langNote({ dataLang, ternLang, metaLang, htmlLang, use = '' }) {
  const own = `window.TERN = { ${ternLang ? `lang: '${ternLang}', ` : ''}schema: { block: { theorem: { tag: 'section', counter: 'theorem', label: ${LANGS} } } } };`;
  const attr = (dataLang === undefined ? '' : ` data-lang="${dataLang}"`) + (use ? ` data-use="${use}"` : '');
  return `<!doctype html>${htmlLang ? `<html lang="${htmlLang}">` : ''}<meta charset="utf-8"><script>${own}</script>\n<script src="tern.js"${attr}></script>\n${metaLang ? `:::meta\nlang: ${metaLang}\n:::\n\n` : ''}:::theorem{#t}\nx\n:::\n\nSee @t.\n`;
}
const theoremLabel = (ast) => ast.children.find((n) => n.name === 'theorem').data.tern.text;

test('check, parse, build: the label language is data-lang, then window.TERN.lang, then :::meta, then <html lang>, as in tern.js', () => {
  const cases = [
    [{ dataLang: 'de', ternLang: 'fr', metaLang: 'es' }, 'Satz 1', 'data-lang wins'],
    [{ ternLang: 'fr', metaLang: 'es' }, 'Théorème 1', 'window.TERN.lang, without data-lang'],
    [{ dataLang: '', ternLang: 'fr', metaLang: 'es' }, 'Teorema 1', 'an empty data-lang hides window.TERN.lang, as config.lang = "" does'],
    [{ metaLang: 'es' }, 'Teorema 1', ':::meta lang'],
    [{ ternLang: 'fr', htmlLang: 'it' }, 'Théorème 1', 'window.TERN.lang over <html lang>'],
    [{ dataLang: 'de', htmlLang: 'it' }, 'Satz 1', 'data-lang over <html lang>'],
    [{ htmlLang: 'it' }, 'Teorema (it) 1', '<html lang>'],
    [{}, 'Theorem 1', 'none: en'],
  ];
  cases.forEach(([c, want, why], i) => {
    write(`l/${i}.html`, langNote(c));
    eq(theoremLabel(JSON.parse(run(['parse', `l/${i}.html`, '--transformed']).out)), want, `parse: ${why}`);
  });
  const b = run(['build', 'l/0.html']);
  exits(b, 0, 'build');
  const main = pageParts(b.out).main;
  ok(main.includes('<span class="t-label">Satz 1</span>') && main.includes('href="#t">Satz 1</a>'), `build: the label and the reference read Satz 1: ${main}`);
  // tern check reads the same: an add-on transform reports ctx.lang.
  write('l/lang.js', "tern.transform('lang', (ast, ctx) => ctx.report('lang.seen', ast, `lang ${ctx.lang}`, null, 'info'));\n");
  write('l/t.html', langNote({ dataLang: 'de', ternLang: 'fr', use: 'lang.js' }));
  eq(JSON.parse(run(['check', 'l/t.html', '--json']).out).map((d) => d.message), ['lang de'], 'check: ctx.lang');
});

test('check: window.TERN.schema.strict turns on name.unknown, over an add-on', () => {
  write('st/strict.js', 'tern.schema.strict = true;\n');
  const note = (own, use) => `${FIRST}<script>window.TERN = ${own};</script><script src="tern.js"${use ? ' data-use="strict.js"' : ''}></script>\n:::nope\nx\n:::\n`;
  write('st/on.html', note('{ schema: { strict: true } }'));
  write('st/addon.html', note('{}', true));
  write('st/off.html', note('{ schema: { strict: false } }', true));
  write('st/none.html', note('{ schema: {} }'));
  const codes = (f) => JSON.parse(run(['check', f, '--json']).out).map((d) => [d.code, d.severity, d.filePosition.start.line, d.filePosition.start.column]);
  eq(codes('st/on.html'), [['name.unknown', 'info', 2, 4]], 'strict: true');
  eq(codes('st/addon.html'), [['name.unknown', 'info', 2, 4]], "an add-on's tern.schema.strict");
  eq(codes('st/off.html'), [], "strict: false wins over the add-on's");
  eq(codes('st/none.html'), [], 'no strict');
});

// An add-on transform (tern.transform): it runs, in its place in the order,
// for the note that loads it, and no other.
const STAMP = `tern.leaf('toc', { tag: 'nav', transform: 'toc' });
tern.transform('stamp', (ast, ctx) => {
  const h = ast.children.find((n) => n.type === 'heading');
  h.children = [{ type: 'text', value: 'Stamped' }];
  ctx.report('stamp.ran', h, 'the stamp ran', null, 'info');
}, { before: 'toc' });
`;

test("check, parse, build: an add-on's transforms run for its note only; one that throws is addon.failed", () => {
  write('x/stamp.js', STAMP);
  const body = '::toc\n\n## Plain\n\nSee @nowhere.\n';
  write('x/a.html', `${FIRST}<script src="tern.js" data-use="stamp.js"></script>\n${body}`);
  write('x/b.html', `${FIRST}<script src="tern.js"></script>\n${body}`);
  const r = run(['check', 'x/a.html', 'x/b.html', '--json']);
  exits(r, 0, 'check');
  eq(JSON.parse(r.out).map((d) => [d.file, d.code]), [['x/a.html', 'stamp.ran'], ['x/a.html', 'ref.dangling'], ['x/b.html', 'ref.dangling']], 'the transform runs for a.html, not for b.html checked after it');
  const main = pageParts(run(['build', 'x/a.html']).out).main;
  ok(/<h2 id="plain">Stamped<\/h2>/.test(main) && /<nav class="toc"[^>]*><ol><li><a href="#plain">Stamped<\/a>/.test(main), `build: the heading, and the toc built after the stamp: ${main}`);
  const ast = JSON.parse(run(['parse', 'x/a.html', '--transformed']).out);
  eq(ast.children[1].children[0].value, 'Stamped', 'parse --transformed');
  eq(JSON.parse(run(['parse', 'x/a.html']).out).children[1].children[0].value, 'Plain', 'parse without --transformed runs no transform');
  // In process: the engine holds no add-on transform after an analysis.
  const note = require(path.join(ROOT, 'cli', 'note.js'));
  const before = tern.transforms.join();
  const a = note.analyse(read('x/a.html'), at('x/a.html'));
  ok(a.diagnostics.some((d) => d.code === 'stamp.ran'), 'analyse ran the transform');
  eq(tern.transforms.join(), before, 'tern.transforms after analyse');
  // A transform that throws is skipped and reported; the others run.
  write('x/boom.js', "tern.transform('boom', () => { throw new Error('kaput'); });\ntern.transform('later', (ast, ctx) => ctx.report('later.ran', ast, 'later ran', null, 'info'));\n");
  write('x/boom.html', `${FIRST}<script src="tern.js" data-use="boom.js"></script>\n# Boom\n`);
  const t = run(['check', 'x/boom.html']);
  exits(t, 1, 'check a throwing transform');
  const lines = t.out.trimEnd().split('\n');
  eq(lines[0], 'x/boom.html:1:1: error addon.failed: the transform "boom" of the add-on boom.js threw: kaput', 'the throwing transform');
  ok(lines.some((l) => /info later\.ran/.test(l)), `the transform after it ran: ${t.out}`);
  const bb = run(['build', 'x/boom.html']);
  ok(bb.err.includes('tern build: the transform "boom" of the add-on boom.js threw: kaput; the page is written without it\n'), `build warns: ${bb.err}`);
  // The calls replay in order: one anchored to a transform its add-on then removed still runs.
  write('x/undo.js', "const off = tern.transform('first', (ast, ctx) => ctx.report('first.ran', ast, 'first ran', null, 'info'));\ntern.transform('second', (ast, ctx) => ctx.report('second.ran', ast, 'second ran', null, 'info'), { after: 'first' });\noff();\n");
  write('x/undo.html', `${FIRST}<script src="tern.js" data-use="undo.js"></script>\n# Undo\n`);
  eq(JSON.parse(run(['check', 'x/undo.html', '--json']).out).map((d) => d.code), ['second.ran'], 'a removed transform does not run; the one after it does');
  // tern.transform's own checks throw at the add-on's top level, as in a browser.
  write('x/builtin.js', "tern.block('kept', {});\ntern.transform('figures', () => {});\n");
  write('x/builtin.html', `${FIRST}<script src="tern.js" data-use="builtin.js"></script>\n# B\n`);
  ok(/error addon\.failed: the add-on builtin\.js did not load: it threw: tern\.transform: "figures" is a built-in transform/.test(run(['check', 'x/builtin.html']).out), 'a built-in name');
});

test('check: every data-use entry not ending in .css is a script, .mjs and no extension included; one that cannot run says why', () => {
  write('m/mod.mjs', "tern.block('frommjs', { tag: 'aside' });\n");
  write('m/plain', "tern.block('fromplain', { tag: 'aside' });\n");
  write('m/esm.mjs', 'export const x = 1;\n');
  fs.mkdirSync(at('m/dir'), { recursive: true });
  write('m/n.html', `${FIRST}<script>window.TERN = { schema: { strict: true } };</script><script src="tern.js" data-use="mod.mjs plain esm.mjs nothere dir THEME.CSS"></script>\n:::frommjs\nx\n:::\n\n:::fromplain\ny\n:::\n`);
  const r = run(['check', 'm/n.html']);
  exits(r, 1, 'check');
  const lines = r.out.trimEnd().split('\n');
  eq(lines.length, 3, `three problems, no name.unknown: ${r.out}`);
  ok(/^m\/n\.html:1:1: error addon\.failed: the add-on esm\.mjs did not load: it does not parse as a classic script, which is how tern\.js runs an add-on: Unexpected token 'export'$/.test(lines[0]), `esm.mjs: ${lines[0]}`);
  ok(/^m\/n\.html:1:1: error addon\.failed: the add-on nothere did not load: cannot read \S+nothere$/.test(lines[1]), `nothere: ${lines[1]}`);
  ok(/^m\/n\.html:1:1: error addon\.failed: the add-on dir did not load: \S+dir is a directory$/.test(lines[2]), `dir: ${lines[2]}`);
});

test('check: a remote add-on is addon.remote, an info, so --fail-on decides; build warns', () => {
  write('rm/n.html', `${FIRST}<script src="tern.js" data-use="https://cdn.example/x.js?v=1 //cdn.example/y.js https://cdn.example/t.css"></script>\n# Remote\n`);
  const r = run(['check', 'rm/n.html']);
  exits(r, 0, 'check, default --fail-on');
  eq(r.out.trimEnd().split('\n'), [
    'rm/n.html:1:1: info addon.remote: the add-on https://cdn.example/x.js is not loaded under node; names it declares are unknown to tern check',
    'rm/n.html:1:1: info addon.remote: the add-on //cdn.example/y.js is not loaded under node; names it declares are unknown to tern check',
  ], 'the diagnostics');
  exits(run(['check', 'rm/n.html', '--fail-on=info']), 1, '--fail-on=info');
  eq(run(['check', 'rm/n.html', '--quiet']).out, '', '--quiet');
  const b = run(['build', 'rm/n.html']);
  exits(b, 0, 'build');
  ok(b.err.includes('tern build: the add-on https://cdn.example/x.js is not loaded under node, so the page uses its names without its schema'), `build warns: ${b.err}`);
});

// ---------------------------------------------------------------- parse

test('parse: the AST as JSON, parsed or transformed, pretty or compact', () => {
  write('p/box.js', ADDON);
  const head = `<html lang="de">\n${FIRST}`;
  const note = ':::box[Titel]{#b}\nSiehe @b und $x$.\n:::\n';
  write('p/n.html', `${head}<script src="tern.js" data-use="box.js"></script>\n${note}`);
  const schema = { block: { box: { tag: 'aside', counter: 'box', label: 'Box' }, blinker: { tag: 'blink' } }, leaf: {}, inline: {} };
  const parsed = tern.parse(note, { schema, head }).ast;
  const r = run(['parse', 'p/n.html']);
  exits(r, 0, 'parse');
  eq(JSON.parse(r.out), JSON.parse(JSON.stringify(parsed)), 'the parsed AST');
  ok(r.out.split('\n').length > 20, 'pretty by default');
  const c = run(['parse', 'p/n.html', '--compact']);
  eq(c.out.trimEnd().split('\n').length, 1, '--compact is one line');
  const transformed = JSON.parse(JSON.stringify(tern.transform(tern.parse(note, { schema, head }).ast, { schema, head })));
  eq(JSON.parse(run(['parse', 'p/n.html', '--transformed']).out), transformed, 'the transformed AST');
  write('p/plain.html', '<p>plain</p>\n');
  exits(run(['parse', 'p/plain.html']), 2, 'a non-note');
  exits(run(['parse', 'p/missing.html']), 2, 'a missing file');
  exits(run(['parse']), 2, 'no FILE');
});

// ---------------------------------------------------------------- build

const BUILD_NOTE = `:::meta
title: Gebaut
lang: de
author: O. C.
:::

# Gebaut {#top}

:::box[Erste]{#b1}
Inside $x^2$ and @nowhere.[^1]
:::

$$ \\int_0^1 x\\,dx $$ {#eq}

See @b1 and @eq.

<script>window.__script = (window.__script || 0) + 1;</script>

~~~
Source text that must survive: </script> </SCRIPT <!-- and <\\/script> and <\\\\!--.
~~~

[^1]: A footnote.
`;

test('build: the page parses; main.tern is tern.toHTML; the source and diagnostics survive; the head is written', () => {
  write('b/tern.js', '');
  write('b/box.js', ADDON);
  const head = FIRST;
  write('b/n.html', `${head}<script src="tern.js" data-use="box.js theme.css"></script>\n${BUILD_NOTE}`);
  const r = run(['build', 'b/n.html', '-o', 'b/out.html']);
  exits(r, 0, 'build');
  ok(/b\/n\.html:11:18: warning ref\.dangling/.test(r.err), `diagnostics on stderr: ${r.err}`);
  ok(/wrote b\/out\.html; 2 formulas$/m.test(r.err), `summary: ${r.err}`);
  const html = read('b/out.html');
  wellFormed(html);
  const p = pageParts(html);
  const schema = { block: { box: { tag: 'aside', counter: 'box', label: 'Box' }, blinker: { tag: 'blink' } }, leaf: {}, inline: {} };
  const want = tern.toHTML(BUILD_NOTE, { schema, head });
  if (p.main !== want) throw new Error(`main.tern differs from tern.toHTML at ${JSON.stringify(firstDifference(normalize(p.main || ''), normalize(want)))}`);
  eq(p.line, 1, 'data-line');
  eq(decodeSource(p.source), BUILD_NOTE, 'the source, decoded');
  ok(!/<\/script|<!--/i.test(p.source), 'the source holds no </script or <!--');
  eq(p.diagnostics.map((d) => [d.code, d.position.start.line]), [['ref.dangling', 10]], 'the diagnostics, with note positions');
  // The head: prelude, :::meta, viewport, colour scheme, tern's sheets, tern.js, add-ons.
  ok(p.head.startsWith('<!doctype html><html lang="de"><meta charset="utf-8">'), `head start: ${p.head.slice(0, 80)}`);
  ok(p.head.includes('<title>Gebaut</title>') && p.head.includes('<meta name="author" content="O. C.">'), ':::meta written');
  ok(p.head.includes('<meta name="viewport"') && p.head.includes('<meta name="color-scheme" content="light dark">'), 'viewport and color-scheme');
  ok(p.head.includes(`<style id="tern-style">\n${tern.css}</style>\n<link rel="stylesheet" href="theme.css">`), 'tern.css inlined, then the CSS add-on');
  ok(p.head.includes('<script data-built="math" src="tern.js" data-use="box.js theme.css"></script><script src="box.js"></script>\n'), 'tern.js with data-built, then the script add-on');
  // stdout without -o; the built page is not a note.
  eq(run(['build', 'b/n.html']).out, html, 'the page on stdout');
  ok(/it is a page written by tern build/.test(run(['check', 'b/out.html']).err), 'check skips the built page');
});

test('build: the head wins over :::meta, a head link to tern.css is the base, tern goes before author CSS', () => {
  write('h/n.html', `<!doctype html><html lang="fr"><meta charset="utf-8"><title>Head</title><link rel="stylesheet" href="../tern.css"><style>p{}</style>\n<script src="tern.js" data-use="x.css"></script>\n:::meta\ntitle: Note\nlang: de\n:::\n# Hi\n`);
  const r = run(['build', 'h/n.html']);
  exits(r, 0, 'build');
  const { head } = pageParts(r.out);
  ok(/<title>Head<\/title>/.test(head) && (head.match(/<title>/g) || []).length === 1 && /<html lang="fr">/.test(head), 'the head wins');
  ok(!/<style id="tern-style">/.test(head), 'tern.css is not inlined');
  ok(head.includes('<link rel="stylesheet" href="../tern.css">\n<link rel="stylesheet" href="x.css"><style>p{}</style>'), `the CSS add-on after the tern.css link: ${head}`);
  write('h/m.html', `<!doctype html><meta charset="utf-8"><style>p{}</style>\n<script src="tern.js"></script>\n# Hi\n`);
  const m = pageParts(run(['build', 'h/m.html']).out).head;
  ok(m.indexOf('<style id="tern-style">') < m.indexOf('<style>p{}</style>'), 'tern.css before the author stylesheet');
  write('h/q.html', `<script src="tern.js"></script>\n# Quirky\n`);
  const q = run(['build', 'h/q.html']);
  ok(q.out.startsWith('<!doctype html><meta charset="utf-8">'), 'a doctype and charset added');
  ok(q.err.includes('tern build: the note has no <!doctype html>; the page adds it\n') && q.err.includes('tern build: the note has no <meta charset>; the page adds <meta charset="utf-8">\n'), `a warning for each: ${q.err}`);
  write('h/c.html', `<!doctype html><title>C</title>\n<script src="tern.js"></script>\n# No charset\n`);
  const c = run(['build', 'h/c.html']);
  ok(c.out.startsWith('<!doctype html><meta charset="utf-8"><title>C</title>'), 'the charset added after the doctype');
  ok(/has no <meta charset>/.test(c.err) && !/has no <!doctype/.test(c.err), `only the charset warning: ${c.err}`);
  ok(!/has no/.test(run(['build', 'h/m.html']).err), 'no warning when both are there');
});

test('build --katex: formulas pre-rendered to HTML and MathML, with data-tex and KaTeX CSS under SRI', () => {
  const cache = path.join(ROOT, 'node_modules', '.cache', 'tern-smoke');
  const version = fs.existsSync(cache) && fs.readdirSync(cache).find((d) => /^katex-\d/.test(d) && fs.existsSync(path.join(cache, d, 'dist', 'katex.js')));
  // Without the package, --katex leaves the formulas to tern.js and says why.
  write('k/n.html', `${FIRST}<script src="tern.js"></script>\n:::macros\n\\newcommand{\\RR}{\\mathbb{R}}\n:::\n\n# Top $x^2$\n\nInline $x \\in \\RR$ and display:\n\n$$ \\sum_{i=1}^n i $$\n`);
  const without = run(['build', 'k/n.html', '--katex']);
  exits(without, 0, 'build --katex without katex');
  ok(/the katex package cannot be required/.test(without.err) && !/class="katex"/.test(without.out), 'no pre-rendering');
  if (!version) throw new Skip('no KaTeX in node_modules/.cache/tern-smoke (run the smoke tests once)');
  const pkg = at('kx', 'node_modules', 'katex');
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'katex', version: version.slice(6), main: 'dist/katex.js' }));
  try {
    fs.symlinkSync(path.join(cache, version, 'dist'), path.join(pkg, 'dist'), 'dir');
  } catch {
    fs.cpSync(path.join(cache, version, 'dist'), path.join(pkg, 'dist'), { recursive: true });
  }
  const env = { NODE_PATH: at('kx', 'node_modules') };
  const r = run(['build', 'k/n.html', '--katex'], { env });
  exits(r, 0, 'build --katex');
  ok(/3 formulas, 3 pre-rendered/.test(r.err), `summary: ${r.err}`);
  const p = pageParts(r.out);
  const spans = [...p.main.matchAll(/<span class="t-math"( data-display)? data-pos="[^"]*" data-tex="([^"]*)"><span class="katex(-display)?">/g)].map((m) => m[2]);
  eq(spans, ['x^2', 'x \\in \\RR', '\\sum_{i=1}^n i'], 'pre-rendered formulas and their data-tex');
  ok((p.main.match(/<math xmlns=/g) || []).length === 3 && /class="katex-html"/.test(p.main), 'HTML and MathML');
  if (version === 'katex-0.19.0') ok(p.head.includes(`<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.19.0/dist/katex.min.css" integrity="${KATEX.css}" crossorigin="anonymous">\n<style id="tern-style">`), "KaTeX's CSS with the runtime's SRI, before tern.css");
  ok(/<script data-built src="tern\.js">/.test(r.out), 'data-built with no formulas left');
  // A formula KaTeX rejects is left to tern.js, which then needs KaTeX.
  write('k/bad.html', `${FIRST}<script src="tern.js"></script>\nGood $x$, bad $\\left( x$.\n`);
  const bad = run(['build', 'k/bad.html', '--katex'], { env });
  ok(/k\/bad\.html:2:15: warning math\.error: KaTeX cannot typeset this formula/.test(bad.err), `stderr: ${bad.err}`);
  ok(/<script data-built="math" src="tern\.js">/.test(bad.out) && /data-pos="1:15">\\left\( x<\/span>/.test(bad.out), 'the bad formula left as TeX, data-built="math"');
  write('k/none.html', `${FIRST}<script src="tern.js" data-katex="none"></script>\nNo $x$.\n`);
  ok(/data-katex="none"/.test(run(['build', 'k/none.html', '--katex'], { env }).err), 'data-katex="none" is not pre-rendered');
});

test('build: refusals and usage errors', () => {
  write('e/plain.html', '<p>plain</p>\n');
  write('e/n.html', `${FIRST}<script src="tern.js"></script>\n# x\n`);
  exits(run(['build', 'e/plain.html']), 2, 'a non-note');
  exits(run(['build', 'e/n.html', '-o', 'e/n.html']), 2, '-o the note itself');
  eq(read('e/n.html'), `${FIRST}<script src="tern.js"></script>\n# x\n`, 'the note');
  exits(run(['build']), 2, 'no FILE');
  fs.mkdirSync(at('e/dist'));
  exits(run(['build', 'e/n.html', '-o', 'e/dist']), 0, '-o a directory');
  ok(fs.existsSync(at('e/dist/n.html')), 'written as dist/n.html');
});

test('build -o: a trailing slash or an existing directory is a directory, created if missing; otherwise a file, its directory created', () => {
  write('o2/n.html', `${FIRST}<script src="tern.js"></script>\n# x\n`);
  const d = run(['build', 'o2/n.html', '-o', 'o2/site/notes/']);
  exits(d, 0, '-o a missing directory/');
  ok(fs.statSync(at('o2/site/notes/n.html')).isFile(), 'written as o2/site/notes/n.html');
  ok(/wrote o2\/site\/notes\/n\.html;/.test(d.err), `stderr: ${d.err}`);
  exits(run(['build', 'o2/n.html', '-o', 'o2/site/notes']), 0, '-o the existing directory, without a slash');
  exits(run(['build', 'o2/n.html', '-o', 'o2/deep/er/page.html']), 0, '-o a file in a missing directory');
  ok(fs.statSync(at('o2/deep/er/page.html')).isFile(), 'written as o2/deep/er/page.html');
  const f = run(['build', 'o2/n.html', '-o', 'o2/bare']);
  exits(f, 0, '-o a missing name without a slash');
  ok(fs.statSync(at('o2/bare')).isFile(), 'written as the file o2/bare');
  ok(f.err.includes('tern build: o2/bare is written as a file; end -o with / to write n.html into a directory of that name'), `the hint: ${f.err}`);
  ok(!/is written as a file/.test(d.err), 'no hint for a directory');
  const g = run(['build', 'o2/n.html', '-o', 'o2/n.html/x.html']);
  exits(g, 2, '-o under a file');
  ok(/tern build: cannot create the directory o2\/n\.html: a file is in the way/.test(g.err), `stderr: ${g.err}`);
});

// ---------------------------------------------------------------- corpus

// A documentation page (docs/README.md "Live examples") whose add-on exposes
// a demo schema, as docs.js does.
const F3 = '```';
const DEMO_ADDON = `tern.leaf('toc', { tag: 'nav', transform: 'toc' });\nwindow.ternDocs = { demo: ${JSON.stringify(require('./fixtures/schema'))} };\n`;
const DOC_PAGE = [
  `${FIRST}<script src="../tern.js" data-use="demo.js"></script>`,
  `${F3}tern {.live}`,
  'Before any heading.',
  F3,
  '',
  '## Fenced code {#fence}',
  '',
  `\`\`\`\`\`tern {.live}`,
  `\`\`\`\`tern`,
  'inner',
  `\`\`\`\``,
  `\`\`\`\`\``,
  '',
  `\`\`\`\`tern {.live spec="syntax-blocks#fence syntax-blocks#r5"}`,
  `${F3}js`,
  'x',
  F3,
  `\`\`\`\``,
  '',
  `${F3}tern {.live #own expect="block.unclosed"}`,
  ':::note',
  'open',
  F3,
  '',
  `${F3}tern {.live schema=demo}`,
  ':::theorem{#t}',
  'x',
  ':::',
  '',
  'See @t.',
  F3,
  '',
  `${F3}tern {.live head="<title>Head</title>" expect=meta.conflict}`,
  ':::meta',
  'title: Meta',
  ':::',
  F3,
  '',
  `${F3}tern {.live}`,
  'two trailing spaces  ',
  'and\ta tab',
  F3,
  '',
  `${F3}tern`,
  'not live',
  F3,
  '',
  `${F3}js {.live}`,
  'not tern',
  F3,
  '',
].join('\n');

test('corpus: live examples become corpus cases (ids, spec, options, blocks) that parse and pass', () => {
  write('c/docs/demo.js', DEMO_ADDON);
  write('c/docs/page.html', DOC_PAGE);
  const r = run(['corpus', 'c/docs/page.html']);
  exits(r, 0, 'corpus');
  ok(/tern corpus: 7 cases from 1 page/.test(r.err), `the summary: ${r.err}`);
  write('c/out1/a.txt', r.out);
  const { cases, errors } = loadAll(at('c/out1'));
  eq(errors.map((e) => e.message), [], 'the cases parse');
  eq(cases.map((c) => c.id), ['docs/page-1', 'docs/page-fence-1', 'docs/page-fence-2', 'docs/page-own', 'docs/page-fence-4', 'docs/page-fence-5', 'docs/page-fence-6'], 'ids: the heading id and a number, or the fence #id');
  const by = Object.fromEntries(cases.map((c) => [c.id, c]));
  eq(by['docs/page-fence-2'].spec, ['syntax-blocks#fence', 'syntax-blocks#r5'], 'spec= is the spec line');
  eq(by['docs/page-fence-1'].spec, ['page#fence'], 'else the section the example is in');
  eq(by['docs/page-1'].spec, ['page#top'], 'before any heading: the top of the page');
  eq([...by['docs/page-1'].options], ['schema=none'], 'schema=none by default');
  eq([...by['docs/page-fence-4'].options], [], 'schema=demo runs with the fixture schema');
  eq(by['docs/page-fence-5'].head, '<title>Head</title>', 'head= is the html head block');
  eq(by['docs/page-fence-5'].diagnostics.map((d) => d.code), ['meta.conflict'], 'the head reaches the engine');
  eq([...by['docs/page-fence-6'].options], ['schema=none', 'escaped'], 'trailing spaces and a tab: escaped');
  eq(by['docs/page-fence-6'].source, 'two trailing spaces  \nand\ta tab\n', 'the escaped source decodes to the example');
  eq(by['docs/page-fence-1'].source, '````tern\ninner\n````\n', 'a source with a four-backtick fence');
  ok(r.out.includes('`````tern\n````tern\ninner'), 'is fenced with five backticks');
  eq(by['docs/page-own'].diagnostics.map((d) => [d.code, d.severity, d.position.start.line]), [['block.unclosed', 'error', 1]], 'the diagnostics block from expect, positioned by the engine');
  // As test/run.js runs a case: the diagnostics match exactly.
  const fixture = require('./fixtures/schema');
  for (const c of cases) {
    const schema = c.options.has('schema=none') ? { block: {}, leaf: {}, inline: {} } : fixture;
    const got = tern.check(c.source, { schema, head: c.head }).map((d) => `${d.position.start.line}:${d.position.start.column} ${d.severity} ${d.code}`);
    const want = (c.diagnostics || []).map((d) => `${d.position.start.line}:${d.position.start.column} ${d.severity} ${d.code}`);
    eq(got, want, `${c.id} passes`);
  }
  // --out writes DIR/docs-PAGE.txt, the same text; a page in examples/ gets examples- in its ids.
  write('c/examples/demo.js', DEMO_ADDON);
  write('c/examples/lecture.html', `${FIRST}<script src="../tern.js"></script>\n${F3}tern {.live}\nx\n${F3}\n`);
  const o = run(['corpus', 'c/docs/page.html', 'c/examples', '--out=c/out2/sub']);
  exits(o, 0, 'corpus --out');
  eq(fs.readFileSync(at('c/out2/sub/docs-page.txt'), 'utf8'), r.out, '--out writes what stdout prints');
  const lecture = fs.readFileSync(at('c/out2/sub/docs-examples-lecture.txt'), 'utf8');
  ok(/^## docs\/examples-lecture-1$/m.test(lecture), 'examples/lecture.html: docs/examples-lecture-1');
  ok(/^spec: guide#top$/m.test(lecture), 'a page outside docs/ cites the guide');
  eq(o.out, '', 'nothing on stdout with --out');
});

test('corpus: an example that does not match its expect, or has no schema, is reported and left out (exit 1); usage', () => {
  write('c/bad/page.html', [`${FIRST}<script src="tern.js"></script>`, `${F3}tern {.live expect="block.unclosed"}`, 'fine', F3, '', `${F3}tern {.live schema=demo}`, 'x', F3, '', `${F3}tern {.live schema=mine}`, 'y', F3, '', `${F3}tern {.live}`, 'z', F3, ''].join('\n'));
  const r = run(['corpus', 'c/bad/page.html']);
  exits(r, 1, 'corpus with problems');
  const lines = r.err.trimEnd().split('\n');
  ok(lines.some((l) => /^c\/bad\/page\.html:2: example page-1: expect="block\.unclosed" but the engine reports nothing/.test(l)), `the mismatch, at its file line: ${r.err}`);
  ok(lines.some((l) => /^c\/bad\/page\.html:6: schema=demo, but the page's add-ons expose no demo schema/.test(l)), 'schema=demo without docs.js');
  ok(lines.some((l) => /^c\/bad\/page\.html:10: schema="mine" is not a schema/.test(l)), 'an unknown schema');
  eq((r.out.match(/^## /gm) || []).length, 1, 'only the good example is a case');
  write('c/bad/plain.html', '<!doctype html><p>not a note</p>\n');
  const n = run(['corpus', 'c/bad/plain.html']);
  exits(n, 0, 'a file that is not a note');
  ok(/is not a note/.test(n.err), 'says why');
  exits(run(['corpus']), 2, 'no path');
  exits(run(['corpus', 'c/nowhere.html']), 2, 'a missing file');
  exits(run(['corpus', 'c/bad/page.html', '--bogus']), 2, 'an unknown option');
});

test('usage: help, unknown commands, --help, --version', () => {
  const h = run(['help']);
  exits(h, 0, 'help');
  for (const c of ['new', 'check', 'parse', 'build', 'corpus', 'lsp']) ok(h.out.includes(`tern ${c}`), `usage names ${c}`);
  exits(run([]), 0, 'no command');
  exits(run(['bogus']), 2, 'an unknown command');
  exits(run(['usage']), 2, 'usage is not a command');
  for (const c of ['new', 'check', 'parse', 'build', 'corpus', 'lsp']) {
    const r = run([c, '--help']);
    exits(r, 0, `${c} --help`);
    ok(r.out.startsWith(`usage: tern ${c}`), `${c} --help prints its synopsis`);
  }
  eq(run(['lsp', '-h']).out, 'usage: tern lsp [--stdio]\n', 'lsp -h');
  for (const args of [['lsp', '--bogus'], ['lsp', 'extra']]) {
    const r = run(args);
    exits(r, 2, args.join(' '));
    ok(/usage: tern lsp/.test(r.err), `${args.join(' ')} prints the synopsis`);
  }
  eq(run(['--version']).out, `${tern.version}\n`, '--version');
});

// ---------------------------------------------------------------- run

let failed = 0;
let skipped = 0;
let ran = 0;
for (const t of tests) {
  if (FILTER && !t.name.includes(FILTER)) continue;
  ran++;
  try {
    t.fn();
    console.log(`✓ ${t.name}`);
  } catch (e) {
    if (e instanceof Skip) {
      skipped++;
      console.log(`- ${t.name} (skipped: ${e.message})`);
      continue;
    }
    failed++;
    console.log(`✗ ${t.name}\n    ${e.message}`);
  }
}
fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${ran - failed - skipped}/${ran} CLI tests pass${skipped ? `; ${skipped} skipped` : ''}`);
process.exit(failed ? 1 : 0);
