-- Live preview: a tiny HTTP server on 127.0.0.1 that serves the note's folder
-- and tells the browser to reload whenever a file under it is written.
local uv = vim.uv

local M = { server = nil, port = nil, root = nil, clients = {} }

-- Injected before the note's first line (everything after tern.js is note text).
-- Timers and the EventSource survive tern.js rewriting the document.
local CLIENT = [[<script>(function(){var k='tern-scroll:'+location.pathname,y=sessionStorage.getItem(k);]]
  .. [[if(y!==null){sessionStorage.removeItem(k);var n=0,t=setInterval(function(){]]
  .. [[if(document.querySelector('main.tern'))scrollTo(0,+y);if(++n>15)clearInterval(t)},100)}]]
  .. [[new EventSource('/__tern/events').onmessage=function(){sessionStorage.setItem(k,scrollY);location.reload()}})()</script>]]

local TYPES = {
  html = 'text/html; charset=utf-8',
  htm = 'text/html; charset=utf-8',
  js = 'text/javascript; charset=utf-8',
  mjs = 'text/javascript; charset=utf-8',
  css = 'text/css; charset=utf-8',
  json = 'application/json',
  svg = 'image/svg+xml',
  png = 'image/png',
  jpg = 'image/jpeg',
  jpeg = 'image/jpeg',
  gif = 'image/gif',
  webp = 'image/webp',
  ico = 'image/x-icon',
  pdf = 'application/pdf',
  woff = 'font/woff',
  woff2 = 'font/woff2',
  ttf = 'font/ttf',
  mp4 = 'video/mp4',
  mp3 = 'audio/mpeg',
  txt = 'text/plain; charset=utf-8',
}

local function close(sock)
  if not sock:is_closing() then
    sock:close()
  end
end

local function respond(sock, status, ctype, body)
  local head = ('HTTP/1.1 %s\r\nContent-Type: %s\r\nContent-Length: %d\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n')
    :format(status, ctype, #body)
  sock:write(head .. body, function()
    close(sock)
  end)
end

local function handle(sock, request)
  local path = request:match('^GET%s+(%S+)')
  if not path then
    return respond(sock, '405 Method Not Allowed', 'text/plain', 'GET only')
  end
  path = path:gsub('[?#].*$', ''):gsub('%%(%x%x)', function(hex)
    return string.char(tonumber(hex, 16))
  end)

  if path == '/__tern/events' then
    sock:write('HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-store\r\nConnection: keep-alive\r\n\r\n: ok\n\n')
    M.clients[sock] = true
    return
  end

  if path:find('..', 1, true) or path:find('%z') then
    return respond(sock, '403 Forbidden', 'text/plain', 'forbidden')
  end
  local file = io.open(M.root .. path, 'rb')
  local body = file and file:read('*a')
  if file then
    file:close()
  end
  if not body then
    return respond(sock, '404 Not Found', 'text/plain', 'not found: ' .. path)
  end
  local ext = (path:match('%.([%w]+)$') or ''):lower()
  if (ext == 'html' or ext == 'htm') and body:sub(1, 400):match('<script[^>]-src=["\'][^"\']-tern%.js["\']') then
    body = CLIENT .. body
  end
  respond(sock, '200 OK', TYPES[ext] or 'application/octet-stream', body)
end

function M.stop()
  for sock in pairs(M.clients) do
    close(sock)
  end
  M.clients = {}
  if M.server then
    close(M.server)
  end
  M.server, M.port, M.root = nil, nil, nil
end

function M.reload()
  for sock in pairs(M.clients) do
    if sock:is_closing() then
      M.clients[sock] = nil
    else
      sock:write('data: reload\n\n')
    end
  end
end

local function listen(root)
  M.stop()
  local server = assert(uv.new_tcp())
  assert(server:bind('127.0.0.1', 0))
  assert(server:listen(64, function(err)
    if err then
      return
    end
    local sock = assert(uv.new_tcp())
    server:accept(sock)
    local data, handled = '', false
    sock:read_start(function(read_err, chunk)
      if read_err or not chunk then
        M.clients[sock] = nil
        return close(sock)
      end
      if handled then
        return
      end
      data = data .. chunk
      if data:find('\r\n\r\n', 1, true) then
        handled = true
        vim.schedule(function()
          handle(sock, data)
        end)
      end
    end)
  end))
  M.server, M.root, M.port = server, root, server:getsockname().port
end

--- Start (or reuse) the server for this buffer's note and return its URL.
function M.start(buf)
  local file = vim.fs.normalize(vim.api.nvim_buf_get_name(buf))
  if file == '' then
    error('tern: buffer has no file')
  end
  -- Serve from the folder that holds tern.js, so the note's relative <script src> resolves.
  local root = vim.fs.root(file, 'tern.js') or vim.fs.dirname(file)
  if not M.server or M.root ~= root then
    listen(root)
  end
  return ('http://127.0.0.1:%d%s'):format(M.port, (file:sub(#root + 1):gsub(' ', '%%20')))
end

vim.api.nvim_create_autocmd('BufWritePost', {
  group = vim.api.nvim_create_augroup('tern_preview', { clear = true }),
  callback = function(args)
    if M.server and vim.startswith(vim.fs.normalize(args.file ~= '' and vim.fn.fnamemodify(args.file, ':p') or ''), M.root .. '/') then
      M.reload()
    end
  end,
})

return M
