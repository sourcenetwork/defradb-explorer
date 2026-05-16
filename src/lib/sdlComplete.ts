import { autocompletion, type CompletionContext, type Completion } from '@codemirror/autocomplete'

// ── Constants ─────────────────────────────────────────────────────────────────

export const SDL_SCALARS = [
  'String', 'Int', 'Float', 'Float32', 'Float64', 'Boolean', 'ID', 'DateTime', 'Blob', 'JSON',
]

const DIRECTIVE_COMPLETIONS: Record<string, Completion[]> = {
  index: [
    { label: 'unique: true',  apply: 'unique: true',  detail: 'unique index',       type: 'property' },
    { label: 'unique: false', apply: 'unique: false', detail: 'non-unique (default)', type: 'property' },
  ],
  default: [
    { label: 'bool: true',   apply: 'bool: true',   detail: 'boolean default',  type: 'property' },
    { label: 'bool: false',  apply: 'bool: false',  detail: 'boolean default',  type: 'property' },
    { label: 'int: 0',       apply: 'int: 0',       detail: 'integer default',  type: 'property' },
    { label: 'float: 0.0',   apply: 'float: 0.0',   detail: 'float default',    type: 'property' },
    { label: 'string: ""',   apply: 'string: ""',   detail: 'string default',   type: 'property' },
  ],
  relation: [
    { label: 'name: ""', apply: 'name: ""', detail: 'relation name', type: 'property' },
  ],
  crdt: [
    { label: 'type: lww',      apply: 'type: lww',      detail: 'last-write-wins',         type: 'property' },
    { label: 'type: pcounter', apply: 'type: pcounter', detail: 'positive counter',         type: 'property' },
    { label: 'type: pncounter',apply: 'type: pncounter',detail: 'positive/negative counter',type: 'property' },
  ],
  policy: [
    { label: 'id: ""',         apply: 'id: ""',         detail: 'policy id',       type: 'property' },
    { label: 'resource: ""',   apply: 'resource: ""',   detail: 'resource name',   type: 'property' },
  ],
  materialized: [
    { label: 'if: true',  apply: 'if: true',  detail: 'cache result', type: 'property' },
    { label: 'if: false', apply: 'if: false', detail: 'always fresh', type: 'property' },
  ],
}

const DIRECTIVE_NAMES: Completion[] = [
  { label: 'index',        detail: 'secondary index',        type: 'keyword', apply: 'index' },
  { label: 'default',      detail: 'field default value',    type: 'keyword', apply: 'default' },
  { label: 'relation',     detail: 'name a relation',        type: 'keyword', apply: 'relation' },
  { label: 'primary',      detail: 'owning side of relation',type: 'keyword', apply: 'primary' },
  { label: 'crdt',         detail: 'conflict resolution',    type: 'keyword', apply: 'crdt' },
  { label: 'policy',       detail: 'access-control policy',  type: 'keyword', apply: 'policy' },
  { label: 'branchable',   detail: 'enable commit branching',type: 'keyword', apply: 'branchable' },
  { label: 'materialized', detail: 'view caching strategy',  type: 'keyword', apply: 'materialized' },
]

// ── Source ─────────────────────────────────────────────────────────────────────

/**
 * Completion source that handles:
 *   1. Directive names after `@`
 *   2. Directive arguments inside `@name(...)`
 *   3. Scalar + user-defined type names after `:` in field definitions
 */
function sdlDirectiveAndTypeSource(getTypeNames: () => string[]) {
  return (ctx: CompletionContext) => {
    const pos = ctx.pos
    const doc = ctx.state.doc
    const line = doc.lineAt(pos)
    const lineText = doc.sliceString(line.from, pos)

    // 1. After `@` → directive names
    const atWord = ctx.matchBefore(/@\w*/)
    if (atWord) {
      return { from: atWord.from + 1, options: DIRECTIVE_NAMES }
    }

    // 2. Inside directive argument list: find last unmatched `(`
    const openIdx = lineText.lastIndexOf('(')
    const closeIdx = lineText.lastIndexOf(')')
    if (openIdx !== -1 && openIdx > closeIdx) {
      const beforeParen = lineText.slice(0, openIdx)
      const dirMatch = beforeParen.match(/@(\w+)\s*$/)
      if (dirMatch) {
        const dirName = dirMatch[1]
        const options = DIRECTIVE_COMPLETIONS[dirName]
        if (options) {
          // Find start of current token (could be part of `unique`, `int`, etc.)
          const word = ctx.matchBefore(/[\w.:"-]*/)
          return { from: word?.from ?? pos, options }
        }
      }
    }

    // 3. Type position: after `:` (field type or array type)
    const word = ctx.matchBefore(/\w*/)
    if (!word) return null
    const before = doc.sliceString(line.from, word.from)
    const inTypePos = /:\s*\[?$/.test(before)
    if (!inTypePos && !ctx.explicit && word.from === word.to) return null
    // Only trigger on upper-case start or explicit; lower-case is probably a field name
    if (!inTypePos && !ctx.explicit && word.text && /^[a-z]/.test(word.text)) return null

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

// ── Extension factory ─────────────────────────────────────────────────────────

/** Single autocompletion extension — directive names, directive args, and scalar/type names. */
export function makeSdlCompletion(getTypeNames: () => string[]) {
  return autocompletion({
    override: [sdlDirectiveAndTypeSource(getTypeNames)],
  })
}

/**
 * Raw source — use this when you need to combine with additional override sources
 * in a single `autocompletion({ override: [...] })` call.
 */
export function sdlDirectiveAndTypeCompletionSource(getTypeNames: () => string[]) {
  return sdlDirectiveAndTypeSource(getTypeNames)
}
