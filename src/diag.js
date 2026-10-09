// SPDX-License-Identifier: MIT
// The diagnostic codes with their severities, and report(), behind the
// parser's ctx.report. Severity follows the consequence: an error means
// content lost or meaning changed, a warning probably not what the author
// meant, an info a hint.
'use strict';

const E = 'error';
const W = 'warning';
const I = 'info';

// Every code the parser and the transforms report (transform.js reads this
// table too). The runtime and the command line have codes of their own.
const SEVERITY = {
  'block.unclosed': E,
  'block.closer-mismatch': E,
  'block.stray-closer': W,
  'block.closer-count': I,
  'block.opener-junk': E,
  'block.bad-opener': W,
  'block.spaced-name': W,
  'block.unclosed-fence': E,
  'fence.info-junk': W,
  'html.unclosed': E,
  'html.stray-closer': I,
  'html.wrapper': W,
  'html.inline-unclosed': W,
  'html.inline-escaped': I,
  'math.unclosed': E,
  'math.opener-tail': E,
  'math.closer-tail': W,
  'math.inline-display': I,
  'math.unclosed-inline': I,
  'math.bracket': I,
  'math.suspect-price': W,
  'attr.malformed': W,
  'attributes.orphan': W,
  'attributes.raw': W,
  'table.stray-delimiter': W,
  'table.row-unterminated': W,
  'table.misplaced-separator': W,
  'table.extra-cell': W,
  'cell.orphan': W,
  'leaf.demoted': I,
  'leaf.void-content': W,
  'inline.unclosed': W,
  'inline.glued': I,
  'footnote.undefined': W,
  'footnote.duplicate': W,
  'footnote.nested': W,
  'footnote.unused': I,
  'latex.delimiters': I,
  'latex.linebreak': I,
  'nesting.limit': E,
  'doc.frontmatter': I,
  'meta.conflict': W,
  'meta.duplicate': W,
  'meta.malformed': W,
  'meta.nested': W,
  'name.reserved': W,
  'tag.not-allowed': W,
  'table.body': W,
  'id.invalid': W,
  'id.duplicate': W,
  'ref.dangling': W,
  'ref.unreferenceable': W,
  'name.unknown': I,
};

// Appends one diagnostic. `start` and `end` are offsets into the normalised
// source (end exclusive; defaults to start). An unknown code is a bug in the
// engine, so it throws rather than reporting something unlisted.
function report(ctx, code, start, end, message, hint) {
  const severity = SEVERITY[code];
  if (!severity) throw new Error(`tern: unknown diagnostic code ${code}`);
  const d = { code, severity, message, position: ctx.position(start, end == null ? start : end) };
  if (hint) d.hint = hint;
  ctx.diagnostics.push(d);
  return d;
}

// Document order, then code, so output is stable whatever order phases report in.
function sortDiagnostics(list) {
  return list.sort(
    (a, b) =>
      a.position.start.offset - b.position.start.offset ||
      a.position.end.offset - b.position.end.offset ||
      (a.code < b.code ? -1 : a.code > b.code ? 1 : 0),
  );
}

module.exports = { SEVERITY, report, sortDiagnostics };
