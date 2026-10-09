// SPDX-License-Identifier: MIT
// The parse context, positions, inline source spans and visit(). Positions
// are unist's: 1-based line and column, 0-based offset into the normalised
// source, end exclusive; a column counts UTF-16 code units, a tab being one.
'use strict';

const diag = require('./diag');

function lineStarts(src) {
  const starts = [0];
  for (let i = src.indexOf('\n'); i !== -1; i = src.indexOf('\n', i + 1)) starts.push(i + 1);
  return starts;
}

// Everything one parse shares: the normalised source, its line table, the
// options and schema, the diagnostics, and once-per-note flags.
function createContext(src, opts) {
  const starts = lineStarts(src);
  let last = 0; // the line found last time: lookups mostly move forward
  const ctx = {
    src,
    starts,
    opts,
    schema: (opts && opts.schema) || { block: {}, leaf: {}, inline: {} },
    diagnostics: [],
    flags: Object.create(null),
    point(offset) {
      let lo;
      const n = starts.length;
      if (offset >= starts[last] && (last + 1 >= n || offset < starts[last + 1])) lo = last;
      else if (last + 1 < n && offset >= starts[last + 1] && (last + 2 >= n || offset < starts[last + 2])) lo = ++last;
      else {
        lo = 0;
        let hi = starts.length - 1;
        while (lo < hi) {
          const mid = (lo + hi + 1) >> 1;
          if (starts[mid] <= offset) lo = mid;
          else hi = mid - 1;
        }
        last = lo;
      }
      return { line: lo + 1, column: offset - starts[lo] + 1, offset };
    },
    position(start, end) {
      return { start: ctx.point(start), end: ctx.point(end == null ? start : end) };
    },
    report(code, start, end, message, hint) {
      return diag.report(ctx, code, start, end, message, hint);
    },
  };
  return ctx;
}

// ---------------------------------------------------------------- spans

// A span is inline source handed from the block parser to the inline parser:
// `text`, the characters after prefixes and stripping, and `segs`, a flat
// array of pairs [at, offset, at, offset, …]: text[at] and the characters
// after it, up to the next pair, were copied from the source starting at
// `offset`. A joining '\n' is its own pair, at the offset of the line's
// newline. `empty` is the offset to use when the text is empty. So every
// inline node and diagnostic gets exact source columns, across quote
// prefixes, list indentation and joined lines.
function createSpan(empty) {
  return { text: '', segs: [], empty: empty || 0 };
}

function spanAdd(span, str, offset) {
  if (!str) return span;
  span.segs.push(span.text.length, offset);
  span.text += str;
  return span;
}

// The source offset of text[i]. For i = text.length, the offset just after
// the last character.
function spanStart(span, i) {
  const n = span.text.length;
  if (!n) return span.empty;
  if (i >= n) return spanStart(span, n - 1) + 1;
  const s = span.segs;
  let lo = 0;
  let hi = s.length / 2 - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (s[mid * 2] <= i) lo = mid;
    else hi = mid - 1;
  }
  return s[lo * 2 + 1] + (i - s[lo * 2]);
}

// The source offset just after text[i - 1]: the end of a node whose text
// ends before index i.
function spanEnd(span, i) {
  return i > 0 ? spanStart(span, i - 1) + 1 : spanStart(span, 0);
}

// The position of text[a…b). An empty range is a point at a.
function spanPosition(ctx, span, a, b) {
  const start = spanStart(span, a);
  return ctx.position(start, b > a ? spanEnd(span, b) : start);
}

// ---------------------------------------------------------------- trees

// unist-util-visit, the subset tern needs: visit(tree, [type,] fn), with
// fn(node, index, parent). Returning false skips the node's children.
function visit(tree, type, fn) {
  if (typeof type === 'function') {
    fn = type;
    type = null;
  }
  const walk = (node, index, parent) => {
    const r = !type || node.type === type ? fn(node, index, parent) : undefined;
    if (r === false || !node.children) return;
    for (let i = 0; i < node.children.length; i++) walk(node.children[i], i, node);
  };
  walk(tree, null, null);
}

module.exports = { createContext, createSpan, spanAdd, spanStart, spanEnd, spanPosition, visit };
