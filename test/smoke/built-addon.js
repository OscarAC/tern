// SPDX-License-Identifier: MIT
// The add-on of test/smoke/built.html (P5): a block with a label and a DOM
// behaviour, and a stylesheet through tern.style, whose place in the head
// follows data-use on a built page too.
tern.block('box', { tag: 'aside', counter: 'box', label: 'Box', dom(el) { el.dataset.dom = 'yes'; } });
tern.style('main.tern aside.box { padding-inline: 1rem; }');
