/** `GET /api/meta`: databases, defaults, and the effective actor. */
import { computed, signal } from "@preact/signals";
import { api } from "../lib/api.ts";
import type { DatabaseInfo, Meta } from "../lib/bff-types.ts";
import { actorPref } from "./prefs.ts";

export const meta = signal<Meta | null>(null);
export const metaError = signal<unknown>(null);
export const metaLoading = signal(false);

export const databases = computed<DatabaseInfo[]>(() => meta.value?.databases ?? []);
export const actor = computed(() => actorPref.value ?? meta.value?.actorDefault ?? "bddb");

export async function loadMeta(): Promise<Meta | null> {
  metaLoading.value = true;
  try {
    const value = await api.meta();
    meta.value = value;
    metaError.value = null;
    return value;
  } catch (err) {
    metaError.value = err;
    return null;
  } finally {
    metaLoading.value = false;
  }
}

/** Merge a `status` frame into the meta database list so the header reflects it. */
export function updateDatabaseInfo(info: DatabaseInfo): void {
  const current = meta.value;
  if (!current) return;
  const exists = current.databases.some((d) => d.name === info.name);
  meta.value = {
    ...current,
    databases: exists
      ? current.databases.map((d) => (d.name === info.name ? info : d))
      : [...current.databases, info],
  };
}
