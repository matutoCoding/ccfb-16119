import { h, mount, button, card, numberField, toggleField, table } from '../dom';
import { store } from '../store';
import { defaultCatalog, parseCatalogCsv } from '../../core/pipes/catalog';
import { uid } from '../../types';
import { repos, Stores, idb } from '../../core/db/indexeddb';

export function renderSettings(root: HTMLElement): void {
  const s = store.state.settings;
  function render(): void {
    mount(root, [
      h('div', { class: 'page-head' },
        h('h2', {}, document.createTextNode('设置')),
      ),
      card('渲染',
        numberField({ label: '渲染缩放（预留）', value: s.renderScale, min: 0.5, max: 2, step: 0.1,
          onInput: (v) => { store.state.settings.renderScale = v; store.saveSettings(); } }),
        toggleField('显示 FPS/收敛 HUD', s.showFps, (on) => {
          store.state.settings.showFps = on;
          store.saveSettings();
        }),
      ),
      card('数据管理（IndexedDB）',
        h('p', { class: 'muted' },
          document.createTextNode(`项目 ${store.state.projects.length} 个 · 参数表 ${store.state.catalogs.length} 个`)),
        h('div', { class: 'btn-row' },
          button('导出全部项目 JSON', exportAll, 'primary'),
          button('导入项目 JSON', importAll),
          button('清空全部本地数据', () => {
            if (confirm('将删除所有项目和参数表，确定？')) clearAll();
          }, 'danger'),
        ),
      ),
      card('厂家参数表',
        h('div', { class: 'btn-row' },
          button('恢复内置典型参数表', restoreDefault, 'primary'),
          csvImport(),
        ),
        table(['名称', '管径系列 mm', '数据点', '弯头折减'],
          store.state.catalogs.map((c) => [
            c.name + (c.builtin ? '（内置）' : ''),
            c.diameters.map((d) => Math.round(d * 1000)).join('/'),
            c.transmission.length,
            (c.elbowLoss * 100).toFixed(0) + '%',
          ])),
      ),
      card('关于与验收口径',
        h('ul', { class: 'about-list' },
          h('li', {}, document.createTextNode('CIE 全阴天 Lγ=Lz(1+2sinγ)/3，晴天空 ISO 15469 type 12')),
          h('li', {}, document.createTextNode('DDGI：SH L1+L2 辐照度探针 + 深度矩 Chebyshev 可见性，GPU 每帧轮转更新')),
          h('li', {}, document.createTextNode('场景三角面 BVH 打包 RGBA32F 纹理，着色器内 Möller–Trumbore 求交')),
          h('li', {}, document.createTextNode('白墙空房校核：立方体辐射度解析解（积分球公式特例），平均照度误差目标 <5%')),
          h('li', {}, document.createTextNode('全部计算本地完成，无网络依赖')),
        ),
      ),
    ]);
  }

  function exportAll(): void {
    const blob = new Blob([JSON.stringify(store.state.projects, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `导光管项目备份_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function importAll(): HTMLElement {
    const input = h('input', { type: 'file', accept: '.json', style: 'display:none' }) as HTMLInputElement;
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const arr = JSON.parse(await file.text());
        const list = Array.isArray(arr) ? arr : [arr];
        for (const proj of list) {
          proj.id = uid('proj');
          await repos.saveProject(proj);
        }
        location.reload();
      } catch (e) {
        alert(`导入失败: ${(e as Error).message}`);
      }
    });
    return h('span', {}, button('选择文件', () => input.click()), input);
  }

  async function clearAll(): Promise<void> {
    await idb.clear(Stores.projects);
    await idb.clear(Stores.catalogs);
    location.reload();
  }

  async function restoreDefault(): Promise<void> {
    await store.saveCatalog(defaultCatalog());
    render();
  }

  function csvImport(): HTMLElement {
    const input = h('input', { type: 'file', accept: '.csv', style: 'display:none' }) as HTMLInputElement;
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      const r = parseCatalogCsv(await file.text());
      if (!r.transmission.length) { alert('CSV 无有效数据'); return; }
      const base = defaultCatalog();
      await store.saveCatalog({
        ...base,
        id: uid('cat'),
        name: file.name.replace(/\.csv$/i, ''),
        builtin: false,
        transmission: r.transmission,
        elbowLoss: r.elbowLoss ?? base.elbowLoss,
        diameters: [...new Set(r.transmission.map((t) => t.diameter))].sort((a, b) => a - b),
      });
      render();
    });
    return h('span', {}, button('导入 CSV', () => input.click()), input);
  }

  render();
}
