// SPDX-License-Identifier: MIT
// The fixture schema (./schema.js) plus entries for corpus cases with
// `options: schema=extended`: what the engine must handle although the docs'
// demo schema declares none of it. ./schema.js stays exactly the demo
// schema (test/docs.js checks), so these live here.
//   frame     a schema `tag` naming a reserved element (docs/elements.html#step-schema)
//   bib       a counted leaf in citation style: its label is its number
//   photo     a counted void leaf, which has nowhere to put its label
//   contents  a toc leaf with a label
//   term      a counted, labelled inline element
//   brk       a labelled void inline element
'use strict';

const fixture = require('./schema');

module.exports = {
  block: { ...fixture.block, frame: { tag: 'main' } },
  leaf: {
    ...fixture.leaf,
    bib: { counter: 'bib', ref: '[{n}]' },
    photo: { tag: 'img', counter: 'photo', label: 'Photo' },
    contents: { tag: 'nav', transform: 'toc', label: 'Contents' },
  },
  inline: { ...fixture.inline, term: { tag: 'dfn', counter: 'term', label: 'Term' }, brk: { tag: 'wbr', label: 'Break' } },
};
