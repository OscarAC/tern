// SPDX-License-Identifier: MIT
// `tern lsp`, the language server (docs/tools.html#lsp): a hand-rolled
// JSON-RPC 2.0 server over stdio, with Content-Length framing and no
// dependencies; main() starts it. It runs the engine on a note and
// publishes its diagnostics, as the browser reports them, and the
// `tern/outline` digest; cli/language.js answers the requests from the
// analysis, and this file maps its answers onto the protocol's shapes.
// Positions are UTF-16 code units, as the engine's columns are; note line n
// is file line n + the head's line count (cli/note.js).
'use strict';

const fs = require('fs');
const path = require('path');
const { fileURLToPath } = require('url');
const note = require('./note');
const language = require('./language');

const { tern } = note;
const DEBOUNCE = 150; // ms after the last change
const SEVERITY = { error: 1, warning: 2, info: 3 };
const SYMBOL = { heading: 15, container: 5, leaf: 8 }; // LSP SymbolKind: String, Class, Field
const COMPLETION = { name: 7, core: 14, closer: 14, element: 10, id: 18 }; // LSP CompletionItemKind: Class, Keyword, Property, Reference
const HIGHLIGHT = { read: 2, write: 3 }; // LSP DocumentHighlightKind
const ERROR = { invalid: -32602, refused: -32803 }; // a LanguageError's code: InvalidParams, RequestFailed

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
      if (e && e.rpc) error = e.rpc;
      else if (e instanceof language.LanguageError) error = { code: ERROR[e.code], message: e.message };
      else {
        error = { code: -32603, message: String((e && e.message) || e) };
        log((e && e.stack) || e);
      }
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
  documentHighlightProvider: true,
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
  'textDocument/documentHighlight': documentHighlight,
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

const docs = new Map(); // uri -> {uri, version, text, timer, index, wasNote}

function didOpen({ textDocument: d }) {
  if (!d || typeof d.uri !== 'string') return;
  const doc = { uri: d.uri, version: d.version, text: String(d.text ?? ''), timer: null, index: null, wasNote: false };
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

// The document a request names, analysed: a pending change is analysed
// first, so the debounce spaces out publishing but never serves stale text.
// Its `index` is cli/language.js's, or null for a file that is not a note.
function current(params) {
  const doc = docs.get(params.textDocument && params.textDocument.uri);
  if (!doc) throw fail(-32602, 'unknown document: it was never opened');
  if (doc.timer) analyse(doc);
  return doc;
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
  if (a || doc.wasNote) guard(() => notify('tern/outline', { uri: doc.uri, version: doc.version, ...language.outline(a) }));
  doc.wasNote = !!a;
  doc.index = null;
  guard(() => (doc.index = language.index(a)));
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

// ---------------------------------------------------------------- features

// Each request asks cli/language.js and gives its answer the protocol's
// shape: a location carries the document's uri, kinds are numbers.
const at = (params) => [current(params).index, params.position];

function definition(params) {
  const doc = current(params);
  const range = language.definition(doc.index, params.position);
  return range && { uri: doc.uri, range };
}

function references(params) {
  const doc = current(params);
  const ranges = language.references(doc.index, params.position, { includeDeclaration: !!(params.context && params.context.includeDeclaration) });
  return ranges && ranges.map((range) => ({ uri: doc.uri, range }));
}

function documentHighlight(params) {
  const list = language.highlights(...at(params));
  return list && list.map((h) => ({ range: h.range, kind: HIGHLIGHT[h.kind] }));
}

function hover(params) {
  const h = language.hover(...at(params));
  return h && { contents: { kind: 'markdown', value: h.markdown }, range: h.range };
}

function prepareRename(params) {
  return language.prepareRename(...at(params));
}

function rename(params) {
  const doc = current(params);
  const edits = language.rename(doc.index, params.position, params.newName);
  return edits && { changes: { [doc.uri]: edits } };
}

function completion(params) {
  return language.completion(...at(params)).map((i) => ({
    label: i.label,
    kind: COMPLETION[i.kind],
    detail: i.detail,
    sortText: i.sortText,
    filterText: i.filterText,
    textEdit: { range: i.range, newText: i.newText },
  }));
}

function documentSymbol(params) {
  const symbol = (s) => ({ ...s, kind: SYMBOL[s.kind], children: s.children.map(symbol) });
  return language.symbols(current(params).index).map(symbol);
}

function foldingRange(params) {
  return language.folds(current(params).index);
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
