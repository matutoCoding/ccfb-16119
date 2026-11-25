import { h, mount, button, card, table } from '../dom';
import { store } from '../store';
import type { Project } from '../../types';

export function renderProjects(root: HTMLElement): void {
  const projects = store.state.projects;
  const rows = projects.map((p) => [
    p.name,
    kindLabel(p.kind),
    `${p.room.width}×${p.room.depth}×${p.room.height} m`,
    p.schemes.find((s) => s.id === p.activeSchemeId)?.pipes.filter((x) => x.enabled).length ?? 0,
    new Date(p.updatedAt).toLocaleString('zh-CN', { hour12: false }),
  ]);

  mount(root, [
    h('div', { class: 'page-head' },
      h('div', {},
        h('h2', {}, document.createTextNode('项目列表')),
        h('p', { class: 'muted' }, document.createTextNode('所有数据保存在浏览器 IndexedDB，离线可用')),
      ),
    ),
    h('div', { class: 'create-row' },
      button('新建带货架老厂房（示例）', () => openKind('factory'), 'primary'),
      button('新建地下车库（示例）', () => openKind('garage'), 'primary'),
      button('新建空白项目', () => openKind('blank')),
    ),
    projects.length === 0
      ? h('div', { class: 'empty' }, document.createTextNode('暂无项目，点击上方按钮创建'))
      : card('全部项目',
        table(['项目名', '类型', '空间尺寸', '启用管数', '更新时间'], rows),
        h('div', { class: 'row-actions' },
          ...projects.map((p) =>
            h('div', { class: 'project-card' },
              h('div', { class: 'project-card-name' }, document.createTextNode(p.name)),
              h('div', { class: 'project-card-meta' },
                document.createTextNode(`${kindLabel(p.kind)} · ${p.objects.length} 个构件`),
              ),
              h('div', { class: 'project-card-btns' },
                button('打开', () => openProject(p)),
                button('复制', () => store.duplicateProject(p.id)),
                button('删除', () => {
                  if (confirm(`确认删除项目「${p.name}」？不可恢复`)) store.deleteProject(p.id);
                }, 'danger'),
              ),
            ),
          ),
        ),
      ),
  ]);

  async function openKind(kind: 'factory' | 'garage' | 'blank'): Promise<void> {
    const p = await store.createProject(kind);
    store.selectProject(p.id);
    store.navigate('model');
  }

  function openProject(p: Project): void {
    store.selectProject(p.id);
    store.navigate('model');
  }
}

function kindLabel(k: Project['kind']): string {
  return k === 'factory' ? '老厂房/仓库' : k === 'garage' ? '地下车库' : '自定义';
}
