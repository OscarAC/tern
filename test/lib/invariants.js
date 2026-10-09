// SPDX-License-Identifier: MIT
// Properties every parse must have, whatever the input. The corpus harness
// checks them on every case and the fuzzer on every mutated input.
//   checkParse(result, source)  the problems in tern.parse(source), as strings
//
// - The result is JSON-serialisable and round-trips (no cycles, no functions).
// - Every node has a type and a position; offsets lie in the normalised
//   source, start ≤ end, and line/column agree with the offset.
// - Children lie inside their parent and do not overlap their siblings,
//   in source order.
// - Every diagnostic has a known severity, a code, a message and a valid
//   position.
'use strict';

const SEVERITIES = new Set(['error', 'warning', 'info']);

// The normalised source, which positions refer to
// (docs/syntax-blocks.html#normalisation).
function normaliseSource(s) {
  return s.replace(/^﻿/, '').replace(/\r\n?/g, '\n').replace(/\0/g, '�');
}

function lineStarts(src) {
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

function checkPoint(p, src, starts, where, out) {
  if (!p || ![p.line, p.column, p.offset].every(Number.isInteger)) {
    out.push(`${where}: point must have integer line, column and offset, got ${JSON.stringify(p)}`);
    return false;
  }
  if (p.offset < 0 || p.offset > src.length) {
    out.push(`${where}: offset ${p.offset} outside the source (length ${src.length})`);
    return false;
  }
  const line = p.line;
  if (line < 1 || line > starts.length) {
    out.push(`${where}: line ${line} outside the source (${starts.length} lines)`);
    return false;
  }
  if (starts[line - 1] + p.column - 1 !== p.offset) {
    out.push(`${where}: line ${line} column ${p.column} is offset ${starts[line - 1] + p.column - 1}, but offset says ${p.offset}`);
    return false;
  }
  return true;
}

function checkPosition(pos, src, starts, where, out) {
  if (!pos || typeof pos !== 'object') {
    out.push(`${where}: no position`);
    return false;
  }
  const a = checkPoint(pos.start, src, starts, `${where}.start`, out);
  const b = checkPoint(pos.end, src, starts, `${where}.end`, out);
  if (a && b && pos.start.offset > pos.end.offset) {
    out.push(`${where}: start ${pos.start.offset} after end ${pos.end.offset}`);
    return false;
  }
  return a && b;
}

function checkTree(root, source, out) {
  const src = normaliseSource(source);
  const starts = lineStarts(src);
  if (!root || root.type !== 'root') out.push(`root: expected type "root", got ${root && JSON.stringify(root.type)}`);
  const walk = (node, where, parent) => {
    if (out.length > 20) return;
    if (!node || typeof node.type !== 'string') {
      out.push(`${where}: not a node`);
      return;
    }
    const ok = checkPosition(node.position, src, starts, `${where}(${node.type}).position`, out);
    if (ok && parent) {
      const p = parent.position;
      if (node.position.start.offset < p.start.offset || node.position.end.offset > p.end.offset)
        out.push(`${where}(${node.type}): [${node.position.start.offset}, ${node.position.end.offset}) outside its parent ${parent.type} [${p.start.offset}, ${p.end.offset})`);
    }
    if (node.children !== undefined) {
      if (!Array.isArray(node.children)) {
        out.push(`${where}(${node.type}): children is not an array`);
        return;
      }
      let prevEnd = -1;
      node.children.forEach((child, i) => {
        walk(child, `${where}.children[${i}]`, ok ? node : null);
        const cp = child && child.position;
        if (cp && cp.start && Number.isInteger(cp.start.offset)) {
          if (cp.start.offset < prevEnd) out.push(`${where}.children[${i}](${child.type}): starts at ${cp.start.offset}, before its previous sibling ends (${prevEnd})`);
          if (cp.end && Number.isInteger(cp.end.offset)) prevEnd = cp.end.offset;
        }
      });
    }
  };
  walk(root, 'root', null);
  return out;
}

function checkDiagnostics(diags, source, out) {
  const src = normaliseSource(source);
  const starts = lineStarts(src);
  if (!Array.isArray(diags)) {
    out.push(`diagnostics: not an array`);
    return out;
  }
  diags.forEach((d, i) => {
    const where = `diagnostics[${i}]${d && d.code ? `(${d.code})` : ''}`;
    if (!d || typeof d.code !== 'string' || !/^[a-z]+\.[a-z-]+$/.test(d.code)) out.push(`${where}: bad code ${d && JSON.stringify(d.code)}`);
    if (!d || !SEVERITIES.has(d.severity)) out.push(`${where}: bad severity ${d && JSON.stringify(d.severity)}`);
    if (!d || typeof d.message !== 'string' || !d.message) out.push(`${where}: no message`);
    if (d && d.hint !== undefined && typeof d.hint !== 'string') out.push(`${where}: hint is not a string`);
    if (d) checkPosition(d.position, src, starts, `${where}.position`, out);
  });
  return out;
}

function checkSerialisable(value, out) {
  try {
    const s = JSON.stringify(value);
    if (JSON.stringify(JSON.parse(s)) !== s) out.push('JSON round trip changed the value');
  } catch (e) {
    out.push(`not JSON-serialisable: ${e.message}`);
  }
  return out;
}

// All checks on one parse result {ast, diagnostics}.
function checkParse(result, source) {
  const out = [];
  if (!result || typeof result !== 'object') return ['parse returned no result'];
  checkSerialisable(result, out);
  checkTree(result.ast, source, out);
  checkDiagnostics(result.diagnostics, source, out);
  return out;
}

module.exports = { checkParse };
