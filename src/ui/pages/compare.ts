// 方案对比页：并排 2~3 套管数/位置，热力图、指标、漏光/过亮/眩光点
import { store } from '../../core/store';
import type { Project, Scheme, IlluminanceGrid, LeakPoint } from '../../core/types';
import { h, btn, select, toast } from '../dom';
import { buildProjectScene, solveWorkplane, type BuiltScene } from '../../core/solver';
import { analyzeIssues } from '../../core/issues';
import { drawHeatmap } from '../heatmap';

interface ColResult {
  scheme: Scheme;
  grid: IlluminanceGrid;
  issues: LeakPoint[];
  built: BuiltScene;
}

export function renderCompare(content: HTMLElement, projectId: string): () => void {
  const project = store.getProject(projectId)!;
  let alive = true;
  // 默认选前 3 套（或前 2）
  const selected: string[] = project.schemes.slice(0, Math.min(3, project.schemes.length)).map((s) => s.id);
  while (selected.length < 2 && project.schemes.length >= 2) selected.push(project.schemes[1].id);

  const root = h('div', { class: 'stack', style: 'padding:18px 22px;max-width:1700px;margin:0 auto' });
  root.appendChild(h('div', { class: 'page-head' },
    h('div', null,
      h('div', { class: 'page-title' }, '方案对比'),
      h('div', { class: 'page-desc' }, '并排比较 2~3 套管数与布管位置；统一天空工况与标准，列出漏光、过亮与眩光点。'),
    ),
  ));

  const controls = h('div', { class: 'card' }, h('div', { class: 'card-body flex aic gap12 wrap' }));
  const pickers = h('div', { class: 'flex gap12 wrap grow' });
  controls.querySelector('.card-body')!.appendChild(pickers);
  const runBtn = btn('▶ 计算并对比', () => void run(), { variant: 'primary' });
  controls.querySelector('.card-body')!.appendChild(runBtn);
  root.appendChild(controls);

  const status = h('div', { class: 'small muted' }, '选择方案后点击「计算并对比」。');
  root.appendChild(status);
  const gridWrap = h('div', { class: 'compare-grid' });
  gridWrap.style.gridTemplateColumns = `repeat(${Math.max(2, selected.length)}, minmax(0,1fr))`;
  root.appendChild(gridWrap);
  content.appendChild(root);

  function renderPickers(): void {
    pickers.innerHTML = '';
    const count = Math.min(3, project.schemes.length);
    for (let i = 0; i < count; i++) {
      const val = selected[i] ?? project.schemes[i].id;
      if (selected[i] == null) selected[i] = val;
      const sel = select(val, project.schemes.map((s) => ({ value: s.id, label: s.name })), (v) => {
        selected[i] = v;
      }) as HTMLSelectElement;
      sel.style.minWidth = '220px';
      pickers.appendChild(h('label', { class: 'flex aic gap8 small' }, `方案 ${i + 1}`, sel));
    }
  }
  renderPickers();

  async function run(): Promise<void> {
    runBtn.disabled = true;
    gridWrap.innerHTML = '';
    const ids = selected.slice(0, 3);
    const results: ColResult[] = [];
    try {
      for (let i = 0; i < ids.length; i++) {
        const scheme = project.schemes.find((s) => s.id === ids[i]);
        if (!scheme) continue;
        status.textContent = `正在计算 ${i + 1}/${ids.length}：${scheme.name} …`;
        await new Promise((r) => setTimeout(r, 20));
        const built = buildProjectScene(project, scheme, store.tables);
        const grid = await solveWorkplane(built, project, { resolution: 40, samples: 10, smoothing: 1, onProgress: () => {} });
        const issues = analyzeIssues(project, grid, built);
        results.push({ scheme, grid, issues, built });
        if (!alive) return;
      }
      status.textContent = `完成 · 统一工况 ${project.sky.type === 'overcast' ? 'CIE 全阴天' : 'CIE 晴天'} · 标准 ${project.standard.requiredAvg} lx`;
      renderColumns(results);
    } catch (e) {
      status.textContent = '计算失败：' + (e as Error).message;
      toast('对比计算失败：' + (e as Error).message, 'err');
    } finally {
      runBtn.disabled = false;
    }
  }

  function renderColumns(results: ColResult[]): void {
    gridWrap.innerHTML = '';
    // 选综合最优：达标面积比例高 + 均匀度高 + issue 少
    const score = (r: ColResult) =>
      r.grid.stats.compliantAreaRatio * 2 + Math.min(1, r.grid.stats.uniformity) - r.issues.filter((x) => x.kind === 'leak').length * 0.1;
    let bestIdx = 0;
    results.forEach((r, i) => { if (score(r) > score(results[bestIdx])) bestIdx = i; });

    results.forEach((r, i) => {
      const { stats } = r.grid;
      const leakN = r.issues.filter((x) => x.kind === 'leak').length;
      const overN = r.issues.filter((x) => x.kind === 'overbright').length;
      const glareN = r.issues.filter((x) => x.kind === 'glare').length;
      const col = h('div', { class: `compare-col${i === bestIdx ? ' best' : ''}` });
      col.appendChild(h('div', { class: 'compare-head' },
        h('h3', null, r.scheme.name, i === bestIdx ? badge('综合最优', 'ok') : null),
        h('div', { class: 'note' }, r.scheme.note || `${r.scheme.tubes.filter((t) => t.enabled).length} 根管`),
      ));
      const cvWrap = h('div', { class: 'compare-canvas' });
      const cv = h('canvas') as HTMLCanvasElement;
      cvWrap.appendChild(cv);
      col.appendChild(cvWrap);

      col.appendChild(h('div', { class: 'compare-metrics' },
        metric('平均照度', `${Math.round(stats.avg)}`, 'lx', stats.avg >= project.standard.requiredAvg ? 'good' : 'bad'),
        metric('最小照度', `${Math.round(stats.min)}`, 'lx', stats.min >= project.standard.requiredAvg * project.standard.uniformity ? 'good' : 'warn'),
        metric('均匀度 U0', stats.uniformity.toFixed(2), '', stats.uniformity >= project.standard.uniformity ? 'good' : 'bad'),
        metric('达标面积', `${Math.round(stats.compliantAreaRatio * 100)}`, '%', stats.compliantAreaRatio > 0.8 ? 'good' : 'warn'),
      ));

      const issueBox = h('div', { class: 'compare-issues' });
      issueBox.appendChild(h('div', { class: 'flex gap8 wrap' },
        badge(`漏光 ${leakN}`, leakN ? 'bad' : 'ok'),
        badge(`过亮 ${overN}`, overN ? 'warn' : 'ok'),
        badge(`眩光 ${glareN}`, glareN ? 'warn' : 'ok'),
      ));
      if (!r.issues.length) issueBox.appendChild(h('div', { class: 'empty-ok mt8' }, '✓ 未发现漏光 / 过亮 / 眩光点'));
      for (const is of r.issues.slice(0, 8)) {
        issueBox.appendChild(h('div', { class: `issue ${is.kind} mt8` },
          h('span', { class: 'ico' }, is.kind === 'leak' ? '⚠' : is.kind === 'overbright' ? '☀' : '👁'),
          h('div', null,
            h('div', null, is.message),
            h('div', { class: 'meta' }, `位置 x=${is.x.toFixed(1)} z=${is.z.toFixed(1)} · ${is.severity === 'high' ? '严重' : is.severity === 'mid' ? '中等' : '轻微'}`),
          ),
        ));
      }
      col.appendChild(issueBox);
      gridWrap.appendChild(col);
      requestAnimationFrame(() => drawHeatmap(cv, r.grid, {
        maxLux: store.settings.falseColorMaxLux,
        standardLux: project.standard.requiredAvg,
        showIsolines: true,
        showDeficient: true,
        tubes: r.scheme.tubes,
        widthM: project.space.width,
        depthM: project.space.depth,
      }));
    });
  }

  return () => { alive = false; };
}

function metric(k: string, v: string, unit: string, tone: 'good' | 'bad' | 'warn'): HTMLElement {
  return h('div', { class: 'metric-mini' },
    h('div', { class: 'k' }, k),
    h('div', { class: `v ${tone === 'good' ? 'fps-good' : tone === 'bad' ? 'fps-bad' : 'fps-mid'}` }, v, unit ? h('small', { style: 'font-size:11px;color:var(--text-3);font-weight:600' }, ' ' + unit) : null),
  );
}

function badge(text: string, tone: 'ok' | 'warn' | 'bad'): HTMLElement {
  const b = document.createElement('span');
  b.className = `badge badge-${tone}`;
  b.textContent = text;
  return b;
}
