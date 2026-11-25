import { h, mount, button, card, stat, table } from '../dom';
import { store } from '../store';
import { Viewport } from '../viewport';
import { computeStats } from '../../core/analysis/illuminance';
import { computePipeOutput } from '../../core/pipes/catalog';
import { buildSkyField } from '../../core/sky/sky';
import type { Project, Scheme } from '../../types';
import { uid } from '../../types';

const GRID = 48;

interface SchemeMetrics {
  scheme: Scheme;
  pipeCount: number;
  totalLumens: number;
  avg: number;
  min: number;
  uniformity: number;
  leakSpots: number;   // 墙后漏光疑似点（Chebyshev 低权重仍高亮）
  hotSpots: number;    // 过亮：>2 倍平均
  glareSpots: number;  // 眩光点：高亮度发光面直视
}

export function renderCompare(root: HTMLElement): void {
  const p = store.current;
  if (!p) {
    mount(root, h('div', { class: 'empty' }, document.createTextNode('请先选择项目')));
    return;
  }
  const viewport = new Viewport();
  const side = h('div', { class: 'side-panel side-wide' });

  function manageSchemes(): HTMLElement {
    const proj = store.current!;
    return card('方案管理（2–3 套并排对比）',
      h('div', { class: 'scheme-list' },
        ...proj.schemes.map((s) =>
          h('div', { class: `scheme-item ${s.id === proj.activeSchemeId ? 'active' : ''}` },
            h('strong', {}, document.createTextNode(s.name)),
            h('span', { class: 'muted' }, document.createTextNode(`${s.pipes.length} 管`)),
            button('切换激活', () => store.mutate((x) => { x.activeSchemeId = s.id; })),
            button('重命名', () => {
              const name = prompt('方案名称', s.name);
              if (name) store.mutate(() => { s.name = name; });
            }),
            button('复制为新方案', () => store.mutate((x) => {
              const copy: Scheme = structuredClone(s);
              copy.id = uid('scheme');
              copy.name = `${s.name} 副本`;
              copy.createdAt = Date.now();
              x.schemes.push(copy);
              x.activeSchemeId = copy.id;
            })),
            proj.schemes.length > 1
              ? button('删除', () => store.mutate((x) => {
                x.schemes = x.schemes.filter((q) => q.id !== s.id);
                if (x.activeSchemeId === s.id) x.activeSchemeId = x.schemes[0].id;
              }), 'danger')
              : null,
          ),
        ),
      ),
      button('从当前方案派生（改管位后再对比）', () => store.mutate((x) => {
        const src = x.schemes.find((s) => s.id === x.activeSchemeId)!;
        const copy: Scheme = structuredClone(src);
        copy.id = uid('scheme');
        copy.name = `方案${x.schemes.length + 1}`;
        copy.createdAt = Date.now();
        x.schemes.push(copy);
        x.activeSchemeId = copy.id;
      }), 'primary'),
    );
  }

  async function evaluateAll(): Promise<SchemeMetrics[]> {
    const proj = store.current!;
    const engine = viewport.glEngine;
    const sky = buildSkyField(proj.sky, 128);
    const cat = store.catalog;
    const out: SchemeMetrics[] = [];
    for (const scheme of proj.schemes.slice(0, 3)) {
      // 切换激活方案触发视口重建
      await store.mutate((x) => { x.activeSchemeId = scheme.id; });
      await new Promise((r) => setTimeout(r, 1800)); // 等探针收敛一轮
      let avg = 0;
      let min = Infinity;
      let max = 0;
      let leak = 0;
      let hot = 0;
      if (engine) {
        const raw = engine.renderWorkPlane(proj.probe.workPlaneHeight, GRID, GRID, 0, 1, proj.standardMinLux);
        const grid = new Float32Array(GRID * GRID);
        for (let z = 0; z < GRID; z++) {
          for (let x = 0; x < GRID; x++) {
            const v = raw[((GRID - 1 - z) * GRID + x) * 4];
            grid[z * GRID + x] = v;
          }
        }
        const st = computeStats(grid, GRID, GRID, 1, proj.standardMinLux);
        avg = st.avg;
        min = st.min;
        max = st.max;
        // 过亮点
        for (let i = 0; i < grid.length; i++) if (grid[i] > avg * 2) hot++;
        // 漏光检测：靠墙 1m 网格出现高于室内中位数 3 倍的异常亮斑
        const sorted = [...grid].sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)];
        for (let z = 0; z < GRID; z++) {
          for (let x = 0; x < GRID; x++) {
            const edge = x < 2 || x >= GRID - 2 || z < 2 || z >= GRID - 2;
            if (edge && grid[z * GRID + x] > median * 3 + 50) leak++;
          }
        }
      }
      let totalLumens = 0;
      for (const pipe of scheme.pipes) {
        if (!pipe.enabled) continue;
        totalLumens += computePipeOutput(pipe, cat, sky).outputLumens;
      }
      out.push({
        scheme,
        pipeCount: scheme.pipes.filter((x) => x.enabled).length,
        totalLumens,
        avg, min,
        uniformity: avg > 0 ? min / avg : 0,
        leakSpots: leak,
        hotSpots: hot,
        glareSpots: scheme.pipes.filter((x) => x.enabled && x.diameter >= 0.75).length,
      });
    }
    return out;
  }

  function renderSide(): void {
    mount(side, [
      manageSchemes(),
      card('对比指标',
        h('p', { class: 'muted' }, document.createTextNode(
          '逐方案切换激活并采样工作面，自动统计漏光/过亮/眩光。漏光判定：墙边网格异常亮于室内中位数 3 倍',
        )),
        button('运行并排评估（2–3 方案）', () => runCompare(), 'primary'),
        h('div', { id: 'compare-result' }),
      ),
    ]);
  }

  async function runCompare(): Promise<void> {
    const host = side.querySelector('#compare-result') as HTMLElement;
    if (host) host.replaceChildren(document.createTextNode('评估中，每个方案约 2 秒…'));
    const original = store.current!.activeSchemeId;
    const metrics = await evaluateAll();
    await store.mutate((x) => { x.activeSchemeId = original; });
    if (!host) return;
    mount(host, [
      h('div', { class: 'compare-grid' },
        ...metrics.map((m) =>
          h('div', { class: 'compare-col card' },
            h('h4', {}, document.createTextNode(m.scheme.name)),
            stat('管数', String(m.pipeCount)),
            stat('总通量', `${m.totalLumens.toFixed(0)} lm`),
            stat('平均照度', `${m.avg.toFixed(0)} lx`),
            stat('均匀度', m.uniformity.toFixed(2)),
            stat('漏光疑点', String(m.leakSpots), m.leakSpots === 0 ? '无墙后漏光' : '需检查'),
            stat('过亮网格', String(m.hotSpots)),
            stat('眩光风险管', String(m.glareSpots), '大管径漫射器'),
          ),
        ),
      ),
      table(
        ['方案', '管数', '总通量 lm', '平均 lx', '均匀度', '漏光', '过亮', '眩光'],
        metrics.map((m) => [m.scheme.name, m.pipeCount, m.totalLumens.toFixed(0),
          m.avg.toFixed(0), m.uniformity.toFixed(2), m.leakSpots, m.hotSpots, m.glareSpots]),
      ),
    ]);
  }

  renderSide();
  mount(root, h('div', { class: 'workspace' }, viewport.el, side));
  viewport.start();
  window.addEventListener('hashchange', () => viewport.dispose(), { once: true });
}
