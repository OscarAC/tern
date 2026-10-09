// SPDX-License-Identifier: MIT
// Parses test/corpus/*.txt into cases: loadAll(dir = test/corpus) returns
// {cases, errors}. The format is documented in test/corpus/README.md; this
// file is its reference implementation.
'use strict';

const fs = require('fs');
const path = require('path');

const ID = /^[a-z][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/;
const KINDS = new Set(['tern', 'tern js', 'html', 'html head', 'json ast', 'json transformed', 'json diagnostics', 'diagnostics']);
const OPTIONS = new Set(['schema=fixture', 'schema=none', 'schema=extended', 'strict', 'safe', 'diagnostics=any', 'diagnostics=partial', 'escaped', 'noeol']);
const SEVERITY = { error: 'error', warning: 'warning', info: 'info', E: 'error', W: 'warning', I: 'info' };

class CorpusError extends Error {
  constructor(file, line, message) {
    super(`${file}:${line}: ${message}`);
    this.file = file;
    this.line = line;
  }
}

function parseFile(file, text) {
  const rel = path.relative(process.cwd(), file);
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const cases = [];
  const errors = [];
  let cur = null;
  const err = (line, msg) => errors.push(new CorpusError(rel, line, msg));

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;
    if (/^# /.test(line)) {
      cur = null; // a file-level heading ends the current case
      continue;
    }
    if ((m = /^## (.*)$/.exec(line))) {
      const id = m[1].trim();
      if (!ID.test(id)) err(i + 1, `case heading must be "## area/slug" in kebab case, got "${id}"`);
      cur = { id, file: rel, line: i + 1, spec: [], options: new Set(), blocks: {}, prose: [] };
      cases.push(cur);
      continue;
    }
    if ((m = /^(`{4,})(.*)$/.exec(line))) {
      const fence = m[1];
      const info = m[2].trim();
      const body = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const c = /^(`{4,})\s*$/.exec(lines[j]);
        if (c && c[1].length >= fence.length) break;
        body.push(lines[j]);
      }
      if (j >= lines.length) err(i + 1, `unclosed ${fence} block`);
      if (!cur) err(i + 1, 'fenced block outside a case');
      else if (!KINDS.has(info)) err(i + 1, `unknown block "${info}" (expected one of: ${[...KINDS].join(', ')})`);
      else if (cur.blocks[info] !== undefined) err(i + 1, `duplicate "${info}" block in ${cur.id}`);
      else cur.blocks[info] = { text: body.join('\n'), line: i + 2 };
      i = j;
      continue;
    }
    if (!cur) continue;
    if ((m = /^spec:\s*(.*)$/.exec(line)) && !Object.keys(cur.blocks).length) {
      cur.spec.push(...m[1].split(/\s+/).filter(Boolean));
      continue;
    }
    if ((m = /^options:\s*(.*)$/.exec(line)) && !Object.keys(cur.blocks).length) {
      for (const o of m[1].split(/\s+/).filter(Boolean)) {
        if (!OPTIONS.has(o)) err(i + 1, `unknown option "${o}"`);
        cur.options.add(o);
      }
      continue;
    }
    if (line.trim()) cur.prose.push(line);
  }

  for (const c of cases) finish(c, err);
  return { cases, errors };
}

function decodeEscapes(s) {
  return s.replace(/\\(?:u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|([trn0\\]))/g, (_, cp, u4, ch) => {
    if (cp) return String.fromCodePoint(parseInt(cp, 16));
    if (u4) return String.fromCharCode(parseInt(u4, 16));
    return { t: '\t', r: '\r', n: '\n', 0: '\0', '\\': '\\' }[ch];
  });
}

function finish(c, err) {
  const b = c.blocks;
  if (b.tern && b['tern js']) err(c.line, `${c.id}: give either a "tern" or a "tern js" block, not both`);
  if (!b.tern && !b['tern js']) err(c.line, `${c.id}: no "tern" source block`);
  if (b['json diagnostics'] && b.diagnostics) err(c.line, `${c.id}: give either "diagnostics" or "json diagnostics", not both`);
  const expects = ['html', 'json ast', 'json transformed', 'json diagnostics', 'diagnostics'].filter((k) => b[k]);
  if (!expects.length) err(c.line, `${c.id}: no expectation (html, json ast, json transformed or diagnostics)`);
  if (!c.spec.length) err(c.line, `${c.id}: no "spec:" line`);

  try {
    if (b['tern js']) {
      // eslint-disable-next-line no-new-func
      const v = new Function(`"use strict"; return (${b['tern js'].text});`)();
      if (typeof v !== 'string') throw new Error('the expression did not produce a string');
      c.source = v;
    } else if (b.tern) {
      let s = b.tern.text;
      if (c.options.has('escaped')) s = decodeEscapes(s);
      c.source = c.options.has('noeol') ? s : s + '\n';
    }
  } catch (e) {
    err(b['tern js'].line, `${c.id}: tern js: ${e.message}`);
  }
  if (b['html head']) c.head = b['html head'].text;
  if (b.html) c.html = b.html.text;
  for (const k of ['json ast', 'json transformed', 'json diagnostics']) {
    if (!b[k]) continue;
    try {
      c[k.split(' ')[1]] = JSON.parse(b[k].text || 'null');
    } catch (e) {
      err(b[k].line, `${c.id}: ${k}: ${e.message}`);
    }
  }
  if (b.diagnostics) {
    c.diagnostics = [];
    c.forbidden = [];
    b.diagnostics.text.split('\n').forEach((line, k) => {
      if (!line.trim()) return;
      const no = /^\s*!\s*([a-z]+\.[a-z-]+)\s*$/.exec(line);
      if (no) return c.forbidden.push(no[1]);
      const d = parseDiagnosticLine(line);
      if (!d) err(b.diagnostics.line + k, `${c.id}: diagnostics line must be "[?] LINE:COL[-LINE:COL] SEVERITY CODE [\\"substring\\"]", got "${line}"`);
      else c.diagnostics.push(d);
    });
  }
  if (c.diagnostics && !Array.isArray(c.diagnostics)) err(c.line, `${c.id}: diagnostics must be an array`);
}

// "12:3 error math.unclosed"  "4:1-4:9 W attr.malformed \"braces\""
// "? 3:1 info latex.linebreak"  (optional: may appear, need not)
function parseDiagnosticLine(line) {
  const m = /^\s*(\?\s*)?(\d+):(\d+)(?:-(\d+):(\d+))?\s+(error|warning|info|E|W|I)\s+([a-z]+\.[a-z-]+)(?:\s+"(.*)")?\s*$/.exec(line);
  if (!m) return null;
  const d = { code: m[7], severity: SEVERITY[m[6]], position: { start: { line: +m[2], column: +m[3] } } };
  if (m[4]) d.position.end = { line: +m[4], column: +m[5] };
  if (m[8] !== undefined) d.text = m[8];
  if (m[1]) d.optional = true;
  return d;
}

function loadAll(dir = path.join(__dirname, '..', 'corpus')) {
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.txt'))
    .sort();
  const cases = [];
  const errors = [];
  for (const f of files) {
    const r = parseFile(path.join(dir, f), fs.readFileSync(path.join(dir, f), 'utf8'));
    cases.push(...r.cases);
    errors.push(...r.errors);
  }
  const seen = new Map();
  for (const c of cases) {
    if (seen.has(c.id)) errors.push(new CorpusError(c.file, c.line, `duplicate case id ${c.id} (first at ${seen.get(c.id)})`));
    else seen.set(c.id, `${c.file}:${c.line}`);
  }
  return { cases, errors };
}

module.exports = { loadAll };
