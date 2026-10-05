-- A tern note is an .html file whose first lines load tern.js.
vim.filetype.add({
  pattern = {
    ['.*%.html?'] = {
      function(_, bufnr)
        for _, line in ipairs(vim.api.nvim_buf_get_lines(bufnr, 0, 5, false)) do
          if line:match('<script[^>]-src=["\'][^"\']-tern%.js["\']') then
            return 'tern'
          end
        end
      end,
      { priority = 10 },
    },
  },
})
