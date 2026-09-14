/** "New issue" modal request: which prefills to open it with (`null` = closed). */
import { signal } from "@preact/signals";

export interface CreatePrefill {
  status?: string | undefined;
  parent?: string | undefined;
  priority?: number | undefined;
}

export const createRequest = signal<CreatePrefill | null>(null);

export function openCreate(prefill: CreatePrefill = {}): void {
  createRequest.value = prefill;
}

export function closeCreate(): void {
  createRequest.value = null;
}
