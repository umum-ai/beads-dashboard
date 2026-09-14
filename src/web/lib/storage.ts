/** localStorage under the `bddb.` prefix; every access is guarded (private mode, quotas). */

export const STORAGE_PREFIX = "bddb.";

export function readStored<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + key);
    if (raw === null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function writeStored(key: string, value: unknown): void {
  try {
    if (value === undefined || value === null) localStorage.removeItem(STORAGE_PREFIX + key);
    else localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(value));
  } catch {
    // storage unavailable: preferences simply do not persist
  }
}

/** sessionStorage counterpart (per tab, cleared when the tab closes), same prefix and guards. */
export function readSession<T>(key: string, fallback: T): T {
  try {
    const raw = sessionStorage.getItem(STORAGE_PREFIX + key);
    if (raw === null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function writeSession(key: string, value: unknown): void {
  try {
    if (value === undefined || value === null) sessionStorage.removeItem(STORAGE_PREFIX + key);
    else sessionStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(value));
  } catch {
    // storage unavailable
  }
}
