// 管道选型页：方案管道列表 + 2D 布置 + 选型参数 + 厂家参数表管理/导入
import { store } from '../../core/store';
import type { Project, TubeInstance, TubeParamTable } from '../../core/types';
import { uid, clamp } from '../../core/util';
import { h, btn, field, numInput, select, modal, toast, pickTextFile, downloadText } from '../dom';
import { exteriorIlluminance } from '../../core/sky';
import { computeTubeFlux, tubeLossBreakdown } from '../../core/geometry';
import { parseParamCsv, paramCsvTemplate } from '../../core/paramTable';
import { drawPlanCanvas } from '../plan2d';

export function renderTubes(content: HTMLElement, projectId: string): () => void {
  const project = store.getProject(projectId)!;
  let selectedTubeId: string | null = activeScheme()?.tubes[0]?.id ?? null;
  let alive = true;

  function activeScheme() {
    return project.schemes.find((s) => s.id === project.activeSchemeId) ?? project.schemes[0];
  }

  const root = h('div', { class: 'workspace wide-right' });
  const left = h('aside', { class: 'inspector' });
  const stage = h('div', { class: 'stage', style: 'background:#0e1626' });
  const canvas = h('canvas', { id: 'plan2d' }) as HTMLCanvasElement;
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%';
  stage.appendChild(canvas);
  const hint = h('div', { class: 'stage-hud' }, h('div', { class: 'hud-chip' }, '在平面上点击空白处放管 · 拖动圆点移动 · 右侧编辑参数'));
  stage.appendChild(hint);
  root.append(left, stage);
  content.appendChild(root);

  const plan = drawPlanCanvas(canvas, project, {
    selectedId: () => selectedTubeId,
    onSelect: (id) => { selectedTubeId = id; renderLeft(); },
    onChange: () => { store.updateProject(projectId, () => {}); renderLeft(); },
    onAddAt: (x, z) => addTube(x, z),
  });

  function refreshPlan(): void {
    plan.redraw();
  }

  function addTube(x = 0, z = 0): void {
    const scheme = activeScheme();
    if (!scheme) return;
    const table = store.getTable(scheme.tubes[0]?.tableId ?? store.defaultTable().id) ?? store.defaultTable();
    const t: TubeInstance = {
      id: uid('tube'), tableId: table.id, diameter: table.diameters.includes(530) ? 530 : table.diameters[Math.floor(table.diameters.length / 2)],
      length: 3, elbows: 1, domeId: table.domes[0].id, diffuserId: table.diffusers[0].id,
      x: clamp(x, -project.space.width / 2 + 0.4, project.space.width / 2 - 0.4),
      z: clamp(z, -project.space.depth / 2 + 0.4, project.space.depth / 2 - 0.4),
      rotation: 0, enabled: true,
    };
    scheme.tubes.push(t);
    selectedTubeId = t.id;
    store.updateProject(projectId, () => {});
    renderLeft();
    refreshPlan();
  }

  function currentExteriorLux(): number {
    return exteriorIlluminance(project.sky).horizontalLux;
  }

  function renderLeft(): void {
    if (!alive) return;
    left.innerHTML = '';
    const scheme = activeScheme();

    // 方案与管道
    const listCard = h('section', { class: 'card' },
      h('header', { class: 'card-head' },
        h('h3', null, `导光管 (${scheme?.tubes.length ?? 0})`),
        h('div', { class: 'right' },
          btn('＋ 添加', () => addTube(), { variant: 'primary', size: 'sm' }),
        ),
      ),
      h('div', { class: 'card-body' },
        h('div', { class: 'obj-list', style: 'max-height:210px' },
          ...(scheme?.tubes ?? []).map((t, i) =>
            h('div', {
              class: `obj-item${t.id === selectedTubeId ? ' selected' : ''}`,
              onclick: () => { selectedTubeId = t.id; renderLeft(); },
            },
              h('span', { class: 'dot', style: 'background:#ffe9a8' }),
              h('span', null, `#${i + 1} · DN${t.diameter} · ${t.length}m · ${t.elbows}弯`),
              h('span', { class: 'spacer' }),
              h('input', {
                type: 'checkbox', checked: t.enabled, title: '启用',
                onclick: (e: Event) => e.stopPropagation(),
                onchange: (e: Event) => { t.enabled = (e.target as HTMLInputElement).checked; commit(); },
              }),
              h('button', {
                class: 'del',
                onclick: (e: MouseEvent) => {
                  e.stopPropagation();
                  scheme!.tubes = scheme!.tubes.filter((x) => x.id !== t.id);
                  if (selectedTubeId === t.id) selectedTubeId = null;
                  commit();
                },
              }, '×'),
            ),
          ),
        ),
      ),
    );
    left.appendChild(listCard);

    const tube = scheme?.tubes.find((t) => t.id === selectedTubeId);
    if (tube) left.appendChild(editor(tube));

    // 参数表
    left.appendChild(tableCard());

    // 室外工况通量预览
    const extLux = currentExteriorLux();
    const totalFlux = (scheme?.tubes ?? []).filter((t) => t.enabled).reduce((s, t) => s + computeTubeFlux(t, store.getTable(t.tableId), extLux), 0);
    left.appendChild(h('section', { class: 'card mt16' },
      h('div', { class: 'card-body' },
        h('div', { class: 'kv' },
          h('dt', null, '当前室外水平面照度'), h('dd', { class: 'mono' }, `${Math.round(extLux).toLocaleString()} lx`),
          h('dt', null, '单管平均输出'), h('dd', { class: 'mono' }, `${scheme && scheme.tubes.length ? Math.round(totalFlux / scheme.tubes.filter((t) => t.enabled).length || 0) : 0} lm`),
          h('dt', null, '方案总输出光通量'), h('dd', { class: 'mono' }, `${Math.round(totalFlux).toLocaleString()} lm`),
          h('dt', null, '单位面积光通量'), h('dd', { class: 'mono' }, `${(totalFlux / (project.space.width * project.space.depth)).toFixed(0)} lm/m²`),
        ),
        h('div', { class: 'field-hint mt8' }, '输出 = E室外 × 集光面积 × 罩 × 管段传输 × 弯头 × 漫射器 × 维护系数。到「照度分析」运行完整 GI。'),
      ),
    ));
  }

  function commit(): void {
    store.updateProject(projectId, () => {});
    renderLeft();
    refreshPlan();
  }

  function editor(tube: TubeInstance): HTMLElement {
    const table = store.getTable(tube.tableId) ?? store.defaultTable();
    const card = h('section', { class: 'card mt16' },
      h('header', { class: 'card-head' }, h('h3', null, '选型参数')),
      h('div', { class: 'card-body' }),
    );
    const body = card.querySelector('.card-body') as HTMLElement;

    body.appendChild(field('厂家参数表', select(tube.tableId, store.tables.map((t) => ({ value: t.id, label: t.name })), (v) => {
      tube.tableId = v;
      const nt = store.getTable(v)!;
      if (!nt.diameters.includes(tube.diameter)) tube.diameter = nt.diameters[0];
      tube.domeId = nt.domes[0]?.id ?? tube.domeId;
      tube.diffuserId = nt.diffusers[0]?.id ?? tube.diffuserId;
      commit();
    })));

    body.appendChild(h('div', { class: 'grid-form' },
      field('管径 DN (mm)', select(String(tube.diameter), table.diameters.map((d) => ({ value: String(d), label: `DN${d}` })), (v) => { tube.diameter = parseInt(v); commit(); })),
      field('管长 m', numInput(tube.length, (v) => { tube.length = v; commit(); }, { min: 0.3, max: 30, step: 0.1 })),
      field('弯头数量', numInput(tube.elbows, (v) => { tube.elbows = Math.round(clamp(v, 0, 12)); commit(); }, { min: 0, max: 12, step: 1 })),
      field('旋转 °', numInput(Math.round((tube.rotation * 180) / Math.PI), (v) => { tube.rotation = (v * Math.PI) / 180; commit(); }, { step: 5 })),
    ));
    body.appendChild(field('采光罩型号', select(tube.domeId, table.domes.map((d) => ({ value: d.id, label: `${d.name} (τ=${d.transmittance})` })), (v) => { tube.domeId = v; commit(); })));
    body.appendChild(field('漫射器型号/配光', select(tube.diffuserId, table.diffusers.map((d) => ({ value: d.id, label: `${d.name} · ${distLabel(d.distribution)} (τ=${d.transmittance})` })), (v) => { tube.diffuserId = v; commit(); })));
    body.appendChild(h('div', { class: 'grid-form' },
      field('位置 X', numInput(tube.x, (v) => { tube.x = v; commit(); }, { step: 0.1 })),
      field('位置 Z', numInput(tube.z, (v) => { tube.z = v; commit(); }, { step: 0.1 })),
    ));

    // 损失分解
    const parts = tubeLossBreakdown(tube, table);
    const flux = computeTubeFlux(tube, table, currentExteriorLux());
    const loss = h('div', { class: 'mt12' }, h('div', { class: 'field-label' }, '传输损失分解（连乘）'));
    for (const p of parts) {
      loss.appendChild(h('div', { class: 'flex aic gap8', style: 'margin:5px 0' },
        h('span', { class: 'small', style: 'width:110px;color:var(--text-2)' }, p.label),
        h('div', { class: 'progress light grow' }, h('i', { style: `width:${p.factor * 100}%` })),
        h('span', { class: 'small mono', style: 'width:48px;text-align:right' }, `${(p.factor * 100).toFixed(0)}%`),
      ));
    }
    loss.appendChild(h('div', { class: 'small mt8' }, '该管当前工况输出 ', h('b', { class: 'mono' }, `${Math.round(flux)} lm`)));
    body.appendChild(loss);
    return card;
  }

  function tableCard(): HTMLElement {
    const card = h('section', { class: 'card mt16' },
      h('header', { class: 'card-head' },
        h('h3', null, '厂家参数表'),
        h('div', { class: 'right' },
          btn('导入 CSV/JSON', () => importTable(), { variant: 'ghost', size: 'sm' }),
          btn('模板', () => downloadText('tubelight-param-template.csv', paramCsvTemplate(), 'text/csv'), { variant: 'subtle', size: 'sm' }),
        ),
      ),
      h('div', { class: 'card-body' },
        h('select', {
          onchange: (e: Event) => {
            const id = (e.target as HTMLSelectElement).value;
            if (id === '__import__') return importTable();
          },
        }, ...store.tables.map((t) => h('option', { value: t.id, selected: t.id === activeScheme()?.tubes[0]?.tableId }, `${t.name}（DN${t.diameters.join('/')}）`))),
        h('div', { class: 'small muted mt8' }, '传输效率按管长在对数域插值；JSON 可包含完整罩/漫射器型号。导入的表存 IndexedDB。'),
        h('div', { class: 'row gap8 mt12 wrap' },
          btn('导出全部数据', () => void idbExport(), { variant: 'subtle', size: 'sm' }),
        ),
      ),
    );
    return card;
  }

  async function importTable(): Promise<void> {
    const f = await pickTextFile('.csv,.json');
    if (!f) return;
    try {
      let t: TubeParamTable;
      if (f.name.endsWith('.json')) {
        const data = JSON.parse(f.text);
        t = data.id ? { ...data, id: uid('tbl'), builtin: false } : (data.tables?.[0] ? { ...data.tables[0], id: uid('tbl') } : null as never);
        if (!t) throw new Error('JSON 中未找到参数表');
      } else {
        t = parseParamCsv(f.text, f.name.replace(/\.[^.]+$/, ''));
      }
      await store.saveTable(t);
      toast(`已导入参数表「${t.name}」`, 'ok');
      renderLeft();
    } catch (e) {
      toast('导入失败：' + (e as Error).message, 'err', 4000);
    }
  }

  async function idbExport(): Promise<void> {
    const { idb } = await import('../../core/db');
    const text = await idb.exportAll();
    downloadText('tubelight-studio-backup.json', text);
  }

  renderLeft();
  // 尺寸就绪后重绘
  requestAnimationFrame(() => plan.redraw());
  const unsub = store.subscribe(() => { if (!alive) return; refreshPlan(); });
  return () => { alive = false; unsub(); plan.destroy(); };
}

function distLabel(d: string): string {
  return d === 'wide' ? '宽配光' : d === 'narrow' ? '窄配光' : '朗伯';
}
