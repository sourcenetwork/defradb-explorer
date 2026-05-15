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
