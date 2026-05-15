export interface DefraConfig {
  baseUrl: string
  token?: string
}

export class DefraError extends Error {
  public status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'DefraError'
    this.status = status
  }
}

export async function defraFetch<T>(
  config: DefraConfig,
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const url = `${config.baseUrl}/api/v0${path}`

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((options.headers as Record<string, string>) ?? {}),
  }

  if (config.token) {
    headers['Authorization'] = `Bearer ${config.token}`
  }

  const res = await fetch(url, { ...options, headers })

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    let message = text
    try {
      const parsed = JSON.parse(text)
      if (typeof parsed?.error === 'string') message = parsed.error
    } catch { /* use raw text */ }
    throw new DefraError(res.status, message)
  }

  const text = await res.text()
  if (!text) return undefined as T
  return JSON.parse(text) as T
}
