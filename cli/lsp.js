// SPDX-License-Identifier: MIT
// `tern lsp`, the language server (docs/tools.html#lsp): a hand-rolled
// JSON-RPC 2.0 server over stdio, with Content-Length framing and no
// dependencies; main() starts it. It runs the engine on a note and answers
// from the AST: diagnostics as the browser reports them, the `tern/outline`
// digest, and ids, references and names at exact columns. Positions are
// UTF-16 code units, as the engine's columns are; note line n is file line
// n + the head's line count (cli/note.js).
'use strict';

const fs = require('fs');
const path = require('path');
const { fileURLToPath } = require('url');
const note = require('./note');
const { ALLOW } = require('../src/schema'); // the HTML element allowlists, for completion

const { tern } = note;
const DEBOUNCE = 150; // ms after the last change
const SEVERITY = { error: 1, warning: 2, info: 3 };
const IDENT = /^[\p{L}_][\p{L}\p{M}\p{N}_-]*$/u; // an id that `{#id}` and `@id` accept
const NAME = /^\p{L}[\p{L}\p{M}\p{N}_-]*$/u;
const LEVEL = { containerDirective: 'block', leafDirective: 'leaf', textDirective: 'inline' };
const USES = new Set(['ref', 'link', 'footnote']); // what references an id
const OPAQUE = new Set(['code', 'inlineCode', 'math', 'inlineMath', 'html']); // no Tern syntax inside
const FOLDS = new Set(['containerDirective', 'code', 'math', 'table', 'list', 'footnoteDefinition']);
const NESTS = new Set(['blockquote', 'list', 'listItem', 'cell', 'footnoteDefinition']); // block parents
const KIND = { heading: 15, container: 5, leaf: 8 }; // LSP SymbolKind: String, Class, Field

const tn = (n) => (n.data && n.data.tern) || {};
const log = (s) => process.stderr.write(`tern lsp: ${s}\n`);
const fail = (code, message) => Object.assign(new Error(message), { rpc: { code, message } });
const guard = (fn) => {
  try {
    fn();
  } catch (e) {
    log((e && e.stack) || e);
  }
};

// ---------------------------------------------------------------- JSON-RPC

function send(msg) {
  const body = JSON.stringify({ jsonrpc: '2.0', ...msg });
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}
const notify = (method, params) => send({ method, params });

// Content-Length framing. A header block without a length is skipped; a body
// that is not JSON gets a parse error.
function read(input, onMessage) {
  let buf = Buffer.alloc(0);
  input.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (let sep; (sep = buf.indexOf('\r\n\r\n')) >= 0; ) {
      const m = /^content-length:[ \t]*(\d+)[ \t]*$/im.exec(buf.toString('ascii', 0, sep));
      const end = m ? sep + 4 + Number(m[1]) : sep + 4;
      if (buf.length < end) return;
      const body = m ? buf.toString('utf8', sep + 4, end) : null;
      buf = buf.subarray(end);
      if (body === null) continue;
      let msg;
      try {
        msg = JSON.parse(body);
      } catch {
        send({ id: null, error: { code: -32700, message: 'the message is not JSON' } });
        continue;
      }
      guard(() => onMessage(msg));
    }
  });
}

let phase = 'new'; // 'running' after initialize, 'down' after shutdown

function receive(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return send({ id: null, error: { code: -32600, message: 'not a JSON-RPC message' } });
  const { id, method } = msg;
  const params = msg.params && typeof msg.params === 'object' ? msg.params : {};
  if (typeof method !== 'string') return; // a response: the server sends no requests
  if (id === undefined) {
    if (method === 'exit') return exit();
    const fn = phase === 'running' && NOTIFICATIONS[method];
    return fn && fn(params); // notifications are never answered
  }
  const fn = REQUESTS[method];
  let error = null;
  let result = null;
  if (phase === 'new' && method !== 'initialize') error = { code: -32002, message: 'the server is not initialized' };
  else if (phase === 'down') error = { code: -32600, message: 'the server is shut down' };
  else if (!fn) error = { code: -32601, message: `${method} is not supported` };
  else {
    try {
      result = fn(params) ?? null;
    } catch (e) {
      error = e.rpc || { code: -32603, message: String((e && e.message) || e) };
      if (!e.rpc) log((e && e.stack) || e);
    }
  }
  send(error ? { id, error } : { id, result });
}

const CAPABILITIES = {
  positionEncoding: 'utf-16',
  textDocumentSync: { openClose: true, change: 1 }, // full text
  completionProvider: { triggerCharacters: [':', '@', '/', '#'] },
  hoverProvider: true,
  definitionProvider: true,
  referencesProvider: true,
  renameProvider: { prepareProvider: true },
  documentSymbolProvider: true,
  foldingRangeProvider: true,
};

const REQUESTS = {
  initialize() {
    if (phase !== 'new') throw fail(-32600, 'the server is already initialized');
    phase = 'running';
    return { capabilities: CAPABILITIES, serverInfo: { name: 'tern', version: tern.version } };
  },
  shutdown() {
    phase = 'down';
    for (const doc of docs.values()) clearTimeout(doc.timer);
    return null;
  },
  'textDocument/completion': completion,
  'textDocument/definition': definition,
  'textDocument/references': references,
  'textDocument/prepareRename': prepareRename,
  'textDocument/rename': rename,
  'textDocument/hover': hover,
  'textDocument/documentSymbol': documentSymbol,
  'textDocument/foldingRange': foldingRange,
};

const NOTIFICATIONS = { 'textDocument/didOpen': didOpen, 'textDocument/didChange': didChange, 'textDocument/didClose': didClose };

function exit() {
  const code = phase === 'down' ? 0 : 1;
  process.stdout.write('', () => process.exit(code));
}

// ---------------------------------------------------------------- documents

const docs = new Map(); // uri -> {uri, version, text, timer, a, wasNote}

function didOpen({ textDocument: d }) {
  if (!d || typeof d.uri !== 'string') return;
  const doc = { uri: d.uri, version: d.version, text: String(d.text ?? ''), timer: null, a: null, wasNote: false };
  docs.set(d.uri, doc);
  analyse(doc);
}

function didChange({ textDocument: d, contentChanges }) {
  const doc = d && docs.get(d.uri);
  if (!doc) return;
  const last = contentChanges && contentChanges[contentChanges.length - 1];
  if (!last) return;
  doc.text = String(last.text ?? ''); // full sync: each change is the whole text
  doc.version = d.version;
  clearTimeout(doc.timer);
  doc.timer = setTimeout(() => guard(() => analyse(doc)), DEBOUNCE);
}

function didClose({ textDocument: d }) {
  const doc = d && docs.get(d.uri);
  if (!doc) return;
  clearTimeout(doc.timer);
  docs.delete(d.uri);
  notify('textDocument/publishDiagnostics', { uri: doc.uri, diagnostics: [] });
}

// The analysis a request reads: a pending change is analysed first, so the
// debounce spaces out publishing but never serves stale text.
function current(params) {
  const doc = docs.get(params.textDocument && params.textDocument.uri);
  if (!doc) throw fail(-32602, 'unknown document: it was never opened');
  if (doc.timer) analyse(doc);
  return doc.a;
}

// Parses and transforms, then publishes the diagnostics and the outline. A
// file that is not a note gets none, and an empty outline if it was one.
function analyse(doc) {
  clearTimeout(doc.timer);
  doc.timer = null;
  let a;
  try {
    a = note.analyse(doc.text, fileOf(doc.uri), { addons: load });
  } catch (e) {
    return log(`analysing ${doc.uri}: ${(e && e.stack) || e}`);
  }
  notify('textDocument/publishDiagnostics', { uri: doc.uri, version: doc.version, diagnostics: a ? a.diagnostics.map(diagnostic) : [] });
  if (a || doc.wasNote) guard(() => notify('tern/outline', { uri: doc.uri, version: doc.version, ...outline(a) }));
  doc.wasNote = !!a;
  doc.a = null;
  guard(() => (doc.a = a && index(a, doc.uri)));
}

// The note's path, for its head scripts and add-ons; null for an untitled or remote document.
function fileOf(uri) {
  try {
    return fileURLToPath(uri);
  } catch {
    return null;
  }
}

// The vocabulary loader note.analyse calls (note.addons: the head's scripts,
// the add-ons, then window.TERN.schema), cached by all its result
// depends on: the directory, the tag, the head's scripts as written, and the
// mtime of every file they and the add-ons may load. A root-relative URL
// (/lib/x.js) is looked up in every ancestor directory, so each candidate is
// stamped. The cached value holds the add-ons' transforms; note.analyse
// registers them for each analysis and unregisters them after it, so a
// note's transforms never run on another note.
const cache = new Map(); // key -> {stamp, value}, the most recent 64
const remote = (url) => /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(url);
function load(tag, dir, head) {
  const scripts = note.headScripts(head);
  const urls = scripts.map((s) => s.src).filter((u) => u !== null && !remote(u));
  for (const u of (note.attributes(tag)['data-use'] || '').split(/\s+/)) if (u && !/\.css$/i.test(u.replace(/[?#].*$/, '')) && !remote(u)) urls.push(u);
  const files = [];
  for (const url of urls.map((u) => u.replace(/[?#].*$/, ''))) {
    if (!url.startsWith('/')) files.push(path.resolve(dir, url));
    else
      for (let d = path.resolve(dir); ; d = path.dirname(d)) {
        files.push(path.join(d, url));
        if (path.dirname(d) === d) break;
      }
  }
  const key = JSON.stringify([dir, tag, scripts]);
  const stamp = files.map((f) => `${f} ${fs.statSync(f, { throwIfNoEntry: false })?.mtimeMs}`).join('\n');
  const hit = cache.get(key);
  if (hit && hit.stamp === stamp) return hit.value;
  const value = note.addons(tag, dir, head);
  cache.delete(key);
  cache.set(key, { stamp, value });
  if (cache.size > 64) cache.delete(cache.keys().next().value);
  return value;
}

// An engine diagnostic as LSP's: a 0-based range from the file position, the
// tern code, and the hint after the message and in `data`.
function diagnostic(d) {
  const p = d.filePosition;
  const at = (q) => ({ line: Math.max(q.line - 1, 0), character: Math.max(q.column - 1, 0) });
  const out = { range: { start: at(p.start), end: at(p.end) }, severity: SEVERITY[d.severity] || 3, code: d.code, source: 'tern' };
  out.message = d.hint ? `${d.message}\n${d.hint}` : d.message;
  if (d.hint) out.data = { hint: d.hint };
  return out;
}

// tern.outline with every `line` and `endLine` a file line, 1-based like the
// outline's own.
function outline(a) {
  const o = tern.outline(a ? a.ast : { type: 'root', children: [] });
  for (const k in o) for (const e of o[k]) (e.line += a.line), e.endLine && (e.endLine += a.line);
  return o;
}

// ---------------------------------------------------------------- the index

// What the features read from one analysis, in the engine's note offsets:
// the registry, the element holding each id and where it is written, and
// every occurrence of an id or a name: its extent [s, e] and the characters
// [from, to) a rename replaces.
function index(a, uri) {
  const src = a.note.replace(/^\uFEFF/, ''); // as the parser normalises it
  const starts = [0];
  for (let i = src.indexOf('\n'); i >= 0; i = src.indexOf('\n', i + 1)) starts.push(i + 1);
  const ids = (a.ast.data.tern && a.ast.data.tern.ids) || {};
  const holders = new Map();
  const occ = [];
  const ends = new Map(); // an end offset -> the innermost container ending there
  tern.visit(a.ast, (n) => {
    if (!n.position) return false; // copied text: reference text, toc entries
    const t = tn(n);
    const s = n.position.start.offset;
    const e = n.position.end.offset;
    if (n.type === 'ref') occ.push({ kind: 'ref', id: n.id, s, e, from: s + 1, to: s + 1 + n.id.length });
    else if (n.type === 'link') {
      const f = fragment(src, n);
      if (f) occ.push({ kind: 'link', s, e, ...f });
    } else if (n.type === 'footnoteReference' && t.target) occ.push({ kind: 'footnote', id: t.target, s, e, from: s + 2, to: s + 2 + n.label.length });
    if (LEVEL[n.type] && !t.implicit) {
      const np = n.type === 'textDirective' ? { s: s + 1, e: s + 1 + n.name.length } : t.namePosition && { s: t.namePosition.start.offset, e: t.namePosition.end.offset };
      if (np) occ.push({ kind: 'name', node: n, ...np, from: np.s, to: np.e });
      if (n.type === 'containerDirective') ends.set(e, n);
    }
    // The holder of an id is the element the registry records it at.
    const id = n.attributes && n.attributes.id !== undefined ? String(n.attributes.id) : n.type.startsWith('footnote') ? t.id : undefined;
    const r = id !== undefined && Object.prototype.hasOwnProperty.call(ids, id) ? ids[id] : null;
    if (r) {
      const w = ((r.explicit && t.idPosition) || n.position).start;
      if (!holders.has(id) || (w.line === r.line && w.column === r.column)) holders.set(id, n);
    }
  });
  // A named closer is read back from the source at its container's end: the
  // AST records neither its position nor whether the container was closed.
  const unclosed = new Set(a.diagnostics.filter((d) => d.code === 'block.unclosed' && d.position).map((d) => d.position.start.offset));
  for (const [end, n] of ends) {
    const k = end - n.name.length;
    if (!unclosed.has(n.position.start.offset) && src.slice(k - 4, end) === `:::/${n.name}`) occ.push({ kind: 'closer', node: n, s: k, e: end, from: k, to: end });
  }
  // Declarations: the `#id` or `id=` item; a footnote's `[^label]:`; a slug's
  // heading. A heading is also a hit area for its own id.
  const decls = new Map();
  for (const [id, n] of holders) {
    const t = tn(n);
    const s = n.position.start.offset;
    let d = { id, node: n, s, e: n.position.end.offset, generated: !ids[id].explicit };
    if (ids[id].explicit && t.idPosition) {
      const p = t.idPosition;
      const q = /["']/.test(src[p.start.offset + 3]) && src[p.start.offset] !== '#';
      const from = p.start.offset + (src[p.start.offset] === '#' ? 1 : q ? 4 : 3);
      d = { ...d, s: p.start.offset, e: p.end.offset, from, to: p.end.offset - (q ? 1 : 0) };
    } else if (n.type === 'footnoteDefinition') d = { ...d, e: s + n.label.length + 4, from: s + 2, to: s + 2 + n.label.length };
    else if (n.type === 'heading') d.slug = true;
    decls.set(id, d);
    if (d.from !== undefined) occ.push({ kind: 'decl', id, s: d.s, e: d.e, from: d.from, to: d.to });
    if (n.type === 'heading') occ.push({ kind: 'decl', id, s, e: n.position.end.offset, from: s, to: n.position.end.offset });
  }
  return { uri, line: a.line, src, starts, schema: a.schema, ast: a.ast, ids, holders, decls, occ };
}

// The `#id` of a fragment link as written: after the `](` that ends its text,
// whitespace and an optional `<`. The AST records no destination position.
function fragment(src, n) {
  if (typeof n.url !== 'string' || n.url.length < 2 || n.url[0] !== '#') return null;
  const last = n.children && n.children[n.children.length - 1];
  let k = last && last.position ? last.position.end.offset : n.position.start.offset + 1;
  if (src.slice(k, k + 2) !== '](') return null;
  for (k += 2; /\s/.test(src[k] || ''); ) k++;
  if (src[k] === '<') k++;
  if (src[k] !== '#') return null;
  let e = ++k;
  while (e < n.position.end.offset && !/[\s)>]/.test(src[e])) e++;
  let id = n.url.slice(1);
  try {
    id = decodeURIComponent(id);
  } catch {
    // not UTF-8 percent-encoding: compared as written, as the refs transform does
  }
  return { id, from: k, to: e };
}

// Offsets and LSP positions: line l of the note is file line l + a.line.
function point(a, off) {
  const s = a.starts;
  let lo = 0;
  let hi = s.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (s[mid] <= off) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + a.line, character: off - s[lo] };
}
const range = (a, s, e) => ({ start: point(a, s), end: point(a, e) });
const location = (a, s, e) => ({ uri: a.uri, range: range(a, s, e) });
function offset(a, p) {
  const l = p && p.line - a.line;
  if (!(l >= 0 && l < a.starts.length)) return -1;
  const end = l + 1 < a.starts.length ? a.starts[l + 1] - 1 : a.src.length;
  return Math.min(a.starts[l] + Math.max(0, p.character | 0), end);
}

// The innermost occurrence at a position, its end included.
function hit(a, p) {
  const off = a ? offset(a, p) : -1;
  let best = null;
  for (const o of off < 0 ? [] : a.occ) if (o.s <= off && off <= o.e && (!best || o.e - o.s < best.e - best.s)) best = o;
  return best;
}
const at = (params) => {
  const a = current(params);
  return { a, h: hit(a, params.position) };
};

// ---------------------------------------------------------------- features

// The plain text of inline content, as a title or a label shows it.
function plain(nodes) {
  let s = '';
  for (const n of nodes || []) {
    if (n.type === 'image') s += n.alt || '';
    else if (n.type === 'break') s += ' ';
    else if (n.type === 'ref' && !n.children) s += `@${n.id}`;
    else if (typeof n.value === 'string' && n.type !== 'html') s += n.value;
    else if (n.type !== 'footnoteReference') s += plain(n.children);
  }
  return s;
}
const clip = (s) => ((s = s.replace(/\s+/g, ' ').trim()).length > 80 ? `${s.slice(0, 79)}…` : s);

// What a reference shows of its target: the label and the
// title, "Theorem 2 — Rank–nullity"; a heading's text; an equation's number.
function describe(n) {
  const t = tn(n);
  const kids = n.children || [];
  let title = '';
  if (n.type === 'containerDirective') title = kids[0] && kids[0].data && kids[0].data.directiveLabel ? plain(kids[0].children) : '';
  else if (n.type === 'code') title = t.title ? plain(t.title) : '';
  else if (n.type === 'footnoteDefinition') title = plain(kids[0] && kids[0].children);
  else if (n.type !== 'paragraph' && n.type !== 'table') title = plain(kids);
  const label = n.type === 'footnoteDefinition' && t.number ? `Footnote ${t.number}` : t.text;
  return [label, clip(title)].filter(Boolean).join(' — ');
}
const md = (s) => s.replace(/[\\`*_[\]<>#|]/g, '\\$&');

function definition(params) {
  const { a, h } = at(params);
  if (!h) return null;
  const d = h.kind === 'closer' ? a.occ.find((o) => o.kind === 'name' && o.node === h.node) : h.id !== undefined && a.decls.get(h.id);
  return d ? location(a, d.s, d.e) : null;
}

function references(params) {
  const { a, h } = at(params);
  if (!h || h.id === undefined) return null;
  const out = a.occ.filter((o) => USES.has(o.kind) && o.id === h.id).map((o) => location(a, o.s, o.e));
  const d = a.decls.get(h.id);
  if (d && params.context && params.context.includeDeclaration) out.unshift(location(a, d.s, d.e));
  return out;
}

function hover(params) {
  const { a, h } = at(params);
  if (!h) return null;
  let value;
  if (h.node) {
    const n = h.node;
    const t = tn(n);
    const level = LEVEL[n.type];
    const how = Object.prototype.hasOwnProperty.call(a.schema[level] || {}, n.name) ? 'declared in the schema' : ALLOW[level].has(n.name) ? 'an HTML element' : 'no schema entry';
    const written = `${n.type === 'textDirective' ? ':' : ':'.repeat(t.colons || 2)}${n.name}`;
    value = t.tag ? `\`${written}\` → \`<${t.tag}>\`, ${how}${t.text ? ` · ${md(t.text)}` : ''}` : `\`${written}\`, a core block`;
  } else {
    const n = a.holders.get(h.id);
    if (!n) value = `\`@${h.id}\` names no id in this note`;
    else value = `**${md(describe(n) || h.id)}**\n\n${md(a.ids[h.id].kind)} · \`#${h.id}\` · line ${n.position.start.line + a.line}`;
  }
  return { contents: { kind: 'markdown', value }, range: range(a, h.s, h.e) };
}

// Rename: an id with its declaration and every reference, or one
// element's name with its named closer. Generated ids have nothing to edit.
function target(params) {
  const { a, h } = at(params);
  if (!h) return null;
  if (h.node) return { a, h, name: h.node.name, occ: a.occ.filter((o) => o.node === h.node) };
  const d = a.decls.get(h.id);
  if (d && d.generated && !d.slug) throw fail(-32803, `"${h.id}" is generated from a footnote label; it cannot be renamed`);
  return { a, h, id: h.id, d };
}

function prepareRename(params) {
  const t = target(params);
  return t && { range: range(t.a, t.h.from, t.h.to), placeholder: t.name || t.id };
}

function rename(params) {
  const t = target(params);
  if (!t) return null;
  const { a } = t;
  const to = params.newName;
  if (typeof to !== 'string') throw fail(-32602, 'rename needs a newName');
  const edit = (from, end, newText = to) => ({ range: range(a, from, end), newText });
  if (t.name) {
    if (!NAME.test(to)) throw fail(-32602, `"${to}" is not an element name: a letter, then letters, digits, _ or -`);
    return { changes: { [a.uri]: t.occ.map((o) => edit(o.from, o.to)) } };
  }
  if (!IDENT.test(to) || to.endsWith('-')) throw fail(-32602, `"${to}" is not an id @ can reach: a letter or _, then letters, digits, _ or -, not ending in -`);
  if (to !== t.id && Object.prototype.hasOwnProperty.call(a.ids, to)) throw fail(-32602, `the id "${to}" is already used in this note`);
  const edits = [];
  const d = t.d;
  if (d && d.slug) {
    const own = Object.keys(d.node.attributes || {}).filter((k) => k !== 'id');
    if (own.length || tn(d.node).idPosition) throw fail(-32803, `the heading's id is its slug; write {#${t.id}} in its attribute group first`);
    edits.push(edit(d.e, d.e, ` {#${to}}`));
  } else if (d) edits.push(edit(d.from, d.to));
  for (const o of a.occ) if ((o.kind === 'ref' || o.kind === 'link') && o.id === t.id) edits.push(edit(o.from, o.to));
  return { changes: { [a.uri]: edits } };
}

// Completion: element names after `:::`, `::` and `:`, the open
// containers' named closers, and ids after `@` or `](#`. Never inside code,
// math, raw HTML or a raw body, which the AST tells.
function completion(params) {
  const a = current(params);
  const off = a ? offset(a, params.position) : -1;
  if (off < 0 || opaque(a, off)) return [];
  const bol = a.starts[params.position.line - a.line];
  const before = a.src.slice(bol, off);
  const items = [];
  const add = (from, kind, sort) => (label, detail) =>
    items.push({ label, kind, detail, sortText: `${sort}${label}`, filterText: label, textEdit: { range: range(a, from, off), newText: label } });
  let m;
  if ((m = /^[\s>]*(?:(?:[-+*]|\d{1,9}[.)])[ \t]+)?(:{2,})(\/?)([\p{L}\p{M}\p{N}_-]*)$/u.exec(before))) {
    const from = off - m[2].length - m[3].length;
    if (m[1].length >= 3) {
      const close = add(from, 14, '0');
      for (const n of open(a, bol)) close(`/${n.name}`, `closes :::${n.name} (line ${n.position.start.line + a.line})`);
      if (!m[2]) names(a, 'block', from, add);
    } else if (!m[2]) names(a, 'leaf', from, add);
  } else if ((m = /(?:^|[^A-Za-z0-9_:/]):([\p{L}\p{M}\p{N}_-]*)$/u.exec(before))) names(a, 'inline', off - m[1].length, add);
  else if ((m = /(?:^|[^A-Za-z0-9_./@-])@([\p{L}\p{M}\p{N}_-]*)$/u.exec(before) || /\]\(#([^\s()<>]*)$/u.exec(before))) {
    const id = add(off - m[1].length, 18, '');
    for (const k in a.ids) {
      const n = a.holders.get(k);
      if (a.ids[k].kind !== 'footnoteReference' && IDENT.test(k)) id(k, (n && describe(n)) || a.ids[k].kind);
    }
  }
  return items;
}

// The names of a level: the schema (head and add-ons), the core blocks, the allowlist.
function names(a, level, from, add) {
  const seen = new Set();
  const put = (fn) => (name, detail) => seen.has(name) || (seen.add(name), fn(name, detail));
  const schema = a.schema[level] || {};
  const own = put(add(from, 7, '1'));
  for (const k of Object.keys(schema)) own(k, `schema${schema[k] && schema[k].tag ? ` → <${schema[k].tag}>` : ''}`);
  if (level === 'block') for (const k of ['meta', 'macros']) put(add(from, 14, '2'))(k, 'core');
  for (const k of ALLOW[level]) put(add(from, 10, '3'))(k, `<${k}>`);
}

// The containers open at a line, innermost first.
function open(a, bol) {
  const out = [];
  tern.visit(a.ast, (n) => {
    if (!n.position || n.position.start.offset >= bol || n.position.end.offset < bol) return n.type === 'root' ? undefined : false;
    if (n.type === 'containerDirective' && !tn(n).implicit) out.unshift(n);
  });
  return out;
}

// Whether an offset is inside code, math, raw HTML or a raw body.
function opaque(a, off) {
  const line = point(a, off).line - a.line + 1;
  let inside = false;
  tern.visit(a.ast, (n) => {
    if (inside || !n.position) return false;
    const { start, end } = n.position;
    const holds = start.offset < off && (off < end.offset || (off === end.offset && off === a.src.length)); // an open block runs to the end
    if (n.type !== 'root' && !holds) return false;
    if (OPAQUE.has(n.type) || (typeof n.value === 'string' && LEVEL[n.type] && start.line < line && line < end.line)) inside = true;
  });
  return inside;
}

// Headings nest by depth, each spanning its section; named containers and
// leaves sit where they are written, a container holding what it contains.
function documentSymbol(params) {
  const a = current(params);
  return a ? symbols(a, a.ast.children, []) : [];
}

function symbols(a, list, out) {
  const open = []; // [depth, symbol] for each heading whose section is open
  let last = 0;
  const close = (depth) => {
    while (open.length && open[open.length - 1][0] >= depth) open.pop()[1].range.end = point(a, last);
  };
  for (const n of list) {
    if (!n.position) continue;
    if (n.type === 'heading') close(n.depth);
    const into = open.length ? open[open.length - 1][1].children : out;
    const s = n.position.start.offset;
    const e = n.position.end.offset;
    const id = n.attributes && n.attributes.id !== undefined ? ` #${n.attributes.id}` : '';
    const symbol = (name, detail, kind) => {
      const r = range(a, s, e);
      const sym = { name: name || '(untitled)', detail, kind, range: r, selectionRange: { ...r }, children: [] };
      return into.push(sym), sym;
    };
    if (n.type === 'heading') open.push([n.depth, symbol(clip(plain(n.children)), `${'#'.repeat(n.depth)}${id}`, KIND.heading)]);
    else if (n.type === 'containerDirective' || n.type === 'leafDirective') {
      const container = n.type === 'containerDirective';
      const sym = symbol(describe(n) || n.name, `${':'.repeat(tn(n).colons || (container ? 3 : 2))}${n.name}${id}`, container ? KIND.container : KIND.leaf);
      if (container && Array.isArray(n.children)) symbols(a, n.children, sym.children);
    } else if (NESTS.has(n.type) && n.children) symbols(a, n.children, into);
    last = e;
  }
  close(0);
  return out;
}

// Containers, fences, raw HTML blocks, display math, tables, lists, footnote
// definitions, and heading sections.
function foldingRange(params) {
  const a = current(params);
  if (!a) return [];
  const out = [];
  const fold = (r) => r.end.line > r.start.line && out.push({ startLine: r.start.line, endLine: r.end.line });
  tern.visit(a.ast, (n) => {
    if (!n.position) return false;
    if (FOLDS.has(n.type) || (n.type === 'html' && tn(n).kind !== 'inline')) fold(range(a, n.position.start.offset, n.position.end.offset));
  });
  const sections = (list) => {
    for (const s of list) {
      if (s.kind === KIND.heading) fold(s.range);
      sections(s.children);
    }
  };
  sections(symbols(a, a.ast.children, []));
  return out;
}

// ---------------------------------------------------------------- main

function main() {
  // stdout carries the protocol and nothing else: whatever a script logs
  // through `console` goes to stderr.
  const err = new console.Console(process.stderr, process.stderr);
  for (const k of Object.keys(console)) if (typeof console[k] === 'function' && typeof err[k] === 'function') console[k] = err[k].bind(err);
  process.on('uncaughtException', (e) => log((e && e.stack) || e));
  read(process.stdin, receive);
  process.stdin.on('end', () => process.exit(phase === 'down' ? 0 : 1));
}

module.exports = { main };
