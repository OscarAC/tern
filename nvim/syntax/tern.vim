" Syntax for tern notes: a markdown superset with $math$, :::directives and raw HTML.

if exists('b:current_syntax')
  finish
endif

syn include @ternHtml syntax/html.vim
unlet! b:current_syntax
syn include @ternTex syntax/tex.vim
unlet! b:current_syntax

syn case match
syn sync fromstart
syn spell toplevel

syn cluster ternInline contains=ternEscape,ternCode,ternMath,ternMathBlock,ternBold,ternItalic,ternStrike,ternMark,ternLinkText,ternAutolink,ternInlineDir,ternAttrs,ternRef,ternHtmlTag,ternHtmlComment,ternEntity

" --- inline ---------------------------------------------------------------
syn match ternEscape /\\[[:punct:]]/
syn match ternEntity /&\%(#\d\+\|#x\x\+\|\a\w*\);/
syn region ternCode matchgroup=ternCodeDelim start=/\z(`\+\)/ end=/\z1/ end=/^\s*$/ keepend

syn region ternBold start=/\*\*\ze\S/ end=/\S\@1<=\*\*/ end=/^\s*$/ keepend contains=@ternInline
syn region ternBold start=/\w\@1<!__\ze\S/ end=/\S\@1<=__\w\@!/ end=/^\s*$/ keepend contains=@ternInline
syn region ternItalic start=/\*\@1<!\*\ze[^ \t*]/ end=/[^ \t*]\@1<=\*\*\@!/ end=/^\s*$/ keepend contains=@ternInline
syn region ternItalic start=/[[:alnum:]_]\@1<!_\ze[^ \t_]/ end=/[^ \t_]\@1<=_[[:alnum:]_]\@!/ end=/^\s*$/ keepend contains=@ternInline
syn region ternStrike start=/\~\~\ze\S/ end=/\S\@1<=\~\~/ end=/^\s*$/ keepend contains=@ternInline
syn region ternMark start=/==\ze\S/ end=/\S\@1<===/ end=/^\s*$/ keepend contains=@ternInline

syn region ternLinkText matchgroup=ternLinkDelim start=/!\?\[\ze[^\]]*\](/ end=/\]\ze(/ oneline contains=@ternInline nextgroup=ternUrl
syn region ternUrl matchgroup=ternLinkDelim start=/(/ end=/)/ contained oneline
syn match ternAutolink /<https\?:\/\/[^ \t<>]\+>/

syn match ternInlineDir /[[:alnum:]_:]\@1<!:\a[[:alnum:]_-]*\ze\[/
syn match ternAttrs /\]\@1<={[^}]*}/
syn match ternRef /[[:alnum:]]\@1<!@\a[[:alnum:]_-]*\%(:[[:alnum:]_-]\+\)*/

" Pandoc's rule for inline math: opener is followed by a non-space, closer follows one
" and is not followed by a digit. A blank line always ends it.
syn region ternMath matchgroup=ternMathDelim start=/\\\@1<!\$\ze\S/ skip=/\\./ end=/\S\@1<=\$\d\@!/ end=/^\s*$/ keepend contains=@texMathZoneGroup
syn region ternMathBlock matchgroup=ternMathDelim start=/\$\$/ end=/\$\$/ keepend contains=@texMathZoneGroup
syn match ternLabel /\%(\$\$\s*\)\@<=#[[:alnum:]_:-]\+\ze\s*$/

" --- raw HTML ---------------------------------------------------------------
syn match ternHtmlTag /<\/\?\a[[:alnum:]:-]*\%(\_s\_[^<>]*\)\?\/\?>/ contains=@ternHtml
syn region ternHtmlComment start=/<!--/ end=/-->/ keepend
syn region ternHtmlScript start=/<script\>\_[^>]*>/ end=/<\/script\s*>/ keepend contains=@ternHtml
syn region ternHtmlStyle start=/<style\>\_[^>]*>/ end=/<\/style\s*>/ keepend contains=@ternHtml

" --- blocks -----------------------------------------------------------------
syn match ternListMarker /^\s*\%([-*+]\|\d\+[.)]\)\ze\%(\s\|$\)/ nextgroup=ternTask skipwhite
syn match ternTask /\[[ xX]\]/ contained
syn match ternRule /^\s*\([-*_]\)\%(\s*\1\)\{2,}\s*$/
syn match ternQuote /^\s*>>\@!/
syn match ternQuestion /^\s*??\ze\s/
syn match ternAnswer /^\s*>>/

syn match ternH1 /^\s*#\s.*$/ contains=@ternInline,ternHeadingId
syn match ternH2 /^\s*##\s.*$/ contains=@ternInline,ternHeadingId
syn match ternH3 /^\s*###\s.*$/ contains=@ternInline,ternHeadingId
syn match ternH4 /^\s*####\s.*$/ contains=@ternInline,ternHeadingId
syn match ternH5 /^\s*#####\s.*$/ contains=@ternInline,ternHeadingId
syn match ternH6 /^\s*######\s.*$/ contains=@ternInline,ternHeadingId
syn match ternHeadingId /{#[[:alnum:]_:-]\+}\ze\s*$/ contained

" :::name[title] #id .class key=value   /   ::leaf[content]{attrs}   /   :::
syn match ternDirLine /^\s*:\{2,}\s*\a[[:alnum:]_-]*.*$/ contains=ternDirDelim,ternDirLabel,ternDirClass,ternDirAttr
syn match ternDirDelim /^\s*:\{2,}/ contained nextgroup=ternDirName skipwhite
syn match ternDirName /\a[[:alnum:]_-]*/ contained nextgroup=ternDirTitle
syn region ternDirTitle matchgroup=ternDirDelim start=/\[/ end=/\]/ contained oneline contains=@ternInline
syn match ternDirLabel /[ {]\zs#[[:alnum:]_:-]\+/ contained
syn match ternDirClass /[ {]\zs\.[[:alnum:]_-]\+/ contained
syn match ternDirAttr /[ {]\zs[[:alpha:]_][[:alnum:]_-]*=\%("[^"]*"\|\S\+\)/ contained
syn match ternDirEnd /^\s*:\{3,}\s*$/
syn region ternMacros matchgroup=ternDirEnd start=/^\s*:\{3,}\s*macros\>.*$/ end=/^\s*:\{3,}\s*$/ keepend contains=@texMathZoneGroup

syn region ternFence matchgroup=ternFenceDelim start=/^\s*\z(`\{3,}\|\~\{3,}\).*$/ end=/^\s*\z1[`~]*\s*$/ keepend

" --- highlight links ----------------------------------------------------------
hi def link ternH1 @markup.heading.1
hi def link ternH2 @markup.heading.2
hi def link ternH3 @markup.heading.3
hi def link ternH4 @markup.heading.4
hi def link ternH5 @markup.heading.5
hi def link ternH6 @markup.heading.6
hi def link ternHeadingId ternLabel
hi def link ternBold @markup.strong
hi def link ternItalic @markup.italic
hi def link ternStrike @markup.strikethrough
hi def link ternMark Search
hi def link ternCode @markup.raw
hi def link ternCodeDelim Delimiter
hi def link ternFence @markup.raw.block
hi def link ternFenceDelim Delimiter
hi def link ternLinkText @markup.link.label
hi def link ternUrl @markup.link.url
hi def link ternAutolink @markup.link.url
hi def link ternLinkDelim Delimiter
hi def link ternEscape SpecialChar
hi def link ternEntity SpecialChar
hi def link ternMath @markup.math
hi def link ternMathBlock @markup.math
hi def link ternMathDelim Delimiter
hi def link ternMacros @markup.math
hi def link ternHtmlComment Comment
hi def link ternListMarker @markup.list
hi def link ternTask @markup.list.unchecked
hi def link ternRule Delimiter
hi def link ternQuote @markup.quote
hi def link ternQuestion Todo
hi def link ternAnswer Todo
hi def link ternDirDelim Delimiter
hi def link ternDirEnd Delimiter
hi def link ternDirName Keyword
hi def link ternDirTitle Title
hi def link ternDirLabel ternLabel
hi def link ternDirClass Type
hi def link ternDirAttr Identifier
hi def link ternInlineDir Keyword
hi def link ternAttrs Identifier
hi def link ternLabel Label
hi def link ternRef @markup.link

let b:current_syntax = 'tern'

" Highlight fenced code in its own language, for the languages this buffer uses.
lua pcall(function() require('tern.fences').apply(true) end)
