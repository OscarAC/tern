#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// The documentation (docs/README.md "Checking"): every page, every live
// example and every link, under node, with no browser and no dependencies.
// The pages are index.html, docs/*.html and examples/*.html that are notes.
//
//   - The page: its diagnostics under its own add-ons (what `tern check`
//     prints) include no error or warning; infos are listed and pass. A page
//     that loads docs.js uses only names it declares (README "Use nothing
//     else"), and no id of its own is one tern.js or docs.js gives its own
//     elements (tern-style, ex1-…).
//   - Every live example: its diagnostics equal its `expect` as a multiset,
//     under schema=none or demo and its head=; it renders; what its case
//     cites (its spec=, else its section) are anchors PAGE#ID that exist.
//     `tern corpus` turns the page's examples into corpus cases that parse
//     and lint (test/lib/corpus.js, spec.js).
//   - Every link: a relative link, image or element URL (`[x](page.html#id)`,
//     `![x](img.svg)`, `::video{src=…}`, raw HTML href/src) names a file that
//     exists, and its fragment an id of that page: its id registry
//     (data.tern.ids) or an id its HTML emits; a fragment in a .md file is a
//     GitHub heading anchor. Root-relative URLs are refused: the site is
//     served under a path.
//   - docs.js: its demo schema equals test/fixtures/schema.js, and its site
//     navigation lists every example page. A page the navigation lists that
//     does not exist yet is pending (listed, not failed; --strict fails it).
//
// Each problem prints as `file:line: message`; exit 1 on any.
//
//   node test/docs.js [--strict] [--quiet] [PAGE…]
//
// With PAGEs, only those pages are checked (and the links they make).
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const note = require('../cli/note');
const examples = require('../cli/examples');
const { loadAll } = require('./lib/corpus');
const anchors = require('./lib/anchors');
const spec = require('./lib/spec').load();
const fixture = require('./fixtures/schema');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const STRICT = args.includes('--strict');
const QUIET = args.includes('--quiet');
const tern = note.tern;

const problems = [];
const infos = [];
const pending = [];
const pendingLinks = new Map(); // a planned page not written yet -> {n, first}
const rel = (file) => path.relative(ROOT, file).split(path.sep).join('/');
const problem = (file, line, message) => problems.push(`${rel(file)}:${line}: ${message}`);

// ---------------------------------------------------------------- the pages

function pages() {
  const list = [];
  if (fs.existsSync(path.join(ROOT, 'index.html'))) list.push(path.join(ROOT, 'index.html'));
  for (const dir of ['docs', 'examples']) {
    const d = path.join(ROOT, dir);
    if (fs.existsSync(d)) for (const f of fs.readdirSync(d).sort()) if (/\.html$/.test(f)) list.push(path.join(d, f));
  }
  return list;
}

// Every page is analysed once (test/lib/anchors.js): the AST, its ids, its examples.
const { load, decode } = anchors;
const usesDocs = (x) => (note.attributes(x.a.tag)['data-use'] || '').split(/\s+/).some((u) => /(?:^|\/)docs\.js(?:[?#]|$)/.test(u));

function checkPage(file) {
  const p = load(file);
  if (!p) return null; // not a note
  if (p.error) return problem(file, 1, `cannot be analysed: ${p.error.stack || p.error}`), null;
  const { x } = p;
  const lineOf = (d) => (d.filePosition ? d.filePosition.start.line : 1);
  for (const d of x.a.diagnostics) {
    const at = `${lineOf(d)}: ${d.severity} ${d.code}: ${d.message}`;
    if (d.severity === 'info') infos.push(`${rel(file)}:${at}`);
    else problems.push(`${rel(file)}:${at}`);
  }

  if (usesDocs(x)) {
    // Names docs.js does not declare: name.unknown under `strict`.
    const strict = tern.check(x.a.note, { ...x.a.opts, schema: { ...x.a.schema, strict: true } });
    for (const d of strict) {
      if (d.code !== 'name.unknown') continue;
      const name = (/`([^`]+)`/.exec(d.message) || [])[1];
      problem(file, d.position.start.line + x.a.line, `\`${name}\` is not in docs.js's vocabulary, so it is a plain ${/span$/.test(d.message) ? 'span' : 'div'} (docs/README.md: use nothing else without adding it to docs.js)`);
    }
  }
  // Ids docs.js makes (example results ex1-…, widgets docs-ex1 …, the nav
  // docs-nav-…). Tern's own ids are the engine's to keep out (id.duplicate,
  // reported with the page's diagnostics above).
  for (const id of p.ids) {
    const at = x.a.ast.data.tern.ids[id] ? x.a.ast.data.tern.ids[id].line + x.a.line : 1;
    if (/^ex\d+-|^docs-ex\d+(?:-|$)|^docs-nav-/.test(id)) problem(file, at, `the id ${id} is one docs.js makes (ex1-…, docs-ex1, docs-nav-…); give this one another id ({#…})`);
  }

  checkExamples(p);
  checkLinks(p);
  return p;
}

// ---------------------------------------------------------------- examples

function checkExamples({ file, x }) {
  for (const pr of x.problems) problem(file, pr.line, pr.message);
  for (const ex of x.examples) {
    if (!ex.schema) continue; // reported above
    try {
      const r = examples.check(ex);
      if (r.missing.length || r.unexpected.length) {
        const got = r.diagnostics.map((d) => `${d.code} (${d.position.start.line}:${d.position.start.column})`).join(', ') || 'none';
        problem(file, ex.line, `live example ${ex.slug}: diagnostics ${got}; expect="${ex.expect.join(' ')}"${r.missing.length ? `; missing ${r.missing.join(' ')}` : ''}${r.unexpected.length ? `; unexpected ${r.unexpected.join(' ')}` : ''}`);
      }
      tern.toHTML(ex.source, { ...examples.options(ex), positions: false });
    } catch (e) {
      problem(file, ex.line, `live example ${ex.slug} throws: ${(e && e.stack) || e}`);
    }
    // What `tern corpus` cites for it: its spec=, else its section.
    for (const s of ex.spec || [ex.cite]) {
      const r = spec.resolve(String(s));
      if (r.error) problem(file, ex.line, `live example ${ex.slug}: ${ex.spec ? `spec="${ex.spec.join(' ')}"` : 'its section'} cites ${s}: ${r.error}`);
    }
  }
}

// `tern corpus` on the pages: the cases parse as corpus cases, and their
// codes and severities lint. Mismatched examples and the anchors the cases
// cite are reported with the examples.
function checkCorpus(checked) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tern-docs-'));
  try {
    let n = 0;
    for (const p of checked) {
      const c = examples.toCorpus(p.x, rel(p.file));
      if (c.text) fs.writeFileSync(path.join(tmp, `${String(++n).padStart(3, '0')}.txt`), c.text);
    }
    const { cases, errors } = loadAll(tmp);
    for (const e of errors) problems.push(`tern corpus: ${e.message.replace(/^[^:]*:\d+: /, '')}`);
    for (const c of cases) {
      for (const d of c.diagnostics || []) {
        const known = spec.codes.get(d.code);
        if (!known) problems.push(`tern corpus: ${c.id}: ${d.code} is not an engine code (src/diag.js)`);
        else if (known !== d.severity) problems.push(`tern corpus: ${c.id}: ${d.code} is ${known} in src/diag.js, tern.js says ${d.severity}`);
      }
    }
    return cases.length;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- links

const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:|^\/\//;
const URL_KEYS = ['href', 'src', 'poster', 'data'];

function checkLinks({ file, x }) {
  const at = (node) => (node.position ? x.a.toFile(node.position).start.line : 1);
  tern.visit(x.a.ast, (node) => {
    // A fragment link within the page is the engine's: ref.dangling.
    if ((node.type === 'link' || node.type === 'image') && typeof node.url === 'string' && !node.url.startsWith('#')) target(file, at(node), node.url);
    if (node.attributes && typeof node.attributes === 'object' && node.type !== 'code') {
      for (const k of URL_KEYS) if (typeof node.attributes[k] === 'string') target(file, at(node), node.attributes[k]);
    }
    if (node.type === 'html' && typeof node.value === 'string') {
      const base = at(node);
      for (const m of node.value.matchAll(/<[a-zA-Z][^<>]*>/g)) {
        const line = base + (node.value.slice(0, m.index).match(/\n/g) || []).length;
        for (const a of m[0].matchAll(/\s(href|src|poster)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi)) target(file, line, decode(a[2] ?? a[3] ?? a[4]));
      }
    }
  });
}

function target(file, line, url) {
  url = url.trim();
  if (!url || SCHEME.test(url)) return;
  if (url.startsWith('/')) return problem(file, line, `${url} is root-relative; the site is served under a path, so link relative to the page`);
  const hash = url.indexOf('#');
  let pathPart = (hash < 0 ? url : url.slice(0, hash)).replace(/\?.*$/, '');
  let frag = hash < 0 ? null : url.slice(hash + 1);
  try {
    pathPart = decodeURIComponent(pathPart);
    if (frag !== null) frag = decodeURIComponent(frag);
  } catch {
    return problem(file, line, `${url} is not a valid URL`);
  }
  let dest = pathPart ? path.resolve(path.dirname(file), pathPart) : file;
  if (pathPart && (pathPart.endsWith('/') || (fs.existsSync(dest) && fs.statSync(dest).isDirectory()))) dest = path.join(dest, 'index.html');
  if (!fs.existsSync(dest)) {
    // A page the site navigation plans, not written yet: pending (--strict fails it).
    if (PLANNED.has(dest) && !STRICT) {
      const k = rel(dest);
      if (!pendingLinks.has(k)) pendingLinks.set(k, { n: 0, first: `${rel(file)}:${line}` });
      pendingLinks.get(k).n++;
      return;
    }
    return problem(file, line, `${url}: ${rel(dest)} does not exist`);
  }
  if (frag === null || frag === '') return;
  const ids = idsOf(dest);
  // #top with no such id scrolls to the top in every browser (HTML's "top").
  if (ids && !ids.has(frag) && frag.toLowerCase() !== 'top') problem(file, line, `${url}: ${rel(dest)} has no id ${JSON.stringify(frag)}`);
}

// The ids a file offers to a fragment: a note's registry and emitted ids; a
// Markdown file's GitHub heading anchors; other HTML's id attributes.
const idCache = new Map();
function idsOf(file) {
  if (idCache.has(file)) return idCache.get(file);
  let ids = null;
  if (/\.html?$/i.test(file)) {
    const p = load(file);
    if (p && p.ids) ids = p.ids;
    else if (!p) ids = new Set([...fs.readFileSync(file, 'utf8').matchAll(/\sid\s*=\s*["']?([^"'\s>]+)/g)].map((m) => decode(m[1])));
  } else if (/\.md$/i.test(file)) ids = markdownAnchors(fs.readFileSync(file, 'utf8'));
  idCache.set(file, ids);
  return ids;
}

function markdownAnchors(text) {
  const ids = new Set();
  const seen = new Map();
  let fence = null;
  for (const line of text.split('\n')) {
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (f && (!fence || (f[1][0] === fence[0] && f[1].length >= fence.length))) {
      fence = fence ? null : f[1];
      continue;
    }
    if (fence) continue;
    const m = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    const slug = m[1]
      .replace(/<[^>]+>/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}\s_-]/gu, '')
      .replace(/\s/g, '-');
    const n = seen.get(slug) || 0;
    seen.set(slug, n + 1);
    ids.add(n ? `${slug}-${n}` : slug);
  }
  return ids;
}

// ---------------------------------------------------------------- docs.js

// docs.js under node, as `tern check` loads it: window.ternDocs, or null.
const DOCS_JS = path.join(ROOT, 'docs', 'docs.js');
function docsJs() {
  if (!fs.existsSync(DOCS_JS)) return problem(DOCS_JS, 1, 'docs.js is missing'), null;
  const { problems: failed, window } = note.addons('<script src="../tern.js" data-use="docs.js">', path.dirname(DOCS_JS), '');
  for (const f of failed) problem(DOCS_JS, 1, `does not load under node: ${f.message}`);
  const docs = window && window.ternDocs;
  if (!docs) problem(DOCS_JS, 1, 'sets no window.ternDocs');
  return docs || null;
}
const DOCS = docsJs();
// The pages the site navigation lists, by absolute path.
const PLANNED = new Set(DOCS ? [...(DOCS.pages || []), ...(DOCS.examples || [])].map(([p]) => path.join(ROOT, p)) : []);

function checkDocsJs(found) {
  const file = DOCS_JS;
  const docs = DOCS;
  if (!docs) return;
  // The realms differ, so compare as canonical JSON.
  const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : typeof x === 'function' ? `[function ${x.name}]` : x));
  if (canon(docs.demo) !== canon(fixture)) problem(file, 1, 'window.ternDocs.demo differs from test/fixtures/schema.js; keep the demo schema exactly the corpus fixture');
  const listed = [...(docs.pages || []), ...(docs.examples || [])].map(([p]) => p);
  for (const p of listed) {
    if (fs.existsSync(path.join(ROOT, p))) continue;
    const links = pendingLinks.get(p);
    const say = `${p} is not written yet: the site navigation lists it${links ? `; ${links.n} link(s) to it, the first at ${links.first}` : ''}`;
    if (STRICT) problems.push(`docs/docs.js: ${say}`);
    else pending.push(say);
  }
  for (const f of found) {
    const r = rel(f);
    if (/^(docs|examples)\/[^_][^/]*\.html$|^index\.html$/.test(r) && !listed.includes(r)) problem(f, 1, `is not in the site navigation (docs.js ternDocs.${r.startsWith('examples/') ? 'examples' : 'pages'})`);
  }
}

// ---------------------------------------------------------------- main

const t0 = Date.now();
const named = args.filter((a) => !a.startsWith('--')).map((a) => path.resolve(a));
const found = named.length ? named : pages();
const checked = [];
let exampleCount = 0;
for (const f of found) {
  const p = checkPage(f);
  if (p) {
    checked.push(p);
    exampleCount += p.x.examples.length;
  }
}
checkDocsJs(found);
const cases = checkCorpus(checked);

if (!QUIET) {
  for (const i of infos) console.log(`  info  ${i}`);
  for (const p of pending) console.log(`  pending  ${p}`);
}
for (const p of problems) console.log(`✗ ${p}`);
console.log(
  `docs: ${checked.length} page(s), ${exampleCount} live example(s), ${cases} corpus case(s); ` +
    `${problems.length} problem(s), ${infos.length} info(s)${pending.length ? `, ${pending.length} pending` : ''} in ${Date.now() - t0} ms`,
);
process.exit(problems.length ? 1 : 0);
