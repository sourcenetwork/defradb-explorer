import { ViewPlugin, Decoration, type DecorationSet, EditorView } from '@codemirror/view'
import { RangeSetBuilder, Prec, type EditorState } from '@codemirror/state'
import { syntaxTree } from '@codemirror/language'

// Shared color palette — single source of truth for editor syntax colors.
export const COLOR_FIELD   = '#a6e3a1'  // field names (SDL definitions, GQL sub-selections)
export const COLOR_TYPE    = '#10CBFF'  // type refs, root operation names
export const COLOR_KEYWORD = '#c792ea'  // keywords, directives, variables

// ── Shared ViewPlugin factory ─────────────────────────────────────────────────

type BuildFn = (view: EditorView) => DecorationSet

function makeDecoPlugin(build: BuildFn) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      constructor(view: EditorView) { this.decorations = build(view) }
      update(u: { docChanged: boolean; viewportChanged: boolean; view: EditorView; startState: EditorState }) {
        if (u.docChanged || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.view.state)) {
          this.decorations = build(u.view)
        }
      }
    },
    { decorations: v => v.decorations },
  )
}

// ── SDL: field name decorator ─────────────────────────────────────────────────
// In SDL type definitions, both field names and type refs are `Name` nodes
// (tags.atom → cyan). We walk FieldDefinition/InputValueDefinition nodes and
// color their first Name child (the field name) green.

const sdlFieldTheme = EditorView.baseTheme({
  '.cm-sdl-field-name': { color: `${COLOR_FIELD} !important` },
})

const sdlFieldDeco = Decoration.mark({ class: 'cm-sdl-field-name' })

function buildSdlFields(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  const tree = syntaxTree(view.state)

  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from, to,
      enter(node) {
        if (node.name !== 'FieldDefinition' && node.name !== 'InputValueDefinition') return
        // Scan direct children for the first Name (field name).
        // Description may precede it, NamedType follows it — stop there.
        let child = node.node.firstChild
        while (child) {
          if (child.name === 'Name') {
            builder.add(child.from, child.to, sdlFieldDeco)
            break
          }
          if (child.name === 'NamedType' || child.name === 'ListType' || child.name === 'NonNullType') break
          child = child.nextSibling
        }
      },
    })
  }

  return builder.finish()
}

/** Add to an SDL editor's extensions to color field names green. */
export function sdlFieldNameHighlighter() {
  return [sdlFieldTheme, Prec.highest(makeDecoPlugin(buildSdlFields))]
}

// ── GQL query: root-field decorator ──────────────────────────────────────────
// FieldName nodes are tags.propertyName (green) for both root operation fields
// (Post, add_Author) and nested selections (_docID, name). We walk the tree and
// color the root-level ones cyan.
// Ancestry: FieldName → Field → Selection → SelectionSet → OperationDefinition

const gqlRootFieldTheme = EditorView.baseTheme({
  '.cm-gql-root-field': { color: `${COLOR_TYPE} !important` },
})

const gqlRootFieldDeco = Decoration.mark({ class: 'cm-gql-root-field' })

function buildGqlRootFields(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  const tree = syntaxTree(view.state)

  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from, to,
      enter(node) {
        if (node.name !== 'FieldName') return
        const opDef = node.node.parent?.parent?.parent?.parent
        if (opDef?.name === 'OperationDefinition') {
          builder.add(node.from, node.to, gqlRootFieldDeco)
        }
      },
    })
  }

  return builder.finish()
}

/** Add to a GraphQL query editor's extensions to color root operation fields cyan. */
export function gqlRootFieldHighlighter() {
  return [gqlRootFieldTheme, Prec.highest(makeDecoPlugin(buildGqlRootFields))]
}
