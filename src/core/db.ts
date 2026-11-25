// IndexedDB 持久化：projects / tables / kv 三个对象仓库
import type { AppSettings, Project, TubeParamTable } from './types';

const DB_NAME = 'tubelight-studio';
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('projects')) {
        db.createObjectStore('projects', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('tables')) {
        db.createObjectStore('tables', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('kv')) {
        db.createObjectStore('kv');
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
  fn: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

export const idb = {
  async getAllProjects(): Promise<Project[]> {
    try {
      return await tx('projects', 'readonly', (s) => s.getAll() as IDBRequest<Project[]>);
    } catch {
      return [];
    }
  },
  async getProject(id: string): Promise<Project | undefined> {
    return tx('projects', 'readonly', (s) => s.get(id) as IDBRequest<Project | undefined>);
  },
  async putProject(p: Project): Promise<void> {
    p.updatedAt = Date.now();
    await tx('projects', 'readwrite', (s) => s.put(p) as IDBRequest<IDBValidKey>);
  },
  async deleteProject(id: string): Promise<void> {
    await tx('projects', 'readwrite', (s) => s.delete(id));
  },

  async getAllTables(): Promise<TubeParamTable[]> {
    try {
      return await tx('tables', 'readonly', (s) => s.getAll() as IDBRequest<TubeParamTable[]>);
    } catch {
      return [];
    }
  },
  async putTable(t: TubeParamTable): Promise<void> {
    await tx('tables', 'readwrite', (s) => s.put(t) as IDBRequest<IDBValidKey>);
  },
  async deleteTable(id: string): Promise<void> {
    await tx('tables', 'readwrite', (s) => s.delete(id));
  },

  async getKv<T>(key: string): Promise<T | undefined> {
    return tx('kv', 'readonly', (s) => s.get(key) as IDBRequest<T | undefined>);
  },
  async setKv<T>(key: string, value: T): Promise<void> {
    await tx('kv', 'readwrite', (s) => s.put(value, key) as IDBRequest<IDBValidKey>);
  },

  async exportAll(): Promise<string> {
    const [projects, tables] = await Promise.all([
      this.getAllProjects(),
      this.getAllTables(),
    ]);
    const settings = await this.getKv<AppSettings>('settings');
    return JSON.stringify({ app: 'tubelight-studio', version: 1, projects, tables, settings }, null, 2);
  },

  async importAll(json: string): Promise<{ projects: number; tables: number }> {
    const data = JSON.parse(json);
    let pc = 0;
    let tc = 0;
    if (Array.isArray(data.projects)) {
      for (const p of data.projects as Project[]) {
        await this.putProject(p);
        pc++;
      }
    }
    if (Array.isArray(data.tables)) {
      for (const t of data.tables as TubeParamTable[]) {
        await this.putTable(t);
        tc++;
      }
    }
    if (data.settings) await this.setKv('settings', data.settings);
    return { projects: pc, tables: tc };
  },

  async clearAll(): Promise<void> {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction(['projects', 'tables', 'kv'], 'readwrite');
      t.objectStore('projects').clear();
      t.objectStore('tables').clear();
      t.objectStore('kv').clear();
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  },
};
