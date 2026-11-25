// 空间建模页：柱网/层高 + 货架/隔墙/梁/侧窗 + 反射率，WebGL2 三维视图
import { store } from '../../core/store';
import type { Project, SceneObj, ShelfObj } from '../../core/types';
import { uid, clamp } from '../../core/util';
import { h, btn, field, numInput, select, slider, toast } from '../dom';
import { buildSceneMesh } from '../../core/geometry';
import { buildBVH } from '../../core/bvh';
import { buildProbeLayout } from '../../core/grid';
import { SceneRenderer } from '../../gl/SceneRenderer';

type AnyObj = SceneObj;

export function renderModel(content: HTMLElement, projectId: string): () => void {
  const project = store.getProject(projectId)!;
  let selectedId: string | null = project.space.objects[0]?.id ?? null;
  let moveMode = false;
  let renderer: SceneRenderer | null = null;
  let alive = true;
  const cleanupFns: (() => void)[] = [];

  const workspace = h('div', { class: 'workspace' });
  const inspector = h('aside', { class: 'inspector' });
  const stage = h('div', { class: 'stage' });
  const canvas = h('canvas', { class: 'gl' }) as HTMLCanvasElement;
  stage.appendChild(canvas);

  // 工具条
  const toolBar = h('div', { class: 'stage-toolbar' });
  const viewBtn = btn('🖱 视角旋转', () => setMove(false), { variant: 'subtle' });
  const moveBtn = btn('✥ 拖动定位', () => setMove(true), { variant: 'subtle' });
  toolBar.append(viewBtn, moveBtn);
  stage.appendChild(toolBar);
  const hud = h('div', { class: 'stage-hud' });
  const hudProbe = h('div', { class: 'hud-chip' });
  const hudFps = h('div', { class: 'hud-chip' });
  hud.append(hudProbe, hudFps);
  stage.appendChild(hud);

  workspace.append(inspector, stage);
  content.appendChild(workspace);

  try {
    renderer = new SceneRenderer(canvas);
    renderer.onFrame = (fps) => {
      if (!alive) return;
      const cls = fps >= 30 ? 'fps-good' : fps >= 20 ? 'fps-mid' : 'fps-bad';
      hudFps.innerHTML = `渲染 <b class="${cls}">${fps.toFixed(0)}</b> FPS`;
    };
    renderer.onClick = (e) => pickObject(e);
    setupDrag();
  } catch (err) {
    stage.appendChild(h('div', {
      class: 'hud-panel',
      style: 'position:absolute;inset:20px auto auto 20px;max-width:360px;color:#ffb4ab',
    }, 'WebGL2 初始化失败：' + (err as Error).message + '。建模表单仍可使用。'));
  }

  function activeScheme() {
    return project.schemes.find((s) => s.id === project.activeSchemeId) ?? project.schemes[0];
  }

  function rebuild3D(): void {
    if (!renderer) return;
    const table = store.defaultTable();
    const mesh = buildSceneMesh(project.space, activeScheme()?.tubes ?? [], store.tables, 20000);
    buildBVH(mesh); // 预构建验证无异常
    renderer.setMesh(mesh);
    const layout = buildProbeLayout(project.space.width, project.space.depth, project.space.height, project.probeSpacing);
    renderer.setProbes(store.settings.showProbes ? layout : null);
    hudProbe.innerHTML = `探针 <b>${layout.count}</b> 个 · 柱网 ${project.space.grid.baysX}×${project.space.grid.baysZ}`;
    updateSelectionBox();
  }

  function updateSelectionBox(): void {
    if (!renderer) return;
    const o = project.space.objects.find((x) => x.id === selectedId);
    if (!o) {
      renderer.setSelectionBox(null);
      return;
    }
    const box = objectBox(o);
    renderer.setSelectionBox(box);
  }

  function objectBox(o: AnyObj): { min: [number, number, number]; max: [number, number, number] } {
    if (o.kind === 'shelf') {
      return { min: [o.x - o.length / 2, 0, o.z - o.depth / 2], max: [o.x + o.length / 2, o.height, o.z + o.depth / 2] };
    }
    if (o.kind === 'partition') {
      const horiz = Math.abs(Math.cos(o.rotation)) > 0.5;
      return horiz
        ? { min: [o.x - o.length / 2, 0, o.z - o.thickness / 2], max: [o.x + o.length / 2, o.height, o.z + o.thickness / 2] }
        : { min: [o.x - o.thickness / 2, 0, o.z - o.length / 2], max: [o.x + o.thickness / 2, o.height, o.z + o.length / 2] };
    }
    if (o.kind === 'beam') {
      return { min: [o.x - o.length / 2, project.space.height - o.drop, o.z - o.width / 2], max: [o.x + o.length / 2, project.space.height, o.z + o.width / 2] };
    }
    if (o.kind === 'window') {
      return { min: [o.x - o.width / 2, o.sill, o.z - 0.2], max: [o.x + o.width / 2, o.sill + o.height, o.z + 0.2] };
    }
    return { min: [o.x - o.size / 2, 0, o.z - o.size / 2], max: [o.x + o.size / 2, o.height, o.z + o.size / 2] };
  }

  function commit(mut?: () => void): void {
    store.updateProject(projectId, (p) => {
      if (mut) {
        // 在最新副本上执行：通过 id 拿到响应式 project 已是同一引用（store 内对象）
        mut();
      }
    });
    rebuild3D();
    renderInspector();
  }

  function setMove(on: boolean): void {
    moveMode = on;
    if (renderer) renderer.controlsEnabled = !on;
    viewBtn.classList.toggle('active', !on);
    moveBtn.classList.toggle('active', on);
    canvas.style.cursor = on ? 'move' : 'grab';
  }

  function setupDrag(): void {
    if (!renderer) return;
    let dragging = false;
    const move = (e: PointerEvent) => {
      if (!moveMode || !selectedId) return;
      const g = renderer!.eventToGround(e, 0);
      if (!g) return;
      dragging = true;
      const o = project.space.objects.find((x) => x.id === selectedId);
      if (!o) return;
      store.updateProject(projectId, () => {
        o.x = clamp(g[0], -project.space.width / 2 + 0.3, project.space.width / 2 - 0.3);
        o.z = clamp(g[2], -project.space.depth / 2 + 0.3, project.space.depth / 2 - 0.3);
      });
      updateSelectionBox();
      renderInspector();
    };
    const up = () => {
      if (dragging) {
        dragging = false;
        void store.saveProjectNow(projectId);
      }
    };
    canvas.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    cleanupFns.push(() => canvas.removeEventListener('pointermove', move));
    cleanupFns.push(() => window.removeEventListener('pointerup', up));
  }

  function pickObject(e: MouseEvent): void {
    if (!renderer) return;
    const g = renderer.eventToGround(e, 0);
    if (!g) return;
    // 最近对象中心 / 足迹
    let best: string | null = null;
    let bestD = Infinity;
    for (const o of project.space.objects) {
      const d = Math.hypot(o.x - g[0], o.z - g[2]);
      const reach = o.kind === 'shelf' ? Math.max(o.length, o.depth) / 2 + 0.6 : 2.2;
      if (d < reach && d < bestD) {
        bestD = d;
        best = o.id;
      }
    }
    if (best) {
      selectedId = best;
      renderInspector();
      updateSelectionBox();
    }
  }

  function addObject(kind: AnyObj['kind']): void {
    const id = uid('obj');
    const base = { id, x: 0, z: 0, rotation: 0 };
    let o: AnyObj;
    if (kind === 'shelf') {
      o = { ...base, kind, name: `货架 ${project.space.objects.filter((x) => x.kind === 'shelf').length + 1}`, length: 6, depth: 1.2, height: 4, levels: 4, openness: 0.55 } as ShelfObj;
    } else if (kind === 'partition') {
      o = { ...base, kind, name: '隔墙', length: 8, thickness: 0.2, height: project.space.height };
    } else if (kind === 'beam') {
      o = { ...base, y: project.space.height - 0.8, kind, name: '梁', length: project.space.width, width: 0.35, drop: 0.8 };
    } else if (kind === 'window') {
      o = { ...base, kind, name: '侧窗', wall: 'south', width: 4, height: 1.6, sill: 1.2, transmittance: 0.7, rotation: 0 };
    } else {
      o = { ...base, kind: 'column', name: '独立柱', size: 0.5, height: project.space.height };
    }
    project.space.objects.push(o);
    selectedId = id;
    commit();
    setMove(true);
    toast('已添加，可在视图中拖动定位', 'info');
  }

  // ---------- Inspector ----------
  function renderInspector(): void {
    inspector.innerHTML = '';
    // 空间与柱网
    const spaceCard = h('section', { class: 'card' },
      h('header', { class: 'card-head' }, h('h3', null, '空间与柱网')),
      h('div', { class: 'card-body' },
        h('div', { class: 'grid-form' },
          field('总长 X (m)', numInput(project.space.width, (v) => commit(() => { project.space.width = v; }), { min: 4, max: 200, step: 0.5 })),
          field('总深 Z (m)', numInput(project.space.depth, (v) => commit(() => { project.space.depth = v; }), { min: 4, max: 200, step: 0.5 })),
          field('层高 (m)', numInput(project.space.height, (v) => commit(() => { project.space.height = v; }), { min: 2.4, max: 20, step: 0.1 })),
          field('工作面高 (m)', numInput(project.space.workPlaneHeight, (v) => commit(() => { project.space.workPlaneHeight = v; }), { min: 0, max: 1.5, step: 0.05 })),
        ),
        h('div', { class: 'field-label mt8' }, '柱网（跨数 × 跨度，修改后总尺寸联动）'),
        h('div', { class: 'grid-form' },
          field('X 跨数', numInput(project.space.grid.baysX, (v) => commit(() => { project.space.grid.baysX = Math.round(v); project.space.width = Math.round(v) * project.space.grid.spanX; }), { min: 1, max: 20, step: 1 })),
          field('X 跨度 m', numInput(project.space.grid.spanX, (v) => commit(() => { project.space.grid.spanX = v; project.space.width = project.space.grid.baysX * v; }), { min: 3, max: 16, step: 0.1 })),
          field('Z 跨数', numInput(project.space.grid.baysZ, (v) => commit(() => { project.space.grid.baysZ = Math.round(v); project.space.depth = Math.round(v) * project.space.grid.spanZ; }), { min: 1, max: 20, step: 1 })),
          field('Z 跨度 m', numInput(project.space.grid.spanZ, (v) => commit(() => { project.space.grid.spanZ = v; project.space.depth = project.space.grid.baysZ * v; }), { min: 3, max: 16, step: 0.1 })),
          field('柱截面 m', numInput(project.space.grid.columnSize, (v) => commit(() => { project.space.grid.columnSize = v; }), { min: 0.2, max: 1.2, step: 0.05 })),
          h('label', { class: 'field' }, h('span', { class: 'field-label' }, '显示结构柱'),
            h('input', { type: 'checkbox', checked: project.space.grid.columns, onchange: (e: Event) => commit(() => { project.space.grid.columns = (e.target as HTMLInputElement).checked; }) })),
        ),
        field('探针间距 m（自动取整到 ≤256 个）', slider(project.probeSpacing, 2, 6, 0.1, (v) => { project.probeSpacing = v; commit(); }, (v) => `${v.toFixed(1)} m`)),
      ),
    );
    inspector.appendChild(spaceCard);

    // 反射率
    const R = project.space.reflectance;
    const reflCard = h('section', { class: 'card mt16' },
      h('header', { class: 'card-head' }, h('h3', null, '表面反射率')),
      h('div', { class: 'card-body' },
        reflSlider('墙面 ρ', R.wall, (v) => commit(() => (R.wall = v))),
        reflSlider('地面 ρ', R.floor, (v) => commit(() => (R.floor = v))),
        reflSlider('顶棚 ρ', R.ceiling, (v) => commit(() => (R.ceiling = v))),
        reflSlider('货架 ρ', R.shelf, (v) => commit(() => (R.shelf = v))),
      ),
    );
    inspector.appendChild(reflCard);

    // 添加对象
    const addCard = h('section', { class: 'card mt16' },
      h('header', { class: 'card-head' }, h('h3', null, '布置构件')),
      h('div', { class: 'card-body' },
        h('div', { class: 'row wrap gap8' },
          btn('▤ 货架', () => addObject('shelf'), { variant: 'ghost', size: 'sm' }),
          btn('▯ 隔墙', () => addObject('partition'), { variant: 'ghost' }),
          btn('▬ 梁', () => addObject('beam'), { variant: 'ghost' }),
          btn('☷ 侧窗', () => addObject('window'), { variant: 'ghost' }),
        ),
        h('div', { class: 'field-hint mt8' }, '添加后在下方列表选中，用「✥ 拖动定位」在三维视图里移动。'),
      ),
    );
    inspector.appendChild(addCard);

    // 对象列表 + 编辑
    const listCard = h('section', { class: 'card mt16' },
      h('header', { class: 'card-head' }, h('h3', null, `构件列表 (${project.space.objects.length})`)),
      h('div', { class: 'card-body' },
        h('div', { class: 'obj-list' },
          ...project.space.objects.map((o) =>
            h('div', {
              class: `obj-item${o.id === selectedId ? ' selected' : ''}`,
              onclick: () => { selectedId = o.id; renderInspector(); updateSelectionBox(); },
            },
              h('span', { class: 'dot', style: `background:${kindColor(o.kind)}` }),
              h('span', null, o.name),
              h('span', { class: 'spacer' }),
              h('button', {
                class: 'del', title: '删除',
                onclick: (e: MouseEvent) => {
                  e.stopPropagation();
                  project.space.objects = project.space.objects.filter((x) => x.id !== o.id);
                  if (selectedId === o.id) selectedId = null;
                  commit();
                },
              }, '×'),
            ),
          ),
        ),
        selectedId ? editorFor(project.space.objects.find((o) => o.id === selectedId)!, commit) : h('div', { class: 'small muted mt12' }, '选择一个构件以编辑参数。'),
      ),
    );
    inspector.appendChild(listCard);
  }

  function reflSlider(label: string, value: number, on: (v: number) => void): HTMLElement {
    return h('div', { class: 'field' },
      h('span', { class: 'field-label' }, `${label} · ${value.toFixed(2)}`),
      slider(value, 0.05, 0.98, 0.01, (v) => on(v), (v) => v.toFixed(2)),
    );
  }

  renderInspector();
  rebuild3D();
  setMove(false);

  const unsub = store.subscribe(() => {
    if (!alive) return;
    // 外部变化（如顶栏方案切换）时重建
    rebuild3D();
  });
  cleanupFns.push(unsub);

  return () => {
    alive = false;
    cleanupFns.forEach((f) => f());
    renderer?.dispose();
  };
}

function kindColor(k: string): string {
  return { shelf: '#d69e5c', partition: '#dce4f5', beam: '#9aa7bd', window: '#6fc3ff', column: '#b7c0d0' }[k] ?? '#ccc';
}

/** 选中构件的参数编辑器 */
function editorFor(o: AnyObj, commit: (fn?: () => void) => void): HTMLElement {
  const box = h('div', { class: 'mt16', style: 'border-top:1px solid var(--line);padding-top:12px' });
  const nameInput = h('input', { type: 'text', value: o.name }) as HTMLInputElement;
  nameInput.addEventListener('change', () => commit(() => { o.name = nameInput.value; }));
  box.appendChild(field('名称', nameInput));
  box.appendChild(h('div', { class: 'grid-form' },
    field('中心 X', numInput(o.x, (v) => commit(() => { o.x = v; }), { step: 0.1 })),
    field('中心 Z', numInput(o.z, (v) => commit(() => { o.z = v; }), { step: 0.1 })),
    field('旋转 °', numInput(Math.round((o.rotation * 180) / Math.PI), (v) => commit(() => { o.rotation = (v * Math.PI) / 180; }), { step: 5 })),
  ));

  if (o.kind === 'shelf') {
    box.appendChild(h('div', { class: 'grid-form' },
      field('长度 m', numInput(o.length, (v) => commit(() => { o.length = v; }), { min: 0.5, step: 0.1 })),
      field('进深 m', numInput(o.depth, (v) => commit(() => { o.depth = v; }), { min: 0.3, step: 0.05 })),
      field('高度 m', numInput(o.height, (v) => commit(() => { o.height = v; }), { min: 0.5, step: 0.1 })),
      field('层数', numInput(o.levels, (v) => commit(() => { o.levels = Math.round(v); }), { min: 1, max: 12, step: 1 })),
    ));
  } else if (o.kind === 'partition') {
    box.appendChild(h('div', { class: 'grid-form' },
      field('长度 m', numInput(o.length, (v) => commit(() => { o.length = v; }), { min: 0.5, step: 0.1 })),
      field('厚度 m', numInput(o.thickness, (v) => commit(() => { o.thickness = v; }), { min: 0.05, step: 0.05 })),
      field('高度 m', numInput(o.height, (v) => commit(() => { o.height = v; }), { min: 1, step: 0.1 })),
    ));
  } else if (o.kind === 'beam') {
    box.appendChild(h('div', { class: 'grid-form' },
      field('长度 m', numInput(o.length, (v) => commit(() => { o.length = v; }), { step: 0.1 })),
      field('梁宽 m', numInput(o.width, (v) => commit(() => { o.width = v; }), { min: 0.1, step: 0.05 })),
      field('下垂 m', numInput(o.drop, (v) => commit(() => { o.drop = v; }), { min: 0.1, max: 2, step: 0.05 })),
    ));
  } else if (o.kind === 'window') {
    box.appendChild(h('div', { class: 'grid-form' },
      field('所在外墙', select(o.wall, [
        { value: 'south', label: '南 (z−)' }, { value: 'north', label: '北 (z+)' },
        { value: 'west', label: '西 (x−)' }, { value: 'east', label: '东 (x+)' },
      ], (v) => commit(() => { o.wall = v; }))),
      field('宽 m', numInput(o.width, (v) => commit(() => { o.width = v; }), { min: 0.5, step: 0.1 })),
      field('高 m', numInput(o.height, (v) => commit(() => { o.height = v; }), { min: 0.3, step: 0.1 })),
      field('窗台高 m', numInput(o.sill, (v) => commit(() => { o.sill = v; }), { min: 0, step: 0.1 })),
      field('透射比', numInput(o.transmittance, (v) => commit(() => { o.transmittance = clamp(v, 0, 1); }), { min: 0, max: 1, step: 0.02 })),
    ));
  } else if (o.kind === 'column') {
    box.appendChild(h('div', { class: 'grid-form' },
      field('边长 m', numInput(o.size, (v) => commit(() => { o.size = v; }), { min: 0.2, step: 0.05 })),
      field('高度 m', numInput(o.height, (v) => commit(() => { o.height = v; }), { step: 0.1 })),
    ));
  }
  return box;
}
