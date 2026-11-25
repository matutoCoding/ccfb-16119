// 项目列表页：卡片、缩略平面图、新建/复制/删除/导入导出
import { store } from '../../core/store';
import type { Project } from '../../core/types';
import { uid } from '../../core/util';
import { STANDARDS } from '../../core/seed';
import { h, btn, modal, toast, pickTextFile, downloadText, badge } from '../dom';

export function renderProjects(): HTMLElement {
  const wrap = h('div', { class: 'stack' });

  const head = h('div', { class: 'page-head' },
    h('div', null,
      h('div', { class: 'page-title' }, '采光设计项目'),
      h('div', { class: 'page-desc' },
        '按柱网与层高建立空间，选型导光管与厂家参数表，运行 CIE 天空 + 探针动态 GI + BVH 光线求交的照度仿真。数据保存在本机 IndexedDB。'),
    ),
    h('div', { class: 'grow' }),
    btn('导入项目 JSON', async () => {
      const f = await pickTextFile('.json');
      if (!f) return;
      try {
        const { idb } = await import('../../core/db');
        const res = await idb.importAll(f.text);
        await store.init();
        toast(`已导入 ${res.projects} 个项目、${res.tables} 张参数表`, 'ok');
        rerender();
      } catch (e) {
        toast('导入失败：' + (e as Error).message, 'err');
      }
    }, { variant: 'ghost', icon: '⤓' }),
    btn('＋ 新建项目', () => openNewProject(rerender), { variant: 'primary' }),
  );
  wrap.appendChild(head);

  const grid = h('div', { class: 'project-grid' });
  wrap.appendChild(grid);

  function rerender(): void {
    grid.innerHTML = '';
    const newCard = h('div', { class: 'new-card', onclick: () => openNewProject(rerender) },
      h('div', { class: 'plus' }, '＋'),
      h('div', null, '新建空白项目'),
    );
    grid.appendChild(newCard);
    for (const p of store.projects) grid.appendChild(projectCard(p, rerender));
  }
  rerender();

  // 订阅 store 变化（删除等）
  const unsub = store.subscribe(() => {
    if (!wrap.isConnected) unsub();
    else rerender();
  });

  return wrap;
}

function projectCard(p: Project, rerender: () => void): HTMLElement {
  const scheme = p.schemes.find((s) => s.id === p.activeSchemeId) ?? p.schemes[0];
  const tubeCount = scheme?.tubes.filter((t) => t.enabled).length ?? 0;
  const card = h('article', { class: 'project-card', onclick: () => (location.hash = `#/project/${p.id}/analysis`) });

  const thumb = h('div', { class: 'project-thumb' });
  const canvas = h('canvas') as HTMLCanvasElement;
  thumb.appendChild(canvas);
  const tplLabel = p.template === 'factory' ? '老厂房' : p.template === 'garage' ? '地下车库' : '校核间';
  thumb.appendChild(h('div', { class: 'tpl-tag' }, badge(tplLabel, p.template === 'garage' ? 'info' : p.template === 'factory' ? 'warn' : 'ok')));
  card.appendChild(thumb);
  requestAnimationFrame(() => drawThumb(canvas, p));

  card.appendChild(h('div', { class: 'project-body' },
    h('div', { class: 'project-name' }, p.name),
    h('div', { class: 'project-meta' },
      h('span', null, '空间 ', h('b', null, `${p.space.width}×${p.space.depth}×${p.space.height}m`)),
      h('span', null, '导光管 ', h('b', null, `${tubeCount} 根`)),
      h('span', null, '方案 ', h('b', null, `${p.schemes.length} 套`)),
    ),
    h('div', { class: 'project-meta' },
      h('span', null, p.sky.location.name),
      h('span', null, p.sky.type === 'overcast' ? 'CIE 全阴天' : 'CIE 晴天'),
      h('span', null, `标准 ${p.standard.requiredAvg}lx`),
    ),
  ));

  const actions = h('div', { class: 'project-actions' },
    btn('照度分析', (e) => { e.stopPropagation(); location.hash = `#/project/${p.id}/analysis`; }, { variant: 'primary' }),
    btn('建模', (e) => { e.stopPropagation(); location.hash = `#/project/${p.id}/model`; }, { variant: 'ghost' }),
    btn('⧉', async (e) => {
      e.stopPropagation();
      const c = await store.duplicateProject(p.id);
      if (c) toast('已复制项目', 'ok');
      rerender();
    }, { variant: 'ghost', title: '复制项目' }),
    btn('🗑', (e) => {
      e.stopPropagation();
      confirmDelete(p, rerender);
    }, { variant: 'danger', title: '删除' }),
  );
  card.appendChild(actions);
  return card;
}

function confirmDelete(p: Project, rerender: () => void): void {
  const body = h('div', null,
    h('p', { class: 'small' }, `确定删除「${p.name}」？该操作同时清除其 IndexedDB 数据，不可恢复。`),
    h('div', { class: 'flex gap12 mt16', style: 'justify-content:flex-end' },
      btn('取消', () => m.close(), { variant: 'ghost' }),
      btn('删除', async () => {
        await store.deleteProject(p.id);
        m.close();
        toast('项目已删除', 'ok');
        rerender();
      }, { variant: 'danger' }),
    ),
  );
  const m = modal('删除项目', body, { width: 420 });
}

function openNewProject(rerender: () => void): void {
  let name = '新建采光项目';
  let tpl: 'factory' | 'garage' | 'blank' = 'blank';
  const nameInput = h('input', { type: 'text', value: name }) as HTMLInputElement;
  nameInput.addEventListener('input', () => (name = nameInput.value));
  const tplCards = [
    { id: 'factory' as const, title: '带货架老厂房', desc: '48×24×8m · 6×3 跨柱网 · 成排货架 · 高侧窗', ico: '🏭' },
    { id: 'garage' as const, title: '地下车库', desc: '48×32×3.8m · 梁+柱 · 无窗 · 24 管方案', ico: '🅿️' },
    { id: 'blank' as const, title: '空白空间', desc: '自定义柱网与尺寸，从零布置', ico: '▢' },
  ];
  const tplRow = h('div', { class: 'row wrap' });
  const renderTpl = () => {
    tplRow.innerHTML = '';
    for (const t of tplCards) {
      const active = tpl === t.id;
      const c = h('div', {
        class: 'card',
        style: `cursor:pointer;flex:1;min-width:150px;${active ? 'border-color:var(--primary);box-shadow:0 0 0 2px rgba(31,111,235,.2)' : ''}`,
        onclick: () => { tpl = t.id; renderTpl(); },
      }, h('div', { class: 'card-body' },
        h('div', { style: 'font-size:26px' }, t.ico),
        h('div', { style: 'font-weight:700;margin:6px 0 3px' }, t.title),
        h('div', { class: 'small muted' }, t.desc),
      ));
      tplRow.appendChild(c);
    }
  };
  renderTpl();

  const body = h('div', { class: 'stack' },
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, '项目名称'), nameInput),
    h('div', { class: 'field-label' }, '选择模板'),
    tplRow,
    h('div', { class: 'flex gap12 mt12', style: 'justify-content:flex-end' },
      btn('取消', () => m.close(), { variant: 'ghost' }),
      btn('创建', () => {
        const p = createProjectFromTemplate(name || '未命名项目', tpl);
        store.createProject(p).then(() => {
          m.close();
          toast('项目已创建并保存到 IndexedDB', 'ok');
          location.hash = `#/project/${p.id}/model`;
        });
      }, { variant: 'primary' }),
    ),
  );
  const m = modal('新建项目', body, { width: 720 });
}

export function createProjectFromTemplate(name: string, tpl: Project['template']): Project {
  // 复用 seed 构造器：通过 buildSeedProjects 取对应模板再克隆改名
  const table = store.defaultTable();
  // 直接动态构造，避免循环依赖 seed 内部未导出的空间函数：用 JSON 深拷贝种子项目
  const seed = store.projects.find((p) =>
    tpl === 'factory' ? p.id === 'proj-factory-demo' : tpl === 'garage' ? p.id === 'proj-garage-demo' : p.id === 'proj-white-check',
  );
  const now = Date.now();
  let p: Project;
  if (seed && tpl !== 'blank') {
    p = structuredClone(seed);
    p.id = uid('proj');
    p.name = name;
    p.createdAt = now;
    p.updatedAt = now;
    p.schemes.forEach((s) => (s.id = uid('sch')));
    p.activeSchemeId = p.schemes[0].id;
  } else {
    p = blankProject(name, table.id);
  }
  return p;
}

function blankProject(name: string, tableId: string): Project {
  const now = Date.now();
  const schemeId = uid('sch');
  return {
    id: uid('proj'),
    name,
    template: 'blank',
    createdAt: now,
    updatedAt: now,
    space: {
      width: 24, depth: 18, height: 4.5, workPlaneHeight: 0.75,
      grid: { baysX: 3, baysZ: 3, spanX: 8, spanZ: 6, columnSize: 0.45, columns: true },
      reflectance: { wall: 0.75, floor: 0.5, ceiling: 0.8, shelf: 0.5 },
      objects: [],
    },
    sky: { type: 'overcast', month: 6, day: 21, hour: 12, location: { name: '上海', latitude: 31.23, longitude: 121.47 }, turbidity: 2.5, overrideExteriorLux: null },
    standard: STANDARDS[1],
    energy: { lpd: 6, occupiedHours: 3000, dayStart: 8, dayEnd: 18, electricityPrice: 0.85, targetLux: 200, dimmingK: 1 },
    schemes: [{ id: schemeId, name: '方案1', note: '', createdAt: now, tubes: [] }],
    activeSchemeId: schemeId,
    probeSpacing: 3,
  };
}

/** 项目卡片缩略平面图 */
export function drawThumb(canvas: HTMLCanvasElement, p: Project): void {
  const dpr = Math.min(2, devicePixelRatio || 1);
  const w = canvas.clientWidth || 320;
  const h = canvas.clientHeight || 158;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(dpr, dpr);
  // 背景渐变
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, '#16233d');
  g.addColorStop(1, '#0c1424');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);

  const W = p.space.width,
    D = p.space.depth;
  const pad = 26;
  const s = Math.min((w - pad * 2) / W, (h - pad * 2) / D);
  const dw = W * s,
    dh = D * s;
  const ox = (w - dw) / 2,
    oy = (h - dh) / 2;
  const X = (x: number) => ox + (x + W / 2) * s;
  const Z = (z: number) => oy + (z + D / 2) * s;

  // 地面
  ctx.fillStyle = 'rgba(120,150,200,.14)';
  ctx.fillRect(X(-W / 2), Z(-D / 2), dw, dh);
  // 柱网
  const gr = p.space.grid;
  ctx.fillStyle = 'rgba(180,200,235,.5)';
  for (let ix = 0; ix <= gr.baysX; ix++)
    for (let iz = 0; iz <= gr.baysZ; iz++) {
      const totalX = gr.baysX * gr.spanX,
        totalZ = gr.baysZ * gr.spanZ;
      const x = -totalX / 2 + ix * gr.spanX;
      const z = -totalZ / 2 + iz * gr.spanZ;
      const cs = gr.columnSize * s;
      ctx.fillRect(X(x) - cs / 2, Z(z) - cs / 2, cs, cs);
    }
  // 对象
  for (const o of p.space.objects) {
    ctx.save();
    ctx.translate(X(o.x), Z(o.z));
    ctx.rotate(-(o.rotation || 0));
    if (o.kind === 'shelf') {
      ctx.fillStyle = 'rgba(214,158,92,.85)';
      ctx.fillRect(-(o.length * s) / 2, -(o.depth * s) / 2, o.length * s, o.depth * s);
    } else if (o.kind === 'partition') {
      ctx.fillStyle = 'rgba(220,228,245,.9)';
      ctx.fillRect(-(o.length * s) / 2, -(o.thickness * s) / 2, o.length * s, Math.max(2, o.thickness * s));
    } else if (o.kind === 'window') {
      ctx.fillStyle = 'rgba(120,200,255,.95)';
      ctx.fillRect(-(o.width * s) / 2, -2, o.width * s, 3);
    }
    ctx.restore();
  }
  // 管
  const scheme = p.schemes.find((x) => x.id === p.activeSchemeId) ?? p.schemes[0];
  for (const t of scheme?.tubes ?? []) {
    ctx.beginPath();
    ctx.arc(X(t.x), Z(t.z), Math.max(2.5, (t.diameter / 1000 / 2) * s + 1.5), 0, Math.PI * 2);
    ctx.fillStyle = '#ffe9a8';
    ctx.fill();
  }
  // 墙
  ctx.strokeStyle = 'rgba(235,242,255,.95)';
  ctx.lineWidth = 2;
  ctx.strokeRect(X(-W / 2), Z(-D / 2), dw, dh);
}
