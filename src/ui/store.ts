import type { AppSettings, PipeCatalog, Project } from '../types';
import { uid } from '../types';
import { repos, Stores } from '../core/db/indexeddb';
import { factoryProject, garageProject } from '../data/samples';
import { defaultCatalog } from '../core/pipes/catalog';

// 全局应用状态 + 发布订阅
export interface AppState {
  projects: Project[];
  catalogs: PipeCatalog[];
  currentId: string | null;
  settings: AppSettings;
  route: string;
}

type Listener = (s: AppState) => void;

const defaultSettings: AppSettings = {
  id: 'singleton',
  defaultCatalogId: 'cat_default',
  renderScale: 1,
  showFps: true,
};

class Store {
  state: AppState = {
    projects: [],
    catalogs: [],
    currentId: null,
    settings: defaultSettings,
    route: location.hash.slice(1) || 'projects',
    routeDirty: false,
  } as AppState;

  private listeners = new Set<Listener>();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn(this.state);
  }

  async init(): Promise<void> {
    let [projects, catalogs, settings] = await Promise.all([
      repos.listProjects(),
      repos.listCatalogs(),
      repos.getSettings(),
    ]);
    if (!catalogs.find((c) => c.id === 'cat_default')) {
      const cat = defaultCatalog();
      await repos.saveCatalog(cat);
      catalogs = [cat];
    }
    if (!settings) {
      settings = defaultSettings;
      await repos.saveSettings(settings);
    }
    this.state = {
      ...this.state,
      projects,
      catalogs,
      settings,
      currentId: projects[0]?.id ?? null,
    };
    window.addEventListener('hashchange', () => {
      this.state.route = location.hash.slice(1) || 'projects';
      this.emit();
    });
    this.emit();
  }

  get current(): Project | null {
    return this.state.projects.find((p) => p.id === this.state.currentId) ?? null;
  }

  get catalog(): PipeCatalog {
    const p = this.current;
    return this.state.catalogs.find((c) => c.id === (p?.catalogId ?? this.state.settings.defaultCatalogId))
      ?? this.state.catalogs[0]
      ?? defaultCatalog();
  }

  navigate(route: string): void {
    location.hash = route;
  }

  async createProject(kind: 'factory' | 'garage' | 'blank'): Promise<Project> {
    let project: Project;
    let catalog = this.state.catalogs[0] ?? defaultCatalog();
    if (kind === 'factory') ({ project, catalog } = factoryProject());
    else if (kind === 'garage') ({ project, catalog } = garageProject());
    else project = this.blankProject();
    if (!this.state.catalogs.find((c) => c.id === catalog.id)) {
      await repos.saveCatalog(catalog);
      this.state.catalogs = [...this.state.catalogs, catalog];
    }
    project.catalogId = catalog.id;
    await repos.saveProject(project);
    this.state.projects = [...this.state.projects, project];
    this.state.currentId = project.id;
    this.emit();
    return project;
  }

  private blankProject(): Project {
    const now = Date.now();
    const scheme = {
      id: uid('scheme'), name: '方案A', createdAt: now,
      pipes: [],
    };
    return {
      id: uid('proj'),
      name: '新项目',
      createdAt: now,
      updatedAt: now,
      kind: 'custom',
      room: {
        width: 18, depth: 12, height: 4.5, bayX: 6, bayZ: 6,
        wallReflectance: 0.5, floorReflectance: 0.2, ceilingReflectance: 0.7,
      },
      objects: [],
      schemes: [scheme],
      activeSchemeId: scheme.id,
      sky: {
        model: 'overcast', latitude: 31.23, longitude: 121.47, timezone: 8,
        date: '2026-03-20', hour: 12, turbidity: 3.5, manualEh: null,
      },
      probe: { spacing: 3, workPlaneHeight: 0.75, raysPerProbe: 128, probesPerFrame: 16 },
      catalogId: this.state.settings.defaultCatalogId,
      standardMinLux: 300,
    };
  }

  async deleteProject(id: string): Promise<void> {
    await repos.deleteProject(id);
    this.state.projects = this.state.projects.filter((p) => p.id !== id);
    if (this.state.currentId === id) this.state.currentId = this.state.projects[0]?.id ?? null;
    this.emit();
  }

  async duplicateProject(id: string): Promise<void> {
    const src = this.state.projects.find((p) => p.id === id);
    if (!src) return;
    const copy: Project = structuredClone(src);
    copy.id = uid('proj');
    copy.name = `${src.name}（副本）`;
    copy.createdAt = Date.now();
    copy.updatedAt = copy.createdAt;
    copy.schemes = src.schemes.map((s) => ({ ...structuredClone(s), id: uid('scheme') }));
    copy.activeSchemeId = copy.schemes[0].id;
    await repos.saveProject(copy);
    this.state.projects = [...this.state.projects, copy];
    this.emit();
  }

  /** 以 mutation 方式修改当前项目并落库 */
  async mutate(fn: (p: Project) => void): Promise<void> {
    const p = this.current;
    if (!p) return;
    fn(p);
    p.updatedAt = Date.now();
    await repos.saveProject(p);
    this.emit();
  }

  async saveCatalog(c: PipeCatalog): Promise<void> {
    await repos.saveCatalog(c);
    const i = this.state.catalogs.findIndex((x) => x.id === c.id);
    const next = [...this.state.catalogs];
    if (i >= 0) next[i] = c;
    else next.push(c);
    this.state.catalogs = next;
    this.emit();
  }

  async deleteCatalog(id: string): Promise<void> {
    if (id === 'cat_default') return;
    await repos.deleteCatalog(id);
    this.state.catalogs = this.state.catalogs.filter((c) => c.id !== id);
    this.emit();
  }

  async saveSettings(): Promise<void> {
    await repos.saveSettings(this.state.settings);
    this.emit();
  }

  selectProject(id: string): void {
    this.state.currentId = id;
    this.emit();
  }
}

export const store = new Store();
export { Stores };

// 自动化验收钩子
if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__store = store;
}
