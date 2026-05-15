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
import styles from './App.module.css'

const LAST_COLLECTION_KEY = 'defradb:lastCollection'

export default function App() {
  const [activeCollection, setActiveCollection] = useState<string | null>(() =>
    localStorage.getItem(LAST_COLLECTION_KEY)
  )
  const [activeTab, setActiveTab] = useState<Tab>(() =>
    localStorage.getItem(LAST_COLLECTION_KEY) ? 'collections' : 'dashboard'
  )
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [mountedTabs, setMountedTabs]   = useState<Set<Tab>>(() =>
    new Set<Tab>(localStorage.getItem(LAST_COLLECTION_KEY) ? ['dashboard', 'collections'] : ['dashboard'])
  )
  const collectionsRef = useRef<CollectionsViewHandle>(null)
  const schemaRef      = useRef<SchemaViewHandle>(null)
  const queryRef       = useRef<QueryViewHandle>(null)

  function selectTab(tab: Tab) {
    setMountedTabs(prev => { const next = new Set(prev); next.add(tab); return next })
    setActiveTab(tab)
  }

  function selectCollection(name: string) {
    localStorage.setItem(LAST_COLLECTION_KEY, name)
    setActiveCollection(name)
    selectTab('collections')
  }

  function clearCollection() {
    localStorage.removeItem(LAST_COLLECTION_KEY)
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
            onExport={() => collectionsRef.current?.exportDocs()}
            onNewType={() => schemaRef.current?.openCreate()}
            onPatchType={() => schemaRef.current?.openPatch()}
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
                  onOpenInQueryRunner={query => { queryRef.current?.openQuery(query); selectTab('query') }}
                />
              </div>
            )}
            {mountedTabs.has('query') && (
              <div className={styles.tabPane} hidden={activeTab !== 'query'}><QueryView ref={queryRef} /></div>
            )}
            {mountedTabs.has('schema') && (
              <div className={styles.tabPane} hidden={activeTab !== 'schema'}><SchemaView ref={schemaRef} /></div>
            )}
            {mountedTabs.has('peers') && (
              <div className={styles.tabPane} hidden={activeTab !== 'peers'}><PeersView /></div>
            )}
            {mountedTabs.has('commits') && (
              <div className={styles.tabPane} hidden={activeTab !== 'commits'}><CommitsView /></div>
            )}
          </div>
        </main>
      </div>

      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
    </div>
  )
}
