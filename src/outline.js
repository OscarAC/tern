// SPDX-License-Identifier: MIT
// outline(ast) -> {headings, blocks, refs, math, tables, raw, inline}: the
// editor digest, one walk over the AST, sent by the LSP as `tern/outline` so
// the editor never re-parses. It reads whatever the tree holds: on a parse
// AST, explicit ids only; after the transforms, slugs, labels, numbers and
// resolved references too.
'use strict';

const { visit } = require('./ast');

// The plain text of inline content: text, code and math values, with tags
// dropped. Entities give their decoded value.
function plainText(nodes) {
  let out = '';
  const walk = (list) => {
    for (const n of list || []) {
      if (n.type === 'text' || n.type === 'inlineCode' || n.type === 'inlineMath') out += n.value;
      else if (n.type === 'image') out += n.alt || '';
      else if (n.type === 'break') out += '\n';
      else if (n.children) walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

const tern = (n) => (n.data && n.data.tern) || {};
const line = (n) => n.position.start.line;
const endLine = (n) => n.position.end.line;
const id = (n) => (n.attributes && n.attributes.id) || undefined;

function outline(ast) {
  const out = { headings: [], blocks: [], refs: [], math: [], tables: [], raw: [], inline: [] };
  visit(ast, (n) => {
    if (!n.position) return false; // text the transforms copied (a reference's, a toc entry's): not in the source
    const t = tern(n);
    switch (n.type) {
      case 'heading':
        out.headings.push({ line: line(n), depth: n.depth, id: id(n), text: plainText(n.children) });
        break;
      case 'containerDirective':
      case 'leafDirective': {
        const label = n.type === 'containerDirective' && n.children && n.children[0] && n.children[0].data && n.children[0].data.directiveLabel ? n.children[0] : null;
        out.blocks.push({
          line: line(n),
          endLine: endLine(n),
          kind: n.type === 'containerDirective' ? 'container' : 'leaf',
          name: n.name,
          id: id(n),
          title: label ? plainText(label.children) : n.type === 'leafDirective' && n.children.length ? plainText(n.children) : undefined,
          label: t.text,
          colons: t.colons,
        });
        break;
      }
      case 'ref':
        out.refs.push({ line: line(n), col: n.position.start.column, end: n.position.end.column, id: n.id, text: n.children ? plainText(n.children) : undefined, resolved: t.resolved });
        break;
      case 'math':
      case 'inlineMath':
        out.math.push({ line: line(n), col: n.position.start.column, endLine: endLine(n), end: n.position.end.column, display: n.type === 'math', number: t.text, tex: n.value });
        break;
      case 'table':
        out.tables.push({ line: line(n), endLine: endLine(n) });
        break;
      case 'html':
        if (t.kind !== 'inline') out.raw.push({ line: line(n), endLine: endLine(n), kind: t.kind });
        break;
      case 'textDirective':
        out.inline.push({ line: line(n), col: n.position.start.column, end: n.position.end.column, name: n.name });
        break;
    }
  });
  return JSON.parse(JSON.stringify(out)); // drop undefined fields
}

module.exports = { outline };
