// 全局状态 + IndexedDB 持久化 + 首次种子
import type { AppSettings, Project, TubeParamTable } from './types';
import { idb } from './db';
import { DEFAULT_SETTINGS, defaultParamTable, buildSeedProjects } from './seed';

type Listener = () => void;

class Store {
  projects: Project[] = [];
  tables: TubeParamTable[] = [];
  settings: AppSettings = { ...DEFAULT_SETTINGS };
  ready = false;
  private listeners = new Set<Listener>();
  private saveTimers = new Map<string, ReturnType<typeof setTimeout>>();

  async init(): Promise<void> {
    let tables = await idb.getAllTables();
    if (!tables.length) {
      const t = defaultParamTable();
      await idb.putTable(t);
      tables = [t];
    }
    this.tables = tables;

    let projects = await idb.getAllProjects();
    if (!projects.length) {
      const seedTable = tables.find((t) => t.builtin) ?? tables[0];
      const seeds = buildSeedProjects(seedTable);
      for (const p of seeds) await idb.putProject(p);
      projects = seeds;
    }
    this.projects = projects.sort((a, b) => b.updatedAt - a.updatedAt);

    const settings = await idb.getKv<AppSettings>('settings');
    if (settings) this.settings = { ...DEFAULT_SETTINGS, ...settings };
    this.ready = true;
    this.emit();
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  emit(): void {
    this.listeners.forEach((fn) => fn());
  }

  getProject(id: string): Project | undefined {
    return this.projects.find((p) => p.id === id);
  }
  getTable(id: string): TubeParamTable | undefined {
    return this.tables.find((t) => t.id === id);
  }
  defaultTable(): TubeParamTable {
    return this.tables.find((t) => t.builtin) ?? this.tables[0];
  }

  async refreshTables(): Promise<void> {
    this.tables = await idb.getAllTables();
    this.emit();
  }

  /** 更新项目（内存立即改，IndexedDB 防抖写） */
  updateProject(id: string, mutator: (p: Project) => void): Project | undefined {
    const p = this.getProject(id);
    if (!p) return;
    mutator(p);
    p.updatedAt = Date.now();
    this.emit();
    const existing = this.saveTimers.get(id);
    if (existing) clearTimeout(existing);
    this.saveTimers.set(
      id,
      setTimeout(() => {
        void idb.putProject(structuredClone(p));
      }, 350),
    );
    return p;
  }

  async saveProjectNow(id: string): Promise<void> {
    const p = this.getProject(id);
    if (!p) return;
    const t = this.saveTimers.get(id);
    if (t) clearTimeout(t);
    await idb.putProject(structuredClone(p));
  }

  async createProject(p: Project): Promise<void> {
    this.projects.unshift(p);
    await idb.putProject(p);
    this.emit();
  }

  async deleteProject(id: string): Promise<void> {
    this.projects = this.projects.filter((p) => p.id !== id);
    await idb.deleteProject(id);
    this.emit();
  }

  async duplicateProject(id: string): Promise<Project | undefined> {
    const p = this.getProject(id);
    if (!p) return;
    const copy: Project = structuredClone(p);
    copy.id = `proj_${Math.random().toString(36).slice(2, 10)}`;
    copy.name = p.name + ' 副本';
    copy.createdAt = Date.now();
    copy.updatedAt = Date.now();
    this.projects.unshift(copy);
    await idb.putProject(copy);
    this.emit();
    return copy;
  }

  async saveTable(t: TubeParamTable): Promise<void> {
    const i = this.tables.findIndex((x) => x.id === t.id);
    if (i >= 0) this.tables[i] = t;
    else this.tables.push(t);
    await idb.putTable(t);
    this.emit();
  }

  async deleteTable(id: string): Promise<void> {
    this.tables = this.tables.filter((t) => t.id !== id);
    await idb.deleteTable(id);
    this.emit();
  }

  async updateSettings(patch: Partial<AppSettings>): Promise<void> {
    this.settings = { ...this.settings, ...patch };
    await idb.setKv('settings', this.settings);
    this.emit();
  }
}

export const store = new Store();
