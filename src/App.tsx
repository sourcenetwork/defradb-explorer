import { useState, useRef } from 'react'
import type { Tab } from './types'
import Topbar from './components/Topbar'
import Sidebar from './components/Sidebar'
import TabBar from './components/TabBar'
import SettingsModal from './components/SettingsModal'
import DashboardView from './views/DashboardView'
import CollectionsView from './views/CollectionsView'
import type { CollectionsViewHandle } from './views/CollectionsView'
import QueryView from './views/QueryView'
import type { QueryViewHandle } from './views/QueryView'
import SchemaView from './views/SchemaView'
import type { SchemaViewHandle } from './views/SchemaView'
import PeersView from './views/PeersView'
import CommitsView from './views/CommitsView'
import { useUIStore } from './store/uiStore'
import { useCollectionViewNames } from './hooks/useCollections'
import styles from './App.module.css'

export default function App() {
  const activeTab           = useUIStore(s => s.activeTab)
  const setActiveTab        = useUIStore(s => s.setActiveTab)
  const activeCollection    = useUIStore(s => s.activeCollection)
  const setActiveCollection = useUIStore(s => s.setActiveCollection)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [mountedTabs, setMountedTabs]   = useState<Set<Tab>>(() => {
    const initial = new Set<Tab>(['dashboard'])
    if (activeCollection) initial.add('collections')
    initial.add(activeTab)
    return initial
  })
  const { data: viewNames } = useCollectionViewNames()
  const [commitsJump, setCommitsJump] = useState<{ docID: string; seq: number } | null>(null)
  const collectionsRef = useRef<CollectionsViewHandle>(null)
  const schemaRef      = useRef<SchemaViewHandle>(null)
  const queryRef       = useRef<QueryViewHandle>(null)

  function selectTab(tab: Tab) {
    setMountedTabs(prev => { const next = new Set(prev); next.add(tab); return next })
    setActiveTab(tab)
  }

  function selectCollection(name: string) {
    setActiveCollection(name)
    selectTab('collections')
  }

  function clearCollection() {
    setActiveCollection(null)
  }

  return (
    <div className={styles.shell}>
      <Topbar onOpenSettings={() => setSettingsOpen(true)} />
      <div className={styles.body}>
        <Sidebar
          activeCollection={activeCollection}
          onSelectCollection={selectCollection}
          activeTab={activeTab}
          onSelectTab={selectTab}
        />
        <main className={styles.main}>
          <TabBar
            activeTab={activeTab}
            onTabChange={selectTab}
            onNewDocument={() => collectionsRef.current?.openNewDoc()}
            isViewSelected={!!(activeCollection && viewNames?.has(activeCollection))}
            onExport={() => collectionsRef.current?.exportDocs()}
            onNewType={() => schemaRef.current?.openCreate()}
            onPatchType={() => schemaRef.current?.openPatch()}
            onNewView={() => { schemaRef.current?.openCreateView(); selectTab('schema') }}
          />
          <div className={styles.content}>
            {mountedTabs.has('dashboard') && (
              <div className={styles.tabPane} hidden={activeTab !== 'dashboard'}><DashboardView /></div>
            )}
            {mountedTabs.has('collections') && (
              <div className={styles.tabPane} hidden={activeTab !== 'collections'}>
                <CollectionsView
                  ref={collectionsRef}
                  collection={activeCollection}
                  onViewSchema={name => { schemaRef.current?.selectType(name); selectTab('schema') }}
                  onCollectionInvalid={clearCollection}
                  onOpenInQueryRunner={query => { selectTab('query'); setTimeout(() => queryRef.current?.openQuery(query), 0) }}
                  onViewCommitGraph={docID => {
                    setCommitsJump(prev => ({ docID, seq: (prev?.seq ?? 0) + 1 }))
                    selectTab('commits')
                  }}
                />
              </div>
            )}
            {mountedTabs.has('query') && (
              <div className={styles.tabPane} hidden={activeTab !== 'query'}><QueryView ref={queryRef} onOpenInCollections={(collection, docID) => {
                setActiveCollection(collection)
                selectTab('collections')
                setTimeout(() => collectionsRef.current?.openDoc(docID), 0)
              }} /></div>
            )}
            {mountedTabs.has('schema') && (
              <div className={styles.tabPane} hidden={activeTab !== 'schema'}><SchemaView ref={schemaRef} /></div>
            )}
            {mountedTabs.has('peers') && (
              <div className={styles.tabPane} hidden={activeTab !== 'peers'}><PeersView /></div>
            )}
            {mountedTabs.has('commits') && (
              <div className={styles.tabPane} hidden={activeTab !== 'commits'}><CommitsView
                jump={commitsJump}
                onOpenInQueryRunner={query => { selectTab('query'); setTimeout(() => queryRef.current?.openQuery(query), 0) }}
                onOpenInCollections={(collection, docID) => {
                  setActiveCollection(collection)
                  selectTab('collections')
                  setTimeout(() => collectionsRef.current?.openDoc(docID), 0)
                }}
              /></div>
            )}
          </div>
        </main>
      </div>

      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
    </div>
  )
}
