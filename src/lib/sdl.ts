const REF_SCALARS = ['String', 'Int', 'Float', 'Float32', 'Float64', 'Boolean', 'ID', 'DateTime', 'Blob', 'JSON']
const REF_SCALAR_RE = new RegExp(`\\b(${REF_SCALARS.join('|')})\\b`, 'g')
const REF_KEYWORDS_RE = /\b(type|input|enum|interface|scalar|union|implements)\b/g

/**
 * Lightweight syntax highlighter for static SDL/GraphQL code snippets in guide panels.
 * Reuses the global .sdl-* CSS classes defined in SchemaView.module.css.
 */
export function highlightRefCode(code: string): string {
  return code.split('\n').map(line => {
    // 1. HTML-escape
    let out = line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

    // 2. Stash trailing comment so later passes don't corrupt it
    let trailingComment = ''
    out = out.replace(/(#.*)$/, (_, c) => { trailingComment = c; return '\x00' })

    // 3. String literals inside directive args, e.g. @default(string: "draft")
    out = out.replace(/"([^"]*)"/g, '<span class="sdl-string">&#34;$1&#34;</span>')

    // 4. SDL keywords (type / enum / …)
    out = out.replace(REF_KEYWORDS_RE, '<span class="sdl-keyword">$1</span>')

    // 5. Directives: @word
    out = out.replace(/@(\w+)/g, '<span class="sdl-keyword">@$1</span>')

    // 6. Scalar types
    out = out.replace(REF_SCALAR_RE, '<span class="sdl-scalar">$1</span>')

    // 7. Type name immediately after a keyword span (type / enum / interface…)
    out = out.replace(
      /(class="sdl-keyword">[^<]+<\/span>)\s+([A-Z]\w*)/g,
      '$1 <span class="sdl-typename">$2</span>',
    )

    // 8. Type references after colon: `: User`, `: [Post]`
    out = out.replace(
      /(:\s*\[?)([A-Z]\w*)(\]?[!]?)/g,
      (_, pre, name, post) =>
        REF_SCALARS.includes(name)
          ? `${pre}<span class="sdl-scalar">${name}</span>${post}`
          : `${pre}<span class="sdl-typeref">${name}</span>${post}`,
    )

    // 9. Collection/type names in query position: word before `(` or ` {`
    out = out.replace(/^(\s*)([A-Z]\w*)(?=\s*[({])/m,
      '$1<span class="sdl-typename">$2</span>',
    )

    // 10. Field names: word before `:`
    out = out.replace(/^(\s*)(\w+)(?=:)/m, '$1<span class="sdl-field">$2</span>')

    // 11. Restore comment
    if (trailingComment) {
      out = out.replace('\x00', `<span class="sdl-comment">${trailingComment}</span>`)
    }

    return out
  }).join('\n')
}

/** Lightweight JSON syntax highlighter for static code panels. */
export function highlightJson(json: string): string {
  return json
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    // String keys: "word":
    .replace(/"([^"]+)"(\s*:)/g, '<span class="json-key">"$1"</span>$2')
    // String values: : "..."
    .replace(/:\s*"([^"]*)"/g, (m, v) => m.replace(`"${v}"`, `<span class="json-string">"${v}"</span>`))
    // Numbers
    .replace(/:\s*(-?\d+\.?\d*)/g, (m, v) => m.replace(v, `<span class="json-number">${v}</span>`))
    // Booleans + null
    .replace(/\b(true|false|null)\b/g, '<span class="json-atom">$1</span>')
    // Punctuation
    .replace(/([{}\[\],])/g, '<span class="json-punct">$1</span>')
}

export const SCALAR_DESCS: Record<string, string> = {
  String:  'UTF-8 character sequence',
  Int:     '32-bit signed integer',
  Float:   '64-bit floating-point number',
  Boolean: 'true or false',
  ID:      'Unique identifier (serialized as String)',
}

export function attr(s: string): string {
  return s.replace(/"/g, '&quot;')
}

/** Strip all description strings from SDL text (both `"""..."""` and `"..."` forms). */
export function stripDescriptions(sdl: string): string {
  return sdl
    .replace(/\n?[ \t]*"""[\s\S]*?"""\n?/g, '\n')
    .replace(/^[ \t]*"(?:[^"\\]|\\.)*"[ \t]*\n/gm, '')
    .replace(/\n{2,}/g, '\n')
    .replace(/\n(type|enum|input|interface|scalar|union)\b/g, '\n\n$1')
    .trim()
}

export function highlightSdl(sdl: string, descriptions: Map<string, string> = new Map()): string {
  let currentType = ''
  return sdl
    .split('\n')
    .map(line => {
      const escaped = line
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

      const typeMatch = line.trim().match(/^type\s+(\w+)/)
      if (typeMatch) currentType = typeMatch[1]

      return escaped
        .replace(/\b(type|enum|interface|union|scalar|input|implements)\b/g,
          '<span class="sdl-keyword">$1</span>')
        .replace(/\b(String|Int|Float|Boolean|ID)\b/g, (_, s) =>
          `<span class="sdl-scalar" data-desc="${SCALAR_DESCS[s]}">${s}</span>`)
        .replace(/^(\s*)(\w+)(?=\s*:)/m, (_, indent, name) => {
          const desc = descriptions.get(`${currentType}.${name}`)
          return desc
            ? `${indent}<span class="sdl-field" data-desc="${attr(desc)}">${name}</span>`
            : `${indent}<span class="sdl-field">${name}</span>`
        })
        .replace(/(sdl-keyword">[^<]+<\/span>) (<span class="sdl-field">)?(\w+)/g, (_, kw, _sp, name) => {
          const desc = descriptions.get(name)
          return desc
            ? `${kw} <span class="sdl-typename" data-desc="${attr(desc)}">${name}</span>`
            : `${kw} <span class="sdl-typename">${name}</span>`
        })
        .replace(/(:\s*\[?)([A-Z]\w*)(\]?[!]?\s*)$/, (_, pre, name, post) => {
          const desc = descriptions.get(name)
          return `${pre}<span class="sdl-typeref"${desc ? ` data-desc="${attr(desc)}"` : ''}>${name}</span>${post}`
        })
        .replace(/#.*/g, '<span class="sdl-comment">$&</span>')
    })
    .join('\n')
}
