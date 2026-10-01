// SPDX-License-Identifier: GPL-3.0-or-later
// Entry persistence for the vinyl test page: IndexedDB when the browser
// offers it, otherwise the same interface over a Map so a private window
// still works for one session. Saving is the explicit action; nothing is
// written before the person taps "save".

const DB_NAME = 'musiclinkii-vinyl-test';
const DB_VERSION = 1;
const STORE = 'entries';

const promisify = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
});

function openDatabase(indexedDB, name) {
  return new Promise((resolve, reject) => {
    let request;
    try {
      request = indexedDB.open(name, DB_VERSION);
    } catch (error) {
      reject(error);
      return;
    }
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE)) database.createObjectStore(STORE, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB could not be opened'));
    request.onblocked = () => reject(new Error('IndexedDB is blocked by another tab'));
  });
}

function memoryStore() {
  const entries = new Map();
  return {
    persistent: false,
    async put(entry) { entries.set(entry.id, entry); },
    async getAll() { return [...entries.values()]; },
    async deleteById(id) { entries.delete(id); },
    async clear() { entries.clear(); },
  };
}

function databaseStore(database) {
  const run = (mode, action) => {
    const transaction = database.transaction(STORE, mode);
    return promisify(action(transaction.objectStore(STORE)));
  };
  return {
    persistent: true,
    put: (entry) => run('readwrite', (store) => store.put(entry)).then(() => undefined),
    getAll: () => run('readonly', (store) => store.getAll()),
    deleteById: (id) => run('readwrite', (store) => store.delete(id)).then(() => undefined),
    clear: () => run('readwrite', (store) => store.clear()).then(() => undefined),
  };
}

export async function openEntryStore({ indexedDB = globalThis.indexedDB, name = DB_NAME } = {}) {
  if (!indexedDB) return memoryStore();
  try {
    return databaseStore(await openDatabase(indexedDB, name));
  } catch {
    return memoryStore();
  }
}
