import { h, mount } from './dom';
import { store } from './store';
import { renderProjects } from './pages/projects';
import { renderModel } from './pages/model';
import { renderPipes } from './pages/pipes';
import { renderSky } from './pages/sky';
import { renderAnalysis } from './pages/analysis';
import { renderCompare } from './pages/compare';
import { renderSettings } from './pages/settings';

const NAV = [
  { route: 'projects', label: '项目列表', icon: '▦' },
  { route: 'model', label: '空间建模', icon: '◳' },
  { route: 'pipes', label: '管道选型', icon: '◎' },
  { route: 'sky', label: '室外天空', icon: '☁' },
  { route: 'analysis', label: '照度分析', icon: '◐' },
  { route: 'compare', label: '方案对比', icon: '⇌' },
  { route: 'settings', label: '设置', icon: '⚙' },
] as const;

type Route = (typeof NAV)[number]['route'];

export class App {
  private root: HTMLElement;
  private content: HTMLElement;

  constructor(root: HTMLElement) {
    this.root = root;
    this.content = h('main', { class: 'content' });
  }

  async start(): Promise<void> {
    await store.init();
    store.subscribe(() => this.render());
    this.render();
  }

  private render(): void {
    const route = (store.state.route || 'projects').split('/')[0] as Route;
    const current = store.current;
    mount(this.root, [
      h('aside', { class: 'sidebar' },
        h('div', { class: 'brand' },
          h('div', { class: 'brand-mark' }, document.createTextNode('光')),
          h('div', {},
            h('div', { class: 'brand-title' }, document.createTextNode('导光管采光设计')),
            h('div', { class: 'brand-sub' }, document.createTextNode('WebGL2 DDGI 照度仿真')),
          ),
        ),
        h('nav', { class: 'nav' },
          ...NAV.map((n) =>
            h('a', {
              class: `nav-item ${route === n.route ? 'active' : ''} ${n.route !== 'projects' && !current ? 'disabled' : ''}`,
              href: `#${n.route}`,
            },
              h('span', { class: 'nav-icon' }, document.createTextNode(n.icon)),
              document.createTextNode(n.label),
            ),
          ),
        ),
        current
          ? h('div', { class: 'current-project' },
            h('div', { class: 'muted small' }, document.createTextNode('当前项目')),
            h('strong', {}, document.createTextNode(current.name)),
          )
          : null,
      ),
      this.content,
    ]);
    const page = this.content;
    if (route === 'projects') renderProjects(page);
    else if (!current) renderProjects(page);
    else if (route === 'model') renderModel(page);
    else if (route === 'pipes') renderPipes(page);
    else if (route === 'sky') renderSky(page);
    else if (route === 'analysis') renderAnalysis(page);
    else if (route === 'compare') renderCompare(page);
    else if (route === 'settings') renderSettings(page);
    else renderProjects(page);
  }
}
