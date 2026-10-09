// SPDX-License-Identifier: MIT
// The add-on of test/smoke/own-schema.html (D12): its `theorem` loses to the
// note's own window.TERN.schema entry; its `lemma` stands.
tern.block('theorem', { tag: 'section', counter: 'theorem', label: 'Satz', dom(el) { el.dataset.dom = 'addon'; } });
tern.block('lemma', { tag: 'section', counter: 'theorem', label: 'Lemma' });
