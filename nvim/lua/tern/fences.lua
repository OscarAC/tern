-- Per-language highlighting inside fenced code blocks. Only languages that
-- actually appear in the buffer are loaded.
local M = {}

local alias = {
  js = 'javascript',
  ts = 'typescript',
  py = 'python',
  rb = 'ruby',
  rs = 'rust',
  sh = 'bash',
  zsh = 'bash',
  shell = 'bash',
  ['c++'] = 'cpp',
  yml = 'yaml',
  tex = 'tex',
  latex = 'tex',
}

---@param reset boolean forget what was loaded (the syntax was just re-sourced)
function M.apply(reset)
  local done = (not reset and vim.b.tern_fences) or {}
  for _, line in ipairs(vim.api.nvim_buf_get_lines(0, 0, -1, false)) do
    local lang = line:match('^%s*```+%s*([%w_+-]+)') or line:match('^%s*~~~+%s*([%w_+-]+)')
    if lang and not done[lang] then
      done[lang] = true
      local ft = alias[lang] or lang
      if ft:match('^[%w_]+$') and #vim.api.nvim_get_runtime_file('syntax/' .. ft .. '.vim', false) > 0 then
        local id = lang:gsub('[^%w_]', '_')
        pcall(vim.cmd, ([[
          unlet! b:current_syntax
          syn include @ternCode_%s syntax/%s.vim
          syn region ternFence_%s matchgroup=ternFenceDelim start=/^\s*\z(`\{3,}\|\~\{3,}\)\s*%s\%%(\s.*\)\?$/ end=/^\s*\z1[`~]*\s*$/ keepend contains=@ternCode_%s
          let b:current_syntax = 'tern'
        ]]):format(id, ft, id, vim.fn.escape(lang, [[/\.+]]), id))
      end
    end
  end
  vim.b.tern_fences = done
end

return M
