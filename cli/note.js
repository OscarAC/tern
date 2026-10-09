// SPDX-License-Identifier: MIT
// What every command needs from a note file: whether a file is a note, where
// the note starts, the add-ons its tern.js line loads, the engine run on it,
// and positions in the file rather than in the note. Node only.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { Console } = require('console');
const tern = require('../tern.js');

// The line that makes an HTML file a note: it holds a <script> that tern.js
// would start from. Published for editors (docs/tools.html#detection) with
// fixtures in test/fixtures/detect.json; editors match it per line,
// case-insensitively. Group 1 is the tag. A line counts when:
//   - a <script> tag on it has a src whose file name is tern.js (any path,
//     any quotes, a query or fragment allowed; not mytern.js, tern.json);
//   - the tag is not inside a comment opened earlier on the line;
//   - it has no async, defer or type=module (tern.js would not capture the
//     note) and no data-built (a page written by `tern build` is not a note).
// The tag must be on one line and hold no < or >; a comment that spans
// lines is not seen. Each attempt stops at the next < or >, so a line costs
// linear time.
const DETECT =
  /^(?:[^<]|<(?!!--)|<!--(?:[^-]|-(?!->))*-->)*?(<script(?=[\s>/])(?![^<>]*\s(?:async|defer|data-built)(?=[\s=>/]|$))(?![^<>]*\stype\s*=\s*["']?module(?=["'\s>/]|$))[^<>]*?\ssrc\s*=\s*(["']?)(?:[^"'\s<>]*\/)?tern\.js(?:[?#][^"'\s<>]*)?\2(?=[\s>/])[^<>]*>)/i;

// DETECT on one line: {index, tag} for the tern.js tag, or null.
function detect(line) {
  const m = DETECT.exec(line);
  return m ? { index: m[0].length - m[1].length, tag: m[1] } : null;
}

// Why a file is not a note, when it nearly is: a tern.js tag DETECT refuses.
function notNote(text) {
  const m = /<script\b[^<>]*\ssrc\s*=\s*["']?(?:[^"'\s<>]*\/)?tern\.js(?:[?#][^"'\s<>]*)?(?=["'\s>/])[^<>]*>/i.exec(String(text));
  if (!m) return 'no line loads tern.js';
  if (/\sdata-built\b/i.test(m[0])) return 'it is a page written by tern build; check its source note';
  const how = /\s(async|defer)(?=[\s=>/]|$)/i.exec(m[0]) || /\stype\s*=\s*["']?(module)/i.exec(m[0]);
  if (how) return `it loads tern.js with ${how[1].toLowerCase()}, so tern.js does not render it; use a plain <script src>`;
  return 'its tern.js tag is commented out or not on one line';
}

// Splits a file into the preserved head and the note. Returns null when no
// line loads tern.js. `line` is the number of file lines before the note, so
// note line n is file line n + line.
function split(text) {
  text = String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  let i = -1;
  let d = null;
  while (++i < lines.length && !(d = detect(lines[i])));
  if (!d) return null;
  let at = 0;
  for (let k = 0; k <= i; k++) at = text.indexOf('\n', at) + 1 || text.length;
  return {
    head: [...lines.slice(0, i), lines[i].slice(0, d.index)].join('\n'),
    tag: d.tag,
    note: at > 0 ? text.slice(at) : '',
    line: i + 1,
  };
}

// The tag's attributes: data-use (space-separated add-ons, query strings
// dropped), data-css, data-katex … Values are decoded as HTML decodes them
// (the character references a tag line plausibly holds).
const REFS = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' };
const decodeRefs = (s) =>
  s.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|(amp|quot|apos|lt|gt));/g, (m, d, h, n) => {
    if (n) return REFS[n];
    const c = d ? Number(d) : parseInt(h, 16);
    return c > 0 && c <= 0x10ffff ? String.fromCodePoint(c) : m;
  });
function attributes(tag) {
  const out = {};
  const re = /\s([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (let m; (m = re.exec(tag)); ) out[m[1].toLowerCase()] = decodeRefs(m[2] ?? m[3] ?? m[4] ?? '');
  return out;
}

// Browser globals an add-on may touch while it loads (customElements.define,
// document.addEventListener, class extends HTMLElement …): under node each is
// an object that accepts anything and does nothing, so the add-on gets to
// its tern.block calls.
const inert = new Proxy(function () {}, {
  get: (_, k) => (k === Symbol.toPrimitive ? () => '' : k === Symbol.iterator ? function* () {} : k === 'then' ? undefined : inert),
  apply: () => inert,
  construct: () => inert,
});
const BROWSER = 'document customElements HTMLElement Element Node Event CustomEvent EventTarget CSS CSSStyleSheet navigator location history localStorage sessionStorage matchMedia getComputedStyle requestAnimationFrame cancelAnimationFrame requestIdleCallback setTimeout clearTimeout setInterval clearInterval queueMicrotask MutationObserver IntersectionObserver ResizeObserver fetch addEventListener removeEventListener dispatchEvent'.split(' ');
// An add-on's console writes to stderr: stdout carries JSON (tern parse,
// tern check --json) and the LSP's JSON-RPC.
const quietConsole = new Console({ stdout: process.stderr, stderr: process.stderr });

// A local add-on's file: relative to the note's directory; root-relative
// (/lib/x.js) under the nearest ancestor that has it, since the site root is
// not known here.
function locate(dir, url) {
  const from = path.resolve(dir);
  if (!url.startsWith('/')) return path.resolve(from, url);
  for (let d = from; ; d = path.dirname(d)) {
    const file = path.join(d, url);
    if (fs.existsSync(file)) return file;
    if (path.dirname(d) === d) return path.join(from, url);
  }
}

// The head's classic scripts before the tern.js tag, in document order:
// {src, body, line, column}. Comments are skipped; a module, a data block,
// and an async or defer script (which runs after tern.js has read
// window.TERN) are left out.
const JS_TYPE = /^(?:(?:text|application)\/(?:x-)?(?:java|ecma)script|text\/(?:jscript|livescript|javascript1\.[0-5]))?$/i;
function headScripts(head) {
  head = String(head || '');
  const out = [];
  for (const m of head.matchAll(/<!--[\s\S]*?(?:-->|$)|<script\b([^>]*)>([\s\S]*?)(?:<\/script\s*>|$)/gi)) {
    if (m[0][1] === '!') continue;
    const a = attributes(m[1]);
    if (!JS_TYPE.test((a.type || '').trim()) || (a.src !== undefined && ('async' in a || 'defer' in a))) continue;
    const before = head.slice(0, m.index);
    out.push({ src: a.src === undefined ? null : a.src, body: m[2], line: (before.match(/\n/g) || []).length + 1, column: m.index - before.lastIndexOf('\n') });
  }
  return out;
}

const isRemote = (url) => /^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('//');
const message = (e) => {
  try {
    return (e && e.message) || String(e);
  } catch {
    return 'an exception';
  }
};
const own = (o, k) => Object.prototype.propertyIsEnumerable.call(o, k);

// tern.config as the runtime builds it (src/runtime.js readConfig), for an
// add-on that reads its parameters: `use[name]` from data-use's query
// strings, `katex` from window.TERN.katex and data-katex, and `lang`.
function shimConfig(given, attrs, lang) {
  const g = given && typeof given === 'object' ? given : {};
  const use = Object.assign(Object.create(null), g.use && typeof g.use === 'object' ? g.use : null);
  for (const entry of (attrs['data-use'] || '').split(/\s+/).filter(Boolean)) {
    const q = entry.indexOf('?');
    let file = (q < 0 ? entry : entry.slice(0, q)).replace(/#.*$/, '');
    file = file.slice(file.lastIndexOf('/') + 1);
    try {
      file = decodeURIComponent(file);
    } catch {}
    const name = file.replace(/(?:\.min)?\.(?:m?js|css)$/i, '');
    const params = Object.create(null);
    if (q >= 0) new URLSearchParams(entry.slice(q + 1).replace(/#.*$/, '')).forEach((v, k) => (params[k] = v));
    use[name] = Object.assign(Object.create(null), use[name], params);
  }
  const katex = typeof g.katex === 'string' ? { base: g.katex } : Object.assign({}, g.katex);
  if (attrs['data-katex'] !== undefined) katex.base = attrs['data-katex'].trim();
  return { use, katex, lang };
}

// addons(tag, dir, head) -> {schema, problems, transforms, lang, window}:
// the vocabulary a note's own files declare, as the browser has it at mount.
// One sandbox runs, in order:
//   - the head's scripts (`head`, the preserved head), with no `tern` yet;
//     then window.TERN is read, as tern.js reads it when it starts: its
//     `lang` (unless the tag has data-lang) and its `schema`;
//   - the script add-ons of the tag's data-use (every entry not ending in
//     .css, run as a classic script, as tern.js runs it), with `window.tern`
//     and `tern` a shim: tern.block, leaf and inline write the registry;
//     tern.transform registers with the engine, which checks it as in a
//     browser, and is recorded; what the runtime does in a browser (define,
//     on, style …) is accepted and ignored.
// Then window.TERN.schema goes on top: the note's own declaration wins over
// an add-on's for the same name, and its `strict` sets schema.strict.
// Browser globals are inert. Problems, none of which throws:
//   {url, message}             an add-on that is missing or throws
//   {kind: 'remote', url, message}   a remote add-on, never loaded
//   {kind: 'head', severity, url, message, line, column}
//                              a head script that is remote, missing or throws
// `transforms` are the add-ons' tern.transform calls, {name, fn, order,
// url}, and calls of the functions they returned, {remove: call}, in call
// order: the engine holds none of them once addons returns, and analyse
// replays them for one analysis (transformWith). `lang` is the label
// language tern.js passes the transforms: data-lang, else window.TERN.lang;
// undefined when neither is set.
// `window` is the sandbox's global, for what an add-on exposes besides its
// vocabulary (docs.js's window.ternDocs, read by cli/examples.js).
function addons(tag, dir, head) {
  const schema = { block: {}, leaf: {}, inline: {} };
  const problems = [];
  const transforms = [];
  const sandbox = { console: quietConsole };
  for (const k of BROWSER) sandbox[k] = inert;
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  const run = (code, filename) => vm.runInContext(code, sandbox, { filename, timeout: 2000 });
  const attrs = attributes(tag);

  for (const s of headScripts(head)) {
    const at = { kind: 'head', line: s.line, column: s.column };
    const url = s.src === null ? `inline script on line ${s.line}` : s.src;
    let code = s.body;
    let filename = `${url} (head)`;
    if (s.src !== null) {
      if (isRemote(s.src)) {
        problems.push({ ...at, severity: 'info', url, message: `the head script ${url} is not run under node, so vocabulary it declares in window.TERN.schema is unknown here` });
        continue;
      }
      filename = locate(dir, s.src.replace(/[?#].*$/, ''));
      try {
        code = fs.readFileSync(filename, 'utf8');
      } catch {
        problems.push({ ...at, severity: 'warning', url, message: `the head script ${url} cannot be read (${filename})` });
        continue;
      }
    }
    try {
      run(code, filename);
    } catch (e) {
      problems.push({ ...at, severity: 'warning', url, message: `the head script ${url} threw under node: ${message(e)}; vocabulary it declares may be missing` });
    }
  }

  // window.TERN as tern.js reads it when it starts (src/runtime.js
  // readConfig): after the head's scripts, before the add-ons. The tag's
  // data-lang, even empty, wins over window.TERN.lang.
  let lang;
  let ownSchema = null;
  try {
    const given = sandbox.TERN && typeof sandbox.TERN === 'object' ? sandbox.TERN : null;
    if (given && own(given, 'lang')) lang = given.lang;
    if (given) ownSchema = given.schema;
    if (attrs['data-lang'] !== undefined) lang = attrs['data-lang'].trim();
    lang = lang ? String(lang) : undefined;
  } catch (e) {
    lang = attrs['data-lang'] !== undefined ? attrs['data-lang'].trim() || undefined : undefined;
    problems.push({ kind: 'head', severity: 'warning', url: 'window.TERN', message: `window.TERN cannot be read: ${message(e)}`, line: 1, column: 1 });
  }

  // tern.transform registers with the engine, for its checks (a bad name, a
  // built-in name, an anchor that is not there throw at the add-on's top
  // level, as in a browser), and is recorded; the engine lets go of each
  // when addons returns.
  let current = null; // the add-on running
  const release = [];
  const inertFn = () => () => {};
  sandbox.tern = {
    schema,
    block: (name, spec) => void (schema.block[name] = spec),
    leaf: (name, spec) => void (schema.leaf[name] = spec),
    inline: (name, spec) => void (schema.inline[name] = spec),
    define: inertFn,
    undefine() {},
    on: inertFn,
    style() {},
    transform(name, fn, order) {
      if (typeof name !== 'string') return tern.transform(name, fn); // run the pipeline on a tree
      const off = tern.transform(name, fn, order);
      release.push(off);
      const t = { name, fn, order, url: current };
      transforms.push(t);
      let done = false;
      return () => {
        if (done) return;
        done = true;
        transforms.push({ remove: t });
        off();
      };
    },
    render: () => Promise.resolve([]),
    ready: new Promise(() => {}),
    diagnostics: [],
    config: shimConfig(sandbox.TERN, attrs, lang),
    version: tern.version,
    // The engine's pure functions are the real ones, as in a browser, so a
    // transform can walk the tree with tern.visit.
    parse: tern.parse,
    emit: tern.emit,
    toHTML: tern.toHTML,
    check: tern.check,
    visit: tern.visit,
    outline: tern.outline,
    css: tern.css,
  };
  try {
    for (const entry of (attrs['data-use'] || '').split(/\s+/).filter(Boolean)) {
      const url = entry.replace(/[?#].*$/, '');
      if (/\.css$/i.test(url)) continue; // a stylesheet; anything else is a script
      if (isRemote(url)) {
        problems.push({ kind: 'remote', url, message: `the add-on ${url} is not loaded under node; names it declares are unknown to tern check` });
        continue;
      }
      const file = locate(dir, url);
      let code;
      try {
        code = fs.readFileSync(file, 'utf8');
      } catch (e) {
        problems.push({ url, message: e && e.code === 'EISDIR' ? `${file} is a directory` : `cannot read ${file}` });
        continue;
      }
      current = url;
      try {
        run(code, file);
      } catch (e) {
        const syntax = e && typeof e === 'object' && e.name === 'SyntaxError';
        problems.push({ url, message: syntax ? `it does not parse as a classic script, which is how tern.js runs an add-on: ${message(e)}` : `it threw: ${message(e)}` });
      } finally {
        current = null;
      }
    }
  } finally {
    for (let i = release.length - 1; i >= 0; i--) release[i]();
  }

  try {
    const s = ownSchema && typeof ownSchema === 'object' ? ownSchema : null;
    for (const level of ['block', 'leaf', 'inline']) {
      const entries = s ? s[level] : null;
      if (entries && typeof entries === 'object') for (const name of Object.keys(entries)) if (entries[name] && typeof entries[name] === 'object') schema[level][name] = entries[name];
    }
    if (s && s.strict !== undefined) schema.strict = !!s.strict;
  } catch (e) {
    problems.push({ kind: 'head', severity: 'warning', url: 'window.TERN.schema', message: `window.TERN.schema cannot be read: ${message(e)}`, line: 1, column: 1 });
  }
  return { schema, problems, transforms, lang, window: sandbox };
}

// Runs the transforms on `ast` with the add-ons' tern.transform calls
// registered (addons() `transforms`), through the engine's own registration,
// for this run only: each is unregistered after it, so one note's add-ons
// never reach another's analysis (the LSP serves many notes in one process).
// A transform that throws, or that no longer registers, is skipped and
// returned as {url, name, message}; the others run.
function transformWith(ast, options, transforms) {
  const failures = [];
  const off = [];
  const undo = new Map(); // a call -> its unregister function
  try {
    for (const t of transforms || []) {
      if (t.remove) {
        if (undo.has(t.remove)) undo.get(t.remove)();
        continue;
      }
      const fn = function (tree, ctx) {
        try {
          return t.fn.call(this, tree, ctx);
        } catch (e) {
          failures.push({ url: t.url, name: t.name, message: message(e) });
        }
      };
      try {
        const f = tern.transform(t.name, fn, t.order);
        off.push(f);
        undo.set(t, f);
      } catch (e) {
        failures.push({ url: t.url, name: t.name, message: message(e) });
      }
    }
    tern.transform(ast, options);
  } finally {
    for (let i = off.length - 1; i >= 0; i--) off[i]();
  }
  return failures;
}

// A vocabulary problem as the commands print it: the code, severity and
// message of its diagnostic.
function loadingDiagnostic(p) {
  if (p.kind === 'head') return { code: 'head.script', severity: p.severity, message: p.message };
  if (p.kind === 'remote') return { code: 'addon.remote', severity: 'info', message: p.message };
  if (p.kind === 'transform') return { code: 'addon.failed', severity: 'error', message: `the transform "${p.name}" of the add-on ${p.url} threw: ${p.message}` };
  return { code: 'addon.failed', severity: 'error', message: `the add-on ${p.url} did not load: ${p.message}` };
}

// A note position as a file position: lines move by the head's lines;
// columns and UTF-16 code units are the same (the head ends at a line break).
const toFile = (pos, line) => ({
  start: { line: pos.start.line + line, column: pos.start.column },
  end: { line: pos.end.line + line, column: pos.end.column },
});

// Parses and transforms a note file, with its vocabulary, its add-ons'
// transforms and its label language (addons). Returns null when the file is
// not a note. Diagnostics carry `filePosition` beside the note's `position`,
// in document order. The problems loading vocabulary come first, with only a
// filePosition (codes of the command line's, beside the browser's
// addon.failed: the browser runs head scripts and remote add-ons itself):
//   - an add-on that is missing or throws, or a transform of one that
//     throws: `addon.failed`, an error at the tern.js line;
//   - a remote add-on: `addon.remote`, an info at the tern.js line;
//   - a head script: `head.script`, an info or a warning at its <script>.
// opts.addons(tag, dir, head) replaces addons() (the LSP caches it).
function analyse(text, file, opts = {}) {
  const parts = split(text);
  if (!parts) return null;
  const dir = file ? path.dirname(path.resolve(file)) : process.cwd();
  const loaded = (opts.addons || addons)(parts.tag, dir, parts.head);
  const { schema } = loaded;
  const options = { schema, head: parts.head, lang: loaded.lang };
  const { ast, diagnostics } = tern.parse(parts.note, options);
  const failed = transformWith(ast, options, loaded.transforms);
  const all = diagnostics.concat(ast.data.tern.diagnostics);
  const at = (d) => d.position.start.offset;
  all.sort((a, b) => at(a) - at(b) || a.position.end.offset - b.position.end.offset || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  for (const d of all) d.filePosition = toFile(d.position, parts.line);
  const point = (line, column) => ({ start: { line, column }, end: { line, column } });
  const problems = (loaded.problems || []).concat(failed.map((f) => ({ kind: 'transform', ...f })));
  const loading = problems.map((p) => ({ ...loadingDiagnostic(p), filePosition: p.kind === 'head' ? point(p.line, p.column) : point(parts.line, 1) }));
  return { ...parts, schema, opts: options, ast, diagnostics: loading.concat(all), toFile: (pos) => toFile(pos, parts.line) };
}

module.exports = { DETECT, detect, notNote, split, attributes, headScripts, addons, transformWith, loadingDiagnostic, analyse, tern };
