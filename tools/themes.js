#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Builds the committed themes/*.css (docs/schema.html#themes): colour themes
// after well-known palettes, as stylesheet add-ons that set tern.css's colour
// properties. A family with a light and a dark variant gives three files:
// NAME.css follows the reader's system setting, NAME-light.css and
// NAME-dark.css hold one palette for every reader. A family with one variant
// gives NAME.css. Every file prints as tern.css prints, black on white.
//
// Text colours must reach the family's contrast (4.5:1, WCAG AA; 7:1 for
// high-contrast) against what they are drawn on. A palette colour that falls
// short is mixed toward black or white until it does, and the file's header
// names it. test/themes.js checks the result.
//
//   node tools/themes.js           write themes/*.css
//   node tools/themes.js --check   exit 1 if themes/ is not the current build (CI)
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'themes');

// ---------------------------------------------------------------- colour

const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const hex = (c) => '#' + c.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('');
// `a` taken `t` of the way to `b`, in sRGB.
const mix = (a, b, t) => {
  const [x, y] = [rgb(a), rgb(b)];
  return hex(x.map((v, i) => v + (y[i] - v) * t));
};
// WCAG 2's relative luminance and contrast ratio.
function luminance(h) {
  const [r, g, b] = rgb(h).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a, b) => {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
const isLight = (bg) => luminance(bg) > 0.179; // where black text beats white
// HSL, each part 0-1.
function hsl(h) {
  const [r, g, b] = rgb(h).map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (!d) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const hue = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [hue / 6, s, l];
}
function fromHsl([h, s, l]) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h * 6) % 2) - 1));
  const [r, g, b] = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][Math.floor(h * 6) % 6];
  return hex([r, g, b].map((v) => (v + l - c / 2) * 255));
}

// ---------------------------------------------------------------- palettes

// A variant names the palette's own colours for each role:
//   bg, fg     the page and its text
//   muted      quotes, captions, equation and line numbers
//   soft       code and table-header backgrounds
//   line       rules and borders
//   link       links
//   red        errors; their background is red mixed into bg, unless errorBg
//   warn       warnings in the diagnostics panel
//   yellow     highlights, in its hue (resolve), unless mark gives one
const FAMILIES = [
  {
    name: 'solarized',
    title: 'Solarized',
    after: "Ethan Schoonover's Solarized",
    url: 'https://ethanschoonover.com/solarized/',
    light: { bg: '#fdf6e3', fg: '#586e75', muted: '#657b83', soft: '#eee8d5', line: mix('#93a1a1', '#eee8d5', 0.45), link: '#268bd2', red: '#dc322f', warn: '#cb4b16', yellow: '#b58900' },
    dark: { bg: '#002b36', fg: '#839496', muted: '#586e75', soft: '#073642', line: mix('#586e75', '#073642', 0.5), link: '#268bd2', red: '#dc322f', warn: '#cb4b16', yellow: '#b58900' },
  },
  {
    name: 'gruvbox',
    title: 'Gruvbox',
    after: "Pavel Pertsev's gruvbox",
    url: 'https://github.com/morhetz/gruvbox',
    light: { bg: '#fbf1c7', fg: '#3c3836', muted: '#7c6f64', soft: '#ebdbb2', line: '#d5c4a1', link: '#076678', red: '#9d0006', warn: '#af3a03', yellow: '#d79921' },
    dark: { bg: '#282828', fg: '#ebdbb2', muted: '#a89984', soft: '#3c3836', line: '#504945', link: '#83a598', red: '#fb4934', warn: '#fe8019', yellow: '#d79921' },
  },
  {
    name: 'nord',
    title: 'Nord',
    after: "Arctic Ice Studio's Nord",
    url: 'https://www.nordtheme.com',
    dark: { bg: '#2e3440', fg: '#d8dee9', muted: '#616e88', soft: '#3b4252', line: '#434c5e', link: '#88c0d0', red: '#bf616a', warn: '#d08770', yellow: '#ebcb8b' },
  },
  {
    name: 'dracula',
    title: 'Dracula',
    after: 'Dracula',
    url: 'https://draculatheme.com',
    dark: { bg: '#282a36', fg: '#f8f8f2', muted: '#6272a4', soft: '#343746', line: '#44475a', link: '#8be9fd', red: '#ff5555', warn: '#ffb86c', yellow: '#f1fa8c' },
  },
  {
    name: 'one',
    title: 'One',
    after: "Atom's One Light and One Dark",
    url: 'https://github.com/atom/atom/tree/master/packages/one-dark-syntax',
    light: { bg: '#fafafa', fg: '#383a42', muted: '#a0a1a7', soft: '#f0f0f1', line: '#e5e5e6', link: '#4078f2', red: '#e45649', warn: '#c18401', yellow: '#e5c07b' },
    dark: { bg: '#282c34', fg: '#abb2bf', muted: '#5c6370', soft: '#21252b', line: '#3e4451', link: '#61afef', red: '#e06c75', warn: '#d19a66', yellow: '#e5c07b' },
  },
  {
    name: 'github',
    title: 'GitHub',
    after: "GitHub's Primer colours",
    url: 'https://primer.style/foundations/color',
    light: { bg: '#ffffff', fg: '#1f2328', muted: '#59636e', soft: '#f6f8fa', line: '#d1d9e0', link: '#0969da', red: '#d1242f', errorBg: '#ffebe9', warn: '#9a6700', mark: '#fff8c5' },
    dark: { bg: '#0d1117', fg: '#f0f6fc', muted: '#9198a1', soft: '#151b23', line: '#3d444d', link: '#4493f8', red: '#f85149', warn: '#d29922', yellow: '#bb8009' },
  },
  {
    name: 'catppuccin',
    title: 'Catppuccin',
    after: 'Catppuccin Latte (light) and Mocha (dark)',
    url: 'https://catppuccin.com/palette',
    light: { bg: '#eff1f5', fg: '#4c4f69', muted: '#6c6f85', soft: '#e6e9ef', line: '#ccd0da', link: '#1e66f5', red: '#d20f39', warn: '#fe640b', yellow: '#df8e1d' },
    dark: { bg: '#1e1e2e', fg: '#cdd6f4', muted: '#a6adc8', soft: '#181825', line: '#313244', link: '#89b4fa', red: '#f38ba8', warn: '#fab387', yellow: '#f9e2af' },
  },
  {
    name: 'tokyo-night',
    title: 'Tokyo Night',
    after: 'Tokyo Night Day (light) and Night (dark)',
    url: 'https://github.com/folke/tokyonight.nvim',
    light: { bg: '#e1e2e7', fg: '#3760bf', muted: '#848cb5', soft: '#d0d5e3', line: '#c4c8da', link: '#2e7de9', red: '#f52a65', warn: '#b15c00', yellow: '#8c6c3e' },
    dark: { bg: '#1a1b26', fg: '#c0caf5', muted: '#737aa2', soft: '#16161e', line: '#292e42', link: '#7aa2f7', red: '#f7768e', warn: '#ff9e64', yellow: '#e0af68' },
  },
  {
    name: 'rose-pine',
    title: 'Rosé Pine',
    after: 'Rosé Pine Dawn (light) and Rosé Pine (dark)',
    url: 'https://rosepinetheme.com/palette/',
    light: { bg: '#faf4ed', fg: '#575279', muted: '#797593', soft: '#f2e9e1', line: '#dfdad9', link: '#286983', red: '#b4637a', warn: '#ea9d34', yellow: '#ea9d34' },
    dark: { bg: '#191724', fg: '#e0def4', muted: '#908caa', soft: '#26233a', line: '#403d52', link: '#9ccfd8', red: '#eb6f92', warn: '#f6c177', yellow: '#f6c177' },
  },
  {
    name: 'monokai',
    title: 'Monokai',
    after: "Wimer Hazenberg's Monokai",
    url: 'https://monokai.nl',
    dark: { bg: '#272822', fg: '#f8f8f2', muted: '#75715e', soft: '#3e3d32', line: '#49483e', link: '#66d9ef', red: '#f92672', warn: '#fd971f', yellow: '#e6db74' },
  },
  {
    name: 'everforest',
    title: 'Everforest',
    after: "sainnhe's Everforest (medium)",
    url: 'https://github.com/sainnhe/everforest',
    light: { bg: '#fdf6e3', fg: '#5c6a72', muted: '#829181', soft: '#f4f0d9', line: '#e0dcc7', link: '#3a94c5', red: '#f85552', warn: '#f57d26', yellow: '#dfa000' },
    dark: { bg: '#2d353b', fg: '#d3c6aa', muted: '#9da9a0', soft: '#343f44', line: '#475258', link: '#7fbbb3', red: '#e67e80', warn: '#e69875', yellow: '#dbbc7f' },
  },
  {
    name: 'kanagawa',
    title: 'Kanagawa',
    after: "rebelot's Kanagawa (wave)",
    url: 'https://github.com/rebelot/kanagawa.nvim',
    dark: { bg: '#1f1f28', fg: '#dcd7ba', muted: '#727169', soft: '#2a2a37', line: '#363646', link: '#7e9cd8', red: '#e82424', warn: '#ff9e3b', yellow: '#e6c384' },
  },
  {
    name: 'sepia',
    title: 'Sepia',
    after: 'the warm paper of e-readers',
    light: { bg: '#f5ecd8', fg: '#3b3024', muted: '#6e5d48', soft: '#ece0c5', line: '#d9c9a7', link: '#2d5a87', red: '#a1301c', warn: '#8a5300', yellow: '#e9c46a' },
  },
  {
    name: 'high-contrast',
    title: 'High contrast',
    after: 'black and white, for low vision',
    min: 7,
    light: { bg: '#ffffff', fg: '#000000', muted: '#3b3b3b', soft: '#f0f0f0', line: '#767676', link: '#0033b3', red: '#a00000', errorBg: '#ffe8e8', warn: '#6b4400', mark: '#ffff00' },
    dark: { bg: '#000000', fg: '#ffffff', muted: '#d0d0d0', soft: '#1a1a1a', line: '#8a8a8a', link: '#a8ccff', red: '#ff8f8f', errorBg: '#3a0000', warn: '#ffd24d', mark: '#5c5000' },
  },
];

// ---------------------------------------------------------------- resolving

// The most a derived highlight may stand out from bg, as a contrast ratio.
const MARK = { light: 1.3, dark: 2.2 };

const COLOURS = ['bg', 'fg', 'muted', 'line', 'soft', 'link', 'mark', 'error', 'error-bg', 'warn'];

// A variant's ten colours, each text colour raised to `min` against what it
// is drawn on, and the roles that needed it.
function resolve(v, min) {
  const { bg, soft, line } = v;
  const light = isLight(bg);
  const raised = [];
  const fit = (role, c, backs) => {
    let out = c;
    for (let i = 1; i <= 50 && backs.some((b) => contrast(out, b) < min); i++) out = mix(c, light ? '#000000' : '#ffffff', i / 50);
    if (out !== c) raised.push(role);
    return out;
  };
  const fg = fit('fg', v.fg, [bg, soft]);
  // The highlight: the palette's yellow, its hue and saturation kept, at the
  // lightness that sets it furthest from bg while the text on it keeps
  // `min`, and no further from bg than MARK.
  let mark = v.mark;
  if (!mark) {
    const [h, sat] = hsl(v.yellow);
    for (let i = 0; i <= 200; i++) {
      const c = fromHsl([h, sat, light ? 1 - i / 200 : i / 200]);
      if (contrast(fg, c) < min || contrast(c, bg) > MARK[light ? 'light' : 'dark']) break;
      mark = c;
    }
  }
  if (!mark || contrast(fg, mark) < min) throw new Error(`no highlight in ${v.yellow || v.mark} keeps ${min}:1 for ${fg}`);
  const errorBg = v.errorBg || mix(bg, v.red, light ? 0.1 : 0.18);
  const out = {
    bg,
    fg,
    muted: fit('muted', v.muted, [bg, soft]),
    line,
    soft,
    link: fit('link', v.link, [bg, soft]),
    mark,
    error: fit('error', v.red, [errorBg, bg]),
    'error-bg': errorBg,
    warn: fit('warn', v.warn, [bg]),
  };
  return { colours: out, raised, light };
}

// tern.css's print palette: its light colours under its print overrides, so
// that a theme prints as the base does.
function printPalette() {
  const file = path.join(ROOT, 'src', 'css.js');
  delete require.cache[require.resolve(file)];
  const { css } = require(file);
  const props = (block) => Object.fromEntries([...block.matchAll(/--t-([a-z-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
  const block = (from) => css.slice(from, css.indexOf('}', from));
  const light = props(block(css.indexOf(':root {')));
  const print = props(block(css.indexOf(':root {', css.indexOf('@media print'))));
  return Object.fromEntries(COLOURS.map((k) => [k, print[k] || light[k]]));
}

// ---------------------------------------------------------------- writing

const declarations = (c, indent) =>
  [COLOURS.slice(0, 5), COLOURS.slice(5)].map((ks) => indent + ks.map((k) => `--t-${k}: ${c[k]};`).join(' ')).join('\n');
const rootBlock = (scheme, c, indent = '') => `${indent}:root {\n${indent}  color-scheme: ${scheme};\n${declarations(c, `${indent}  `)}\n${indent}}`;
const declarationsOnly = (c) => `  :root {\n${declarations(c, '    ')}\n  }`;

const MODE = {
  auto: "Light or dark, by the reader's system setting.",
  light: 'Light for every reader.',
  dark: 'Dark for every reader.',
};

// One file: `variants` holds the resolved light and/or dark palette.
function sheet(family, file, mode, variants) {
  const min = family.min || 4.5;
  const raised = Object.entries(variants)
    .filter(([, r]) => r.raised.length)
    .map(([which, r]) => r.raised.join(', ') + (mode === 'auto' ? ` (${which})` : ''));
  const head = [
    '/* SPDX-License-Identifier: MIT */',
    `/* ${family.title} for Tern, after ${family.after}${family.url ? ` (${family.url})` : ''}.`,
    `   ${MODE[mode]} Use: <script src="tern.js" data-use="themes/${file}"></script>`,
  ];
  if (raised.length) head.push(`   Raised to ${min}:1 contrast: ${raised.join('; ')}.`);
  head.push('   Built by tools/themes.js; edit that, not this file. */');
  const body = [];
  if (mode === 'auto') {
    body.push(rootBlock('light dark', variants.light.colours));
    body.push(`@media (prefers-color-scheme: dark) {\n${declarationsOnly(variants.dark.colours)}\n}`);
  } else body.push(rootBlock(mode, variants[mode].colours));
  body.push(`@media print {\n${rootBlock('light', printPalette(), '  ')}\n}`);
  return `${head.join('\n')}\n${body.join('\n')}\n`;
}

// Every file of the build: {name: css}.
function build() {
  const files = {};
  for (const f of FAMILIES) {
    const min = f.min || 4.5;
    const v = {};
    if (f.light) v.light = resolve(f.light, min);
    if (f.dark) v.dark = resolve(f.dark, min);
    if (v.light && v.dark) {
      files[`${f.name}.css`] = sheet(f, `${f.name}.css`, 'auto', v);
      files[`${f.name}-light.css`] = sheet(f, `${f.name}-light.css`, 'light', { light: v.light });
      files[`${f.name}-dark.css`] = sheet(f, `${f.name}-dark.css`, 'dark', { dark: v.dark });
    } else {
      const which = v.light ? 'light' : 'dark';
      files[`${f.name}.css`] = sheet(f, `${f.name}.css`, which, { [which]: v[which] });
    }
  }
  return files;
}

function main() {
  const files = build();
  const names = Object.keys(files);
  const existing = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((n) => n.endsWith('.css')) : [];
  if (process.argv.includes('--check')) {
    const stale = names.filter((n) => !existing.includes(n) || fs.readFileSync(path.join(DIR, n), 'utf8') !== files[n]);
    const extra = existing.filter((n) => !names.includes(n));
    if (stale.length || extra.length) {
      if (stale.length) console.log(`✗ not the current build of tools/themes.js: ${stale.join(', ')}`);
      if (extra.length) console.log(`✗ in themes/ but not built by tools/themes.js: ${extra.join(', ')}`);
      console.log('  run node tools/themes.js');
      process.exit(1);
    }
    console.log(`✓ themes/ is current: ${names.length} files`);
    process.exit(0);
  }
  fs.mkdirSync(DIR, { recursive: true });
  for (const n of existing) if (!names.includes(n)) fs.unlinkSync(path.join(DIR, n));
  for (const n of names) fs.writeFileSync(path.join(DIR, n), files[n]);
  console.log(`wrote ${names.length} themes to themes/`);
}

module.exports = { FAMILIES, COLOURS, build, resolve, printPalette, contrast, luminance, isLight };

if (require.main === module) main();
