import type { AppSettings, PipeCatalog, Project } from '../../types';

// 轻量 IndexedDB Promise 封装，所有项目数据本地持久化，无后端。

const DB_NAME = 'tubedaylight-studio';
const DB_VERSION = 1;
const STORES = {
  projects: 'projects',
  catalogs: 'catalogs',
  settings: 'settings',
} as const;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORES.projects)) {
        db.createObjectStore(STORES.projects, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORES.catalogs)) {
        db.createObjectStore(STORES.catalogs, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORES.settings)) {
        db.createObjectStore(STORES.settings, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(
  store: string,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        req.onsuccess = () => resolve(req.result as T);
        req.onerror = () => reject(req.error);
      }),
  );
}

export const idb = {
  async list<T>(store: string): Promise<T[]> {
    return tx<T[]>(store, 'readonly', (s) => s.getAll());
  },
  async get<T>(store: string, key: string): Promise<T | undefined> {
    return tx<T | undefined>(store, 'readonly', (s) => s.get(key));
  },
  async put<T>(store: string, value: T): Promise<void> {
    await tx(store, 'readwrite', (s) => s.put(value));
  },
  async bulkPut<T>(store: string, values: T[]): Promise<void> {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction(store, 'readwrite');
      const s = t.objectStore(store);
      for (const v of values) s.put(v);
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  },
  async delete(store: string, key: string): Promise<void> {
    await tx(store, 'readwrite', (s) => s.delete(key));
  },
  async clear(store: string): Promise<void> {
    await tx(store, 'readwrite', (s) => s.clear());
  },
};

export const Stores = STORES;

export interface Repos {
  listProjects: () => Promise<Project[]>;
  getProject: (id: string) => Promise<Project | undefined>;
  saveProject: (p: Project) => Promise<void>;
  deleteProject: (id: string) => Promise<void>;
  listCatalogs: () => Promise<PipeCatalog[]>;
  saveCatalog: (c: PipeCatalog) => Promise<void>;
  deleteCatalog: (id: string) => Promise<void>;
  getSettings: () => Promise<AppSettings | undefined>;
  saveSettings: (s: AppSettings) => Promise<void>;
}

export const repos: Repos = {
  listProjects: () => idb.list<Project>(STORES.projects),
  getProject: (id) => idb.get<Project>(STORES.projects, id),
  saveProject: (p) => idb.put(STORES.projects, p),
  deleteProject: (id) => idb.delete(STORES.projects, id),
  listCatalogs: () => idb.list<PipeCatalog>(STORES.catalogs),
  saveCatalog: (c) => idb.put(STORES.catalogs, c),
  deleteCatalog: (id) => idb.delete(STORES.catalogs, id),
  getSettings: () => idb.get<AppSettings>(STORES.settings, 'singleton'),
  saveSettings: (s) => idb.put(STORES.settings, s),
};
