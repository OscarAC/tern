-- Folding: headings fold their sections, and each :::block folds inside them.
local M = {}

local cache = {}

local function compute(lines)
  local levels = {}
  local heading, depth = 0, 0
  local fence_char, fence_len
  for i, line in ipairs(lines) do
    local t = line:gsub('^%s+', '')
    local level = heading + depth
    if fence_char then
      local close = t:match('^([`~]+)%s*$')
      if close and close:sub(1, 1) == fence_char and #close >= fence_len then
        fence_char = nil
      end
    else
      local fence = t:match('^(```+)') or t:match('^(~~~+)')
      local hashes = t:match('^(#+)%s')
      if fence then
        fence_char, fence_len = fence:sub(1, 1), #fence
      elseif hashes and #hashes <= 6 and depth == 0 then
        heading = #hashes
        level = '>' .. heading
      elseif t:match('^:::+%s*%a') then
        depth = depth + 1
        level = '>' .. (heading + depth)
      elseif t:match('^:::+%s*$') and depth > 0 then
        level = '<' .. (heading + depth)
        depth = depth - 1
      end
    end
    levels[i] = level
  end
  return levels
end

function M.expr(lnum)
  local buf = vim.api.nvim_get_current_buf()
  local tick = vim.api.nvim_buf_get_changedtick(buf)
  local c = cache[buf]
  if not c or c.tick ~= tick then
    c = { tick = tick, levels = compute(vim.api.nvim_buf_get_lines(buf, 0, -1, false)) }
    cache[buf] = c
  end
  return c.levels[lnum] or 0
end

return M
