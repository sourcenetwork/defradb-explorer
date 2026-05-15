import { useState, useEffect, useCallback } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useConfig } from '../context/ConfigContext'
import { checkHealth } from '../api/health'
import styles from './SettingsModal.module.css'

interface Props {
  onClose: () => void
}

function CopyIcon() {
  return (
    <svg width={13} height={13} viewBox="0 0 16 16" fill="none">
      <rect x={5} y={5} width={9} height={9} rx={1.5} stroke="currentColor" strokeWidth={1.4}/>
      <path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round"/>
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg width={13} height={13} viewBox="0 0 16 16" fill="none">
      <polyline points="2.5,8 6,11.5 13.5,4.5" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  )
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '0.0.0.0'])

function isPrivateNetworkScenario(endpoint: string): boolean {
  // Dashboard is on a public origin but the endpoint is a local address
  if (LOCAL_HOSTS.has(window.location.hostname)) return false
  try {
    return LOCAL_HOSTS.has(new URL(endpoint).hostname)
  } catch {
    return false
  }
}

export default function SettingsModal({ onClose }: Props) {
  const { config, setConfig } = useConfig()
  const queryClient = useQueryClient()

  const [baseUrl, setBaseUrl] = useState(config.baseUrl)
  const [token, setToken] = useState(config.token ?? '')
  const [testing, setTesting]       = useState(false)
  const [testResult, setTestResult] = useState<'ok' | 'fail' | null>(null)
  const [copied, setCopied]         = useState(false)

  const corsCommand = `defradb start --allowed-origins ${window.location.origin}`
  const showPNAWarning = isPrivateNetworkScenario(baseUrl)

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(corsCommand).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }, [corsCommand])

  // close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  async function handleTest() {
    setTesting(true)
    setTestResult(null)
    try {
      const ok = await checkHealth({ baseUrl: baseUrl.trim(), token: token.trim() || undefined })
      setTestResult(ok ? 'ok' : 'fail')
    } catch {
      setTestResult('fail')
    } finally {
      setTesting(false)
    }
  }

  function handleSave() {
    const next = { baseUrl: baseUrl.trim(), token: token.trim() || undefined }
    setConfig(next)
    queryClient.clear()
    onClose()
  }

  return (
    <div className={styles.overlay} onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className={styles.modal} role="dialog" aria-modal="true" aria-label="Connection settings">
        <div className={styles.header}>
          <h2 className={styles.title}>Connection settings</h2>
          <button className={styles.closeBtn} onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className={styles.body}>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="defra-url">DefraDB endpoint</label>
            <input
              id="defra-url"
              className={styles.input}
              type="url"
              value={baseUrl}
              onChange={e => { setBaseUrl(e.target.value); setTestResult(null) }}
              placeholder="http://localhost:9181"
              spellCheck={false}
            />
            <div className={styles.corsHint}>
              <p className={styles.hint}>Start DefraDB with CORS enabled:</p>
              <div className={styles.codeRow}>
                <code className={styles.code}>{corsCommand}</code>
                <button className={styles.copyBtn} onClick={handleCopy} title="Copy to clipboard">
                  {copied ? <CheckIcon /> : <CopyIcon />}
                </button>
              </div>
            </div>
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor="defra-token">Auth token <span className={styles.optional}>(optional)</span></label>
            <input
              id="defra-token"
              className={styles.input}
              type="password"
              value={token}
              onChange={e => { setToken(e.target.value); setTestResult(null) }}
              placeholder="Bearer token for ACP-enabled instances"
              spellCheck={false}
            />
          </div>

          {showPNAWarning && (
            <div className={styles.pnaWarning}>
              <p className={styles.pnaTitle}>⚠ Private Network Access blocked</p>
              <p className={styles.pnaBody}>
                Chrome 130+ blocks requests from public pages to <code>localhost</code>.
                To connect from this hosted dashboard you have two options:
              </p>
              <ol className={styles.pnaList}>
                <li>
                  Open this dashboard at{' '}
                  <code className={styles.pnaCode}>http://localhost:5173</code>{' '}
                  instead (run <code className={styles.pnaCode}>npm run dev</code> locally).
                </li>
                <li>
                  Disable the Chrome check:{' '}
                  <code className={styles.pnaCode}>chrome://flags/#private-network-access-send-preflights</code>
                  {' '}→ set to <strong>Disabled</strong> and relaunch.
                </li>
              </ol>
            </div>
          )}

          {testResult && (
            <div className={`${styles.testResult} ${testResult === 'ok' ? styles.testOk : styles.testFail}`}>
              {testResult === 'ok'
                ? '✓ Connected successfully'
                : showPNAWarning
                  ? '✗ Blocked — see the Private Network Access warning above'
                  : '✗ Could not reach endpoint — check the URL and CORS settings'}
            </div>
          )}
        </div>

        <div className={styles.footer}>
          <button className={styles.btnTest} onClick={handleTest} disabled={testing}>
            {testing ? 'Testing…' : 'Test connection'}
          </button>
          <div className={styles.footerRight}>
            <button className={styles.btnCancel} onClick={onClose}>Cancel</button>
            <button className={styles.btnSave} onClick={handleSave}>Save &amp; reconnect</button>
          </div>
        </div>
      </div>
    </div>
  )
}
