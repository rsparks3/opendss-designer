// NLR Developer Network credentials (API key + contact email) for the NSRDB
// irradiance fetcher. Remembered per browser in localStorage; the backend
// only ever sees them per request and never stores them.

const STORAGE_KEY = 'opendss-designer.nlrApiCred'

export interface NlrCreds {
  apiKey: string
  email: string
}

export function loadNlrCreds(): NlrCreds | null {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '')
    if (typeof raw?.apiKey === 'string' && raw.apiKey.trim() && typeof raw?.email === 'string') {
      return { apiKey: raw.apiKey, email: raw.email }
    }
  } catch {
    // unset, corrupt, or storage unavailable
  }
  return null
}

export function saveNlrCreds(creds: NlrCreds): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(creds))
  } catch {
    // storage unavailable — the session still works, it just won't remember
  }
}

export function clearNlrCreds(): void {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // storage unavailable
  }
}

/** '••••abcd' style hint so the UI can show which key is in use. */
export function maskKey(apiKey: string): string {
  return `••••${apiKey.slice(-4)}`
}
