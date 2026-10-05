-- Structural index of a note: headings, labelled things, @references, blocks.
-- Columns are 0-based byte offsets; lines are 0-based.
local M = {}

local cache = {}

-- Must match slugify() in tern.js, so heading ids agree with the rendered page.
local function slugify(text, used)
  local base = text:lower():gsub('[^a-z0-9_%s-]', ''):gsub('^%s+', ''):gsub('%s+$', ''):gsub('%s+', '-')
  if base == '' then
    base = 'section'
  end
  local slug, k = base, 1
  while used[slug] do
    k = k + 1
    slug = base .. '-' .. k
  end
  used[slug] = true
  return slug
end

local function scan(lines)
  local idx = { lines = lines, headings = {}, defs = {}, refs = {}, blocks = {}, names = {} }
  local used, open = {}, {}
  local fence_char, fence_len, raw_end

  local function define(id, def)
    used[id] = true
    if not idx.defs[id] then
      def.id = id
      idx.defs[id] = def
    end
  end

  for i, line in ipairs(lines) do
    local l = i - 1
    local t = line:gsub('^%s+', '')
    local indent = #line - #t

    if fence_char then
      local close = t:match('^([`~]+)%s*$')
      if close and close:sub(1, 1) == fence_char and #close >= fence_len then
        fence_char = nil
      end
    elseif raw_end then
      if t:lower():find(raw_end, 1, true) then
        raw_end = nil
      end
    else
      local fence = t:match('^(```+)') or t:match('^(~~~+)')
      local hashes, text = t:match('^(#+)%s+(.-)%s*$')
      local colons, name, rest = t:match('^(::+)%s*(%a[%w_-]*)(.*)$')
      local tag = t:lower():match('^<(script)[%s>]') or t:lower():match('^<(style)[%s>]')

      if fence then
        fence_char, fence_len = fence:sub(1, 1), #fence
      elseif tag then
        if not t:lower():find('</' .. tag, 1, true) then
          raw_end = '</' .. tag
        end
      elseif hashes and #hashes <= 6 then
        text = text:gsub('%s+#+$', '')
        local id = text:match('%s*{#([%w_:-]+)}$')
        local def = { line = l, kind = 'heading' }
        if id then
          text = text:gsub('%s*{#[%w_:-]+}$', '')
          def.s = line:find('{#' .. id, 1, true) + 1
          def.e = def.s + #id
        else
          id = slugify(text, used)
        end
        def.title = text
        define(id, def)
        table.insert(idx.headings, { line = l, level = #hashes, text = text, id = id })
      elseif colons then
        idx.names[name] = true
        local title = rest:match('^%s*(%b[])')
        local from = indent + #colons + 1
        if title then
          local _, te = line:find(title, from, true)
          from = te + 1
        end
        local s, id = line:match('()#([%w_:-]+)', from)
        local block = { line = l, end_line = l, name = name, title = title and title:sub(2, -2), id = id, container = #colons >= 3 }
        table.insert(idx.blocks, block)
        if #colons >= 3 then
          table.insert(open, block)
        end
        if id then
          define(id, { line = l, s = s, e = s + #id, kind = name, title = block.title, block = block })
        end
      elseif t:match('^:::+%s*$') then
        local block = table.remove(open)
        if block then
          block.end_line = l
        end
      end

      if not hashes and not colons then
        local s, id = line:match('%$%$%s*()#([%w_:-]+)%s*$')
        if id then
          define(id, { line = l, s = s, e = s + #id, kind = 'equation' })
        end
      end
      -- ids on inline directives: :name[...]{#id}
      for s, id in line:gmatch('%]{[^}]-()#([%w_:-]+)') do
        define(id, { line = l, s = s, e = s + #id, kind = 'inline' })
      end
      for s, id in line:gmatch('()@(%a[%w_:-]*)') do
        if s == 1 or not line:sub(s - 1, s - 1):match('%w') then
          id = id:gsub(':+$', '')
          table.insert(idx.refs, { line = l, s = s, e = s + #id, id = id })
        end
      end
    end
  end
  for _, block in ipairs(open) do
    block.end_line = #lines - 1
  end
  return idx
end

function M.get(buf)
  local tick = vim.api.nvim_buf_get_changedtick(buf)
  local c = cache[buf]
  if not c or c.tick ~= tick then
    c = scan(vim.api.nvim_buf_get_lines(buf, 0, -1, false))
    c.tick = tick
    cache[buf] = c
  end
  return c
end

function M.forget(buf)
  cache[buf] = nil
end

return M
