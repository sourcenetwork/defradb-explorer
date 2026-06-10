import {
  parse, print, visit, visitWithTypeInfo, TypeInfo, getNamedType, Kind,
  isEnumType, isInputObjectType, isListType, isNonNullType, isObjectType, isScalarType,
} from 'graphql'
import type { DocumentNode, GraphQLObjectType, GraphQLSchema, GraphQLType, FieldNode, SelectionSetNode, OperationDefinitionNode, ArgumentNode, ValueNode, ObjectValueNode } from 'graphql'

// ── Parse cache ───────────────────────────────────────────────────────────────
// parse() is pure/deterministic and expensive. Cache the last result so multiple
// functions processing the same query string in one render cycle share the work.
let _parseCacheKey = ''
let _parseCacheDoc: DocumentNode | null = null

function parseCached(query: string): DocumentNode {
  const key = query || '{ __typename }'
  if (key === _parseCacheKey && _parseCacheDoc !== null) return _parseCacheDoc
  const doc = parse(key) // throws on invalid query — callers must catch
  _parseCacheKey = key
  _parseCacheDoc = doc
  return doc
}

// Field names that DefraDB exposes as aggregates — they must not be included in default sub-selections
const AGGREGATE_FIELD_NAMES = new Set(['AVG', 'COUNT', 'MAX', 'MIN', 'SUM', 'SIMILARITY', 'GROUP'])

export function typeIsList(t: GraphQLType): boolean {
  if (isListType(t)) return true
  if (isNonNullType(t)) return typeIsList(t.ofType as GraphQLType)
  return false
}

export type ActiveObjectInfo = {
  typeName: string
  objectStart: number
  operationName?: string
  opKind?: 'query' | 'mutation' | 'subscription'
}

/** Arg names currently present on a root field in the query. */
export function getArgsForRootField(query: string, rootFieldName: string): Set<string> {
  try {
    const doc = parse(query)
    for (const def of doc.definitions) {
      if (def.kind !== Kind.OPERATION_DEFINITION) continue
      for (const sel of def.selectionSet.selections) {
        if (sel.kind !== Kind.FIELD) continue
        if (sel.name.value !== rootFieldName) continue
        return new Set((sel.arguments ?? []).map(a => a.name.value))
      }
    }
  } catch { /* ignore */ }
  return new Set()
}

function argDefaultValue(argName: string, typeName: string, isList = false): ValueNode {
  if (isList) return { kind: Kind.LIST, values: [] }
  if (argName === 'limit')  return { kind: Kind.INT, value: '10' }
  if (argName === 'offset') return { kind: Kind.INT, value: '0' }
  switch (typeName) {
    case 'Int':      return { kind: Kind.INT,     value: '0' }
    case 'Float':    return { kind: Kind.FLOAT,   value: '0.0' }
    case 'Boolean':  return { kind: Kind.BOOLEAN, value: false }
    case 'String':   return { kind: Kind.STRING,  value: '' }
    case 'ID':       return { kind: Kind.STRING,  value: '' }
    case 'DateTime': return { kind: Kind.STRING,  value: '' }
    default:         return { kind: Kind.OBJECT,  fields: [] }  // empty {} for input types
  }
}

// Serialize a ValueNode back to a short inline string (for new arg defaults only).
function printArgValue(value: ValueNode): string {
  switch (value.kind) {
    case Kind.INT:      return value.value
    case Kind.FLOAT:    return value.value
    case Kind.STRING:   return JSON.stringify(value.value)
    case Kind.BOOLEAN:  return String(value.value)
    case Kind.NULL:     return 'null'
    case Kind.ENUM:     return value.value
    case Kind.VARIABLE: return `$${value.name.value}`
    case Kind.LIST:     return `[${value.values.map(printArgValue).join(', ')}]`
    case Kind.OBJECT:
      return value.fields.length === 0
        ? '{}'
        : `{${value.fields.map(f => `${f.name.value}: ${printArgValue(f.value)}`).join(', ')}}`
    default: return ''
  }
}

/**
 * Toggle an argument on/off for a root field in the query.
 * Uses targeted string splicing so surrounding query formatting is preserved.
 */
export function toggleArgInQuery(
  query: string,
  rootFieldName: string,
  argName: string,
  argTypeName: string,
  isList = false,
): string {
  try {
    const doc = parseCached(query)
    let result = query

    visit(doc, {
      Field(node: FieldNode) {
        if (node.name.value !== rootFieldName || !node.name.loc || !node.loc) return

        const existing  = (node.arguments ?? []) as ArgumentNode[]
        const targetArg = existing.find(a => a.name.value === argName)
        const argIdx    = targetArg ? existing.indexOf(targetArg) : -1

        if (targetArg && targetArg.loc) {
          // ── REMOVE ──────────────────────────────────────────────────────────
          const argLoc = targetArg.loc
          if (existing.length === 1) {
            // Last arg — delete the whole (…) wrapper
            const open  = query.lastIndexOf('(', argLoc.start)
            const close = query.indexOf(')',  argLoc.end)
            if (open >= 0 && close >= 0) result = query.slice(0, open) + query.slice(close + 1)
          } else if (argIdx === 0) {
            // First of several — remove from arg start to start of next arg
            result = query.slice(0, argLoc.start) + query.slice(existing[1].loc!.start)
          } else {
            // Non-first — remove from end of previous arg to end of this arg
            // (avoids lastIndexOf which can hit commas inside list/object values)
            result = query.slice(0, existing[argIdx - 1].loc!.end) + query.slice(argLoc.end)
          }
        } else {
          // ── ADD ─────────────────────────────────────────────────────────────
          const nameEnd = node.name.loc.end
          const ssStart = node.selectionSet?.loc?.start ?? node.loc.end
          const mid     = query.slice(nameEnd, ssStart)   // e.g. "(limit: 10) " or " "
          const newArgText = `${argName}: ${printArgValue(argDefaultValue(argName, argTypeName, isList))}`

          if (mid.trimStart().startsWith('(')) {
            // Existing args — insert before closing )
            const closeIdx = mid.lastIndexOf(')')
            const insertAt = nameEnd + closeIdx
            // Guard against trailing comma from manual editing (e.g. "filter: {} , )")
            const beforeInsert = query.slice(0, insertAt).trimEnd()
            const sep = beforeInsert.endsWith(',') ? ' ' : ', '
            result = query.slice(0, insertAt) + sep + newArgText + query.slice(insertAt)
          } else {
            // No args yet — wrap in ()
            result = query.slice(0, nameEnd) + `(${newArgText})` + query.slice(nameEnd)
          }
        }
      },
    })

    return result
  } catch {
    return query
  }
}

/** Field names currently selected for a given type anywhere in the query. */
export function getSelectedFieldsForType(
  query: string,
  typeName: string,
  schema: GraphQLSchema,
  scopeToFieldName?: string,
): Set<string> {
  try {
    const doc = parse(query)
    const typeInfo = new TypeInfo(schema)
    const selected = new Set<string>()

    visit(doc, visitWithTypeInfo(typeInfo, {
      Field: {
        enter(node: FieldNode) {
          if (!node.selectionSet) return
          const type = typeInfo.getType()
          if (!type) return
          if (getNamedType(type as GraphQLType).name !== typeName) return
          if (scopeToFieldName && node.name.value !== scopeToFieldName) return
          for (const inner of node.selectionSet.selections) {
            if (inner.kind === Kind.FIELD) selected.add(inner.name.value)
          }
        },
      },
    }))

    return selected
  } catch {
    return new Set()
  }
}

/** True if the query contains at least one selection that resolves to typeName. */
export function isTypeInQuery(query: string, typeName: string, schema: GraphQLSchema): boolean {
  try {
    const doc = parse(query)
    const rootFields = {
      ...schema.getQueryType()?.getFields(),
      ...schema.getMutationType()?.getFields(),
    }
    for (const def of doc.definitions) {
      if (def.kind !== Kind.OPERATION_DEFINITION) continue
      for (const sel of def.selectionSet.selections) {
        if (sel.kind !== Kind.FIELD) continue
        const fieldDef = rootFields[sel.name.value]
        if (!fieldDef) continue
        if (getNamedType(fieldDef.type).name === typeName) return true
      }
    }
    return false
  } catch {
    return false
  }
}

function makeField(name: string): FieldNode {
  return { kind: Kind.FIELD, name: { kind: Kind.NAME, value: name } }
}

function makeSelectionSet(fields: FieldNode[]): SelectionSetNode {
  return { kind: Kind.SELECTION_SET, selections: fields }
}

// Extract the indents used inside a selection-set slice (e.g. "{\n    _docID\n  }")
function selectionSetIndents(ssSlice: string): { fieldIndent: string; closeIndent: string } {
  const fieldMatch = ssSlice.match(/\{\n(\s+)/)
  const closeMatch = ssSlice.match(/\n(\s*)\}$/)
  return {
    fieldIndent: fieldMatch ? fieldMatch[1] : '    ',
    closeIndent: closeMatch ? closeMatch[1] : '  ',
  }
}

/** Build the default sub-selection for an object type (scalar fields only, excluding aggregates). */
function buildDefaultSubSelection(type: GraphQLObjectType, indent: string): string {
  const scalars = Object.values(type.getFields()).filter(f => {
    const n = getNamedType(f.type as GraphQLType)
    return isScalarType(n) && !AGGREGATE_FIELD_NAMES.has(f.name) &&
      (f.name === '_docID' || !f.name.startsWith('_'))
  })
  return scalars.length
    ? scalars.map(f => `${indent}${f.name}`).join('\n')
    : `${indent}_docID`
}

/**
 * Toggle a field on/off for the given type.
 * Uses targeted string splicing (add or remove only the toggled field) so that
 * existing sub-selections on other fields are never disturbed.
 * When adding an object-type field, inserts it with a default sub-selection.
 * Falls back to print() only when a brand-new root field needs to be inserted.
 */
export function toggleFieldInQuery(
  query: string,
  typeName: string,
  fieldName: string,
  schema: GraphQLSchema,
  scopeToFieldName?: string,
): string {
  const selected = getSelectedFieldsForType(query, typeName, schema, scopeToFieldName)
  const adding   = !selected.has(fieldName)

  const rootQueryFields = schema.getQueryType()?.getFields() ?? {}

  const rootFieldName = scopeToFieldName ?? Object.keys(rootQueryFields).find(k =>
    getNamedType(rootQueryFields[k].type).name === typeName
  ) ?? null

  try {
    const doc = parseCached(query)
    const typeInfoForToggle = new TypeInfo(schema)
    let targetNode: FieldNode | null = null

    // Use TypeInfo so we can find the right selection set at any nesting depth
    visit(doc, visitWithTypeInfo(typeInfoForToggle, {
      Field: {
        enter(node: FieldNode) {
          if (targetNode || !node.selectionSet || !node.loc) return
          const type = typeInfoForToggle.getType()
          if (!type) return
          if (getNamedType(type as GraphQLType).name !== typeName) return
          if (scopeToFieldName && node.name.value !== scopeToFieldName) return
          targetNode = node
        },
      },
    }))

    if (targetNode) {
      const ss    = (targetNode as FieldNode).selectionSet!
      const ssLoc = ss.loc!
      const ssSlice = query.slice(ssLoc.start, ssLoc.end)
      const { fieldIndent, closeIndent } = selectionSetIndents(ssSlice)

      if (!adding) {
        // REMOVAL: splice out only the toggled field's line(s)
        const fieldNode = ss.selections.find(
          (s): s is FieldNode => s.kind === Kind.FIELD && s.name.value === fieldName,
        )
        if (!fieldNode?.loc) return query

        const nonTypename = ss.selections.filter(
          (s): s is FieldNode => s.kind === Kind.FIELD && s.name.value !== '__typename',
        )
        if (nonTypename.length <= 1) {
          // Last real field — replace entire SS with __typename placeholder
          return query.slice(0, ssLoc.start) +
            `{\n${fieldIndent}__typename\n${closeIndent}}` +
            query.slice(ssLoc.end)
        }

        const lineStart = query.lastIndexOf('\n', fieldNode.loc.start - 1) + 1
        const lineEnd   = query.indexOf('\n', fieldNode.loc.end)
        return lineEnd >= 0
          ? query.slice(0, lineStart) + query.slice(lineEnd + 1)
          : query.slice(0, lineStart - 1) + query.slice(fieldNode.loc.end)

      } else {
        // ADDITION: determine field text (with sub-selection for object types)
        const parentSchemaType = schema.getType(typeName)
        const fDef = isObjectType(parentSchemaType)
          ? (parentSchemaType as GraphQLObjectType).getFields()[fieldName]
          : null
        const namedType   = fDef ? getNamedType(fDef.type as GraphQLType) : null
        const isComplex   = namedType ? isObjectType(schema.getType(namedType.name)) : false

        let fieldText: string
        if (isComplex && namedType) {
          const objType  = schema.getType(namedType.name) as GraphQLObjectType
          const subIndent = fieldIndent + '  '
          fieldText = `${fieldName} {\n${buildDefaultSubSelection(objType, subIndent)}\n${fieldIndent}}`
        } else {
          fieldText = fieldName
        }

        // If only __typename remains, replace entire SS
        const hasReal = ss.selections.some(
          (s): s is FieldNode => s.kind === Kind.FIELD && s.name.value !== '__typename',
        )
        if (!hasReal) {
          return query.slice(0, ssLoc.start) +
            `{\n${fieldIndent}${fieldText}\n${closeIndent}}` +
            query.slice(ssLoc.end)
        }

        const closeBrace       = ssLoc.end - 1
        const lastNlBeforeClose = query.lastIndexOf('\n', closeBrace - 1)
        return query.slice(0, lastNlBeforeClose) +
          `\n${fieldIndent}${fieldText}` +
          query.slice(lastNlBeforeClose)
      }
    }

    // Type not yet in query — insert a new root field (print() is fine here, nothing to preserve)
    if (!targetNode && adding && rootFieldName) {
      const hasLimitArg = !!rootQueryFields[rootFieldName]?.args.find(a => a.name === 'limit')
      // Determine if the field being added is a complex type
      const pt      = schema.getType(typeName)
      const fd      = isObjectType(pt) ? (pt as GraphQLObjectType).getFields()[fieldName] : null
      const nt      = fd ? getNamedType(fd.type as GraphQLType) : null
      const ntType  = nt ? schema.getType(nt.name) : null
      const initSel = (nt && isObjectType(ntType))
        ? makeSelectionSet([{
            kind: Kind.FIELD,
            name: { kind: Kind.NAME, value: fieldName },
            selectionSet: makeSelectionSet([makeField('_docID')]),
          }])
        : makeSelectionSet([makeField(fieldName)])

      const newDoc = visit(doc, {
        OperationDefinition: {
          leave(node: OperationDefinitionNode) {
            if (node.operation !== 'query' && node.operation !== undefined) return
            const newField: FieldNode = {
              kind: Kind.FIELD,
              name: { kind: Kind.NAME, value: rootFieldName },
              arguments: hasLimitArg ? [{
                kind: Kind.ARGUMENT,
                name: { kind: Kind.NAME, value: 'limit' },
                value: { kind: Kind.INT, value: '10' },
              }] : [],
              selectionSet: initSel,
            }
            return {
              ...node,
              selectionSet: {
                ...node.selectionSet,
                selections: [...node.selectionSet.selections, newField],
              },
            }
          },
        },
      })
      return print(newDoc)
    }

    return query
  } catch {
    return query
  }
}

/** Field names currently present inside any ObjectValue of the given input type (at any depth). */
export function getInputObjectFieldsInQuery(
  query: string,
  inputTypeName: string,
  schema: GraphQLSchema,
): Set<string> {
  try {
    const doc = parse(query)
    const typeInfo = new TypeInfo(schema)
    const found = new Set<string>()
    visit(doc, visitWithTypeInfo(typeInfo, {
      ObjectValue(node) {
        const t = typeInfo.getInputType()
        if (t && getNamedType(t).name === inputTypeName) {
          node.fields.forEach(f => found.add(f.name.value))
        }
      },
    }))
    return found
  } catch {
    return new Set()
  }
}

// ── Shared toggle logic ───────────────────────────────────────────────────────

function applyObjectValueToggle(
  query: string,
  node: ObjectValueNode & { loc: NonNullable<ObjectValueNode['loc']> },
  inputTypeName: string,
  fieldName: string,
  schema: GraphQLSchema,
  fieldTypeFallback = '',
): string {
  const existing = node.fields.find(f => f.name.value === fieldName)

  if (existing?.loc) {
    // REMOVE — inline vs multiline
    const isInlineField = query.lastIndexOf('\n', existing.loc.start - 1) < node.loc.start
    if (isInlineField) {
      if (node.fields.length === 1) {
        return query.slice(0, node.loc.start + 1) + query.slice(node.loc.end - 1)
      }
      const idx = node.fields.findIndex(f => f.name.value === fieldName)
      if (idx === 0) {
        return query.slice(0, existing.loc.start) + query.slice(node.fields[1].loc!.start)
      }
      return query.slice(0, node.fields[idx - 1].loc!.end) + query.slice(existing.loc.end)
    } else {
      const lineStart = query.lastIndexOf('\n', existing.loc.start - 1) + 1
      const lineEndNl = query.indexOf('\n', existing.loc.end)
      return lineEndNl >= 0
        ? query.slice(0, lineStart) + query.slice(lineEndNl + 1)
        : query.slice(0, lineStart - 1) + query.slice(existing.loc.end)
    }
  }

  // ADD — derive accurate defaults from schema
  const openBrace  = node.loc.start
  const closeBrace = node.loc.end - 1
  const lastNlBeforeClose = query.lastIndexOf('\n', closeBrace - 1)
  const isInline = lastNlBeforeClose < openBrace

  let fieldIsList = false
  let firstEnumValue: string | null = null
  let derivedTypeName = fieldTypeFallback
  let isCustomScalar  = false
  let listOfInputObject = false
  try {
    const parentDef = schema.getType(inputTypeName)
    if (isInputObjectType(parentDef)) {
      const fDef = parentDef.getFields()[fieldName]
      if (fDef) {
        fieldIsList = typeIsList(fDef.type as GraphQLType)
        const named = getNamedType(fDef.type as GraphQLType)
        derivedTypeName = named.name
        if (fieldIsList) {
          listOfInputObject = isInputObjectType(named)
        } else {
          if (isEnumType(named)) {
            const vals = named.getValues()
            if (vals.length) firstEnumValue = vals[0].name
          } else if (isScalarType(named) && !['Int','Float','Boolean','String','ID'].includes(named.name)) {
            isCustomScalar = true
          }
        }
      }
    }
  } catch {}

  const defaultVal = firstEnumValue !== null
    ? printArgValue({ kind: Kind.ENUM, value: firstEnumValue })
    : isCustomScalar
      ? printArgValue({ kind: Kind.STRING, value: '' })
      : listOfInputObject
        ? '[{}]'
        : printArgValue(argDefaultValue(fieldName, derivedTypeName, fieldIsList))

  if (isInline) {
    const lineNl = query.lastIndexOf('\n', openBrace - 1)
    const lineContent = query.slice(lineNl + 1, openBrace)
    const lineIndent = lineContent.match(/^(\s*)/)?.[1] ?? ''
    const fieldIndent = lineIndent + '  '
    return query.slice(0, openBrace + 1) +
      `\n${fieldIndent}${fieldName}: ${defaultVal}\n${lineIndent}` +
      query.slice(closeBrace)
  } else {
    if (node.fields.length > 0 && node.fields[0].loc) {
      // Has existing fields — append before the closing brace, matching their indent
      const prevNl = query.lastIndexOf('\n', node.fields[0].loc.start - 1)
      const fieldIndent = query.slice(prevNl + 1, node.fields[0].loc.start)
      return query.slice(0, lastNlBeforeClose) +
        `\n${fieldIndent}${fieldName}: ${defaultVal}` +
        query.slice(lastNlBeforeClose)
    } else {
      // Empty multiline ObjectValue — replace interior wholesale so stray blank
      // lines left by the user don't end up above the newly inserted field
      const closeLineNl = query.lastIndexOf('\n', closeBrace - 1)
      const closeIndent = query.slice(closeLineNl + 1, closeBrace)
      const fieldIndent = closeIndent + '  '
      return query.slice(0, openBrace + 1) +
        `\n${fieldIndent}${fieldName}: ${defaultVal}\n${closeIndent}` +
        query.slice(closeBrace)
    }
  }
}

/**
 * Toggle a field on/off inside an ObjectValue of the given input type (at any depth).
 * Uses targeted string splicing to preserve all other formatting.
 */
export function toggleInputObjectField(
  query: string,
  inputTypeName: string,
  fieldName: string,
  fieldTypeName: string,
  schema: GraphQLSchema,
): string {
  try {
    const doc = parse(query)
    const typeInfo = new TypeInfo(schema)
    let result = query
    let handled = false

    visit(doc, visitWithTypeInfo(typeInfo, {
      ObjectValue(node) {
        if (handled) return
        const t = typeInfo.getInputType()
        if (!t || getNamedType(t).name !== inputTypeName || !node.loc) return
        result = applyObjectValueToggle(query, node as ObjectValueNode & { loc: NonNullable<ObjectValueNode['loc']> }, inputTypeName, fieldName, schema, fieldTypeName)
        handled = true
      },
    }))

    return result
  } catch {
    return query
  }
}

// ── Cursor-aware functions ────────────────────────────────────────────────────

// ── Cursor placement after toggle ─────────────────────────────────────────────

function cursorAfterInsert(insertStart: number, inserted: string): number {
  // Position inside "" > {} > [] > after scalar value
  const eoq = inserted.lastIndexOf('""')
  if (eoq !== -1) return insertStart + eoq + 1
  const obj = inserted.lastIndexOf('{}')
  if (obj !== -1) return insertStart + obj + 1
  const lst = inserted.lastIndexOf('[]')
  if (lst !== -1) return insertStart + lst + 1
  // Scalar: find last ': value' and position after the value
  const colonIdx = inserted.lastIndexOf(': ')
  if (colonIdx !== -1) {
    const m = inserted.slice(colonIdx + 2).match(/^-?[\w.]+/)
    if (m) return insertStart + colonIdx + 2 + m[0].length
  }
  return insertStart + inserted.trimEnd().length
}

/**
 * Given the old and new query strings after a toggle, returns the character offset
 * of the best cursor position inside the newly inserted content — or null if
 * the query shrank (removal) or was unchanged.
 */
export function computeCursorAfterToggle(oldQuery: string, newQuery: string): number | null {
  if (newQuery.length <= oldQuery.length) return null
  let i = 0
  while (i < oldQuery.length && oldQuery[i] === newQuery[i]) i++
  const inserted = newQuery.slice(i, i + (newQuery.length - oldQuery.length))
  return cursorAfterInsert(i, inserted)
}

/** Returns the deepest ObjectValue containing the cursor offset, with its schema type and operation context. */
export function getActiveObjectAtOffset(
  query: string,
  cursorOffset: number,
  schema: GraphQLSchema,
): ActiveObjectInfo | null {
  try {
    const doc = parse(query)
    const typeInfo = new TypeInfo(schema)
    let best: ActiveObjectInfo | null = null
    let currentOpKind: 'query' | 'mutation' | 'subscription' = 'query'
    let fieldDepth = 0
    let currentRootField: string | null = null

    visit(doc, visitWithTypeInfo(typeInfo, {
      OperationDefinition: {
        enter(node: OperationDefinitionNode) {
          currentOpKind = node.operation === 'mutation' ? 'mutation' : node.operation === 'subscription' ? 'subscription' : 'query'
          fieldDepth = 0
          currentRootField = null
        },
      },
      Field: {
        enter(node: FieldNode) {
          fieldDepth++
          if (fieldDepth === 1) currentRootField = node.name.value
        },
        leave() {
          if (fieldDepth === 1) currentRootField = null
          fieldDepth--
        },
      },
      ObjectValue: {
        enter(node) {
          if (!node.loc) return
          if (cursorOffset < node.loc.start || cursorOffset > node.loc.end) return
          const t = typeInfo.getInputType()
          if (!t) return
          const named = getNamedType(t)
          if (!isInputObjectType(named)) return
          best = {
            typeName: named.name,
            objectStart: node.loc.start,
            operationName: currentRootField ?? undefined,
            opKind: currentOpKind,
          }
        },
      },
    }))
    return best
  } catch {
    return null
  }
}

/** Field names present in the ObjectValue at the given source offset. */
export function getInputObjectFieldsAtOffset(
  query: string,
  objectStart: number,
): Set<string> {
  try {
    const doc = parse(query)
    const found = new Set<string>()
    visit(doc, {
      ObjectValue(node) {
        if (node.loc?.start === objectStart) {
          node.fields.forEach(f => found.add(f.name.value))
        }
      },
    })
    return found
  } catch {
    return new Set()
  }
}

/** Toggle a field in the specific ObjectValue at objectStart. Derives all defaults from schema. */
export function toggleInputObjectFieldAtOffset(
  query: string,
  objectStart: number,
  fieldName: string,
  schema: GraphQLSchema,
): string {
  try {
    const doc = parse(query)
    const typeInfo = new TypeInfo(schema)
    let result = query
    let handled = false

    visit(doc, visitWithTypeInfo(typeInfo, {
      ObjectValue(node) {
        if (handled || node.loc?.start !== objectStart || !node.loc) return
        const t = typeInfo.getInputType()
        if (!t) return
        const inputTypeName = getNamedType(t).name
        result = applyObjectValueToggle(query, node as ObjectValueNode & { loc: NonNullable<ObjectValueNode['loc']> }, inputTypeName, fieldName, schema)
        handled = true
      },
    }))

    return result
  } catch {
    return query
  }
}

/** Returns the root operation field the cursor is inside (selection set OR args), ignoring ObjectValues handled separately. */
export function getActiveOperationAtOffset(
  query: string,
  cursorOffset: number,
  schema: GraphQLSchema,
): { operationName: string; opKind: 'query' | 'mutation' | 'subscription' } | null {
  try {
    const doc = parse(query)
    const rootQueryFields        = schema.getQueryType()?.getFields()        ?? {}
    const rootMutationFields     = schema.getMutationType()?.getFields()     ?? {}
    const rootSubscriptionFields = schema.getSubscriptionType()?.getFields() ?? {}

    for (const def of doc.definitions) {
      if (def.kind !== Kind.OPERATION_DEFINITION) continue
      const opKind: 'query' | 'mutation' | 'subscription' = def.operation === 'mutation' ? 'mutation' : def.operation === 'subscription' ? 'subscription' : 'query'
      for (const sel of def.selectionSet.selections) {
        if (sel.kind !== Kind.FIELD || !sel.loc) continue
        const fieldName = sel.name.value
        if (!(fieldName in rootQueryFields) && !(fieldName in rootMutationFields) && !(fieldName in rootSubscriptionFields)) continue
        if (cursorOffset >= sel.loc.start && cursorOffset <= sel.loc.end) {
          return { operationName: fieldName, opKind }
        }
      }
    }
    return null
  } catch {
    return null
  }
}

/** Append a new {} item to a list field inside the ObjectValue at parentObjectStart. */
export function addItemToInputList(
  query: string,
  parentObjectStart: number,
  fieldName: string,
): string {
  try {
    const doc = parse(query)
    let result = query
    let handled = false

    visit(doc, {
      ObjectValue(node) {
        if (handled || node.loc?.start !== parentObjectStart) return
        const field = node.fields.find(f => f.name.value === fieldName)
        if (!field?.loc) return
        const listVal = field.value
        if (listVal.kind !== Kind.LIST || !listVal.loc) return

        const listStart = listVal.loc.start
        const listEnd   = listVal.loc.end

        if (listVal.values.length === 0) {
          const nl = query.lastIndexOf('\n', field.loc.start - 1)
          const fieldIndent = nl >= 0 ? query.slice(nl + 1, field.loc.start) : ''
          const itemIndent  = fieldIndent + '  '
          result = query.slice(0, listStart + 1) +
            `\n${itemIndent}{}` +
            `\n${fieldIndent}` +
            query.slice(listEnd - 1)
        } else {
          const lastItem = listVal.values[listVal.values.length - 1]
          if (!lastItem.loc) return
          const isInline = query.lastIndexOf('\n', lastItem.loc.start - 1) < listStart
          if (isInline) {
            result = query.slice(0, lastItem.loc.end) + ', {}' + query.slice(lastItem.loc.end)
          } else {
            const nl = query.lastIndexOf('\n', lastItem.loc.start - 1)
            const itemIndent = nl >= 0 ? query.slice(nl + 1, lastItem.loc.start) : ''
            result = query.slice(0, lastItem.loc.end) +
              `\n${itemIndent}{}` +
              query.slice(lastItem.loc.end)
          }
        }

        handled = true
      },
    })

    return result
  } catch {
    return query
  }
}

/** Returns loc.start for each ObjectValue item inside a list field. */
export function getListItemObjectStarts(
  query: string,
  parentObjectStart: number,
  fieldName: string,
): number[] {
  try {
    const doc = parse(query)
    const starts: number[] = []
    visit(doc, {
      ObjectValue(node) {
        if (node.loc?.start !== parentObjectStart) return
        const field = node.fields.find(f => f.name.value === fieldName)
        if (!field) return
        const listVal = field.value
        if (listVal.kind !== Kind.LIST) return
        for (const item of listVal.values) {
          if (item.kind === Kind.OBJECT && item.loc) starts.push(item.loc.start)
        }
      },
    })
    return starts
  } catch {
    return []
  }
}

/** True if any ObjectValue of the given input type exists in the query. */
function hasInputObjectInQuery(query: string, inputTypeName: string, schema: GraphQLSchema): boolean {
  try {
    const doc = parse(query)
    const typeInfo = new TypeInfo(schema)
    let found = false
    visit(doc, visitWithTypeInfo(typeInfo, {
      ObjectValue() {
        const t = typeInfo.getInputType()
        if (t && getNamedType(t).name === inputTypeName) found = true
      },
    }))
    return found
  } catch { return false }
}

/** Returns true if a root-level field with this name exists anywhere in the query. */
export function isRootFieldInQuery(query: string, fieldName: string): boolean {
  try {
    const doc = parse(query)
    for (const def of doc.definitions) {
      if (def.kind !== Kind.OPERATION_DEFINITION) continue
      for (const sel of def.selectionSet.selections) {
        if (sel.kind === Kind.FIELD && sel.name.value === fieldName) return true
      }
    }
    return false
  } catch { return false }
}

/**
 * Returns true if toggling fields on this input type would do something useful —
 * i.e. the type is already present in the query, or a root operation in the query
 * has an arg that accepts this input type.
 */
export function canToggleInputType(
  query: string,
  inputTypeName: string,
  schema: GraphQLSchema,
): boolean {
  if (hasInputObjectInQuery(query, inputTypeName, schema)) return true
  try {
    const doc = parse(query)
    const rootQueryFields        = schema.getQueryType()?.getFields()        ?? {}
    const rootMutationFields     = schema.getMutationType()?.getFields()     ?? {}
    const rootSubscriptionFields = schema.getSubscriptionType()?.getFields() ?? {}
    for (const def of doc.definitions) {
      if (def.kind !== Kind.OPERATION_DEFINITION) continue
      for (const sel of def.selectionSet.selections) {
        if (sel.kind !== Kind.FIELD) continue
        const rootFieldDef = rootQueryFields[sel.name.value] ?? rootMutationFields[sel.name.value] ?? rootSubscriptionFields[sel.name.value]
        if (rootFieldDef?.args.some(a => getNamedType(a.type).name === inputTypeName)) return true
      }
    }
  } catch {}
  return false
}

/**
 * Toggle a field on an input type, auto-adding the parent arg to the query first if needed.
 * Handles the case where the user navigates to a nested input type before the arg exists.
 */
export function ensureArgAndToggleInputField(
  query: string,
  inputTypeName: string,
  fieldName: string,
  fieldTypeName: string,
  schema: GraphQLSchema,
): string {
  if (hasInputObjectInQuery(query, inputTypeName, schema)) {
    return toggleInputObjectField(query, inputTypeName, fieldName, fieldTypeName, schema)
  }

  // Input type not yet in query — find a root selection that has an arg of this type.
  try {
    const doc = parse(query)
    const rootQueryFields        = schema.getQueryType()?.getFields()        ?? {}
    const rootMutationFields     = schema.getMutationType()?.getFields()     ?? {}
    const rootSubscriptionFields = schema.getSubscriptionType()?.getFields() ?? {}

    for (const def of doc.definitions) {
      if (def.kind !== Kind.OPERATION_DEFINITION) continue
      for (const sel of def.selectionSet.selections) {
        if (sel.kind !== Kind.FIELD) continue
        const rootFieldName = sel.name.value
        const rootFieldDef  = rootQueryFields[rootFieldName] ?? rootMutationFields[rootFieldName] ?? rootSubscriptionFields[rootFieldName]
        if (!rootFieldDef) continue

        const matchingArg = rootFieldDef.args.find(a => getNamedType(a.type).name === inputTypeName)
        if (!matchingArg) continue

        const argIsList = typeIsList(matchingArg.type as GraphQLType)

        // Add the arg scaffold, then add the field inside it
        const withArg = toggleArgInQuery(query, rootFieldName, matchingArg.name, inputTypeName, argIsList)
        return toggleInputObjectField(withArg, inputTypeName, fieldName, fieldTypeName, schema)
      }
    }
  } catch {}

  return query
}

// ── Nested selection helpers ──────────────────────────────────────────────────

/** Arg names active on a nested field, found by parent type (works at any depth). */
export function getArgsForSubField(
  query: string,
  parentTypeName: string,
  fieldName: string,
  schema: GraphQLSchema,
): Set<string> {
  try {
    const doc = parse(query)
    const typeInfo = new TypeInfo(schema)
    const result = new Set<string>()
    visit(doc, visitWithTypeInfo(typeInfo, {
      Field: {
        enter(node: FieldNode) {
          if (node.name.value !== fieldName) return
          const parentType = typeInfo.getParentType()
          if (!parentType || parentType.name !== parentTypeName) return
          for (const a of node.arguments ?? []) result.add(a.name.value)
        },
      },
    }))
    return result
  } catch {
    return new Set()
  }
}

/**
 * Toggle an argument on a nested field, located by parent type name.
 * Uses the same string-splice strategy as toggleArgInQuery to preserve formatting.
 */
export function toggleSubFieldArg(
  query: string,
  parentTypeName: string,
  fieldName: string,
  argName: string,
  argTypeName: string,
  isList = false,
  schema: GraphQLSchema,
): string {
  try {
    const doc = parse(query)
    const typeInfo = new TypeInfo(schema)
    let result = query
    let handled = false

    visit(doc, visitWithTypeInfo(typeInfo, {
      Field: {
        enter(node: FieldNode) {
          if (handled) return
          if (node.name.value !== fieldName || !node.name.loc || !node.loc) return
          const parentType = typeInfo.getParentType()
          if (!parentType || parentType.name !== parentTypeName) return

          handled = true
          const existing  = (node.arguments ?? []) as ArgumentNode[]
          const targetArg = existing.find(a => a.name.value === argName)
          const argIdx    = targetArg ? existing.indexOf(targetArg) : -1

          if (targetArg && targetArg.loc) {
            // ── REMOVE ────────────────────────────────────────────────────────
            const argLoc = targetArg.loc
            if (existing.length === 1) {
              const open  = query.lastIndexOf('(', argLoc.start)
              const close = query.indexOf(')', argLoc.end)
              if (open >= 0 && close >= 0) result = query.slice(0, open) + query.slice(close + 1)
            } else if (argIdx === 0) {
              result = query.slice(0, argLoc.start) + query.slice(existing[1].loc!.start)
            } else {
              result = query.slice(0, existing[argIdx - 1].loc!.end) + query.slice(argLoc.end)
            }
          } else {
            // ── ADD ───────────────────────────────────────────────────────────
            const nameEnd = node.name.loc.end
            const ssStart = node.selectionSet?.loc?.start ?? node.loc.end
            const mid     = query.slice(nameEnd, ssStart)
            const newArgText = `${argName}: ${printArgValue(argDefaultValue(argName, argTypeName, isList))}`

            if (mid.trimStart().startsWith('(')) {
              const closeIdx = mid.lastIndexOf(')')
              const insertAt = nameEnd + closeIdx
              const beforeInsert = query.slice(0, insertAt).trimEnd()
              const sep = beforeInsert.endsWith(',') ? ' ' : ', '
              result = query.slice(0, insertAt) + sep + newArgText + query.slice(insertAt)
            } else {
              result = query.slice(0, nameEnd) + `(${newArgText})` + query.slice(nameEnd)
            }
          }
        },
      },
    }))

    return result
  } catch {
    return query
  }
}

/**
 * Field names selected inside a nested field, found by parent type name (works at any depth).
 * e.g. getSelectedSubFieldsAtPath(q, 'Tag', '_version', schema) → fields inside Tag._version { }
 * e.g. getSelectedSubFieldsAtPath(q, 'Commit', 'heads', schema) → fields inside any Commit.heads { }
 */
export function getSelectedSubFieldsAtPath(
  query: string,
  parentTypeName: string,
  fieldPath: string,
  schema: GraphQLSchema,
): Set<string> {
  try {
    const doc = parse(query)
    const typeInfo = new TypeInfo(schema)
    const result = new Set<string>()

    visit(doc, visitWithTypeInfo(typeInfo, {
      Field: {
        enter(node: FieldNode) {
          if (node.name.value !== fieldPath) return
          const parentType = typeInfo.getParentType()
          if (!parentType || parentType.name !== parentTypeName) return
          if (!node.selectionSet) return
          for (const sel of node.selectionSet.selections) {
            if (sel.kind === Kind.FIELD) result.add(sel.name.value)
          }
        },
      },
    }))

    return result
  } catch {
    return new Set()
  }
}

/**
 * Toggle a sub-field inside a nested selection set, found by parent type name (works at any depth).
 * e.g. toggleSubFieldAtPath(q, 'Tag', '_version', 'cid', schema)
 * e.g. toggleSubFieldAtPath(q, 'Commit', 'heads', 'cid', schema)  — works even for recursive types
 */
export function toggleSubFieldAtPath(
  query: string,
  parentTypeName: string,
  parentFieldName: string,
  subFieldName: string,
  schema: GraphQLSchema,
): string {
  try {
    const doc = parse(query)
    const typeInfo = new TypeInfo(schema)
    let result = query
    let handled = false

    visit(doc, visitWithTypeInfo(typeInfo, {
      Field: {
        enter(node: FieldNode) {
          if (handled) return
          if (node.name.value !== parentFieldName) return
          const parentType = typeInfo.getParentType()
          if (!parentType || parentType.name !== parentTypeName) return
          if (!node.selectionSet?.loc) return

          const ss    = node.selectionSet
          const ssLoc = ss.loc!
          const ssSlice = query.slice(ssLoc.start, ssLoc.end)
          const { fieldIndent, closeIndent } = selectionSetIndents(ssSlice)

          const existing = ss.selections.find(
            (s): s is FieldNode => s.kind === Kind.FIELD && s.name.value === subFieldName,
          )

          if (existing?.loc) {
            // REMOVAL
            const nonTypename = ss.selections.filter(
              (s): s is FieldNode => s.kind === Kind.FIELD && s.name.value !== '__typename',
            )
            if (nonTypename.length <= 1) {
              result = query.slice(0, ssLoc.start) +
                `{\n${fieldIndent}__typename\n${closeIndent}}` +
                query.slice(ssLoc.end)
              handled = true
              return
            }
            const lineStart = query.lastIndexOf('\n', existing.loc.start - 1) + 1
            const lineEnd   = query.indexOf('\n', existing.loc.end)
            result = lineEnd >= 0
              ? query.slice(0, lineStart) + query.slice(lineEnd + 1)
              : query.slice(0, lineStart - 1) + query.slice(existing.loc.end)
            handled = true
          } else {
            // ADDITION — look up sub-field type via the return type of parentFieldName
            const fieldReturnType = typeInfo.getType()   // e.g. [Comment] for 'comment' or '_version'
            const namedReturn     = fieldReturnType ? getNamedType(fieldReturnType as GraphQLType) : null
            const returnTypeObj   = namedReturn ? schema.getType(namedReturn.name) : null
            const subFd = returnTypeObj && isObjectType(returnTypeObj)
              ? (returnTypeObj as GraphQLObjectType).getFields()[subFieldName]
              : null
            const namedSubType = subFd ? getNamedType(subFd.type as GraphQLType) : null
            const subIsComplex = namedSubType ? isObjectType(schema.getType(namedSubType.name)) : false

            let addText: string
            if (subIsComplex && namedSubType) {
              const objType   = schema.getType(namedSubType.name) as GraphQLObjectType
              const subIndent = fieldIndent + '  '
              addText = `${subFieldName} {\n${buildDefaultSubSelection(objType, subIndent)}\n${fieldIndent}}`
            } else {
              addText = subFieldName
            }

            const closeBrace       = ssLoc.end - 1
            const lastNlBeforeClose = query.lastIndexOf('\n', closeBrace - 1)
            result = query.slice(0, lastNlBeforeClose) +
              `\n${fieldIndent}${addText}` +
              query.slice(lastNlBeforeClose)
            handled = true
          }
        },
      },
    }))

    return result
  } catch {
    return query
  }
}

// ── Nested selection cursor tracking ─────────────────────────────────────────

export type ActiveNestedSelectionInfo = {
  parentTypeName: string   // type that owns the field (e.g. 'Tag')
  fieldName: string        // the nested field (e.g. '_version')
  fieldTypeName: string    // the field's return type (e.g. 'Commit')
  operationName: string    // root operation field name (e.g. 'Tag')
  opKind: 'query' | 'mutation' | 'subscription'
}

/** Returns info about the innermost nested selection set the cursor is inside (depth ≥ 2). */
export function getActiveNestedSelectionAtOffset(
  query: string,
  cursorOffset: number,
  schema: GraphQLSchema,
): ActiveNestedSelectionInfo | null {
  try {
    const doc = parse(query)
    const typeInfo = new TypeInfo(schema)
    let best: ActiveNestedSelectionInfo | null = null
    let currentOpKind: 'query' | 'mutation' | 'subscription' = 'query'
    let fieldDepth = 0
    let currentRootField: string | null = null

    visit(doc, visitWithTypeInfo(typeInfo, {
      OperationDefinition: {
        enter(node: OperationDefinitionNode) {
          currentOpKind = node.operation === 'mutation' ? 'mutation' : node.operation === 'subscription' ? 'subscription' : 'query'
          fieldDepth = 0
          currentRootField = null
        },
      },
      Field: {
        enter(node: FieldNode) {
          fieldDepth++
          if (fieldDepth === 1) {
            currentRootField = node.name.value
          } else if (node.selectionSet?.loc) {
            const ssLoc = node.selectionSet.loc
            if (cursorOffset >= ssLoc.start && cursorOffset <= ssLoc.end) {
              const parentType = typeInfo.getParentType()
              const fieldType  = typeInfo.getType()
              if (parentType && fieldType) {
                const named = getNamedType(fieldType as GraphQLType)
                if (isObjectType(named)) {
                  best = {
                    parentTypeName: parentType.name,
                    fieldName: node.name.value,
                    fieldTypeName: named.name,
                    operationName: currentRootField ?? '',
                    opKind: currentOpKind,
                  }
                }
              }
            }
          }
        },
        leave() {
          if (fieldDepth === 1) currentRootField = null
          fieldDepth--
        },
      },
    }))

    return best
  } catch {
    return null
  }
}

// ── Combined cursor context ───────────────────────────────────────────────────
// Computes insertObject + nestedSelection + operation in a single parse + visit
// instead of three separate calls. Use this in components instead of the three
// individual functions to cut cursor-event work by ~3×.

export type CursorContext = {
  insertObject:    ActiveObjectInfo          | null
  nestedSelection: ActiveNestedSelectionInfo | null
  operation:       { operationName: string; opKind: 'query' | 'mutation' | 'subscription' } | null
}

export function getCursorContext(
  query: string,
  cursorOffset: number,
  schema: GraphQLSchema,
): CursorContext {
  const empty: CursorContext = { insertObject: null, nestedSelection: null, operation: null }
  try {
    const doc      = parseCached(query)
    const typeInfo = new TypeInfo(schema)

    let insertObject:    ActiveObjectInfo          | null = null
    let nestedSelection: ActiveNestedSelectionInfo | null = null
    let operation:       CursorContext['operation']       = null

    let currentOpKind: 'query' | 'mutation' | 'subscription' = 'query'
    let fieldDepth = 0
    let currentRootField: string | null = null

    const rootQueryFields        = schema.getQueryType()?.getFields()        ?? {}
    const rootMutationFields     = schema.getMutationType()?.getFields()     ?? {}
    const rootSubscriptionFields = schema.getSubscriptionType()?.getFields() ?? {}

    visit(doc, visitWithTypeInfo(typeInfo, {
      OperationDefinition: {
        enter(node: OperationDefinitionNode) {
          currentOpKind = node.operation === 'mutation' ? 'mutation' : node.operation === 'subscription' ? 'subscription' : 'query'
          fieldDepth    = 0
          currentRootField = null
        },
      },
      Field: {
        enter(node: FieldNode) {
          fieldDepth++
          if (fieldDepth === 1) {
            currentRootField = node.name.value
            if (node.loc && cursorOffset >= node.loc.start && cursorOffset <= node.loc.end) {
              const fn = node.name.value
              if (fn in rootQueryFields || fn in rootMutationFields || fn in rootSubscriptionFields) {
                operation = { operationName: fn, opKind: currentOpKind }
              }
            }
          } else if (node.selectionSet?.loc) {
            const ssLoc = node.selectionSet.loc
            if (cursorOffset >= ssLoc.start && cursorOffset <= ssLoc.end) {
              const parentType = typeInfo.getParentType()
              const fieldType  = typeInfo.getType()
              if (parentType && fieldType) {
                const named = getNamedType(fieldType as GraphQLType)
                if (isObjectType(named)) {
                  nestedSelection = {
                    parentTypeName: parentType.name,
                    fieldName:      node.name.value,
                    fieldTypeName:  named.name,
                    operationName:  currentRootField ?? '',
                    opKind:         currentOpKind,
                  }
                }
              }
            }
          }
        },
        leave() {
          if (fieldDepth === 1) currentRootField = null
          fieldDepth--
        },
      },
      ObjectValue: {
        enter(node) {
          if (!node.loc) return
          if (cursorOffset < node.loc.start || cursorOffset > node.loc.end) return
          const t = typeInfo.getInputType()
          if (!t) return
          const named = getNamedType(t)
          if (!isInputObjectType(named)) return
          insertObject = {
            typeName:      named.name,
            objectStart:   node.loc.start,
            operationName: currentRootField ?? undefined,
            opKind:        currentOpKind,
          }
        },
      },
    }))

    if (insertObject)    return { insertObject, nestedSelection: null, operation: null }
    if (nestedSelection) return { insertObject: null, nestedSelection, operation: null }
    return { insertObject: null, nestedSelection: null, operation }
  } catch {
    return empty
  }
}
