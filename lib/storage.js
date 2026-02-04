/**
 * Lazy forms storage helpers.
 * Schema: { version: 1, entries: Entry[] }
 * Entry: { id, value, contextType, contextKey, label?, createdAt, order? }
 * order: optional number for user-defined sort (lower = earlier). Fallback: createdAt.
 */

const STORAGE_KEY = 'lazyForms';
const VERSION = 1;

const DEFAULT_DATA = () => ({ version: VERSION, entries: [] });

/**
 * @returns {Promise<{ version: number, entries: Entry[] }>}
 */
export async function load() {
  const result = await chrome.storage.sync.get(STORAGE_KEY);
  const data = result[STORAGE_KEY];
  if (!data || !Array.isArray(data.entries)) {
    return DEFAULT_DATA();
  }
  return { version: data.version ?? VERSION, entries: data.entries };
}

/**
 * @param {{ version: number, entries: Entry[] }} data
 */
export async function save(data) {
  await chrome.storage.sync.set({ [STORAGE_KEY]: data });
}

/**
 * @param {Entry} entry
 * @returns {Promise<void>}
 */
export async function addEntry(entry) {
  const data = await load();
  data.entries.push(entry);
  await save(data);
}

/**
 * @param {string} id
 * @returns {Promise<Entry | undefined>}
 */
export async function getEntryById(id) {
  const data = await load();
  return data.entries.find((e) => e.id === id);
}

/**
 * @param {string} id
 * @param {Partial<Entry>} updates
 */
export async function updateEntry(id, updates) {
  const data = await load();
  const idx = data.entries.findIndex((e) => e.id === id);
  if (idx === -1) return;
  data.entries[idx] = { ...data.entries[idx], ...updates };
  await save(data);
}

/**
 * @param {string} id
 */
export async function deleteEntry(id) {
  const data = await load();
  data.entries = data.entries.filter((e) => e.id !== id);
  await save(data);
}

/**
 * @typedef {{
 *   id: string;
 *   value: string;
 *   contextType: 'fieldOnly' | 'url' | 'domain' | 'all' | 'urlPattern';
 *   contextKey: string;
 *   label?: string;
 *   createdAt: number;
 * }} Entry
 */
