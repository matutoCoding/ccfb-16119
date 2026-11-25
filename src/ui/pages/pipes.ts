import { h, mount, button, card, numberField, selectField, toggleField, table, stat } from '../dom';
import { store } from '../store';
import { Viewport } from '../viewport';
import { computePipeOutput, parseCatalogCsv } from '../../core/pipes/catalog';
import { buildSkyField } from '../../core/sky/sky';
import type { LightPipeDef, PipeCatalog } from '../../types';
import { uid } from '../../types';

export function renderPipes(root: HTMLElement): void {
  const p = store.current;
  if (!p) {
    mount(root, h('div', { class: 'empty' }, document.createTextNode('请先选择项目')));
    return;
  }
  const viewport = new Viewport();
  const side = h('div', { class: 'side-panel' });

  function renderSide(): void {
    const proj = store.current!;
    const scheme = proj.schemes.find((s) => s.id === proj.activeSchemeId)!;
    const cat = store.catalog;
    const sky = buildSkyField(proj.sky, 128);
    const rows: (string | number)[][] = [];
    let totalLumens = 0;
    for (const pipe of scheme.pipes) {
      const out = computePipeOutput(pipe, cat, sky);
      totalLumens += pipe.enabled ? out.outputLumens : 0;
      rows.push([
        pipe.name,
        `${pipe.diameter * 1000}`,
        pipe.length,
        pipe.elbowCount,
        `${(out.totalEfficiency * 100).toFixed(1)}%`,
        pipe.enabled ? out.outputLumens.toFixed(0) : '停用',
      ]);
    }

    mount(side, [
      card('厂家参数表',
        selectField('当前参数表', cat.id, store.state.catalogs.map((c) => ({ value: c.id, label: c.name })),
          (v) => store.mutate((x) => { x.catalogId = v; })),
        h('div', { class: 'btn-row' },
          csvImportButton(),
          button('导出 CSV', exportCsv),
        ),
        h('details', {},
          h('summary', {}, document.createTextNode(`传输效率表（${cat.transmission.length} 点）`)),
          table(['管径 mm', '管长 m', '效率'],
            cat.transmission.slice(0, 21).map((t) => [Math.round(t.diameter * 1000), t.length, (t.efficiency * 100).toFixed(1) + '%'])),
        ),
        h('p', { class: 'muted small' },
          document.createTextNode(`单弯头折减 ${(cat.elbowLoss * 100).toFixed(0)}% · 设计全阴天 Eh=${cat.designOvercastEh}lx`)),
      ),
      card('导光管布置',
        h('div', { class: 'btn-row' },
          button('添加单管', addPipe, 'primary'),
          button('按网格批量添加', addGrid),
          button('全部停用/启用', toggleAll),
        ),
        table(['编号', '管径mm', '管长m', '弯头', '总效率', '输出 lm'], rows),
        h('div', { class: 'stat-row' },
          stat('总输出光通量', `${totalLumens.toFixed(0)} lm`, `室外 Eh ${sky.horizontalEh.toFixed(0)} lx`),
          stat('启用管数', String(scheme.pipes.filter((x) => x.enabled).length)),
        ),
      ),
      card('单管编辑（点列表项）',
        h('div', { class: 'object-list' },
          ...scheme.pipes.map((pipe) => pipeEditor(pipe, cat.diameters, cat, renderSide)),
        ),
      ),
    ]);
  }

  function addPipe(): void {
    const proj = store.current!;
    const scheme = proj.schemes.find((s) => s.id === proj.activeSchemeId)!;
    const cat = store.catalog;
    scheme.pipes.push({
      id: uid('pipe'),
      name: `管${scheme.pipes.length + 1}`,
      x: proj.room.width / 2,
      z: proj.room.depth / 2,
      diameter: cat.diameters[1] ?? cat.diameters[0],
      length: proj.room.height,
      elbowCount: 0,
      domeModel: cat.domes[0].id,
      diffuserModel: cat.diffusers[0].id,
      enabled: true,
    });
    store.mutate(() => undefined);
  }

  function addGrid(): void {
    const proj = store.current!;
    const scheme = proj.schemes.find((s) => s.id === proj.activeSchemeId)!;
    const cat = store.catalog;
    const nx = Number(prompt('X 向管数', '3'));
    const nz = Number(prompt('Z 向管数', '3'));
    if (!nx || !nz) return;
    for (let ix = 0; ix < nx; ix++) {
      for (let iz = 0; iz < nz; iz++) {
        scheme.pipes.push({
          id: uid('pipe'),
          name: `管${scheme.pipes.length + 1}`,
          x: (proj.room.width * (ix + 1)) / (nx + 1),
          z: (proj.room.depth * (iz + 1)) / (nz + 1),
          diameter: cat.diameters[1] ?? cat.diameters[0],
          length: proj.room.height,
          elbowCount: 0,
          domeModel: cat.domes[0].id,
          diffuserModel: cat.diffusers[0].id,
          enabled: true,
        });
      }
    }
    store.mutate(() => undefined);
  }

  function toggleAll(): void {
    store.mutate((proj) => {
      const scheme = proj.schemes.find((s) => s.id === proj.activeSchemeId)!;
      const anyOn = scheme.pipes.some((x) => x.enabled);
      scheme.pipes.forEach((x) => { x.enabled = !anyOn; });
    });
  }

  function exportCsv(): void {
    const cat = store.catalog;
    const lines = ['diameter,length,efficiency', `#elbowLoss=${cat.elbowLoss}`,
      ...cat.transmission.map((t) => `${t.diameter},${t.length},${t.efficiency}`)];
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${cat.name}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function csvImportButton(): HTMLElement {
    const input = h('input', { type: 'file', accept: '.csv,text/csv', style: 'display:none' }) as HTMLInputElement;
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      const text = await file.text();
      const { transmission, elbowLoss, errors } = parseCatalogCsv(text);
      if (errors.length) alert(errors.join('\n'));
      if (!transmission.length) { alert('未解析到有效数据'); return; }
      const base = store.catalog;
      await store.saveCatalog({
        ...base,
        id: uid('cat'),
        name: file.name.replace(/\.csv$/i, ''),
        builtin: false,
        transmission,
        elbowLoss: elbowLoss ?? base.elbowLoss,
        diameters: [...new Set(transmission.map((t) => t.diameter))].sort((a, b) => a - b),
      });
      alert(`导入成功：${transmission.length} 个数据点`);
    });
    return h('span', { class: 'btn-row' },
      button('导入 CSV 参数表', () => input.click(), 'primary'),
      input,
    );
  }

  renderSide();
  mount(root, h('div', { class: 'workspace' }, viewport.el, side));
  viewport.start();
  window.addEventListener('hashchange', () => viewport.dispose(), { once: true });
}

function pipeEditor(
  pipe: LightPipeDef,
  diameters: number[],
  cat: PipeCatalog,
  refresh: () => void,
): HTMLElement {
  const proj = store.current!;
  const sky = buildSkyField(proj.sky, 64);
  const out = computePipeOutput(pipe, cat, sky);
  const num = (label: string, value: number, step: number, fn: (v: number) => void) =>
    numberField({ label, value, step, onInput: (v) => { store.mutate(() => fn(v)); refresh(); } });
  return h('div', { class: 'object-item pipe-item' },
    h('div', { class: 'object-item-head' },
      h('strong', {}, document.createTextNode(pipe.name)),
      toggleField('启用', pipe.enabled, (on) => store.mutate(() => { pipe.enabled = on; })),
    ),
    h('div', { class: 'grid-2' },
      num('X 坐标 m', pipe.x, 0.1, (v) => { pipe.x = v; }),
      num('Z 坐标 m', pipe.z, 0.1, (v) => { pipe.z = v; }),
      selectField('管径', String(pipe.diameter), diameters.map((d) => ({ value: String(d), label: `${Math.round(d * 1000)} mm` })),
        (v) => store.mutate(() => { pipe.diameter = Number(v); })),
      num('管长 m', pipe.length, 0.1, (v) => { pipe.length = v; }),
      num('90°弯头数', pipe.elbowCount, 1, (v) => { pipe.elbowCount = Math.max(0, Math.round(v)); }),
    ),
    selectField('采光罩', pipe.domeModel, cat.domes.map((d: any) => ({ value: d.id, label: `${d.name} τ=${(d.transmittance * 100).toFixed(0)}%` })),
      (v) => store.mutate(() => { pipe.domeModel = v; })),
    selectField('漫射器', pipe.diffuserModel, cat.diffusers.map((d: any) => ({ value: d.id, label: `${d.name} τ=${(d.transmittance * 100).toFixed(0)}%` })),
      (v) => store.mutate(() => { pipe.diffuserModel = v; })),
    h('div', { class: 'pipe-output' },
      stat('入口照度', `${out.entranceEh.toFixed(0)} lx`),
      stat('总效率', `${(out.totalEfficiency * 100).toFixed(1)}%`),
      stat('输出通量', `${out.outputLumens.toFixed(0)} lm`),
    ),
    button('删除该管', () => store.mutate((p) => {
      const s = p.schemes.find((x) => x.id === p.activeSchemeId)!;
      s.pipes = s.pipes.filter((q) => q.id !== pipe.id);
    }), 'danger'),
  );
}
