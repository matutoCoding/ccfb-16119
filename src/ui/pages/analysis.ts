import { h, mount, button, card, numberField, stat, table } from '../dom';
import { store } from '../store';
import { Viewport } from '../viewport';
import { computeStats, isolines, falseColor, annualDaylight, type IlluminanceStats, type AnnualResult } from '../../core/analysis/illuminance';
import type { GlEngine } from '../../webgl/glEngine';

const GRID_NX = 96;
const GRID_NZ = 72;
const ISO_LEVELS = [50, 100, 200, 300, 450, 600, 900];

export function renderAnalysis(root: HTMLElement): void {
  const p = store.current;
  if (!p) {
    mount(root, h('div', { class: 'empty' }, document.createTextNode('请先选择项目')));
    return;
  }
  const viewport = new Viewport();
  const side = h('div', { class: 'side-panel side-wide' });
  const heatCanvas = h('canvas', { class: 'heat-canvas', width: GRID_NX, height: GRID_NZ }) as HTMLCanvasElement;
  let luxGrid: Float32Array | null = null;
  let stats: IlluminanceStats | null = null;
  let annual: AnnualResult | null = null;
  let running = false;

  function compute(): void {
    const proj = store.current!;
    const engine: GlEngine | null = viewport.glEngine;
    if (!engine) return;
    // 等待探针初步收敛：至少跑 2 轮全量更新
    const raw = engine.renderWorkPlane(
      proj.probe.workPlaneHeight, GRID_NX, GRID_NZ, 0, 1, proj.standardMinLux,
    );
    // readPixels 原点在左下，翻转 Z
    const grid = new Float32Array(GRID_NX * GRID_NZ);
    for (let z = 0; z < GRID_NZ; z++) {
      for (let x = 0; x < GRID_NX; x++) {
        const srcZ = GRID_NZ - 1 - z;
        grid[z * GRID_NX + x] = raw[(srcZ * GRID_NX + x) * 4];
      }
    }
    luxGrid = grid;
    const cellArea = (proj.room.width * proj.room.depth) / (GRID_NX * GRID_NZ);
    stats = computeStats(grid, GRID_NX, GRID_NZ, cellArea, proj.standardMinLux);
    drawHeatmap();
    renderSide();
  }

  function drawHeatmap(): void {
    if (!luxGrid || !stats) return;
    const ctx = heatCanvas.getContext('2d')!;
    const img = ctx.createImageData(GRID_NX, GRID_NZ);
    const maxLux = Math.max(stats.max, 1);
    for (let i = 0; i < luxGrid.length; i++) {
      const [r, g, b] = falseColor(luxGrid[i] / maxLux);
      img.data[i * 4] = r * 255;
      img.data[i * 4 + 1] = g * 255;
      img.data[i * 4 + 2] = b * 255;
      img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    // 等照度线
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 1.5;
    ctx.font = '11px sans-serif';
    for (const level of ISO_LEVELS) {
      if (level > stats.max * 1.05) continue;
      const segs = isolines(luxGrid, GRID_NX, GRID_NZ, level);
      ctx.beginPath();
      for (const [x1, z1, x2, z2] of segs) {
        ctx.moveTo(x1 * GRID_NX, z1 * GRID_NZ);
        ctx.lineTo(x2 * GRID_NX, z2 * GRID_NZ);
      }
      ctx.stroke();
      if (segs.length) ctx.fillStyle = 'rgba(255,255,255,0.95)';
      segs.slice(0, 1).forEach(([x1, z1]) => ctx.fillText(`${level}lx`, x1 * GRID_NX + 2, z1 * GRID_NZ - 2));
    }
    // 不达标区域红色描边圈出
    ctx.strokeStyle = 'rgba(255,40,40,0.9)';
    ctx.lineWidth = 2;
    for (const [x, z] of stats.belowCells) {
      ctx.strokeRect(x, z, 1, 1);
    }
  }

  function renderSide(): void {
    const proj = store.current!;
    mount(side, [
      card('分析设置',
        numberField({ label: '工作面高度', value: proj.probe.workPlaneHeight, unit: 'm', min: 0, max: 2, step: 0.05,
          onInput: (v) => store.mutate((x) => { x.probe.workPlaneHeight = v; }) }),
        numberField({ label: '采光标准最低照度', value: proj.standardMinLux, unit: 'lux', min: 20, step: 10,
          onInput: (v) => store.mutate((x) => { x.standardMinLux = v; }) }),
        h('div', { class: 'btn-row' },
          button('刷新伪彩图', () => compute(), 'primary'),
          button('等待收敛后自动计算', autoCompute),
        ),
        h('p', { class: 'muted small' }, document.createTextNode(
          '移动货架或调整反射率后，探针几秒内重新收敛，HUD 中 Δ 小于 1% 表示稳定',
        )),
      ),
      stats ? card('工作面照度统计',
        h('div', { class: 'stat-row' },
          stat('平均照度', `${stats.avg.toFixed(1)} lx`),
          stat('最小照度', `${stats.min.toFixed(1)} lx`),
          stat('最大照度', `${stats.max.toFixed(1)} lx`),
          stat('均匀度 min/avg', stats.uniformity.toFixed(2)),
          stat('达标面积比', `${(stats.complianceRatio * 100).toFixed(1)}%`,
            `<${proj.standardMinLux}lx 区域红框标出`),
        ),
        table(['指标', '数值', '判定'], [
          ['平均照度', `${stats.avg.toFixed(1)} lx`, stats.avg >= proj.standardMinLux ? '达标' : '不达标'],
          ['均匀度', stats.uniformity.toFixed(2), stats.uniformity >= 0.4 ? '良好(≥0.4)' : '偏低'],
          ['不达标面积', `${(stats.area - stats.compliantArea).toFixed(1)} m²`, `${stats.belowCells.length} 网格`],
        ]),
      ) : card('工作面照度统计', h('p', { class: 'muted' }, document.createTextNode('点击「刷新伪彩图」开始计算'))),
      card('伪彩图 / 等照度线',
        h('div', { class: 'heat-wrap' }, heatCanvas),
        h('div', { class: 'legend' },
          ...['低', '', '', '', '高'].map((t) => h('span', {}, document.createTextNode(t))),
        ),
      ),
      annual ? card('全年逐时采光估算（工作日 8:00–18:00）',
        h('div', { class: 'stat-row' },
          stat('采光达标时长', `${annual.totalDaylightHours} h`, `共评估 ${annual.evaluatedHours} h`),
          stat('可省电气照明', `${annual.savedElectricHours} h/年`),
          stat('平均满足率', `${(annual.avgCompliance * 100).toFixed(1)}%`),
        ),
        h('div', { class: 'month-bars' },
          ...annual.monthly.map((m) =>
            h('div', { class: 'month-bar', title: `${m.month}月 ${m.hours}h` },
              h('div', { class: 'month-bar-fill', style: `height:${(m.hours / 2.4).toFixed(1)}px` }),
              h('span', {}, document.createTextNode(String(m.month))),
            ),
          ),
        ),
      ) : card('全年逐时采光估算',
        h('p', { class: 'muted' }, document.createTextNode('按当前方案逐时刻重算天空与管道输出，约需数秒')),
        button('运行全年 8760 评估', runAnnual, 'primary'),
      ),
    ]);
  }

  function autoCompute(): void {
    if (running) return;
    running = true;
    const tries = { n: 0 };
    const timer = setInterval(() => {
      tries.n++;
      const engine = viewport.glEngine;
      if (!engine) return;
      if (engine.convergence < 0.015 || tries.n > 60) {
        clearInterval(timer);
        running = false;
        compute();
      }
    }, 500);
  }

  async function runAnnual(): Promise<void> {
    const proj = store.current!;
    const cat = store.catalog;
    const saved = { date: proj.sky.date, hour: proj.sky.hour };
    // 简化：直接复用当前 GPU 结果随 Eh 线性缩放（室内传输线性，反射场景近似线性成立）
    compute();
    const baseEh = viewport.snapshot?.sky.horizontalEh ?? 10000;
    const baseAvg = stats?.avg ?? 1;
    const result = annualDaylight(proj, {
      workStart: 8,
      workEnd: 18,
      thresholdLux: proj.standardMinLux,
      evaluate: (date, hour) => {
        const test = structuredClone(proj.sky);
        test.date = date;
        test.hour = hour;
        test.manualEh = null;
        const field = buildSkyFieldLite(test);
        return baseAvg * (field.horizontalEh / Math.max(1, baseEh));
      },
    });
    annual = result;
    proj.sky.date = saved.date;
    proj.sky.hour = saved.hour;
    renderSide();
  }

  renderSide();
  mount(root, h('div', { class: 'workspace' }, viewport.el, side));
  viewport.start();
  // 首帧场景就绪后自动算一次
  setTimeout(() => compute(), 1500);
  window.addEventListener('hashchange', () => viewport.dispose(), { once: true });
}

// 轻量天空（128 采样足够年度统计）
import { buildSkyField } from '../../core/sky/sky';
function buildSkyFieldLite(sky: Parameters<typeof buildSkyField>[0]) {
  return buildSkyField(sky, 64);
}
