// SPDX-License-Identifier: MIT
// The engine's public API (docs/api.html). Everything returned is
// JSON-serialisable.
'use strict';

const { normalise } = require('./scan');
const { createContext, visit } = require('./ast');
const { sortDiagnostics } = require('./diag');
const { parseBlocks } = require('./block');
const { outline } = require('./outline');
const registry = require('./schema');
const pipeline = require('./transform');
const { emit } = require('./emit');
const { css } = require('./css');
const runtime = require('./runtime');

const version = '0.1.1';

// The schema a call uses: opts.schema when given (the corpus passes one),
// else the registry that tern.block/leaf/inline write.
const withSchema = (opts) => (opts && opts.schema ? opts : { ...opts, schema: registry.schema });

// parse(source, {schema, head, maxDepth}) -> {ast, diagnostics}
// `source` is the note (everything after the tern.js line); `head` is the
// preserved head as a string, for `:::meta` conflicts; `schema` is the
// registry {block, leaf, inline}, with `strict: true` for name.unknown.
function parse(source, opts) {
  const ctx = createContext(normalise(source), withSchema(opts));
  const ast = parseBlocks(ctx);
  return { ast, diagnostics: sortDiagnostics(ctx.diagnostics) };
}

// transform(ast, opts) -> ast: runs the transforms in place and appends
// their diagnostics to ast.data.tern.diagnostics.
// transform(name, fn, {before | after}) registers a transform.
function transform(ast, opts, order) {
  if (typeof ast === 'string') return pipeline.register(ast, opts, order);
  return pipeline.run(ast, withSchema(opts));
}

// Every diagnostic for a note: the parser's and the transforms', in order.
function check(source, opts) {
  const o = withSchema(opts);
  const { ast, diagnostics } = parse(source, o);
  pipeline.run(ast, o);
  return sortDiagnostics(diagnostics.concat(ast.data.tern.diagnostics));
}

// toHTML(source, {schema, head, positions, safe}) -> the body HTML, synchronously.
function toHTML(source, opts) {
  const o = withSchema(opts);
  const { ast } = parse(source, o);
  return emit(pipeline.run(ast, o), o);
}

module.exports = {
  version,
  parse,
  transform,
  emit: (ast, opts) => emit(ast, withSchema(opts)),
  toHTML,
  check,
  visit,
  outline,
  schema: registry.schema,
  block: registry.block,
  leaf: registry.leaf,
  inline: registry.inline,
  get transforms() {
    return pipeline.names();
  },
  css,
};

// The runtime's API (define, undefine, on, render, ready, diagnostics,
// config, style) on the same object; in a browser it also starts the
// runtime. Under node it is inert.
runtime.attach(module.exports);
