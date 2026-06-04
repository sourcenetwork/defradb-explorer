import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Tab } from '../types'

type SchemaSubView = 'table' | 'graph' | 'sdl' | 'editor' | 'create-view'
type SchemaEditorMode = 'create' | 'patch'

interface UIState {
  // Top-level navigation
  activeTab: Tab
  setActiveTab: (tab: Tab) => void

  // Active collection (persisted so the last-open collection survives reload)
  activeCollection: string | null
  setActiveCollection: (name: string | null) => void

  // Schema view
  schemaSubView: SchemaSubView
  setSchemaSubView: (v: SchemaSubView) => void
  schemaEditorMode: SchemaEditorMode
  setSchemaEditorMode: (m: SchemaEditorMode) => void
  selectedSchemaType: string | null
  setSelectedSchemaType: (name: string | null) => void

  // Commits view
  commitsDocID: string | null
  setCommitsDocID: (id: string | null) => void
  commitsViewMode: 'list' | 'graph'
  setCommitsViewMode: (m: 'list' | 'graph') => void

  // Collections view preferences
  collectionsPageSize: number
  setCollectionsPageSize: (n: number) => void

  // Query view layout preferences
  queryShowSchema: boolean
  setQueryShowSchema: (v: boolean) => void
  queryVarsOpen: boolean
  setQueryVarsOpen: (v: boolean) => void
  queryVarsHeight: number
  setQueryVarsHeight: (h: number) => void
  querySchemaWidth: number
  setQuerySchemaWidth: (w: number) => void

  // Resizable panel widths/heights
  schemaGuideWidth: number
  setSchemaGuideWidth: (w: number) => void
  schemaSidebarWidth: number
  setSchemaSidebarWidth: (w: number) => void
  viewGuideWidth: number
  setViewGuideWidth: (w: number) => void
  viewsSidebarWidth: number
  setViewsSidebarWidth: (w: number) => void
  schemaEditorPreviewHeight: number
  setSchemaEditorPreviewHeight: (h: number) => void
  viewSdlHeight: number
  setViewSdlHeight: (h: number) => void
  collectionsDetailWidth: number
  setCollectionsDetailWidth: (w: number) => void

  // Draft inputs — persisted so navigating away doesn't lose work
  viewDraftSdl: string
  setViewDraftSdl: (v: string) => void
  viewDraftQuery: string
  setViewDraftQuery: (v: string) => void
  schemaEditorDraftCreate: string
  setSchemaEditorDraftCreate: (v: string) => void
  schemaEditorDraftPatch: string
  setSchemaEditorDraftPatch: (v: string) => void
}

const VALID_TABS = new Set<Tab>(['dashboard', 'collections', 'query', 'schema', 'peers', 'commits'])
const VALID_SCHEMA_SUB: Set<SchemaSubView> = new Set(['table', 'graph', 'sdl', 'editor', 'create-view'])

export const useUIStore = create<UIState>()(
  persist(
    (set) => ({
      activeTab: 'dashboard',
      setActiveTab: (tab) => set({ activeTab: tab }),

      activeCollection: null,
      setActiveCollection: (name) => set({ activeCollection: name }),

      schemaSubView: 'table',
      setSchemaSubView: (v) => set({ schemaSubView: v }),
      schemaEditorMode: 'create',
      setSchemaEditorMode: (m) => set({ schemaEditorMode: m }),
      selectedSchemaType: null,
      setSelectedSchemaType: (name) => set({ selectedSchemaType: name }),

      commitsDocID: null,
      setCommitsDocID: (id) => set({ commitsDocID: id }),
      commitsViewMode: 'graph',
      setCommitsViewMode: (m) => set({ commitsViewMode: m }),

      collectionsPageSize: 20,
      setCollectionsPageSize: (n) => set({ collectionsPageSize: n }),

      queryShowSchema: true,
      setQueryShowSchema: (v) => set({ queryShowSchema: v }),
      queryVarsOpen: false,
      setQueryVarsOpen: (v) => set({ queryVarsOpen: v }),
      queryVarsHeight: 120,
      setQueryVarsHeight: (h) => set({ queryVarsHeight: h }),
      querySchemaWidth: 320,
      setQuerySchemaWidth: (w) => set({ querySchemaWidth: w }),

      schemaGuideWidth: 400,
      setSchemaGuideWidth: (w) => set({ schemaGuideWidth: w }),
      schemaSidebarWidth: 280,
      setSchemaSidebarWidth: (w) => set({ schemaSidebarWidth: w }),
      viewGuideWidth: 400,
      setViewGuideWidth: (w) => set({ viewGuideWidth: w }),
      viewsSidebarWidth: 220,
      setViewsSidebarWidth: (w) => set({ viewsSidebarWidth: w }),
      schemaEditorPreviewHeight: 260,
      setSchemaEditorPreviewHeight: (h) => set({ schemaEditorPreviewHeight: h }),
      viewSdlHeight: 220,
      setViewSdlHeight: (h) => set({ viewSdlHeight: h }),
      collectionsDetailWidth: 0,
      setCollectionsDetailWidth: (w) => set({ collectionsDetailWidth: w }),

      viewDraftSdl: '',
      setViewDraftSdl: (v) => set({ viewDraftSdl: v }),
      viewDraftQuery: '',
      setViewDraftQuery: (v) => set({ viewDraftQuery: v }),
      schemaEditorDraftCreate: '',
      setSchemaEditorDraftCreate: (v) => set({ schemaEditorDraftCreate: v }),
      schemaEditorDraftPatch: '',
      setSchemaEditorDraftPatch: (v) => set({ schemaEditorDraftPatch: v }),
    }),
    {
      name: 'defradb:ui',
      partialize: (state) => ({
        activeTab:                    VALID_TABS.has(state.activeTab) ? state.activeTab : 'dashboard',
        activeCollection:             state.activeCollection,
        schemaSubView:                VALID_SCHEMA_SUB.has(state.schemaSubView) ? state.schemaSubView : 'table',
        schemaEditorMode:             state.schemaEditorMode === 'patch' ? 'patch' : 'create',
        selectedSchemaType:           state.selectedSchemaType,
        commitsDocID:                 state.commitsDocID,
        commitsViewMode:              state.commitsViewMode,
        collectionsPageSize:          state.collectionsPageSize,
        queryShowSchema:              state.queryShowSchema,
        queryVarsOpen:                state.queryVarsOpen,
        queryVarsHeight:              state.queryVarsHeight,
        querySchemaWidth:             state.querySchemaWidth,
        schemaGuideWidth:             state.schemaGuideWidth,
        schemaSidebarWidth:           state.schemaSidebarWidth,
        viewGuideWidth:               state.viewGuideWidth,
        viewsSidebarWidth:            state.viewsSidebarWidth,
        schemaEditorPreviewHeight:    state.schemaEditorPreviewHeight,
        viewSdlHeight:                state.viewSdlHeight,
        collectionsDetailWidth:       state.collectionsDetailWidth,
        viewDraftSdl:                 state.viewDraftSdl,
        viewDraftQuery:               state.viewDraftQuery,
        schemaEditorDraftCreate:      state.schemaEditorDraftCreate,
        schemaEditorDraftPatch:       state.schemaEditorDraftPatch,
      }),
    },
  ),
)
