// Hash 路由 + 应用外壳（侧边导航 / 顶栏）
import { store } from './core/store';
import { h, clear } from './ui/dom';
import { renderProjects } from './ui/pages/projects';
import { renderModel } from './ui/pages/model';
import { renderTubes } from './ui/pages/tubes';
import { renderAnalysisPage } from './ui/pages/analysis';
import { renderCompare } from './ui/pages/compare';
import { renderSettings } from './ui/pages/settings';

type Route =
  | { name: 'projects' }
  | { name: 'settings' }
  | { name: 'model'; id: string }
  | { name: 'tubes'; id: string }
  | { name: 'analysis'; id: string }
  | { name: 'compare'; id: string };

function parseHash(): Route {
  const hash = location.hash.replace(/^#/, '') || '/';
  const parts = hash.split('/').filter(Boolean);
  if (parts[0] === 'settings') return { name: 'settings' };
  if (parts[0] === 'project' && parts[1]) {
    const id = parts[1];
    const sub = parts[2] ?? 'analysis';
    if (sub === 'model') return { name: 'model', id };
    if (sub === 'tubes') return { name: 'tubes', id };
    if (sub === 'compare') return { name: 'compare', id };
    return { name: 'analysis', id };
  }
  return { name: 'projects' };
}

const NAV = [
  { key: 'projects', label: '项目列表', ico: '▦', hash: '#/' },
  { key: 'model', label: '空间建模', ico: '◈', proj: true },
  { key: 'tubes', label: '管道选型', ico: '◉', proj: true },
  { key: 'analysis', label: '照度分析', ico: '☀', proj: true },
  { key: 'compare', label: '方案对比', ico: '⇉', proj: true },
  { key: 'settings', label: '设置 / 校核', ico: '⚙', hash: '#/settings' },
];

export function startApp(root: HTMLElement): void {
  const shell = h('div', { class: 'app-shell' });
  const sidebar = h('aside', { class: 'sidebar' });
  const main = h('div', { class: 'main' });
  const topbar = h('header', { class: 'topbar' });
  const content = h('main', { class: 'content' });
  main.appendChild(topbar);
  main.appendChild(content);
  shell.appendChild(sidebar);
  shell.appendChild(main);
  root.appendChild(shell);

  let cleanup: (() => void) | null = null;

  function renderSidebar(route: Route): void {
    clear(sidebar);
    sidebar.appendChild(
      h('div', { class: 'brand' },
        h('div', { class: 'brand-mark' }, '光'),
        h('div', null,
          h('div', { class: 'brand-name' }, '光导采光设计'),
          h('div', { class: 'brand-sub' }, 'TUBELIGHT STUDIO'),
        ),
      ),
    );
    sidebar.appendChild(h('div', { class: 'nav-section' }, '工作台'));
    for (const item of NAV) {
      if (item.proj) {
        const active = route.name === item.key;
        const navBtn = h('button', { class: `nav-item${active ? ' active' : ''}` },
          h('span', { class: 'ico' }, item.ico), item.label) as HTMLButtonElement;
        navBtn.addEventListener('click', () => {
          const id = currentProjectId(route);
          if (id) location.hash = `#/project/${id}/${item.key}`;
          else location.hash = '#/';
        });
        sidebar.appendChild(navBtn);
      } else {
        const active = route.name === item.key;
        const a = h('a', {
          class: `nav-item${active ? ' active' : ''}`,
          href: item.hash,
        }, h('span', { class: 'ico' }, item.ico), item.label);
        sidebar.appendChild(a);
      }
    }
    sidebar.appendChild(h('div', { class: 'sidebar-foot' },
      h('div', null, 'TypeScript · WebGL2'),
      h('div', null, 'BVH / 探针 GI / CIE 天空'),
      h('div', { style: 'margin-top:6px' }, '数据仅存于本机 IndexedDB'),
    ));
  }

  function currentProjectId(route: Route): string | null {
    if ('id' in route) return route.id;
    return store.projects[0]?.id ?? null;
  }

  function renderTopbar(route: Route): void {
    clear(topbar);
    const labels: Record<string, string> = {
      projects: '项目列表', settings: '设置与精度校核', model: '空间建模',
      tubes: '管道选型', analysis: '照度分析', compare: '方案对比',
    };
    const crumb = h('div', { class: 'crumb' }, labels[route.name] ?? '');
    if ('id' in route) {
      const p = store.getProject(route.id);
      if (p) {
        crumb.appendChild(h('span', { class: 'sep' }, '/'));
        crumb.appendChild(h('span', { class: 'sub' }, p.name));
      }
    }
    topbar.appendChild(crumb);
    const right = h('div', { class: 'topbar-right' });
    if ('id' in route) {
      const p = store.getProject(route.id);
      if (p) {
        const scheme = p.schemes.find((s) => s.id === p.activeSchemeId) ?? p.schemes[0];
        const sel = h('select', { title: '当前方案' }) as HTMLSelectElement;
        for (const s of p.schemes) {
          const o = h('option', { value: s.id }, s.name) as HTMLOptionElement;
          if (scheme && s.id === scheme.id) o.selected = true;
          sel.appendChild(o);
        }
        sel.addEventListener('change', () => {
          store.updateProject(p.id, (pp) => { pp.activeSchemeId = sel.value; });
          void renderRoute();
        });
        right.appendChild(h('span', { class: 'small muted' }, '当前方案'));
        right.appendChild(sel);
        right.appendChild(h('button', {
          class: 'btn btn-ghost btn-sm',
          onclick: () => store.saveProjectNow(p.id).then(() => flashSaved()),
        }, '保存'));
      }
    }
    topbar.appendChild(right);
  }

  let saveFlash: HTMLElement | null = null;
  function flashSaved(): void {
    if (saveFlash) saveFlash.remove();
    saveFlash = h('span', { class: 'badge badge-ok' }, '已保存到 IndexedDB');
    topbar.querySelector('.topbar-right')?.prepend(saveFlash);
    setTimeout(() => saveFlash?.remove(), 1800);
  }

  async function renderRoute(): Promise<void> {
    const r = parseHash();
    renderSidebar(r);
    renderTopbar(r);
    if (cleanup) {
      try { cleanup(); } catch { /* noop */ }
      cleanup = null;
    }
    clear(content);
    content.classList.remove('nopad');

    if (!store.ready) await store.init();

    if (r.name === 'projects') {
      content.appendChild(renderProjects());
    } else if (r.name === 'settings') {
      content.appendChild(renderSettings());
    } else {
      const p = store.getProject(r.id);
      if (!p) {
        content.appendChild(h('div', { class: 'card' }, h('div', { class: 'card-body' },
          h('p', null, '项目不存在或已删除。'),
          h('a', { class: 'btn btn-primary', href: '#/' }, '返回项目列表'),
        )));
        return;
      }
      if (r.name === 'model') cleanup = renderModel(content, p.id) ?? null;
      else if (r.name === 'tubes') cleanup = renderTubes(content, p.id) ?? null;
      else if (r.name === 'analysis') cleanup = renderAnalysisPage(content, p.id) ?? null;
      else if (r.name === 'compare') cleanup = renderCompare(content, p.id) ?? null;
    }
  }

  window.addEventListener('hashchange', () => void renderRoute());
  void renderRoute();
}
