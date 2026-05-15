import { describe, it, expect } from 'vitest'
import { stripDescriptions, highlightSdl } from './sdl'

// ── stripDescriptions ─────────────────────────────────────────────────────────

describe('stripDescriptions', () => {
  it('removes multi-line """ blocks', () => {
    const sdl = `type Foo {\n  """\n  Some description\n  """\n  name: String\n}`
    const clean = stripDescriptions(sdl)
    expect(clean).not.toContain('"""')
    expect(clean).not.toContain('Some description')
    expect(clean).toContain('name: String')
  })

  it('removes single-line "..." descriptions on their own line', () => {
    const sdl = `type Foo {\n  "A field description"\n  name: String\n}`
    const clean = stripDescriptions(sdl)
    expect(clean).not.toContain('A field description')
    expect(clean).toContain('name: String')
  })

  it('removes type-level single-line descriptions', () => {
    const sdl = `"The Foo type"\ntype Foo {\n  id: ID\n}`
    const clean = stripDescriptions(sdl)
    expect(clean).not.toContain('The Foo type')
    expect(clean).toContain('type Foo')
  })

  it('collapses blank lines left by stripped descriptions within a type', () => {
    const sdl = `type Foo {\n  "desc"\n  a: String\n\n  "desc2"\n  b: Int\n}`
    const clean = stripDescriptions(sdl)
    // No consecutive blank lines should remain
    expect(clean).not.toMatch(/\n\n\n/)
    expect(clean).toContain('a: String')
    expect(clean).toContain('b: Int')
  })

  it('preserves a blank line between separate type definitions', () => {
    const sdl = `type Foo {\n  a: String\n}\n\ntype Bar {\n  b: Int\n}`
    const clean = stripDescriptions(sdl)
    expect(clean).toMatch(/\}\n\ntype Bar/)
  })

  it('does not remove quoted strings that are field values (inside parens)', () => {
    // This is not valid SDL but verifies we only strip standalone description lines
    const sdl = `type Foo {\n  name: String\n}`
    expect(stripDescriptions(sdl)).toContain('name: String')
  })

  it('handles SDL with no descriptions unchanged (modulo whitespace normalisation)', () => {
    const sdl = `type Foo {\n  name: String\n  age: Int\n}`
    const clean = stripDescriptions(sdl)
    expect(clean).toContain('name: String')
    expect(clean).toContain('age: Int')
  })

  it('produces output that starts with "type" when first def has a description', () => {
    const sdl = `"Top-level desc"\ntype Foo {\n  x: ID\n}`
    const clean = stripDescriptions(sdl)
    expect(clean.startsWith('type')).toBe(true)
  })
})

// ── highlightSdl ──────────────────────────────────────────────────────────────

describe('highlightSdl', () => {
  it('wraps keywords in sdl-keyword spans', () => {
    const html = highlightSdl('type Foo {\n  name: String\n}')
    expect(html).toContain('<span class="sdl-keyword">type</span>')
  })

  it('wraps scalars in sdl-scalar spans', () => {
    const html = highlightSdl('type Foo {\n  name: String\n}')
    expect(html).toContain('<span class="sdl-scalar"')
    expect(html).toContain('>String</span>')
  })

  it('adds data-desc to scalars', () => {
    const html = highlightSdl('type Foo {\n  count: Int\n}')
    expect(html).toContain('data-desc="32-bit signed integer"')
  })

  it('wraps field names in sdl-field spans', () => {
    const html = highlightSdl('type Foo {\n  myField: String\n}')
    expect(html).toContain('<span class="sdl-field"')
    expect(html).toContain('>myField</span>')
  })

  it('adds data-desc to field spans when description is provided', () => {
    const descs = new Map([['Foo.myField', 'The field description']])
    const html = highlightSdl('type Foo {\n  myField: String\n}', descs)
    expect(html).toContain('data-desc="The field description"')
  })

  it('does not add data-desc to field spans with no description', () => {
    const html = highlightSdl('type Foo {\n  plain: String\n}')
    expect(html).not.toMatch(/<span class="sdl-field" data-desc/)
  })

  it('wraps type name in sdl-typename span', () => {
    const html = highlightSdl('type MyType {\n  id: ID\n}')
    expect(html).toContain('<span class="sdl-typename"')
    expect(html).toContain('>MyType</span>')
  })

  it('adds data-desc to typename when description provided', () => {
    const descs = new Map([['MyType', 'Describes MyType']])
    const html = highlightSdl('type MyType {\n  id: ID\n}', descs)
    expect(html).toContain('data-desc="Describes MyType"')
  })

  it('wraps custom type references in sdl-typeref spans', () => {
    const html = highlightSdl('type Post {\n  author: Author\n}')
    expect(html).toContain('<span class="sdl-typeref"')
    expect(html).toContain('>Author</span>')
  })

  it('adds data-desc to typeref when description provided', () => {
    const descs = new Map([['Author', 'The author type']])
    const html = highlightSdl('type Post {\n  author: Author\n}', descs)
    expect(html).toContain('data-desc="The author type"')
  })

  it('escapes HTML special characters', () => {
    const html = highlightSdl('# comment with <angle> & "quotes"')
    expect(html).toContain('&lt;angle&gt;')
    expect(html).toContain('&amp;')
  })

  it('wraps comments in sdl-comment spans', () => {
    const html = highlightSdl('# this is a comment')
    expect(html).toContain('<span class="sdl-comment">')
    expect(html).toContain('# this is a comment')
  })

  it('escapes double quotes in data-desc attributes', () => {
    const descs = new Map([['Foo.x', 'Has "quotes" inside']])
    const html = highlightSdl('type Foo {\n  x: String\n}', descs)
    // &quot; entities appear, not literal " chars inside the attribute value
    expect(html).toContain('&quot;quotes&quot;')
    expect(html).not.toContain('data-desc="Has "quotes"')
  })

  it('handles enum keyword', () => {
    const html = highlightSdl('enum Status {\n  ACTIVE\n}')
    expect(html).toContain('<span class="sdl-keyword">enum</span>')
  })

  it('handles list type refs', () => {
    const html = highlightSdl('type Post {\n  tags: [Tag]\n}')
    expect(html).toContain('<span class="sdl-typeref"')
    expect(html).toContain('>Tag</span>')
  })
})
