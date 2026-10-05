if vim.g.loaded_tern then
  return
end
vim.g.loaded_tern = true

vim.api.nvim_create_user_command('TernPreview', function()
  local url = require('tern.preview').start(0)
  vim.ui.open(url)
  vim.notify('tern: preview at ' .. url)
end, { desc = 'Open the note in the browser and reload it on every save' })

vim.api.nvim_create_user_command('TernPreviewStop', function()
  require('tern.preview').stop()
end, { desc = 'Stop the tern preview server' })

vim.api.nvim_create_user_command('TernRender', function()
  require('tern.render').toggle(0)
end, { desc = 'Toggle in-buffer rendering of the current tern note' })

-- Turn the current buffer into a note: add the <script> line pointing at the
-- nearest tern.js above this file.
vim.api.nvim_create_user_command('TernInit', function()
  local dir = vim.fs.dirname(vim.fs.normalize(vim.fn.expand('%:p')))
  local src, up = 'tern.js', ''
  local root = vim.fs.root(dir, 'tern.js')
  if root then
    while dir ~= root do
      dir, up = vim.fs.dirname(dir), up .. '../'
    end
    src = up .. 'tern.js'
  end
  vim.api.nvim_buf_set_lines(0, 0, 0, false, { ('<script src="%s"></script>'):format(src), '' })
  vim.bo.filetype = 'tern'
end, { desc = 'Insert the tern.js script line and switch to the tern filetype' })
