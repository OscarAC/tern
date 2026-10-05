# Tern

Tern is a note format for studying: markdown's ease, LaTeX's structure, and the full power of the web, in one plain `.html` file.

You add one line at the top of a file and write a markdown superset below it. Opening the file in a browser renders it. There is no build step, and HTML, CSS and JavaScript are always available when the built-in syntax runs out.

```html
<script src="tern.js"></script>

# Linear Algebra: Lecture 4 A matrix $A$ is **invertible** if there is a $B$
with $AB = BA = I$. :::theorem[Rank–nullity] #rank-nullity For $T: V \to W$ with
$V$ finite-dimensional, $$\dim V = \dim \ker T + \dim \operatorname{im} T$$ :::
By @rank-nullity, an injective map between spaces of equal dimension is
surjective. ?? What does rank–nullity say? >> $\dim V = \dim \ker T + \dim
\operatorname{im} T$
```

## Documentation

| File                               | What it is                                           |
| ---------------------------------- | ---------------------------------------------------- |
| [`index.html`](index.html)         | the full reference, with every example rendered live |
| [`nvim/README.md`](nvim/README.md) | the Neovim plugin                                    |

## Quick start

1. Copy `tern.js` next to your notes.
2. Create an `.html` file whose first line is `<script src="tern.js"></script>`.
3. Write below that line and open the file in a browser.

Math is rendered by KaTeX, loaded from a CDN, so it needs a network connection unless you point Tern at a local copy (see the documentation).

## Publishing notes

A Tern note is an ordinary HTML file, so any static host serves it as a finished page. On GitHub Pages, enable Pages for the repository and push your notes together with `tern.js`. The empty `.nojekyll` file in this repository tells Pages to serve files untouched.

## AI-generated project

This project was written by AI with a human reviewing every line of the code.

## Development

```
tern.js               the library: parser, styles and browser runtime in one file
index.html            the documentation
test/parser.test.js   parser tests
nvim/                 the Neovim plugin
```

Run the parser tests with Node:

```
node test/parser.test.js
```

The parser has no dependencies and no DOM requirements, so `require('./tern.js')` in Node exposes `toHTML` and `inline` for testing.
