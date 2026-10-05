-- In-buffer rendering: draws a note's structure over its source with extmarks
-- (numbered theorem blocks, resolved @refs, hidden answers, Unicode math, ...).
-- The buffer stays editable and the cursor line always shows raw source.
local index = require('tern.index')

local M = {}

local ns = vim.api.nvim_create_namespace('tern_render')
local state = {} -- buf -> { marks = { [row] = { {col, opts}, ... } }, cursor = row, timer = n, saved = { [win] = opts } }

-- name -> { label, counter group, highlight }   (numbering must match ENVS in tern.js)
local ENVS = {
  theorem = { 'Theorem', 'theorem', 'TernTheorem' },
  lemma = { 'Lemma', 'theorem', 'TernTheorem' },
  proposition = { 'Proposition', 'theorem', 'TernTheorem' },
  corollary = { 'Corollary', 'theorem', 'TernTheorem' },
  definition = { 'Definition', 'definition', 'TernDefinition' },
  example = { 'Example', 'example', 'TernExample' },
  exercise = { 'Exercise', 'exercise', 'TernExample' },
  remark = { 'Remark', nil, 'TernDim' },
  proof = { 'Proof', nil, 'TernDim' },
  note = { 'Note', nil, 'TernNote', true },
  info = { 'Info', nil, 'TernNote', true },
  tip = { 'Tip', nil, 'TernTip', true },
  important = { 'Important', nil, 'TernImportant', true },
  warning = { 'Warning', nil, 'TernWarning', true },
}

local HEADING_ICONS = { '◉ ', '○ ', '◆ ', '◇ ', '▪ ', '▫ ' }

local SYM = {
  alpha = 'α', beta = 'β', gamma = 'γ', delta = 'δ', epsilon = 'ϵ', varepsilon = 'ε', zeta = 'ζ', eta = 'η',
  theta = 'θ', vartheta = 'ϑ', iota = 'ι', kappa = 'κ', lambda = 'λ', mu = 'μ', nu = 'ν', xi = 'ξ', pi = 'π',
  rho = 'ρ', sigma = 'σ', tau = 'τ', upsilon = 'υ', phi = 'ϕ', varphi = 'φ', chi = 'χ', psi = 'ψ', omega = 'ω',
  Gamma = 'Γ', Delta = 'Δ', Theta = 'Θ', Lambda = 'Λ', Xi = 'Ξ', Pi = 'Π', Sigma = 'Σ', Phi = 'Φ', Psi = 'Ψ', Omega = 'Ω',
  to = '→', rightarrow = '→', leftarrow = '←', gets = '←', mapsto = '↦', leftrightarrow = '↔',
  Rightarrow = '⇒', Leftarrow = '⇐', Leftrightarrow = '⇔', implies = '⟹', iff = '⟺',
  hookrightarrow = '↪', twoheadrightarrow = '↠', uparrow = '↑', downarrow = '↓',
  le = '≤', leq = '≤', ge = '≥', geq = '≥', ne = '≠', neq = '≠', approx = '≈', equiv = '≡', sim = '∼', simeq = '≃',
  cong = '≅', propto = '∝', ll = '≪', gg = '≫',
  ['in'] = '∈', notin = '∉', ni = '∋', subset = '⊂', subseteq = '⊆', supset = '⊃', supseteq = '⊇', subsetneq = '⊊',
  cup = '∪', cap = '∩', setminus = '∖', emptyset = '∅', varnothing = '∅', bigcup = '⋃', bigcap = '⋂',
  forall = '∀', exists = '∃', nexists = '∄', neg = '¬', lnot = '¬', land = '∧', wedge = '∧', lor = '∨', vee = '∨',
  top = '⊤', bot = '⊥', perp = '⊥', vdash = '⊢', models = '⊨',
  cdot = '·', times = '×', div = '÷', pm = '±', mp = '∓', circ = '∘', oplus = '⊕', otimes = '⊗', ast = '∗', star = '⋆',
  infty = '∞', partial = '∂', nabla = '∇', sum = '∑', prod = '∏', coprod = '∐', int = '∫', oint = '∮',
  sqrt = '√', angle = '∠', parallel = '∥', mid = '∣', nmid = '∤', ell = 'ℓ', hbar = 'ℏ', Re = 'ℜ', Im = 'ℑ', aleph = 'ℵ',
  langle = '⟨', rangle = '⟩', lVert = '‖', rVert = '‖', Vert = '‖', lvert = '|', rvert = '|', vert = '|',
  lfloor = '⌊', rfloor = '⌋', lceil = '⌈', rceil = '⌉',
  ldots = '…', dots = '…', cdots = '⋯', vdots = '⋮', ddots = '⋱',
  quad = ' ', qquad = '  ', colon = ':', prime = '′', dagger = '†', square = '□', blacksquare = '■', qed = '∎',
  triangle = '△', therefore = '∴', because = '∵',
}
local FUNCS = {}
for name in ('sin cos tan cot sec csc arcsin arccos arctan sinh cosh tanh log ln lg exp lim liminf limsup max min sup inf '
  .. 'det dim ker deg gcd lcm arg hom Pr mod bmod'):gmatch('%S+') do
  FUNCS[name] = true
end
local WRAPPERS = { operatorname = true, text = true, mathrm = true, textrm = true, mathit = true, textit = true }
local BB = { N = 'ℕ', Z = 'ℤ', Q = 'ℚ', R = 'ℝ', C = 'ℂ', H = 'ℍ', P = 'ℙ', F = '𝔽', E = '𝔼', K = '𝕂', A = '𝔸', D = '𝔻', T = '𝕋' }
local SUP = {
  ['0'] = '⁰', ['1'] = '¹', ['2'] = '²', ['3'] = '³', ['4'] = '⁴', ['5'] = '⁵', ['6'] = '⁶', ['7'] = '⁷', ['8'] = '⁸',
  ['9'] = '⁹', ['+'] = '⁺', ['-'] = '⁻', ['='] = '⁼', ['('] = '⁽', [')'] = '⁾', n = 'ⁿ', i = 'ⁱ', k = 'ᵏ', m = 'ᵐ',
  x = 'ˣ', j = 'ʲ', t = 'ᵗ', T = 'ᵀ', a = 'ᵃ', b = 'ᵇ', c = 'ᶜ', d = 'ᵈ',
}
local SUB = {
  ['0'] = '₀', ['1'] = '₁', ['2'] = '₂', ['3'] = '₃', ['4'] = '₄', ['5'] = '₅', ['6'] = '₆', ['7'] = '₇', ['8'] = '₈',
  ['9'] = '₉', ['+'] = '₊', ['-'] = '₋', ['='] = '₌', ['('] = '₍', [')'] = '₎', a = 'ₐ', e = 'ₑ', i = 'ᵢ', j = 'ⱼ',
  k = 'ₖ', n = 'ₙ', m = 'ₘ', x = 'ₓ', o = 'ₒ', r = 'ᵣ', t = 'ₜ', s = 'ₛ', p = 'ₚ',
}

local function set_highlights()
  local links = {
    TernTheorem = 'Keyword', TernDefinition = 'DiagnosticOk', TernExample = 'DiagnosticWarn', TernNote = 'DiagnosticInfo',
    TernTip = 'DiagnosticOk', TernImportant = 'Keyword', TernWarning = 'DiagnosticWarn', TernDim = 'Comment',
    TernBlockTitle = 'Title', TernRefText = '@markup.link', TernEqNo = 'Comment', TernCard = 'Todo', TernHidden = 'NonText',
    TernAside = 'Comment', TernKbd = '@markup.raw', TernBullet = '@markup.list', TernRuleLine = 'NonText',
    TernMathSym = '@markup.math', TernCodeBg = 'ColorColumn', TernTableBorder = 'NonText', TernHeadingIcon = 'Title',
  }
  for name, target in pairs(links) do
    vim.api.nvim_set_hl(0, name, { link = target, default = true })
  end
end

local function blank(s, i, j)
  return s:sub(1, i - 1) .. (' '):rep(j - i + 1) .. s:sub(j + 1)
end

-- Convert e.g. "-1" to "⁻¹"; nil if some character has no counterpart.
local function script(map, s)
  local out = {}
  for ch in s:gmatch('.') do
    if not map[ch] then
      return nil
    end
    out[#out + 1] = map[ch]
  end
  return #out > 0 and table.concat(out) or nil
end

-- What a user macro body displays as, when it is simple enough to show inline.
local function macro_text(body)
  body = vim.trim(body)
  local bb = body:match('^\\mathbb%s*{?(%a)}?$')
  if bb and BB[bb] then
    return BB[bb]
  end
  local word = body:match('^\\operatorname{([%a%s]+)}$') or body:match('^\\mathrm{([%a%s]+)}$') or body:match('^\\text{([%a%s]+)}$')
  if word then
    return word
  end
  local cmd = body:match('^\\(%a+)$')
  return cmd and SYM[cmd] or nil
end

local function build(buf)
  local idx = index.get(buf)
  local lines = idx.lines
  local marks = {}

  local function mark(row, col, opts)
    marks[row] = marks[row] or {}
    table.insert(marks[row], { col, opts })
  end
  local function hide(row, s, e)
    if e > s then
      mark(row, s, { end_col = e, conceal = '' })
    end
  end
  local function virt(row, col, chunks, pos)
    mark(row, col, { virt_text = chunks, virt_text_pos = pos or 'inline' })
  end
  -- Show `text` in place of bytes [s, e).
  local function swap(row, s, e, text, hl)
    if vim.fn.strdisplaywidth(text) == 1 then
      mark(row, s, { end_col = e, conceal = text, hl_group = hl })
    else
      hide(row, s, e)
      virt(row, s, { { text, hl } })
    end
  end

  -- Labels: what each id displays as, numbered in document order like the browser does.
  local label_of, counters = {}, {}
  for _, b in ipairs(idx.blocks) do
    local env = ENVS[b.name]
    if env then
      b.label = env[1]
      if env[2] then
        counters[env[2]] = (counters[env[2]] or 0) + 1
        b.label = b.label .. ' ' .. counters[env[2]]
      end
      if b.id then
        label_of[b.id] = b.label
      end
    end
  end
  local equations, eq_at = {}, {}
  for _, d in pairs(idx.defs) do
    if d.kind == 'equation' then
      equations[#equations + 1] = d
    elseif d.kind == 'heading' then
      label_of[d.id] = d.title
    end
  end
  table.sort(equations, function(a, b)
    return a.line < b.line
  end)
  for n, d in ipairs(equations) do
    label_of[d.id] = '(' .. n .. ')'
    eq_at[d.line] = { def = d, text = '(' .. n .. ')' }
  end

  local macros = {}
  for _, b in ipairs(idx.blocks) do
    if b.name == 'macros' then
      for l = b.line + 2, b.end_line do
        local name, body = (lines[l] or ''):match('\\g?def%s*\\(%a+)%s*{(.*)}%s*$')
        if not name then
          name, body = (lines[l] or ''):match('\\r?e?newcommand%s*{?\\(%a+)}?%s*{(.*)}%s*$')
        end
        if name then
          macros[name] = macro_text(body)
        end
      end
    end
  end

  local starts, refs_at = {}, {}
  for _, b in ipairs(idx.blocks) do
    starts[b.line] = b
  end
  for _, r in ipairs(idx.refs) do
    refs_at[r.line] = refs_at[r.line] or {}
    table.insert(refs_at[r.line], r)
  end

  -- Unicode stand-ins for TeX inside bytes [s, e) of a line.
  local function tex(row, line, s, e)
    local i = s + 1
    while i <= e do
      local a, b, cap = line:find('^\\mathbb%s*{?(%a)}?', i)
      if a and b <= e and BB[cap] then
        swap(row, a - 1, b, BB[cap], 'TernMathSym')
        i = b + 1
      else
        a, b, cap = line:find('^\\(%a+)', i)
        if a and b <= e then
          if WRAPPERS[cap] and line:sub(b + 1, b + 1) == '{' then
            local close = line:find('}', b + 2, true)
            if close and close <= e then
              hide(row, a - 1, b + 1)
              hide(row, close - 1, close)
            end
          elseif SYM[cap] or macros[cap] then
            swap(row, a - 1, b, SYM[cap] or macros[cap], 'TernMathSym')
          elseif FUNCS[cap] then
            hide(row, a - 1, a)
          end
          i = b + 1
        else
          local two = line:sub(i, i + 1)
          local ch = two:sub(1, 1)
          if two == '\\,' or two == '\\;' or two == '\\!' or two == '\\:' then
            hide(row, i - 1, i + 1)
            i = i + 2
          elseif two == '\\{' or two == '\\}' then
            hide(row, i - 1, i)
            i = i + 2
          elseif two == '\\|' then
            swap(row, i - 1, i + 1, '‖', 'TernMathSym')
            i = i + 2
          elseif ch == '\\' then
            i = i + 2
          elseif ch == '^' or ch == '_' then
            local map = ch == '^' and SUP or SUB
            local _, be, inner = line:find('^{([^{}\\]*)}', i + 1)
            if not be then
              inner = line:sub(i + 1, i + 1)
              be = i + 1
            end
            local text = be <= e and script(map, inner)
            if text then
              swap(row, i - 1, be, text, 'TernMathSym')
              i = be + 1
            else
              i = i + 1
            end
          else
            i = i + 1
          end
        end
      end
    end
  end

  -- Inline markup on one line, starting at byte `from` (1-based).
  local function inline(row, line, from)
    local m = blank(line, 1, from - 1)

    -- code spans: hide the backticks, protect the contents
    local pos = 1
    while true do
      local s, e, ticks = m:find('(`+)', pos)
      if not s then
        break
      end
      local cs, ce = m:find(ticks, e + 1, true)
      if cs and m:sub(ce + 1, ce + 1) ~= '`' then
        hide(row, s - 1, e)
        hide(row, cs - 1, ce)
        m = blank(m, s, ce)
        pos = ce + 1
      else
        pos = e + 1
      end
    end

    -- math: $...$ and $$...$$ on this line
    pos = 1
    while true do
      local s = m:find('$', pos, true)
      if not s then
        break
      end
      if s > 1 and m:sub(s - 1, s - 1) == '\\' then
        pos = s + 1
      elseif m:sub(s + 1, s + 1) == '$' then
        local e = m:find('$$', s + 2, true)
        if e then
          hide(row, s - 1, s + 1)
          hide(row, e - 1, e + 1)
          tex(row, line, s + 1, e - 1)
          m = blank(m, s, e + 1)
          pos = e + 2
        else
          pos = s + 2
        end
      else
        local e
        if m:sub(s + 1, s + 1):match('%S') then
          local j = s + 1
          while j <= #m do
            local c = m:sub(j, j)
            if c == '\\' then
              j = j + 1
            elseif c == '$' and m:sub(j - 1, j - 1):match('%S') and not m:sub(j + 1, j + 1):match('%d') then
              e = j
              break
            end
            j = j + 1
          end
        end
        if e then
          hide(row, s - 1, s)
          hide(row, e - 1, e)
          tex(row, line, s, e - 1)
          m = blank(m, s, e)
          pos = e + 1
        else
          pos = s + 1
        end
      end
    end

    -- @refs
    for _, r in ipairs(refs_at[row] or {}) do
      if label_of[r.id] and m:sub(r.s, r.s) == '@' then
        swap(row, r.s - 1, r.e, label_of[r.id], 'TernRefText')
        m = blank(m, r.s, r.e)
      end
    end

    -- :name[content]{attrs}
    pos = 1
    while true do
      local s, e, name = m:find(':(%a[%w_-]*)%[', pos)
      if not s then
        break
      end
      pos = e + 1
      if s == 1 or not m:sub(s - 1, s - 1):match('[%w_:]') then
        local depth, close = 1, nil
        for j = e + 1, #m do
          local c = m:sub(j, j)
          if c == '[' then
            depth = depth + 1
          elseif c == ']' then
            depth = depth - 1
            if depth == 0 then
              close = j
              break
            end
          end
        end
        if close then
          local stop = close
          if m:sub(close + 1, close + 1) == '{' then
            stop = m:find('}', close + 1, true) or close
          end
          if name == 'hide' then
            local width = vim.fn.strdisplaywidth(line:sub(e + 1, close - 1))
            -- marks already placed inside (math, refs) must not show through
            local kept = {}
            for _, mk in ipairs(marks[row] or {}) do
              if mk[1] < s - 1 or mk[1] >= stop then
                kept[#kept + 1] = mk
              end
            end
            marks[row] = kept
            hide(row, s - 1, stop)
            virt(row, s - 1, { { ('▒'):rep(math.max(2, math.min(width, 30))), 'TernHidden' } })
            m = blank(m, s, stop)
          else
            hide(row, s - 1, e)
            hide(row, close - 1, stop)
            local hl = ({ aside = 'TernAside', kbd = 'TernKbd', hl = 'Search' })[name]
            if hl then
              mark(row, e, { end_col = close - 1, hl_group = hl })
            end
            m = blank(blank(m, s, e), close, stop)
          end
          pos = stop + 1
        end
      end
    end

    -- [text](url)
    pos = 1
    while true do
      local s, e = m:find('!?%[[^%]]*%]%([^%)]*%)', pos)
      if not s then
        break
      end
      local open = m:find('[', s, true)
      local mid = m:find('](', open, true)
      hide(row, s - 1, open)
      hide(row, mid - 1, e)
      m = blank(blank(m, s, open), mid, e)
      pos = e + 1
    end

    -- **bold**, ~~strike~~, ==mark==, then *italic* and _italic_
    for _, d in ipairs({ '%*%*', '~~', '==' }) do
      pos = 1
      while true do
        local s, e = m:find(d .. '%S.-' .. d, pos)
        if not s then
          break
        end
        hide(row, s - 1, s + 1)
        hide(row, e - 2, e)
        m = blank(blank(m, s, s + 1), e - 1, e)
        pos = e + 1
      end
    end
    for _, pat in ipairs({ '%*[^%s%*][^%*]*%*', '%f[%w_]_[^%s_][^_]*_%f[^%w_]' }) do
      pos = 1
      while true do
        local s, e = m:find(pat, pos)
        if not s then
          break
        end
        if not m:sub(e - 1, e - 1):match('%s') then
          hide(row, s - 1, s)
          hide(row, e - 1, e)
        end
        pos = e + 1
      end
    end
    return m
  end

  local function bar_of(block)
    local env = ENVS[block.name]
    return env and { '┃ ', env[3] } or { '│ ', 'TernDim' }
  end

  local stack = {}
  local fence_char, fence_len, raw_end, in_math, card, in_table

  for i, line in ipairs(lines) do
    local row = i - 1
    local t = line:gsub('^%s+', '')
    local indent = #line - #t
    local prefix = {}
    for _, b in ipairs(stack) do
      prefix[#prefix + 1] = bar_of(b)
    end
    local head -- extra chunks appended to the prefix (block headers)

    if t == '' then
      card, in_table = nil, nil
    end

    if fence_char then
      mark(row, 0, { line_hl_group = 'TernCodeBg' })
      local close = t:match('^([`~]+)%s*$')
      if close and close:sub(1, 1) == fence_char and #close >= fence_len then
        fence_char = nil
        hide(row, 0, #line)
      end
    elseif raw_end then
      if t:lower():find(raw_end, 1, true) then
        raw_end = nil
      end
    elseif in_math then
      local close = line:find('$$', 1, true)
      if close then
        in_math = nil
        tex(row, line, 0, close - 1)
        hide(row, close - 1, close + 1)
        local eq = eq_at[row]
        if eq then
          hide(row, close + 1, #line)
          virt(row, 0, { { eq.text, 'TernEqNo' } }, 'right_align')
        end
      else
        tex(row, line, 0, #line)
      end
    elseif t:match('^:::+%s*$') and #stack > 0 then
      local block = table.remove(stack)
      table.remove(prefix)
      if block.name == 'proof' then
        hide(row, 0, #line)
        virt(row, 0, { { '∎', 'TernDim' } }, 'right_align')
      else
        mark(row, 0, { conceal_lines = '' })
      end
    elseif starts[row] then
      local b = starts[row]
      local env = ENVS[b.name]
      hide(row, 0, #line)
      if env then
        local callout = env[4]
        head = { { '┃ ', env[3] }, { callout and b.title or b.label, env[3] } }
        if b.title and not callout then
          head[#head + 1] = { ' (' .. b.title .. ')', 'TernBlockTitle' }
        end
      elseif b.name == 'details' then
        head = { { '▸ ', 'TernDim' }, { b.title or 'Details', 'TernBlockTitle' } }
      elseif b.name == 'toc' then
        head = { { 'Contents', 'TernBlockTitle' } }
        local toc = {}
        for _, h in ipairs(idx.headings) do
          if h.level == 2 or h.level == 3 then
            toc[#toc + 1] = { { (h.level == 3 and '    ' or '  ') .. h.text, 'TernRefText' } }
          end
        end
        if #toc > 0 then
          mark(row, 0, { virt_lines = toc })
        end
      else
        head = { { b.container and '┌ ' or '· ', 'TernDim' }, { b.name, 'TernDim' } }
        if b.title then
          head[#head + 1] = { '  ' .. b.title, 'TernBlockTitle' }
        end
      end
      if b.container then
        stack[#stack + 1] = b
        if b.name == 'macros' then
          raw_end = nil
        end
      end
    else
      local fence = t:match('^(```+)') or t:match('^(~~~+)')
      local hashes = t:match('^(#+)%s')
      local tag = t:lower():match('^<(script)[%s>]') or t:lower():match('^<(style)[%s>]')
      local from = indent + 1

      if fence then
        fence_char, fence_len = fence:sub(1, 1), #fence
        mark(row, 0, { line_hl_group = 'TernCodeBg' })
        hide(row, indent, indent + #fence)
        from = nil
      elseif tag then
        if not t:lower():find('</' .. tag, 1, true) then
          raw_end = '</' .. tag
        end
        from = nil
      elseif hashes and #hashes <= 6 then
        local stop = line:find('%S', indent + #hashes + 1) or #line + 1
        swap(row, indent, stop - 1, HEADING_ICONS[#hashes], 'TernHeadingIcon')
        local id_s = line:find('%s*{#[%w_:-]+}%s*$')
        if id_s then
          hide(row, id_s - 1, #line)
        end
        if #hashes == 2 then
          mark(row, 0, { virt_lines = { { { ('─'):rep(60), 'TernRuleLine' } } } })
        end
        from = stop
      elseif t:match('^([-*_])%s*%1%s*%1[%s%-*_]*$') and not t:match('[^%s%-*_]') then
        hide(row, 0, #line)
        head = { { ('─'):rep(60), 'TernRuleLine' } }
        from = nil
      elseif t:match('^%?%?%s') then
        card = 'question'
        swap(row, indent, indent + 2, 'Q', 'TernCard')
        from = indent + 3
      elseif card and (t:sub(1, 2) == '>>' or card == 'answer') then
        card = 'answer'
        hide(row, indent, #line)
        local width = vim.fn.strdisplaywidth(t)
        virt(row, indent, { { 'A ', 'TernCard' }, { ('▒'):rep(math.max(3, math.min(width, 50))), 'TernHidden' } })
        from = nil
      elseif t:sub(1, 2) == '$$' then
        local close = line:find('$$', indent + 3, true)
        hide(row, indent, indent + 2)
        if close then
          tex(row, line, indent + 2, close - 1)
          hide(row, close - 1, close + 1)
          local eq = eq_at[row]
          if eq then
            hide(row, close + 1, #line)
            virt(row, 0, { { eq.text, 'TernEqNo' } }, 'right_align')
          elseif line:find('%S', close + 2) then
            inline(row, line, close + 2)
          end
        else
          in_math = true
          tex(row, line, indent + 2, #line)
        end
        from = nil
      else
        local marker, gap = t:match('^([-*+])(%s+)')
        local quote = t:match('^>%s?')
        if marker then
          swap(row, indent, indent + 1, '•', 'TernBullet')
          from = indent + 1 + #gap + 1
          local box = line:match('^%[([ xX])%]%s', from)
          if box then
            swap(row, from - 1, from + 2, box == ' ' and '☐' or '☑', 'TernBullet')
            from = from + 4
          end
        elseif quote and t:sub(1, 2) ~= '>>' then
          swap(row, indent, indent + 1, '┃', 'TernDim')
          from = indent + #quote + 1
        end
      end

      if from then
        local m = inline(row, line, from)
        -- tables: a row is any line with a pipe once a |---|---| line follows the header
        local next_line = lines[i + 1] or ''
        local is_delim = t:match('^|?%s*:?%-+:?%s*[|%s:%-]*$') and t:find('|', 1, true)
        if not in_table and m:find('|', 1, true) and next_line:find('|', 1, true)
          and next_line:match('^%s*|?%s*:?%-+:?%s*[|%s:%-]*$') then
          in_table = true
        end
        if in_table and m:find('|', 1, true) then
          for p in m:gmatch('()|') do
            if line:sub(p - 1, p - 1) ~= '\\' then
              mark(row, p - 1, { end_col = p, conceal = is_delim and '┼' or '│', hl_group = 'TernTableBorder' })
            end
          end
          if is_delim then
            for p in line:gmatch('()[%-:]') do
              mark(row, p - 1, { end_col = p, conceal = '─', hl_group = 'TernTableBorder' })
            end
          end
        end
      end
    end

    if head then
      for _, chunk in ipairs(head) do
        prefix[#prefix + 1] = chunk
      end
    end
    if #prefix > 0 then
      -- priority below the default so the bars sit left of anything else placed at column 0
      table.insert(marks[row] or {}, 1, { 0, { virt_text = prefix, virt_text_pos = 'inline', priority = 10 } })
      if not marks[row] then
        marks[row] = { { 0, { virt_text = prefix, virt_text_pos = 'inline', priority = 10 } } }
      end
    end
  end
  return marks
end

local function apply_row(buf, row, marks)
  for _, m in ipairs(marks[row] or {}) do
    pcall(vim.api.nvim_buf_set_extmark, buf, ns, row, m[1], m[2])
  end
end

local function cursor_row(buf)
  local win = vim.fn.bufwinid(buf)
  return win ~= -1 and vim.api.nvim_win_get_cursor(win)[1] - 1 or nil
end

local function set_window(buf, on)
  local st = state[buf]
  for _, win in ipairs(vim.fn.win_findbuf(buf)) do
    if on and not st.saved[win] then
      st.saved[win] = { vim.wo[win][0].conceallevel, vim.wo[win][0].concealcursor }
      vim.wo[win][0].conceallevel = 2
      vim.wo[win][0].concealcursor = ''
    elseif not on and st.saved[win] then
      vim.wo[win][0].conceallevel, vim.wo[win][0].concealcursor = st.saved[win][1], st.saved[win][2]
      st.saved[win] = nil
    end
  end
end

function M.render(buf)
  local st = state[buf]
  if not st or not vim.api.nvim_buf_is_valid(buf) then
    return
  end
  set_window(buf, true)
  local ok, marks = pcall(build, buf)
  if not ok then
    vim.notify_once('tern: render failed: ' .. tostring(marks), vim.log.levels.WARN)
    return
  end
  st.marks = marks
  st.cursor = cursor_row(buf)
  vim.api.nvim_buf_clear_namespace(buf, ns, 0, -1)
  for row in pairs(marks) do
    if row ~= st.cursor then
      apply_row(buf, row, marks)
    end
  end
end

-- The cursor line shows raw source: drop its marks, restore the line just left.
local function on_cursor(buf)
  local st = state[buf]
  if not st or not st.marks then
    return
  end
  local row = cursor_row(buf)
  if row == st.cursor then
    return
  end
  if st.cursor then
    vim.api.nvim_buf_clear_namespace(buf, ns, st.cursor, st.cursor + 1)
    apply_row(buf, st.cursor, st.marks)
  end
  if row then
    vim.api.nvim_buf_clear_namespace(buf, ns, row, row + 1)
  end
  st.cursor = row
end

local function schedule(buf)
  local st = state[buf]
  if not st then
    return
  end
  st.timer = (st.timer or 0) + 1
  local token = st.timer
  vim.defer_fn(function()
    if state[buf] and state[buf].timer == token then
      M.render(buf)
    end
  end, 30)
end

function M.attach(buf)
  buf = buf == 0 and vim.api.nvim_get_current_buf() or buf
  if state[buf] then
    return
  end
  set_highlights()
  state[buf] = { saved = {} }
  local group = vim.api.nvim_create_augroup('tern_render_' .. buf, { clear = true })
  vim.api.nvim_create_autocmd({ 'TextChanged', 'TextChangedI', 'TextChangedP' }, {
    group = group, buffer = buf, callback = function() schedule(buf) end,
  })
  vim.api.nvim_create_autocmd({ 'CursorMoved', 'CursorMovedI' }, {
    group = group, buffer = buf, callback = function() on_cursor(buf) end,
  })
  vim.api.nvim_create_autocmd('BufWinEnter', {
    group = group, buffer = buf, callback = function() M.render(buf) end,
  })
  vim.api.nvim_create_autocmd('ColorScheme', { group = group, callback = set_highlights })
  vim.api.nvim_create_autocmd('BufWipeout', {
    group = group, buffer = buf, callback = function() state[buf] = nil end,
  })
  M.render(buf)
end

function M.detach(buf)
  buf = buf == 0 and vim.api.nvim_get_current_buf() or buf
  if not state[buf] then
    return
  end
  pcall(vim.api.nvim_del_augroup_by_name, 'tern_render_' .. buf)
  set_window(buf, false)
  vim.api.nvim_buf_clear_namespace(buf, ns, 0, -1)
  state[buf] = nil
end

function M.toggle(buf)
  buf = buf == 0 and vim.api.nvim_get_current_buf() or buf
  if state[buf] then
    M.detach(buf)
  else
    M.attach(buf)
  end
end

return M
