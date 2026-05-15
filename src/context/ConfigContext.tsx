import { createContext, useContext, useState, useEffect, type ReactNode } from 'react'
import type { DefraConfig } from '../api/client'

interface ConfigContextValue {
  config: DefraConfig
  setConfig: (config: DefraConfig) => void
}

const STORAGE_KEY = 'defradb-config'

const DEFAULT_CONFIG: DefraConfig = {
  baseUrl: import.meta.env.VITE_DEFRADB_URL ?? 'http://localhost:9181',
  token:   import.meta.env.VITE_DEFRADB_TOKEN ?? '',
}

const ConfigContext = createContext<ConfigContextValue | null>(null)

export function ConfigProvider({ children }: { children: ReactNode }) {
  const [config, setConfigState] = useState<DefraConfig>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      return stored ? { ...DEFAULT_CONFIG, ...JSON.parse(stored) } : DEFAULT_CONFIG
    } catch {
      return DEFAULT_CONFIG
    }
  })

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config))
  }, [config])

  function setConfig(next: DefraConfig) {
    setConfigState(next)
  }

  return (
    <ConfigContext.Provider value={{ config, setConfig }}>
      {children}
    </ConfigContext.Provider>
  )
}

export function useConfig(): ConfigContextValue {
  const ctx = useContext(ConfigContext)
  if (!ctx) throw new Error('useConfig must be used inside ConfigProvider')
  return ctx
}
