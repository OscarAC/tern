// Run: node test/parser.test.js
const assert = require('assert');
const { toHTML, inline } = require('../tern.js');

let failed = 0;
function t(name, fn) {
  try { fn(); console.log('ok   ' + name); }
  catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + e.message.split('\n').join('\n     ')); }
}
const eq = (a, b) => assert.strictEqual(a, b);
const has = (html, s) => assert.ok(html.includes(s), `expected ${JSON.stringify(s)} in\n${html}`);
const hasnt = (html, s) => assert.ok(!html.includes(s), `unexpected ${JSON.stringify(s)} in\n${html}`);

t('emphasis', () => {
  eq(inline('**a** *b* _c_ __d__'), '<strong>a</strong> <em>b</em> <em>c</em> <strong>d</strong>');
  eq(inline('***a***'), '<strong><em>a</em></strong>');
  eq(inline('*a **b** c*'), '<em>a <strong>b</strong> c</em>');
  eq(inline('snake_case_name and 2 * 3 * 4'), 'snake_case_name and 2 * 3 * 4');
  eq(inline('~~x~~ ==y== a == b'), '<del>x</del> <mark>y</mark> a == b');
});
t('escaping', () => {
  eq(inline('a < b && c > d, AT&T, &amp; &lt;'), 'a &lt; b &amp;&amp; c &gt; d, AT&amp;T, &amp; &lt;');
  eq(inline('\\*not em\\* \\$5'), '*not em* $5');
  eq(inline('`a < b` and ``x ` y``'), '<code>a &lt; b</code> and <code>x ` y</code>');
});
t('math', () => {
  eq(inline('$a < b$'), '<span class="t-math">a &lt; b</span>');
  eq(inline('$a_1 * b_2 * c$'), '<span class="t-math">a_1 * b_2 * c</span>');
  eq(inline('costs $5 and $10'), 'costs $5 and $10');
  eq(inline('**bold $x*y$ math**'), '<strong>bold <span class="t-math">x*y</span> math</strong>');
  eq(inline('$$x$$'), '<span class="t-math" data-display>x</span>');
  eq(inline('$\\$$'), '<span class="t-math">\\$</span>');
});
t('links, images, html', () => {
  eq(inline('[a *b*](http://x.y "T")'), '<a href="http://x.y" title="T">a <em>b</em></a>');
  eq(inline('![alt](i.png)'), '<img src="i.png" alt="alt">');
  eq(inline('<https://a.b/c?d=1&e=2>'), '<a href="https://a.b/c?d=1&amp;e=2">https://a.b/c?d=1&amp;e=2</a>');
  eq(inline('x <b class="y">z</b> <!-- c -->'), 'x <b class="y">z</b> <!-- c -->');
  eq(inline('[not a link] f(x)'), '[not a link] f(x)');
});
t('inline directives and refs', () => {
  eq(inline(':kbd[Ctrl]'), '<kbd class="kbd" data-t="kbd">Ctrl</kbd>');
  eq(inline(':aside[see $f[x]$ *now*]{#a .b}'), '<span id="a" class="aside b" data-t="aside">see <span class="t-math">f[x]</span> <em>now</em></span>');
  eq(inline('time 10:30[x] a:b[c]'), 'time 10:30[x] a:b[c]');
  eq(inline('see @thm:main, mail a@b.c'), 'see <a class="t-ref" href="#thm:main">@thm:main</a>, mail a@b.c');
});
t('headings and paragraphs', () => {
  eq(toHTML('# Hi *there*\ntext\nmore\n\n## Hi there\n### X {#custom}'),
    '<h1 id="hi-there">Hi <em>there</em></h1>\n<p>text\nmore</p>\n<h2 id="hi-there-2">Hi there</h2>\n<h3 id="custom">X</h3>');
  eq(toHTML('a  \nb\\\nc'), '<p>a<br>\nb<br>\nc</p>');
});
t('code fences', () => {
  eq(toHTML('```js\nif (a < b) {}\n\n:::x\n```\nafter'), '<pre><code class="language-js">if (a &lt; b) {}\n\n:::x</code></pre>\n<p>after</p>');
});
t('lists', () => {
  eq(toHTML('- a\n- b\n  - c\n- d'), '<ul>\n<li>a</li>\n<li>b\n<ul>\n<li>c</li>\n</ul></li>\n<li>d</li>\n</ul>');
  eq(toHTML('1. a\n2. b\n3. c'), '<ol>\n<li>a</li>\n<li>b</li>\n<li>c</li>\n</ol>');
  eq(toHTML('3) a\nlazy'), '<ol start="3">\n<li>a\nlazy</li>\n</ol>');
  eq(toHTML('- a\n\n- b'), '<ul>\n<li><p>a</p></li>\n<li><p>b</p></li>\n</ul>');
  eq(toHTML('- [ ] todo\n- [x] done'), '<ul>\n<li class="t-task"><input type="checkbox"> todo</li>\n<li class="t-task"><input type="checkbox" checked> done</li>\n</ul>');
  eq(toHTML('- a\n1. b'), '<ul>\n<li>a</li>\n</ul>\n<ol>\n<li>b</li>\n</ol>');
  eq(toHTML('text\n- a\n\npara'), '<p>text</p>\n<ul>\n<li>a</li>\n</ul>\n<p>para</p>');
  const h = toHTML('1. a\n   ```\n   code\n   ```\n2. b');
  has(h, '<li>a\n<pre><code>code</code></pre></li>');
});
t('blockquote, hr, table', () => {
  eq(toHTML('> a\n> b\nlazy\n\n---'), '<blockquote>\n<p>a\nb\nlazy</p>\n</blockquote>\n<hr>');
  const h = toHTML('| a | b |\n|:--|--:|\n| $|x|$ | `a|b` |\n| 1 \\| 2 |');
  has(h, '<th style="text-align:left">a</th><th style="text-align:right">b</th>');
  has(h, '<td style="text-align:left"><span class="t-math">|x|</span></td><td style="text-align:right"><code>a|b</code></td>');
  has(h, '<td style="text-align:left">1 | 2</td><td style="text-align:right"></td>');
});
t('containers', () => {
  eq(toHTML(':::theorem[Rank–nullity] #rn .big\nbody\n:::'),
    '<div id="rn" class="t-block theorem t-env big" data-t="theorem">\n<div class="t-head"><span class="t-label">Theorem</span><span class="t-title">Rank–nullity</span></div>\n<p>body</p>\n</div>');
  eq(toHTML(':::mything\nx\n:::'), '<div class="t-block mything" data-t="mything">\n<p>x</p>\n</div>');
  eq(toHTML(':::warning[Careful]\nx\n:::'), '<div class="t-block warning t-callout" data-t="warning">\n<div class="t-head"><span class="t-label">Careful</span></div>\n<p>x</p>\n</div>');
  // nesting: same colon count, and longer outer fence
  let h = toHTML(':::a\n:::b\nin\n:::\nmid\n:::\nout');
  eq(h, '<div class="t-block a" data-t="a">\n<div class="t-block b" data-t="b">\n<p>in</p>\n</div>\n<p>mid</p>\n</div>\n<p>out</p>');
  h = toHTML('::::a\n:::b\nin\n:::\n::::');
  has(h, 'data-t="a">\n<div class="t-block b" data-t="b">\n<p>in</p>\n</div>\n</div>');
  h = toHTML(':::a\n```\n:::\n```\n:::');
  has(h, '<pre><code>:::</code></pre>\n</div>');
  eq(toHTML(':::details[More]\nx\n:::'), '<details class="t-block details"><summary>More</summary>\n<p>x</p>\n</details>');
  eq(toHTML(':::macros\n\\gdef\\R{\\mathbb{R}}\n:::'), '<div class="t-macros" hidden>\\gdef\\R{\\mathbb{R}}</div>');
  eq(toHTML('::toc\n::fig[cap *x*]{#f}'), '<div class="toc" data-t="toc"></div>\n<div id="f" class="fig" data-t="fig">cap <em>x</em></div>');
});
t('layout', () => {
  has(toHTML(':::columns widths="2 1"\nx\n:::'), '<div class="t-block columns" style="--t-cols:minmax(0,2fr) minmax(0,1fr);" data-t="columns">');
  has(toHTML(':::grid cols=3 .wide\nx\n:::'), '<div class="t-block grid wide" style="--t-cols:repeat(3,minmax(0,1fr));" data-t="grid">');
  has(toHTML(':::columns\n:::col\na\n\nb\n:::\n:::col\nc\n:::\n:::'), '<div class="t-block col" data-t="col">\n<p>a</p>\n<p>b</p>\n</div>\n<div class="t-block col" data-t="col">\n<p>c</p>\n</div>\n</div>');
});
t('display math', () => {
  eq(toHTML('$$a < b$$ #eq1'), '<div class="t-eq" id="eq1"><span class="t-math" data-display>a &lt; b</span></div>');
  eq(toHTML('$$\na &< b \\\\\n\nc\n$$'), '<div class="t-eq"><span class="t-math" data-display>a &amp;&lt; b \\\\\n\nc</span></div>');
  eq(toHTML('$$\\begin{aligned}\nx\n\\end{aligned}$$ #e'), '<div class="t-eq" id="e"><span class="t-math" data-display>\\begin{aligned}\nx\n\\end{aligned}</span></div>');
  eq(toHTML('text\n$$x$$\nmore'), '<p>text</p>\n<div class="t-eq"><span class="t-math" data-display>x</span></div>\n<p>more</p>');
  eq(toHTML('$$x$$ and text'), '<p><span class="t-math" data-display>x</span> and text</p>');
});
t('question cards', () => {
  eq(toHTML('?? What is $x$?\n>> It is\n>> $$y$$\n?? Next\n>> ans\n\npara'),
    '<details class="t-card"><summary>What is <span class="t-math">x</span>?</summary>\n<div class="t-answer"><p>It is</p>\n<div class="t-eq"><span class="t-math" data-display>y</span></div></div></details>\n' +
    '<details class="t-card"><summary>Next</summary>\n<div class="t-answer"><p>ans</p></div></details>\n<p>para</p>');
  eq(toHTML('?? just a question'), '<p>?? just a question</p>');
});
t('raw html', () => {
  eq(toHTML('<div class="x">\n*raw*\n</div>\n\n*md*'), '<div class="x">\n*raw*\n</div>\n<p><em>md</em></p>');
  eq(toHTML('<div>\n\n*md*\n\n</div>'), '<div>\n<p><em>md</em></p>\n</div>');
  eq(toHTML('<script>\nif (a < b) {}\n\n# not heading\n</script>\nx'), '<script>\nif (a < b) {}\n\n# not heading\n</script>\n<p>x</p>');
  eq(toHTML('<!-- a\n\n# b -->\nx'), '<!-- a\n\n# b -->\n<p>x</p>');
  eq(toHTML('<b>inline</b> start'), '<p><b>inline</b> start</p>');
  eq(toHTML('<my-widget a="1"></my-widget>'), '<my-widget a="1"></my-widget>');
});

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
