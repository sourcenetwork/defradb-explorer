import { useState, useMemo, useEffect, useRef } from 'react'
import {
  isObjectType, isInputObjectType, isScalarType, isEnumType, isNonNullType, isListType, getNamedType,
} from 'graphql'
import type {
  GraphQLSchema, GraphQLObjectType, GraphQLField, GraphQLOutputType, GraphQLInputObjectType,
} from 'graphql'
import {
  getSelectedFieldsForType, toggleFieldInQuery,
  getArgsForRootField, toggleArgInQuery,
  getInputObjectFieldsInQuery, ensureArgAndToggleInputField,
  getCursorContext,
  getInputObjectFieldsAtOffset,
  toggleInputObjectFieldAtOffset, addItemToInputList, getListItemObjectStarts,
  getSelectedSubFieldsAtPath, toggleSubFieldAtPath,
  typeIsList, computeCursorAfterToggle, canToggleInputType, isRootFieldInQuery,
} from '../lib/queryBuilder'
import type { ActiveObjectInfo, ActiveNestedSelectionInfo } from '../lib/queryBuilder'
import styles from './SchemaExplorer.module.css'

// ── Helpers ───────────────────────────────────────────────────────────────────

const AGGREGATE_NAMES = new Set(['AVG', 'COUNT', 'MAX', 'MIN', 'SUM', 'SIMILARITY', 'GROUP'])
const HIDDEN_TYPES = new Set([
  'Boolean', 'Float', 'ID', 'Int', 'String',
  '__Directive', '__DirectiveLocation', '__EnumValue', '__Field',
  '__InputValue', '__Schema', '__Type',
  'ExplainableMutation', 'ExplainableQuery', 'Mutation', 'Query', 'Subscription',
])

function formatType(type: GraphQLOutputType): string {
  if (isNonNullType(type)) return `${formatType(type.ofType as GraphQLOutputType)}!`
  if (isListType(type))    return `[${formatType(type.ofType as GraphQLOutputType)}]`
  return 'name' in type ? (type as { name: string }).name : ''
}

function scalarPlaceholder(typeName: string): string {
  switch (typeName) {
    case 'Int': return '0'
    case 'Float': case 'Float32': case 'Float64': return '0.0'
    case 'Boolean': return 'false'
    case 'DateTime': return '"2024-01-01T00:00:00Z"'
    case 'JSON': return '"{}"'
    case 'Blob': return '"ff0099"'
    default: return '""'
  }
}

function inputFields(type: GraphQLInputObjectType, indent = '      '): string {
  return Object.values(type.getFields()).filter(f => !f.name.startsWith('_'))
    .map(f => {
      const n = getNamedType(f.type)
      return `${indent}${f.name}: ${isScalarType(n) ? scalarPlaceholder(n.name) : '{}'}`
    }).join('\n')
}

function selectionSet(type: GraphQLObjectType, indent = '    '): string {
  const fields = Object.values(type.getFields()).filter(f => {
    const n = getNamedType(f.type)
    return isScalarType(n) && !AGGREGATE_NAMES.has(f.name) && (f.name === '_docID' || !f.name.startsWith('_'))
  })
  return fields.length ? fields.map(f => `${indent}${f.name}`).join('\n') : `${indent}_docID`
}

function buildQueryTemplate(field: GraphQLField<unknown, unknown>): string {
  const named = getNamedType(field.type)
  const sel = isObjectType(named) ? selectionSet(named) : '    _docID'
  return `{\n  ${field.name}${field.args.some(a => a.name === 'limit') ? '(limit: 10)' : ''} {\n${sel}\n  }\n}`
}

function buildSubscriptionTemplate(field: GraphQLField<unknown, unknown>): string {
  const named = getNamedType(field.type)
  const sel = isObjectType(named) ? selectionSet(named) : '    _docID'
  return `subscription {\n  ${field.name}${field.args.some(a => a.name === 'docID') ? '(docID: [""])' : ''} {\n${sel}\n  }\n}`
}

function buildMutationTemplate(field: GraphQLField<unknown, unknown>): string {
  const argMap = new Map(field.args.map(a => [a.name, a]))
  const named  = getNamedType(field.type)
  const sel    = isObjectType(named) ? selectionSet(named, '    ').split('\n').slice(0, 4).join('\n') : '    _docID'
  if (argMap.has('input') && !argMap.has('filter')) {
    const it = getNamedType(argMap.get('input')!.type)
    return `mutation {\n  ${field.name}(input: [{\n${isInputObjectType(it) ? inputFields(it) : ''}\n  }]) {\n${sel}\n  }\n}`
  }
  if (argMap.has('input') && argMap.has('filter')) {
    const it = getNamedType(argMap.get('input')!.type)
    const two = isInputObjectType(it)
      ? Object.values(it.getFields()).filter(f => !f.name.startsWith('_')).slice(0, 2)
          .map(f => { const n = getNamedType(f.type); return `      ${f.name}: ${isScalarType(n) ? scalarPlaceholder(n.name) : '{}'}` }).join('\n')
      : ''
    return `mutation {\n  ${field.name}(\n    filter: { _docID: { _eq: "" } }\n    input: {\n${two}\n    }\n  ) {\n${sel}\n  }\n}`
  }
  if (argMap.has('add')) {
    const addType = getNamedType(argMap.get('add')!.type)
    const addFields = isInputObjectType(addType) ? inputFields(addType) : ''
    const updType = argMap.has('update') ? getNamedType(argMap.get('update')!.type) : null
    const updateFields = updType && isInputObjectType(updType)
      ? Object.values(updType.getFields()).filter(f => !f.name.startsWith('_')).slice(0, 2)
          .map(f => { const n = getNamedType(f.type); return `      ${f.name}: ${isScalarType(n) ? scalarPlaceholder(n.name) : '{}'}` }).join('\n')
      : ''
    return `mutation {\n  ${field.name}(\n    filter: { _docID: { _eq: "" } }\n    add: {\n${addFields}\n    }\n    update: {\n${updateFields}\n    }\n  ) {\n${sel}\n  }\n}`
  }
  if (argMap.has('filter') || argMap.has('docID')) {
    return `mutation {\n  ${field.name}(\n    filter: { _docID: { _eq: "" } }\n  ) {\n${sel}\n  }\n}`
  }
  return `mutation {\n  ${field.name} {\n${sel}\n  }\n}`
}

// ── Nav stack ─────────────────────────────────────────────────────────────────

type NavPage =
  | { kind: 'root' }
  | { kind: 'opList'; opKind: 'query' | 'mutation' | 'subscription' }
  | { kind: 'typeList' }
  | { kind: 'operation'; opKind: 'query' | 'mutation' | 'subscription'; field: GraphQLField<unknown, unknown> }
  | { kind: 'type'; typeName: string; objectStart?: number }
  | { kind: 'field'; parentTypeName: string; fieldName: string }

function pageKey(p: NavPage): string {
  if (p.kind === 'root')      return 'root'
  if (p.kind === 'opList')    return `opList:${p.opKind}`
  if (p.kind === 'typeList')  return 'typeList'
  if (p.kind === 'operation') return `op:${p.field.name}`
  if (p.kind === 'type')      return `type:${p.typeName}:${p.objectStart ?? ''}`
  return `field:${p.parentTypeName}.${p.fieldName}`
}

// ── Icons ─────────────────────────────────────────────────────────────────────

function AddIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" fill="none">
      <circle cx={8} cy={8} r={6.5} stroke="currentColor" strokeWidth={1.2}/>
      <line x1={8} y1={5} x2={8} y2={11} stroke="currentColor" strokeWidth={1.2} strokeLinecap="round"/>
      <line x1={5} y1={8} x2={11} y2={8} stroke="currentColor" strokeWidth={1.2} strokeLinecap="round"/>
    </svg>
  )
}

function AddedIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" fill="none">
      <circle cx={8} cy={8} r={7} fill="var(--defradb)"/>
      <path d="M5 8.2l2 2 4-4.4" stroke="#000" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  )
}

function ChevronRightIcon({ small }: { small?: boolean }) {
  const s = small ? 9 : 10
  return (
    <svg width={s} height={s} viewBox="0 0 10 10" fill="none">
      <path d="M3.5 2l3 3-3 3" stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  )
}

// ── Selectable row (field or arg) ─────────────────────────────────────────────

function SelectableRow({
  name, typeName, selected, onToggle, onNavigateField, disabled,
}: {
  name: string
  typeName: string
  selected: boolean
  onToggle: () => void
  onNavigateField?: () => void
  disabled?: boolean
}) {
  return (
    <div className={`${styles.selectRow} ${selected ? styles.selectRowOn : ''} ${disabled ? styles.selectRowDisabled : ''}`}>
      <button className={`${styles.addBtn} ${selected ? styles.addBtnOn : ''}`} onClick={disabled ? undefined : onToggle} disabled={disabled}>
        {selected ? <AddedIcon /> : <AddIcon />}
      </button>
      <button
        className={`${styles.rowLabel} ${onNavigateField ? styles.rowLabelLink : ''}`}
        onClick={onNavigateField}
        disabled={!onNavigateField}
      >
        <span className={styles.rowName}>{name}</span>
        <span className={styles.rowColon}>:</span>
        <span className={styles.rowType}>{typeName}</span>
      </button>
      {onNavigateField && (
        <span className={styles.rowChevron}><ChevronRightIcon small /></span>
      )}
    </div>
  )
}

// ── Operation detail page ─────────────────────────────────────────────────────

function OperationPage({
  field, opKind, schema, query, onInsert, onQueryChange, onNavigateType, onNavigateField,
}: {
  field: GraphQLField<unknown, unknown>
  opKind: 'query' | 'mutation' | 'subscription'
  schema: GraphQLSchema
  query: string
  onInsert: (t: string) => void
  onQueryChange: (q: string, cursorAt?: number) => void
  onNavigateType: (name: string) => void
  onNavigateField: (typeName: string, fieldName: string) => void
}) {
  const template    = opKind === 'query'
    ? buildQueryTemplate(field)
    : opKind === 'subscription'
      ? buildSubscriptionTemplate(field)
      : buildMutationTemplate(field)
  const returnType  = getNamedType(field.type)
  const returnFields = isObjectType(returnType)
    ? Object.values(returnType.getFields()).filter(f => !AGGREGATE_NAMES.has(f.name))
    : []
  const inQuery     = isRootFieldInQuery(query, field.name)
  const selected    = getSelectedFieldsForType(query, returnType.name, schema)
  const activeArgs  = getArgsForRootField(query, field.name)
  const visibleArgs = field.args.filter(a => !a.name.startsWith('_'))

  const returnTypeNavigable = !HIDDEN_TYPES.has(returnType.name) && isObjectType(returnType)

  const nameColor = opKind === 'query' ? styles.nameQuery : opKind === 'subscription' ? styles.nameSubscription : styles.nameMutation

  return (
    <div className={styles.detailPage}>
      {/* Title row */}
      <div className={styles.detailTitleRow}>
        <button className={styles.addBtnLg} onClick={() => onInsert(template)}>
          {false ? <AddedIcon /> : <AddIcon />}
        </button>
        <div className={styles.detailTitleContent}>
          <span className={`${styles.detailName} ${nameColor}`}>
            {field.name}:
          </span>
          {' '}
          <button
            className={`${styles.detailReturnType} ${returnTypeNavigable ? styles.detailReturnTypeLink : ''}`}
            onClick={returnTypeNavigable ? () => onNavigateType(returnType.name) : undefined}
            disabled={!returnTypeNavigable}
          >
            {formatType(field.type as GraphQLOutputType)}
          </button>
        </div>
      </div>

      {/* Args */}
      {visibleArgs.length > 0 && (
        <div className={styles.detailSection}>
          <p className={styles.detailSectionLabel}>Arguments</p>
          {visibleArgs.map(a => {
            const typeName  = formatType(a.type as GraphQLOutputType)
            const named     = getNamedType(a.type)
            const argIsList = typeName.includes('[')
            const navigable = !HIDDEN_TYPES.has(named.name) &&
              (isInputObjectType(schema.getType(named.name)) || isObjectType(schema.getType(named.name)) || isScalarType(schema.getType(named.name)) || isEnumType(schema.getType(named.name)))
            return (
              <SelectableRow
                key={a.name}
                name={a.name}
                typeName={typeName}
                selected={activeArgs.has(a.name)}
                onToggle={() => {
                  const next = toggleArgInQuery(query, field.name, a.name, named.name, argIsList)
                  onQueryChange(next, computeCursorAfterToggle(query, next) ?? undefined)
                }}
                onNavigateField={navigable ? () => onNavigateType(named.name) : undefined}
                disabled={!inQuery}
              />
            )
          })}
        </div>
      )}

      {/* Return-type fields */}
      {returnFields.length > 0 && (
        <div className={styles.detailSection}>
          <div className={styles.detailSectionHeader}>
            <p className={styles.detailSectionLabel}>Fields</p>
            {returnTypeNavigable && (
              <button className={styles.typeNavLink} onClick={() => onNavigateType(returnType.name)}>
                {returnType.name} <ChevronRightIcon small />
              </button>
            )}
          </div>
          {returnFields.map(f => {
            const tn = formatType(f.type)
            return (
              <SelectableRow
                key={f.name}
                name={f.name}
                typeName={tn}
                selected={selected.has(f.name)}
                onToggle={() => onQueryChange(toggleFieldInQuery(query, returnType.name, f.name, schema))}
                onNavigateField={() => onNavigateField(returnType.name, f.name)}
                disabled={!inQuery}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Type detail page ──────────────────────────────────────────────────────────

function TypePage({
  typeName, schema, query, onQueryChange, onNavigateField, onNavigateType, objectStart, activeInsertObject,
}: {
  typeName: string
  schema: GraphQLSchema
  query: string
  onQueryChange: (q: string, cursorAt?: number) => void
  onNavigateField: (typeName: string, fieldName: string) => void
  onNavigateType: (typeName: string, objectStart?: number) => void
  objectStart?: number
  activeInsertObject?: ActiveObjectInfo | null
}) {
  const type        = schema.getType(typeName)
  const description = (type as { description?: string | null })?.description

  // Input type (e.g. mutation input args) — selectable fields
  if (isInputObjectType(type)) {
    const fields = Object.values(type.getFields())
    // For insertions: prefer the explicit nav objectStart, then fall back to
    // the live cursor position if the cursor is inside a matching ObjectValue.
    const insertTargetStart = objectStart
      ?? (activeInsertObject?.typeName === typeName ? activeInsertObject?.objectStart : undefined)

    const selectedInputFields = insertTargetStart != null
      ? getInputObjectFieldsAtOffset(query, insertTargetStart)
      : getInputObjectFieldsInQuery(query, typeName, schema)

    const fieldsToggleable = insertTargetStart != null || canToggleInputType(query, typeName, schema)

    return (
      <div className={styles.detailPage}>
        <div className={styles.detailTitleRow}>
          <div className={styles.detailTitleContent}>
            <span className={styles.detailName}>{typeName}</span>
            <span className={styles.detailKindBadge}>input</span>
          </div>
        </div>
        {description && <p className={styles.detailDescription}>{description}</p>}
        {fields.length > 0 && (
          <div className={styles.detailSection}>
            <p className={styles.detailSectionLabel}>Fields</p>
            {fields.map(f => {
              const named      = getNamedType(f.type)
              const isFList    = typeIsList(f.type)
              const navigable  = named.name !== typeName &&
                !HIDDEN_TYPES.has(named.name) &&
                (isInputObjectType(schema.getType(named.name)) || isScalarType(schema.getType(named.name)) || isEnumType(schema.getType(named.name)))
              const isSelected = selectedInputFields.has(f.name)
              const itemStarts = (insertTargetStart != null && isSelected && isFList && isInputObjectType(schema.getType(named.name)))
                ? getListItemObjectStarts(query, insertTargetStart, f.name)
                : null

              const doToggle = () => {
                const next = insertTargetStart != null
                  ? toggleInputObjectFieldAtOffset(query, insertTargetStart, f.name, schema)
                  : ensureArgAndToggleInputField(query, typeName, f.name, named.name, schema)
                onQueryChange(next, computeCursorAfterToggle(query, next) ?? undefined)
              }

              return (
                <div key={f.name}>
                  <SelectableRow
                    name={f.name}
                    typeName={formatType(f.type as GraphQLOutputType)}
                    selected={isSelected}
                    onToggle={doToggle}
                    onNavigateField={navigable ? () => onNavigateType(named.name) : undefined}
                    disabled={!fieldsToggleable}
                  />
                  {itemStarts && (
                    <div className={styles.listItems}>
                      {itemStarts.map((start, i) => (
                        <button
                          key={start}
                          className={styles.listItemRow}
                          onClick={() => onNavigateType(named.name, start)}
                        >
                          <span className={styles.listItemDot}>·</span>
                          <span className={styles.listItemLabel}>Item {i + 1}</span>
                          <ChevronRightIcon small />
                        </button>
                      ))}
                      <button
                        className={styles.listAddRow}
                        onClick={() => {
                          const next = addItemToInputList(query, insertTargetStart!, f.name)
                          onQueryChange(next, computeCursorAfterToggle(query, next) ?? undefined)
                        }}
                      >
                        <span className={styles.listAddPlus}>+</span>
                        <span>Add item</span>
                      </button>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    )
  }

  // Enum type — show values
  if (isEnumType(type)) {
    const values = type.getValues()
    return (
      <div className={styles.detailPage}>
        <div className={styles.detailTitleRow}>
          <div className={styles.detailTitleContent}>
            <span className={styles.detailName}>{typeName}</span>
            <span className={styles.detailKindBadge}>enum</span>
          </div>
        </div>
        {description && <p className={styles.detailDescription}>{description}</p>}
        {values.length > 0 && (
          <div className={styles.detailSection}>
            <p className={styles.detailSectionLabel}>Values</p>
            {values.map(v => (
              <div key={v.name} className={styles.enumValueRow}>
                <span className={styles.enumValueName}>{v.name}</span>
                {v.description && <span className={styles.enumValueDesc}>{v.description}</span>}
              </div>
            ))}
          </div>
        )}
      </div>
    )
  }

  // Scalar type — show name, badge, and description
  if (isScalarType(type)) {
    return (
      <div className={styles.detailPage}>
        <div className={styles.detailTitleRow}>
          <div className={styles.detailTitleContent}>
            <span className={styles.detailName}>{typeName}</span>
            <span className={styles.detailKindBadge}>scalar</span>
          </div>
        </div>
        {description
          ? <p className={styles.detailDescription}>{description}</p>
          : <p className={styles.detailDescription}>Custom scalar type.</p>
        }
      </div>
    )
  }

  // Object type — selectable fields
  const fields   = isObjectType(type)
    ? Object.values(type.getFields()).filter(f => !AGGREGATE_NAMES.has(f.name))
    : []
  const selected = getSelectedFieldsForType(query, typeName, schema)

  return (
    <div className={styles.detailPage}>
      <div className={styles.detailTitleRow}>
        <div className={styles.detailTitleContent}>
          <span className={styles.detailName}>{typeName}</span>
          <span className={styles.detailKindBadge}>type</span>
        </div>
      </div>

      {description && <p className={styles.detailDescription}>{description}</p>}

      {fields.length > 0 && (
        <div className={styles.detailSection}>
          <div className={styles.detailSectionHeader}>
            <p className={styles.detailSectionLabel}>Fields</p>
            <button
              className={styles.toggleAllBtn}
              onClick={() => {
                const allSelected = fields.every(f => selected.has(f.name))
                const toToggle = allSelected
                  ? fields.filter(f => selected.has(f.name))
                  : fields.filter(f => !selected.has(f.name))
                const next = toToggle.reduce((q, f) => toggleFieldInQuery(q, typeName, f.name, schema), query)
                onQueryChange(next)
              }}
            >
              {fields.every(f => selected.has(f.name)) ? 'None' : 'All'}
            </button>
          </div>
          {fields.map(f => (
            <SelectableRow
              key={f.name}
              name={f.name}
              typeName={formatType(f.type)}
              selected={selected.has(f.name)}
              onToggle={() => onQueryChange(toggleFieldInQuery(query, typeName, f.name, schema))}
              onNavigateField={() => onNavigateField(typeName, f.name)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// ── Field detail page ─────────────────────────────────────────────────────────

function FieldDetailPage({
  parentTypeName, fieldName, schema, query, onQueryChange, onNavigateField, onNavigateType,
}: {
  parentTypeName: string
  fieldName: string
  schema: GraphQLSchema
  query: string
  onQueryChange: (q: string, cursorAt?: number) => void
  onNavigateField: (typeName: string, fieldName: string) => void
  onNavigateType: (typeName: string) => void
}) {
  const parentType = schema.getType(parentTypeName)
  const field      = isObjectType(parentType) ? parentType.getFields()[fieldName] : null
  if (!field) return <div className={styles.detailPage}><p className={styles.noResults}>Field not found.</p></div>

  const named      = getNamedType(field.type)
  const typeName   = formatType(field.type)
  const isRequired = isNonNullType(field.type)
  const fieldDesc  = field.description
  const subFields  = isObjectType(named)
    ? Object.values(named.getFields()).filter(f => !AGGREGATE_NAMES.has(f.name))
    : []
  const selected    = getSelectedFieldsForType(query, parentTypeName, schema)
  const isSelected  = selected.has(fieldName)
  const subSelected = getSelectedSubFieldsAtPath(query, parentTypeName, fieldName, schema)
  const typeNavigable = !HIDDEN_TYPES.has(named.name)

  return (
    <div className={styles.detailPage}>
      {/* Title */}
      <div className={styles.detailTitleRow}>
        <button className={`${styles.addBtnLg} ${isSelected ? styles.addBtnLgOn : ''}`}
          onClick={() => onQueryChange(toggleFieldInQuery(query, parentTypeName, fieldName, schema))}>
          {isSelected ? <AddedIcon /> : <AddIcon />}
        </button>
        <div className={styles.detailTitleContent}>
          <span className={styles.detailName}>{fieldName}:</span>{' '}
          <button
            className={`${styles.detailReturnType} ${typeNavigable ? styles.detailReturnTypeLink : ''}`}
            onClick={typeNavigable ? () => onNavigateType(named.name) : undefined}
            disabled={!typeNavigable}
          >
            {typeName}
          </button>
        </div>
      </div>

      {/* Metadata */}
      <div className={styles.detailSection}>
        {fieldDesc && <p className={styles.detailDescription}>{fieldDesc}</p>}
        <div className={styles.metaGrid}>
          <span className={styles.metaKey}>Required</span>
          <span className={styles.metaVal}>{isRequired ? 'Yes' : 'No'}</span>
          <span className={styles.metaKey}>Type</span>
          <button
            className={`${styles.metaVal} ${typeNavigable ? styles.metaValLink : ''}`}
            onClick={typeNavigable ? () => onNavigateType(named.name) : undefined}
            disabled={!typeNavigable}
          >{typeName}</button>
        </div>
      </div>

      {/* Sub-fields (if object type) — toggleable when the parent field is in the query */}
      {subFields.length > 0 && (
        <div className={styles.detailSection}>
          <div className={styles.detailSectionHeader}>
            <p className={styles.detailSectionLabel}>Fields</p>
            <button
              className={styles.toggleAllBtn}
              onClick={() => {
                const allSelected = subFields.every(f => subSelected.has(f.name))
                if (allSelected) {
                  const next = subFields
                    .filter(f => subSelected.has(f.name))
                    .reduce((q, f) => toggleSubFieldAtPath(q, parentTypeName, fieldName, f.name, schema), query)
                  onQueryChange(next)
                } else {
                  let q = isSelected ? query : toggleFieldInQuery(query, parentTypeName, fieldName, schema)
                  q = subFields
                    .filter(f => !subSelected.has(f.name))
                    .reduce((acc, f) => toggleSubFieldAtPath(acc, parentTypeName, fieldName, f.name, schema), q)
                  onQueryChange(q)
                }
              }}
            >
              {subFields.every(f => subSelected.has(f.name)) ? 'None' : 'All'}
            </button>
            {typeNavigable && (
              <button className={styles.typeNavLink} onClick={() => onNavigateType(named.name)}>
                {named.name} <ChevronRightIcon small />
              </button>
            )}
          </div>
          {subFields.map(f => (
            <SelectableRow
              key={f.name}
              name={f.name}
              typeName={formatType(f.type)}
              selected={subSelected.has(f.name)}
              onToggle={() => {
                if (!isSelected) {
                  // Add the parent field first (with default sub-selection), then toggle the sub-field
                  const withParent = toggleFieldInQuery(query, parentTypeName, fieldName, schema)
                  onQueryChange(toggleSubFieldAtPath(withParent, parentTypeName, fieldName, f.name, schema))
                } else {
                  onQueryChange(toggleSubFieldAtPath(query, parentTypeName, fieldName, f.name, schema))
                }
              }}
              onNavigateField={() => onNavigateField(named.name, f.name)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// ── Root page (just Query / Mutation / Types) ─────────────────────────────────

function RootPage({ schema, onNavigate }: {
  schema: GraphQLSchema
  onNavigate: (page: NavPage) => void
}) {
  const queryType        = schema.getQueryType()
  const mutationType     = schema.getMutationType()
  const subscriptionType = schema.getSubscriptionType()
  const typeMap          = schema.getTypeMap()

  const queryCount = queryType ? Object.values(queryType.getFields()).filter(f => f.name !== '_').length : 0
  const mutCount   = mutationType ? Object.values(mutationType.getFields()).filter(f => f.name !== '_').length : 0
  const subCount   = subscriptionType ? Object.values(subscriptionType.getFields()).filter(f => f.name !== '_').length : 0
  const typeCount  = Object.values(typeMap).filter(t => isObjectType(t) && !HIDDEN_TYPES.has(t.name) && !t.name.startsWith('_')).length

  return (
    <div className={styles.rootList}>
      {queryCount > 0 && (
        <RootRow name="Query" badge={`${queryCount}`} accent="var(--defradb)"
          onNavigate={() => onNavigate({ kind: 'opList', opKind: 'query' })} />
      )}
      {mutCount > 0 && (
        <RootRow name="Mutation" badge={`${mutCount}`} accent="#e0a96d"
          onNavigate={() => onNavigate({ kind: 'opList', opKind: 'mutation' })} />
      )}
      {subCount > 0 && (
        <RootRow name="Subscription" badge={`${subCount}`} accent="#a78bfa"
          onNavigate={() => onNavigate({ kind: 'opList', opKind: 'subscription' })} />
      )}
      {typeCount > 0 && (
        <RootRow name="Types" badge={`${typeCount}`}
          onNavigate={() => onNavigate({ kind: 'typeList' })} />
      )}
    </div>
  )
}

// ── Op list page (all queries or all mutations) ───────────────────────────────

function OpListPage({ schema, opKind, viewNames = new Set(), onNavigate }: {
  schema: GraphQLSchema
  opKind: 'query' | 'mutation' | 'subscription'
  viewNames?: Set<string>
  onNavigate: (page: NavPage) => void
}) {
  const [search, setSearch] = useState('')
  const q = search.toLowerCase()

  const rootType = opKind === 'query'
    ? schema.getQueryType()
    : opKind === 'subscription'
      ? schema.getSubscriptionType()
      : schema.getMutationType()
  const allFields = useMemo(
    () => rootType ? Object.values(rootType.getFields()).filter(f => f.name !== '_') : [],
    [rootType],
  )
  const collFields: GraphQLField<unknown, unknown>[] = []
  const viewFields: GraphQLField<unknown, unknown>[] = []
  const aggFields:  GraphQLField<unknown, unknown>[] = []
  const systemFields: GraphQLField<unknown, unknown>[] = []
  for (const f of allFields) {
    if (q && !f.name.toLowerCase().includes(q)) continue
    const isAgg = AGGREGATE_NAMES.has(f.name) || f.name.endsWith('_aggregate')
    if (isAgg) { aggFields.push(f); continue }
    if (f.name.startsWith('_')) { systemFields.push(f); continue }
    if (viewNames.has(f.name)) { viewFields.push(f) } else { collFields.push(f) }
  }
  const empty = collFields.length === 0 && viewFields.length === 0 && aggFields.length === 0 && systemFields.length === 0

  return (
    <>
      <SearchBox value={search} onChange={setSearch} />
      {collFields.length > 0 && (
        <CollectionsGroup fields={collFields} onNavigate={f => onNavigate({ kind: 'operation', opKind, field: f })} />
      )}
      {viewFields.length > 0 && (
        <ViewsGroup fields={viewFields} onNavigate={f => onNavigate({ kind: 'operation', opKind, field: f })} />
      )}
      {aggFields.length > 0 && (
        <AggregateGroup fields={aggFields} onNavigate={f => onNavigate({ kind: 'operation', opKind: 'query', field: f })} />
      )}
      {systemFields.length > 0 && (
        <SystemGroup fields={systemFields} onNavigate={f => onNavigate({ kind: 'operation', opKind, field: f })} />
      )}
      {empty && search && (
        <p className={styles.noResults}>No results for "{search}"</p>
      )}
    </>
  )
}

// ── Type list page ────────────────────────────────────────────────────────────

function TypeListPage({ schema, query, onNavigate }: {
  schema: GraphQLSchema
  query: string
  onNavigate: (page: NavPage) => void
}) {
  const [search, setSearch] = useState('')
  const q = search.toLowerCase()
  const typeMap = schema.getTypeMap()

  const userTypes = useMemo(
    () => (Object.values(typeMap).filter(t => isObjectType(t) && !HIDDEN_TYPES.has(t.name) && !t.name.startsWith('_')) as GraphQLObjectType[])
      .sort((a, b) => a.name.localeCompare(b.name)),
    [typeMap],
  ).filter(t => !q || t.name.toLowerCase().includes(q))

  return (
    <>
      <SearchBox value={search} onChange={setSearch} />
      {userTypes.map(t => {
        const allFields = Object.values(t.getFields()).filter(f => !AGGREGATE_NAMES.has(f.name))
        const sel = getSelectedFieldsForType(query, t.name, schema)
        const count = allFields.filter(f => sel.has(f.name)).length
        return (
          <RootRow key={t.name} name={t.name}
            badge={count > 0 ? `${count}/${allFields.length}` : `${allFields.length}`}
            badgeActive={count > 0}
            onNavigate={() => onNavigate({ kind: 'type', typeName: t.name })} />
        )
      })}
      {userTypes.length === 0 && search && (
        <p className={styles.noResults}>No results for "{search}"</p>
      )}
    </>
  )
}

function SearchBox({ value, onChange }: { value: string; onChange: (s: string) => void }) {
  return (
    <div className={styles.searchWrap}>
      <svg width={12} height={12} viewBox="0 0 14 14" fill="none" className={styles.searchIcon}>
        <circle cx={6} cy={6} r={4.5} stroke="currentColor" strokeWidth={1.3}/>
        <line x1={9.5} y1={9.5} x2={13} y2={13} stroke="currentColor" strokeWidth={1.3} strokeLinecap="round"/>
      </svg>
      <input className={styles.searchInput} placeholder="Search…" value={value}
        onChange={e => onChange(e.target.value)} spellCheck={false} />
      {value && <button className={styles.searchClear} onClick={() => onChange('')}>×</button>}
    </div>
  )
}

function RootRow({ name, returnType, badge, badgeActive, accent, onNavigate }: {
  name: string; returnType?: string; badge?: string; badgeActive?: boolean; accent?: string; onNavigate: () => void
}) {
  return (
    <button className={styles.rootRow} onClick={onNavigate}>
      <span className={styles.rootRowName} style={accent ? { color: accent } : undefined}>{name}</span>
      {returnType && <span className={styles.rootRowType}>{returnType}</span>}
      {badge && <span className={badgeActive ? styles.rootRowBadgeActive : styles.rootRowBadge}>{badge}</span>}
      <span className={styles.rootRowChevron}><ChevronRightIcon /></span>
    </button>
  )
}

function CollectionsGroup({ fields, onNavigate }: { fields: GraphQLField<unknown,unknown>[]; onNavigate: (f: GraphQLField<unknown,unknown>) => void }) {
  const [open, setOpen] = useState(true)
  return (
    <>
      <button className={`${styles.rootRow} ${styles.rootRowDim}`} onClick={() => setOpen(v => !v)}>
        <span className={styles.rootRowName} style={{ color: 'var(--gray-600)' }}>Collections</span>
        <span className={styles.rootRowBadge}>{fields.length}</span>
        <span className={styles.rootRowChevron} style={{ transform: open ? 'rotate(90deg)' : undefined }}><ChevronRightIcon /></span>
      </button>
      {open && fields.map(f => (
        <RootRow key={f.name} name={f.name} returnType={formatType(f.type as GraphQLOutputType)} onNavigate={() => onNavigate(f)} />
      ))}
    </>
  )
}

function ViewsGroup({ fields, onNavigate }: { fields: GraphQLField<unknown,unknown>[]; onNavigate: (f: GraphQLField<unknown,unknown>) => void }) {
  const [open, setOpen] = useState(true)
  return (
    <>
      <button className={`${styles.rootRow} ${styles.rootRowDim}`} onClick={() => setOpen(v => !v)}>
        <span className={styles.rootRowName} style={{ color: 'var(--gray-600)' }}>Views</span>
        <span className={styles.rootRowBadge}>{fields.length}</span>
        <span className={styles.rootRowChevron} style={{ transform: open ? 'rotate(90deg)' : undefined }}><ChevronRightIcon /></span>
      </button>
      {open && fields.map(f => (
        <RootRow key={f.name} name={f.name} returnType={formatType(f.type as GraphQLOutputType)} onNavigate={() => onNavigate(f)} />
      ))}
    </>
  )
}

function AggregateGroup({ fields, onNavigate }: { fields: GraphQLField<unknown,unknown>[]; onNavigate: (f: GraphQLField<unknown,unknown>) => void }) {
  const [open, setOpen] = useState(true)
  return (
    <>
      <button className={`${styles.rootRow} ${styles.rootRowDim}`} onClick={() => setOpen(v => !v)}>
        <span className={styles.rootRowName} style={{ color: 'var(--gray-600)' }}>Aggregates</span>
        <span className={styles.rootRowBadge}>{fields.length}</span>
        <span className={styles.rootRowChevron} style={{ transform: open ? 'rotate(90deg)' : undefined }}><ChevronRightIcon /></span>
      </button>
      {open && fields.map(f => (
        <RootRow key={f.name} name={f.name} returnType={formatType(f.type as GraphQLOutputType)} onNavigate={() => onNavigate(f)} />
      ))}
    </>
  )
}

function SystemGroup({ fields, onNavigate }: { fields: GraphQLField<unknown,unknown>[]; onNavigate: (f: GraphQLField<unknown,unknown>) => void }) {
  const [open, setOpen] = useState(true)
  return (
    <>
      <button className={`${styles.rootRow} ${styles.rootRowDim}`} onClick={() => setOpen(v => !v)}>
        <span className={styles.rootRowName} style={{ color: 'var(--gray-600)' }}>DefraDB</span>
        <span className={styles.rootRowBadge}>{fields.length}</span>
        <span className={styles.rootRowChevron} style={{ transform: open ? 'rotate(90deg)' : undefined }}><ChevronRightIcon /></span>
      </button>
      {open && fields.map(f => (
        <RootRow key={f.name} name={f.name} returnType={formatType(f.type as GraphQLOutputType)} onNavigate={() => onNavigate(f)} />
      ))}
    </>
  )
}

// ── Breadcrumb ────────────────────────────────────────────────────────────────

function pageLabel(p: NavPage): string {
  if (p.kind === 'root')      return 'Root'
  if (p.kind === 'opList')    return p.opKind === 'query' ? 'Query' : p.opKind === 'subscription' ? 'Subscription' : 'Mutation'
  if (p.kind === 'typeList')  return 'Types'
  if (p.kind === 'operation') return p.field.name
  if (p.kind === 'type')      return p.typeName
  return p.fieldName
}

function Breadcrumb({ stack, onJump, isTracking, cursorNavEnabled, onToggleCursorNav }: {
  stack: NavPage[]
  onJump: (idx: number) => void
  isTracking: boolean
  cursorNavEnabled: boolean
  onToggleCursorNav: () => void
}) {
  return (
    <div className={styles.breadcrumb}>
      {stack.map((p, i) => {
        const isCurrent = i === stack.length - 1
        return (
          <span key={i} className={styles.breadcrumbItem}>
            {i > 0 && <span className={styles.breadcrumbSep}>›</span>}
            <button
              className={`${styles.breadcrumbBtn} ${isCurrent ? styles.breadcrumbCurrent : ''}`}
              onClick={() => onJump(i)}
            >{pageLabel(p)}</button>
          </span>
        )
      })}
      <button
        className={`${styles.cursorToggle} ${cursorNavEnabled ? styles.cursorToggleOn : ''}`}
        onClick={onToggleCursorNav}
        title={cursorNavEnabled ? 'Cursor navigation on — click to disable' : 'Cursor navigation off — click to enable'}
      >
        <svg width={13} height={13} viewBox="0 0 14 14" fill="none">
          <circle cx={7} cy={7} r={4.5} stroke="currentColor" strokeWidth={1.3}/>
          <line x1={7} y1={0.5} x2={7} y2={3}    stroke="currentColor" strokeWidth={1.3} strokeLinecap="round"/>
          <line x1={7} y1={11}  x2={7} y2={13.5}  stroke="currentColor" strokeWidth={1.3} strokeLinecap="round"/>
          <line x1={0.5} y1={7} x2={3}   y2={7}   stroke="currentColor" strokeWidth={1.3} strokeLinecap="round"/>
          <line x1={11}  y1={7} x2={13.5} y2={7}  stroke="currentColor" strokeWidth={1.3} strokeLinecap="round"/>
        </svg>
        {isTracking && <span className={styles.trackingDot} />}
      </button>
    </div>
  )
}

// ── Debounce hook ─────────────────────────────────────────────────────────────

function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState<T>(value)
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(id)
  }, [value, delay])
  return debounced
}

// ── Export ────────────────────────────────────────────────────────────────────

interface Props {
  schema: GraphQLSchema
  onInsert: (template: string) => void
  query: string
  onQueryChange: (q: string, cursorAt?: number) => void
  cursorOffset?: number | null
  viewNames?: Set<string>
}

export default function SchemaExplorer({ schema, onInsert, query, onQueryChange, cursorOffset, viewNames }: Props) {
  const [stack, setStack] = useState<NavPage[]>([{ kind: 'root' }])
  const current = stack[stack.length - 1]

  const [cursorNavEnabled, setCursorNavEnabled] = useState(true)

  // Debounced cursor offset for nav (~80ms — keeps insert targeting instant)
  const navCursorOffset = useDebounced(cursorOffset ?? null, 80)

  // Insert targeting — always instant, not gated by nav toggle
  const insertCtx = useMemo(
    () => cursorOffset != null ? getCursorContext(query, cursorOffset, schema) : null,
    [query, cursorOffset, schema],
  )
  const activeInsertObject: ActiveObjectInfo | null = insertCtx?.insertObject ?? null

  // Nav signals — debounced offset, gated by the toggle (single parse+visit for all three)
  const navCtx = useMemo(
    () => (cursorNavEnabled && navCursorOffset != null)
      ? getCursorContext(query, navCursorOffset, schema)
      : null,
    [cursorNavEnabled, query, navCursorOffset, schema],
  )
  const activeObject:          ActiveObjectInfo          | null = navCtx?.insertObject      ?? null
  const activeNestedSelection: ActiveNestedSelectionInfo | null = navCtx?.nestedSelection   ?? null
  const activeOperation = navCtx?.operation ?? null

  const isTracking = cursorNavEnabled && (activeObject != null || activeNestedSelection != null || activeOperation != null)

  // Pop cursor-targeted pages when cursor nav is turned off
  useEffect(() => {
    if (!cursorNavEnabled) {
      setStack(s => {
        let i = s.length - 1
        while (i > 0 && s[i].kind === 'type' && (s[i] as Extract<NavPage, { kind: 'type' }>).objectStart != null) i--
        return i < s.length - 1 ? s.slice(0, i + 1) : s
      })
    }
  }, [cursorNavEnabled])

  // Stable string keys so the effect only fires when context actually changes
  const activeObjectKey    = activeObject          ? `${activeObject.objectStart}:${activeObject.typeName}` : null
  const activeNestedKey    = activeNestedSelection ? `${activeNestedSelection.operationName}:${activeNestedSelection.fieldName}` : null
  const activeOperationKey = activeOperation       ? `${activeOperation.operationName}:${activeOperation.opKind}` : null

  // Auto-navigate when cursor context changes
  useEffect(() => {
    if (activeObject) {
      // ── Inside an ObjectValue ─────────────────────────────────────────────
      setStack(s => {
        const page: NavPage = { kind: 'type', typeName: activeObject.typeName, objectStart: activeObject.objectStart }
        const key  = pageKey(page)
        const last = s[s.length - 1]

        if (pageKey(last) === key) return s

        if (last.kind === 'type' && last.typeName === activeObject.typeName) {
          return [...s.slice(0, -1), page]
        }

        if (activeObject.operationName && activeObject.opKind) {
          const opRootType = activeObject.opKind === 'query' ? schema.getQueryType() : activeObject.opKind === 'subscription' ? schema.getSubscriptionType() : schema.getMutationType()
          const opField    = opRootType?.getFields()[activeObject.operationName]
          if (opField) {
            const opIdx = s.findIndex(
              p => p.kind === 'operation' && (p as Extract<NavPage, { kind: 'operation' }>).field.name === activeObject.operationName,
            )
            if (opIdx !== -1) {
              const existingIdx = s.findIndex(p => pageKey(p) === key)
              if (existingIdx !== -1) return s.slice(0, existingIdx + 1)
              return [...s.slice(0, opIdx + 1), page]
            }
            return [
              { kind: 'root' },
              { kind: 'opList', opKind: activeObject.opKind },
              { kind: 'operation', opKind: activeObject.opKind, field: opField },
              page,
            ]
          }
        }

        const existingIdx = s.findIndex(p => pageKey(p) === key)
        if (existingIdx !== -1) return s.slice(0, existingIdx + 1)
        return [...s, page]
      })
    } else if (activeNestedSelection) {
      // ── Inside a nested selection set (e.g. Tag._version { … }) ──────────
      setStack(s => {
        const opRootType = activeNestedSelection.opKind === 'query' ? schema.getQueryType() : activeNestedSelection.opKind === 'subscription' ? schema.getSubscriptionType() : schema.getMutationType()
        const opField    = opRootType?.getFields()[activeNestedSelection.operationName]
        if (!opField) return s

        const fieldPage: NavPage = { kind: 'field', parentTypeName: activeNestedSelection.parentTypeName, fieldName: activeNestedSelection.fieldName }
        const fieldKey = pageKey(fieldPage)
        const last = s[s.length - 1]
        if (pageKey(last) === fieldKey) return s

        const existingIdx = s.findIndex(p => pageKey(p) === fieldKey)
        if (existingIdx !== -1) return s.slice(0, existingIdx + 1)

        const opPage: NavPage = { kind: 'operation', opKind: activeNestedSelection.opKind, field: opField }
        const opIdx = s.findIndex(p => pageKey(p) === pageKey(opPage))
        if (opIdx !== -1) return [...s.slice(0, opIdx + 1), fieldPage]

        return [
          { kind: 'root' },
          { kind: 'opList', opKind: activeNestedSelection.opKind },
          opPage,
          fieldPage,
        ]
      })
    } else if (activeOperation) {
      // ── Inside a root operation field (selection set or args) ─────────────
      setStack(s => {
        const opRootType = activeOperation.opKind === 'query' ? schema.getQueryType() : activeOperation.opKind === 'subscription' ? schema.getSubscriptionType() : schema.getMutationType()
        const opField    = opRootType?.getFields()[activeOperation.operationName]
        if (!opField) return s

        const opPage: NavPage = { kind: 'operation', opKind: activeOperation.opKind, field: opField }
        const key  = pageKey(opPage)
        const last = s[s.length - 1]
        if (pageKey(last) === key) return s

        const existingIdx = s.findIndex(p => pageKey(p) === key)
        if (existingIdx !== -1) return s.slice(0, existingIdx + 1)

        return [
          { kind: 'root' },
          { kind: 'opList', opKind: activeOperation.opKind },
          opPage,
        ]
      })
    } else {
      // ── Cursor outside all tracked nodes — pop cursor-targeted type pages ─
      setStack(s => {
        let i = s.length - 1
        while (i > 0 && s[i].kind === 'type' && (s[i] as Extract<NavPage, { kind: 'type' }>).objectStart != null) {
          i--
        }
        return i < s.length - 1 ? s.slice(0, i + 1) : s
      })
    }
  }, [activeObjectKey, activeNestedKey, activeOperationKey, schema])

  const prevActiveRef = useRef<ActiveObjectInfo | null>(null)
  prevActiveRef.current = activeObject

  function navigate(page: NavPage) {
    const key = pageKey(page)
    setStack(s => {
      const existingIdx = s.findIndex(p => pageKey(p) === key)
      if (existingIdx !== -1) return s.slice(0, existingIdx + 1)
      return [...s, page]
    })
  }
  function jumpTo(idx: number) { setStack(s => s.slice(0, idx + 1)) }

  function navigateField(typeName: string, fieldName: string) {
    navigate({ kind: 'field', parentTypeName: typeName, fieldName })
  }
  function navigateType(typeName: string, objectStart?: number) {
    navigate({ kind: 'type', typeName, objectStart })
  }

  return (
    <div className={styles.explorer}>
      <div className={styles.panelHeader}>
        <span className={styles.panelTitle}>Schema</span>
      </div>
      <Breadcrumb stack={stack} onJump={jumpTo} isTracking={isTracking} cursorNavEnabled={cursorNavEnabled} onToggleCursorNav={() => setCursorNavEnabled(v => !v)} />
      <div className={styles.pageContent}>
        {current.kind === 'root' && (
          <RootPage schema={schema} onNavigate={navigate} />
        )}
        {current.kind === 'opList' && (
          <OpListPage schema={schema} opKind={current.opKind} viewNames={viewNames} onNavigate={navigate} />
        )}
        {current.kind === 'typeList' && (
          <TypeListPage schema={schema} query={query} onNavigate={navigate} />
        )}
        {current.kind === 'operation' && (
          <OperationPage field={current.field} opKind={current.opKind}
            schema={schema} query={query} onInsert={onInsert}
            onQueryChange={onQueryChange}
            onNavigateType={navigateType}
            onNavigateField={navigateField} />
        )}
        {current.kind === 'type' && (
          <TypePage typeName={current.typeName} schema={schema} query={query}
            onQueryChange={onQueryChange}
            onNavigateField={navigateField}
            onNavigateType={navigateType}
            objectStart={current.objectStart}
            activeInsertObject={activeInsertObject} />
        )}
        {current.kind === 'field' && (
          <FieldDetailPage
            parentTypeName={current.parentTypeName}
            fieldName={current.fieldName}
            schema={schema} query={query}
            onQueryChange={onQueryChange}
            onNavigateField={navigateField}
            onNavigateType={navigateType} />
        )}
      </div>
    </div>
  )
}
