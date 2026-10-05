# tern.nvim

A Neovim plugin for writing [Tern](../README.md) notes: highlighting, folding, language features, in-buffer rendering and a live browser preview.

It needs Neovim 0.11 or later and no external tools.

## Install

With lazy.nvim, pointing at this folder:

```lua
{ dir = '~/path/to/tern/nvim', name = 'tern.nvim', lazy = false }
```

An `.html` file whose first lines load `tern.js` is given the filetype `tern` instead of `html`.

## Features

- **Highlighting** for markdown, directives, labels and references. Math is highlighted as TeX, `<script>` and `<style>` as JavaScript and CSS, and fenced code in its own language.
- **Folding** by heading and by `:::` block. Notes open fully unfolded.
- **Language features**, provided by a server that runs inside Neovim and plugs into your existing LSP mappings and completion plugin:

  | Feature          | Behaviour                                                                                                   |
  | ---------------- | ----------------------------------------------------------------------------------------------------------- |
  | Completion       | `@` lists every label and heading; `:::` lists block names, including your own; `:` lists inline directives |
  | Go to definition | from an `@reference` to its label or heading                                                                |
  | Hover            | shows the source of the referenced block or equation                                                        |
  | References       | lists every use of a label                                                                                  |
  | Rename           | renames a label and all references to it                                                                    |
  | Document symbols | headings as a tree, with titled or labelled blocks beneath them                                             |

- **In-buffer rendering.** The note is drawn over its own source while staying editable. The line under the cursor always shows raw source.
  - Blocks get a coloured bar and a numbered header.
  - References show their resolved text.
  - Recall answers and `:hide[...]` are masked until the cursor is on their line.
  - Common TeX commands show as Unicode symbols.
- **Live preview** in the browser, reloading on every save and keeping the scroll position.

## Commands

| Command            | Action                                                                                                                 |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `:TernPreview`     | start the preview server and open the note in the browser                                                              |
| `:TernPreviewStop` | stop the preview server                                                                                                |
| `:TernRender`      | toggle in-buffer rendering for the current note                                                                        |
| `:TernInit`        | insert the `<script>` line, with the correct relative path to the nearest `tern.js`, and switch to the `tern` filetype |

The plugin defines no key mappings. For example, in `ftplugin/tern.lua` of your config:

```lua
vim.keymap.set('n', '<leader>mp', '<cmd>TernPreview<cr>', { buffer = true })
vim.keymap.set('n', '<leader>mr', '<cmd>TernRender<cr>', { buffer = true })
```

## Options

| Setting                     | Effect                                                        |
| --------------------------- | ------------------------------------------------------------- |
| `vim.g.tern_render = false` | do not render notes when they open; `:TernRender` still works |

The renderer's colours are highlight groups prefixed `Tern` (`TernTheorem`, `TernDefinition`, `TernWarning`, `TernHidden`, and others), each linked to a standard group by default. Override them in your colour scheme setup to change them.

## Limits

- **Rendering is approximate.** A terminal cannot typeset math or place blocks side by side. Fractions, matrices and `aligned` blocks stay as TeX source, and column layouts are shown stacked. Use the browser preview for those.
- **Heading ids cannot be renamed** unless the heading has an explicit `{#id}`, because the id is otherwise derived from the title.
- **The preview server** listens on `127.0.0.1` only and serves the folder that contains `tern.js`. Anything under that folder is readable by local programs while it runs.
- **Highlighting is regex-based**, not Tree-sitter, so Tree-sitter-based markdown plugins do not act on Tern files.
