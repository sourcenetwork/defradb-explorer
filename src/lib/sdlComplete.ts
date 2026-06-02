import { autocompletion, type CompletionContext, type Completion } from '@codemirror/autocomplete'

// ── Constants ─────────────────────────────────────────────────────────────────

export const SDL_SCALARS = [
  'String', 'Int', 'Float', 'Float32', 'Float64', 'Boolean', 'ID', 'DateTime', 'Blob', 'JSON',
]

// Allowed directive sets per editor context
export const DIRECTIVES_CREATE = new Set([
  'index', 'default', 'relation', 'primary', 'crdt',
  'policy', 'branchable', 'constraints', 'encryptedIndex', 'embedding',
])

export const DIRECTIVES_PATCH = new Set([
  'index', 'default', 'relation', 'primary', 'crdt',
  'constraints', 'embedding',
])

export const DIRECTIVES_VIEW = new Set([
  'materialized',
])

const DIRECTIVE_COMPLETIONS: Record<string, Completion[]> = {
  index: [
    { label: 'unique: true',     apply: 'unique: true',     detail: 'unique index',         type: 'property' },
    { label: 'unique: false',    apply: 'unique: false',    detail: 'non-unique (default)',  type: 'property' },
    { label: 'name: ""',         apply: 'name: ""',         detail: 'custom index name',     type: 'property' },
    { label: 'direction: ASC',   apply: 'direction: ASC',   detail: 'ascending sort',        type: 'property' },
    { label: 'direction: DESC',  apply: 'direction: DESC',  detail: 'descending sort',       type: 'property' },
  ],
  default: [
    { label: 'bool: true',        apply: 'bool: true',        detail: 'boolean default',   type: 'property' },
    { label: 'bool: false',       apply: 'bool: false',       detail: 'boolean default',   type: 'property' },
    { label: 'int: 0',            apply: 'int: 0',            detail: 'integer default',   type: 'property' },
    { label: 'float: 0.0',        apply: 'float: 0.0',        detail: 'float default',     type: 'property' },
    { label: 'float32: 0.0',      apply: 'float32: 0.0',      detail: 'float32 default',   type: 'property' },
    { label: 'float64: 0.0',      apply: 'float64: 0.0',      detail: 'float64 default',   type: 'property' },
    { label: 'string: ""',        apply: 'string: ""',        detail: 'string default',    type: 'property' },
    { label: 'dateTime: UTC_NOW', apply: 'dateTime: UTC_NOW', detail: 'current UTC time',  type: 'property' },
    { label: 'dateTime: ""',      apply: 'dateTime: ""',      detail: 'ISO 8601 datetime', type: 'property' },
    { label: 'json: "{}"',        apply: 'json: "{}"',        detail: 'JSON default',      type: 'property' },
    { label: 'blob: ""',          apply: 'blob: ""',          detail: 'hex string',        type: 'property' },
  ],
  relation: [
    { label: 'name: ""', apply: 'name: ""', detail: 'relation name', type: 'property' },
  ],
  crdt: [
    { label: 'type: lww',       apply: 'type: lww',       detail: 'last-write-wins',          type: 'property' },
    { label: 'type: pcounter',  apply: 'type: pcounter',  detail: 'positive counter',          type: 'property' },
    { label: 'type: pncounter', apply: 'type: pncounter', detail: 'positive/negative counter', type: 'property' },
  ],
  policy: [
    { label: 'id: ""',       apply: 'id: ""',       detail: 'policy id',     type: 'property' },
    { label: 'resource: ""', apply: 'resource: ""', detail: 'resource name', type: 'property' },
  ],
  materialized: [
    { label: 'if: true',  apply: 'if: true',  detail: 'cache result', type: 'property' },
    { label: 'if: false', apply: 'if: false', detail: 'always fresh', type: 'property' },
  ],
  branchable: [
    { label: 'if: true',  apply: 'if: true',  detail: 'enable branching',  type: 'property' },
    { label: 'if: false', apply: 'if: false', detail: 'disable branching', type: 'property' },
  ],
  constraints: [
    { label: 'size: 0', apply: 'size: 0', detail: 'max array size', type: 'property' },
  ],
  encryptedIndex: [
    { label: 'type: "equality"', apply: 'type: "equality"', detail: 'searchable encryption type', type: 'property' },
  ],
  embedding: [
    { label: 'provider: ""', apply: 'provider: ""', detail: 'e.g. "ollama", "openAI"',  type: 'property' },
    { label: 'model: ""',    apply: 'model: ""',    detail: 'e.g. "nomic-embed-text"',   type: 'property' },
    { label: 'url: ""',      apply: 'url: ""',      detail: 'provider API endpoint',     type: 'property' },
    { label: 'fields: []',   apply: 'fields: []',   detail: 'field names to embed',      type: 'property' },
    { label: 'template: ""', apply: 'template: ""', detail: 'optional content template', type: 'property' },
  ],
}

const ALL_DIRECTIVE_NAMES: Completion[] = [
  { label: 'index',          detail: 'secondary index',            type: 'keyword', apply: 'index' },
  { label: 'default',        detail: 'field default value',        type: 'keyword', apply: 'default' },
  { label: 'relation',       detail: 'name a relation',            type: 'keyword', apply: 'relation' },
  { label: 'primary',        detail: 'owning side of relation',    type: 'keyword', apply: 'primary' },
  { label: 'crdt',           detail: 'conflict resolution',        type: 'keyword', apply: 'crdt' },
  { label: 'policy',         detail: 'access-control policy',      type: 'keyword', apply: 'policy' },
  { label: 'branchable',     detail: 'enable commit branching',    type: 'keyword', apply: 'branchable' },
  { label: 'materialized',   detail: 'view caching strategy',      type: 'keyword', apply: 'materialized' },
  { label: 'constraints',    detail: 'array size constraint',      type: 'keyword', apply: 'constraints' },
  { label: 'encryptedIndex', detail: 'searchable encryption',      type: 'keyword', apply: 'encryptedIndex' },
  { label: 'embedding',      detail: 'auto-generate vector field', type: 'keyword', apply: 'embedding' },
]

// ── Default arg filter ────────────────────────────────────────────────────────

const TYPE_TO_DEFAULT_PREFIX: Record<string, string[]> = {
  String:   ['string:'],
  Int:      ['int:'],
  Float:    ['float:'],
  Float32:  ['float32:'],
  Float64:  ['float64:'],
  Boolean:  ['bool:'],
  DateTime: ['dateTime:'],
  JSON:     ['json:'],
  Blob:     ['blob:'],
}

function filterDefaultsByType(fieldType: string, all: Completion[]): Completion[] {
  const prefixes = TYPE_TO_DEFAULT_PREFIX[fieldType]
  if (!prefixes) return all
  return all.filter(c => prefixes.some(p => String(c.apply).startsWith(p)))
}

// ── Source ─────────────────────────────────────────────────────────────────────

/**
 * Completion source that handles:
 *   1. Directive names after `@`
 *   2. Directive arguments inside `@name(...)`
 *   3. Scalar + user-defined type names after `:` in field definitions
 *
 * `getAllowed` is called at completion time so mode changes (create ↔ patch)
 * are reflected without rebuilding the editor.
 */
function sdlDirectiveAndTypeSource(
  getTypeNames: () => string[],
  getAllowed: () => Set<string>,
) {
  return (ctx: CompletionContext) => {
    const pos = ctx.pos
    const doc = ctx.state.doc
    const line = doc.lineAt(pos)
    const lineText = doc.sliceString(line.from, pos)

    // 1. After `@` → directives filtered by both allowed set and position context
    const atWord = ctx.matchBefore(/@\w*/)
    if (atWord) {
      const allowed = getAllowed()
      // Type-level directives only valid on `type Name @...` lines
      const TYPE_LEVEL = new Set(['policy', 'branchable', 'materialized'])
      const onTypeLine = /^\s*type\s+\w/.test(lineText)
      const options = ALL_DIRECTIVE_NAMES.filter(d => {
        const name = String(d.apply)
        if (!allowed.has(name)) return false
        if (TYPE_LEVEL.has(name)) return onTypeLine
        return !onTypeLine  // field-level only on field lines
      })
      return { from: atWord.from + 1, options }
    }

    // 2. Inside directive argument list: find last unmatched `(`
    const openIdx = lineText.lastIndexOf('(')
    const closeIdx = lineText.lastIndexOf(')')
    if (openIdx !== -1 && openIdx > closeIdx) {
      const beforeParen = lineText.slice(0, openIdx)
      const dirMatch = beforeParen.match(/@(\w+)\s*$/)
      if (dirMatch) {
        const dirName = dirMatch[1]
        let options = DIRECTIVE_COMPLETIONS[dirName]
        if (options) {
          // For @default, filter to the arg matching the field's declared type
          if (dirName === 'default') {
            const typeMatch = lineText.match(/:\s*\[?(\w+)/)
            if (typeMatch) {
              const fieldType = typeMatch[1]
              const filtered = filterDefaultsByType(fieldType, options)
              if (filtered.length > 0) options = filtered
            }
          }
          const word = ctx.matchBefore(/[\w.:"-]*/)
          return { from: word?.from ?? pos, options }
        }
      }
    }

    // 3. Type position: only after `:` (field type or array type)
    const word = ctx.matchBefore(/\w*/)
    if (!word) return null
    const before = doc.sliceString(line.from, word.from)
    const inTypePos = /:\s*\[?$/.test(before)
    // Never show scalars/types unless cursor is after a `:` — even on explicit trigger
    if (!inTypePos) return null

    return {
      from: word.from,
      options: [
        ...SDL_SCALARS.map(s => ({ label: s, detail: 'scalar', type: 'type' as const, boost: 1 })),
        ...getTypeNames().map(n => ({ label: n, detail: 'type', type: 'type' as const, boost: 0 })),
      ],
    }
  }
}

// ── Field name source (for view SDL editors) ──────────────────────────────────

export function sdlFieldSource(getFields: () => { name: string; typeName: string }[]) {
  return (ctx: CompletionContext) => {
    const fields = getFields()
    if (!fields.length) return null
    const word = ctx.matchBefore(/\w*/)
    if (!word || (word.from === word.to && !ctx.explicit)) return null
    const line = ctx.state.doc.lineAt(ctx.pos)
    const before = ctx.state.doc.sliceString(line.from, word.from)
    if (!/^\s*$/.test(before) && !ctx.explicit) return null
    return {
      from: word.from,
      options: fields.map(f => ({
        label: f.name, detail: f.typeName, apply: `${f.name}: ${f.typeName}`, type: 'property' as const,
      })),
    }
  }
}

// ── Extension factories ───────────────────────────────────────────────────────

/** Single autocompletion extension with a dynamic allowed-directive getter. */
export function makeSdlCompletion(
  getTypeNames: () => string[],
  getAllowed: () => Set<string> = () => DIRECTIVES_CREATE,
) {
  return autocompletion({
    override: [sdlDirectiveAndTypeSource(getTypeNames, getAllowed)],
  })
}

/** Raw source for combining with additional override sources. */
export function sdlDirectiveAndTypeCompletionSource(
  getTypeNames: () => string[],
  getAllowed: () => Set<string> = () => DIRECTIVES_VIEW,
) {
  return sdlDirectiveAndTypeSource(getTypeNames, getAllowed)
}
