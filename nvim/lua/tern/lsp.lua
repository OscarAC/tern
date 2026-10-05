-- An in-process language server for tern notes. It runs inside Neovim (no
-- external binary) and reads buffers directly, so completion, go-to-definition,
-- hover, references, rename and the symbol outline all work through the
-- standard LSP mappings and whatever completion plugin is installed.
local index = require('tern.index')

local M = {}

local BLOCKS = {
  'theorem', 'lemma', 'proposition', 'corollary', 'definition', 'example', 'exercise', 'remark', 'proof',
  'note', 'info', 'tip', 'important', 'warning',
  'columns', 'col', 'grid', 'card', 'center', 'details', 'macros',
}
local INLINE = { 'aside', 'hide', 'kbd', 'hl', 'sub', 'sup' }
local LEAVES = { 'toc' }

local Kind = { Keyword = 14, Reference = 18, Snippet = 15 }
local SymbolKind = { Namespace = 3, Object = 19 }

local function ctx(params)
  local uri = params.textDocument.uri
  return uri, index.get(vim.uri_to_bufnr(uri))
end

local function range(line, s, e)
  return { start = { line = line, character = s }, ['end'] = { line = line, character = e } }
end

local function def_range(def)
  if def.s then
    return range(def.line, def.s, def.e)
  end
  return range(def.line, 0, 0)
end

-- The label id under the cursor, from either a @reference or a #definition.
local function id_at(idx, pos)
  for _, r in ipairs(idx.refs) do
    if r.line == pos.line and pos.character >= r.s - 1 and pos.character <= r.e then
      return r.id
    end
  end
  for id, d in pairs(idx.defs) do
    if d.line == pos.line and d.s and pos.character >= d.s - 1 and pos.character <= d.e then
      return id
    end
  end
end

local function describe(def)
  local what = def.kind
  if def.title and def.title ~= '' then
    what = what .. ': ' .. def.title
  end
  return what
end

-- Source lines of the thing a label points at.
local function source_of(idx, def)
  local first, last = def.line, def.line
  if def.block then
    last = math.min(def.block.end_line, first + 40)
  elseif def.kind == 'equation' then
    while first > 0 and not idx.lines[first + 1]:match('^%s*%$%$') do
      first = first - 1
    end
  end
  return table.concat(idx.lines, '\n', first + 1, last + 1)
end

local handlers = {}

handlers['initialize'] = function()
  return {
    capabilities = {
      positionEncoding = 'utf-8',
      completionProvider = { triggerCharacters = { '@', ':' } },
      definitionProvider = true,
      hoverProvider = true,
      referencesProvider = true,
      renameProvider = true,
      documentSymbolProvider = true,
    },
    serverInfo = { name = 'tern' },
  }
end

handlers['shutdown'] = function() end

handlers['textDocument/definition'] = function(params)
  local uri, idx = ctx(params)
  local def = idx.defs[id_at(idx, params.position) or '']
  return def and { uri = uri, range = def_range(def) } or nil
end

handlers['textDocument/hover'] = function(params)
  local _, idx = ctx(params)
  local def = idx.defs[id_at(idx, params.position) or '']
  if not def then
    return nil
  end
  return { contents = { kind = 'markdown', value = '````\n' .. source_of(idx, def) .. '\n````' } }
end

handlers['textDocument/references'] = function(params)
  local uri, idx = ctx(params)
  local id = id_at(idx, params.position)
  if not id then
    return nil
  end
  local out = {}
  local def = idx.defs[id]
  if def and params.context and params.context.includeDeclaration then
    table.insert(out, { uri = uri, range = def_range(def) })
  end
  for _, r in ipairs(idx.refs) do
    if r.id == id then
      table.insert(out, { uri = uri, range = range(r.line, r.s, r.e) })
    end
  end
  return out
end

handlers['textDocument/rename'] = function(params)
  local uri, idx = ctx(params)
  local id = id_at(idx, params.position)
  local def = id and idx.defs[id]
  if not def then
    return nil, { code = -32602, message = 'tern: no label under the cursor' }
  end
  if not def.s then
    return nil, { code = -32602, message = 'tern: this heading id comes from its title; add {#id} to the heading to name it' }
  end
  if not params.newName:match('^%a[%w_:-]*$') then
    return nil, { code = -32602, message = 'tern: labels use letters, digits, "_", "-" and ":"' }
  end
  local edits = { { range = def_range(def), newText = params.newName } }
  for _, r in ipairs(idx.refs) do
    if r.id == id then
      table.insert(edits, { range = range(r.line, r.s, r.e), newText = params.newName })
    end
  end
  return { changes = { [uri] = edits } }
end

handlers['textDocument/documentSymbol'] = function(params)
  local _, idx = ctx(params)
  local last = #idx.lines - 1
  local root = { children = {}, level = 0 }
  local stack = { root }
  local nodes = {}

  for i, h in ipairs(idx.headings) do
    local stop = last
    for j = i + 1, #idx.headings do
      if idx.headings[j].level <= h.level then
        stop = idx.headings[j].line - 1
        break
      end
    end
    local node = {
      name = h.text ~= '' and h.text or h.id,
      kind = SymbolKind.Namespace,
      range = { start = { line = h.line, character = 0 }, ['end'] = { line = stop, character = 0 } },
      selectionRange = range(h.line, 0, 0),
      children = {},
      level = h.level,
    }
    while stack[#stack].level >= h.level do
      table.remove(stack)
    end
    table.insert(stack[#stack].children, node)
    table.insert(stack, node)
    table.insert(nodes, node)
  end

  -- Titled or labelled blocks hang off the innermost heading that contains them.
  for _, b in ipairs(idx.blocks) do
    if b.title or b.id then
      local parent = root
      for _, node in ipairs(nodes) do
        if node.range.start.line <= b.line and b.line <= node.range['end'].line then
          parent = node
        end
      end
      table.insert(parent.children, {
        name = b.name .. (b.title and (': ' .. b.title) or '') .. (b.id and ('  #' .. b.id) or ''),
        kind = SymbolKind.Object,
        range = { start = { line = b.line, character = 0 }, ['end'] = { line = b.end_line, character = 0 } },
        selectionRange = range(b.line, 0, 0),
      })
    end
  end

  for _, node in ipairs(nodes) do
    node.level = nil
    table.sort(node.children, function(a, b)
      return a.range.start.line < b.range.start.line
    end)
  end
  return root.children
end

handlers['textDocument/completion'] = function(params)
  local _, idx = ctx(params)
  local pos = params.position
  local before = (idx.lines[pos.line + 1] or ''):sub(1, pos.character)
  local items = {}

  local function add(label, typed, kind, extra)
    local item = {
      label = label,
      kind = kind,
      textEdit = { range = range(pos.line, pos.character - #typed, pos.character), newText = label },
    }
    table.insert(items, vim.tbl_extend('force', item, extra or {}))
  end

  -- @label
  local typed = before:match('@([%w_:-]*)$')
  if typed and not before:match('%w@[%w_:-]*$') then
    for id, def in pairs(idx.defs) do
      add(id, typed, Kind.Reference, { detail = describe(def), documentation = source_of(idx, def) })
    end
    return { isIncomplete = false, items = items }
  end

  -- :::block
  typed = before:match('^%s*:::+%s*([%w_-]*)$')
  if typed then
    local names = {}
    for _, n in ipairs(BLOCKS) do
      names[n] = true
    end
    for n in pairs(idx.names) do
      -- the index also sees the half-typed name on this very line
      if n ~= typed then
        names[n] = true
      end
    end
    for n in pairs(names) do
      add(n, typed, Kind.Keyword)
    end
    return { isIncomplete = false, items = items }
  end

  -- ::leaf
  typed = before:match('^%s*::([%w_-]*)$')
  if typed then
    for _, n in ipairs(LEAVES) do
      add(n, typed, Kind.Keyword)
    end
    return { isIncomplete = false, items = items }
  end

  -- :inline[...]
  typed = before:match(':(%a[%w_-]*)$') or before:match(':()$') and ''
  if typed and not before:match('[%w_:]:[%w_-]*$') then
    for _, n in ipairs(INLINE) do
      add(n, typed, Kind.Snippet, {
        insertTextFormat = 2,
        textEdit = { range = range(pos.line, pos.character - #typed, pos.character), newText = n .. '[$1]$0' },
      })
    end
  end
  return { isIncomplete = false, items = items }
end

local function server()
  local closing, request_id = false, 0
  return {
    request = function(method, params, callback)
      request_id = request_id + 1
      local handler = handlers[method]
      vim.schedule(function()
        if not handler then
          return callback(nil, nil)
        end
        local ok, result, err = pcall(handler, params)
        if ok then
          callback(err, result)
        else
          callback({ code = -32603, message = tostring(result) })
        end
      end)
      return true, request_id
    end,
    notify = function(method)
      if method == 'exit' then
        closing = true
      end
      return true
    end,
    is_closing = function()
      return closing
    end,
    terminate = function()
      closing = true
    end,
  }
end

function M.start(buf)
  return vim.lsp.start({
    name = 'tern',
    cmd = server,
    root_dir = vim.fs.dirname(vim.api.nvim_buf_get_name(buf)),
  }, { bufnr = buf })
end

return M
