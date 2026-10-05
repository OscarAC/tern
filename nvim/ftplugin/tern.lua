if vim.b.did_ftplugin then
  return
end
vim.b.did_ftplugin = true

local buf = vim.api.nvim_get_current_buf()

vim.bo.commentstring = '<!-- %s -->'
vim.bo.formatlistpat = [[^\s*\d\+[.)]\s\+\|^\s*[-*+]\s\+]]
vim.opt_local.formatoptions:append('n')

vim.wo[0][0].foldmethod = 'expr'
vim.wo[0][0].foldexpr = "v:lua.require'tern.fold'.expr(v:lnum)"
vim.wo[0][0].foldlevel = 99

require('tern.lsp').start(buf)
if vim.g.tern_render ~= false then
  require('tern.render').attach(buf)
end

local group = vim.api.nvim_create_augroup('tern_buf_' .. buf, { clear = true })
vim.api.nvim_create_autocmd('BufWritePost', {
  group = group,
  buffer = buf,
  callback = function()
    require('tern.fences').apply(false)
  end,
})
vim.api.nvim_create_autocmd('BufWipeout', {
  group = group,
  buffer = buf,
  callback = function()
    require('tern.index').forget(buf)
  end,
})

vim.b.undo_ftplugin = 'setlocal commentstring< formatlistpat< formatoptions< foldmethod< foldexpr< foldlevel<'
