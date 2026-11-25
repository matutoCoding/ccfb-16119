import { store } from '../../core/store';
import type { Project, IlluminanceGrid, AnnualResult, LeakPoint } from '../../core/types';
import { h, btn, field, numInput, select, toast, badge } from '../dom';
import { buildProjectScene, solveWorkplane, solveDaylightCoefficient, type BuiltScene } from '../../core/solver';
import { analyzeIssues } from '../../core/issues';
import { runAnnual } from '../../core/annual';
import { exteriorIlluminance, sunDirection, skyZenithScale } from '../../core/sky';
import { buildSceneMesh } from '../../core/geometry';
import { buildBVH, packBVH } from '../../core/bvh';
import { buildProbeLayout } from '../../core/grid';
import { drawHeatmap } from '../heatmap';
import { ProbeBaker, type BakerStats } from '../../gl/ProbeBaker';
import { STANDARDS } from '../../core/seed';

type Cleanup = () => void;

export function renderAnalysisPage(container: HTMLElement, projectId: string): Cleanup {
  const project = store.getProject(projectId)!;
  let alive = true;
  let baker: ProbeBaker | null = null;
  let built: BuiltScene | null = null;
  let grid: IlluminanceGrid | null = null;
  let issues: LeakPoint[] = [];
  let annual: AnnualResult | null = null;
  let viewMode: 'gpu' | 'cpu' = 'gpu';

  container.classList.add('nopad');
  const root = h('div', { class: 'analysis-layout' });
  const leftCol = h('div', { class: 'analysis-col' });
  const centerCol = h('div', { class: 'analysis-col', style: 'gap:12px;min-height:0' });
  const rightCol = h('div', { class: 'analysis-col right-col' });
  root.append(leftCol, centerCol, rightCol);
  container.appendChild(root);

  // ---------- 左：工况与计算 ----------
  function renderLeft() {
    leftCol.innerHTML = '';
    const sky = project.sky;
    const ext = exteriorIlluminance(sky);

    const skyCard = h('section', { class: 'card' },
      h('header', { class: 'card-head' }, h('h3', null, '天空与地点')),
      h('div', { class: 'card-body' },
        field('CIE 天空模型', select(sky.type, [
          { value: 'overcast', label: 'CIE 标准全阴天' },
          { value: 'clear', label: 'CIE 晴天' },
        ], (v) => store.updateProject(projectId, (p) => { p.sky.type = v; refreshSkyDependent(); }))),
        field('城市/地点', select(sky.location.name, [
          { value: '上海', label: '上海 (31.2°N)' }, { value: '北京', label: '北京 (39.9°N)' },
          { value: '广州', label: '广州 (23.1°N)' }, { value: '成都', label: '成都 (30.7°N)' },
          { value: '哈尔滨', label: '哈尔滨 (45.8°N)' }, { value: '乌鲁木齐', label: '乌鲁木齐 (43.8°N)' },
        ], (v) => {
          const coords: Record<string, [number, number]> = {
            上海: [31.23, 121.47], 北京: [39.9, 116.4], 广州: [23.13, 113.26], 成都: [30.67, 104.07],
            哈尔滨: [45.8, 126.53], 乌鲁木齐: [43.83, 87.62],
          };
          const [lat, lon] = coords[v];
          store.updateProject(projectId, (p) => { p.sky.location.name = v; p.sky.location.latitude = lat; p.sky.location.longitude = lon; });
          renderLeft(); refreshGpuSky();
        })),
        h('div', { class: 'grid-form' },
          field('月', numInput(sky.month, (v) => store.updateProject(projectId, (p) => { p.sky.month = Math.min(12, Math.max(1, Math.round(v))); renderLeft(); refreshGpuSky(); }), { min: 1, max: 12 })),
          field('日', numInput(sky.day, (v) => store.updateProject(projectId, (p) => { p.sky.day = Math.min(28, Math.max(1, Math.round(v))); renderLeft(); refreshGpuSky(); }), { min: 1, max: 28 })),
          field('时刻 (h)', numInput(sky.hour, (v) => store.updateProject(projectId, (p) => { p.sky.hour = Math.min(23, Math.max(0, Math.round(v))); renderLeft(); refreshGpuSky(); }), { min: 0, max: 23 })),
          field('浑浊度', numInput(sky.turbidity, (v) => store.updateProject(projectId, (p) => { p.sky.turbidity = v; refreshGpuSky(); }), { min: 1.5, max: 6, step: 0.1 })),
        ),
        field('室外水平面照度覆盖 (lx，0=按模型)', numInput(sky.overrideExteriorLux ?? 0, (v) => store.updateProject(projectId, (p) => { p.sky.overrideExteriorLux = v > 0 ? v : null; renderLeft(); }), { min: 0, max: 120000, step: 500 })),
        h('div', { class: 'kv mt8' },
          h('dt', null, '太阳高度角'), h('dd', null, `${(ext.sun.elevation * 180 / Math.PI).toFixed(1)}°`),
          h('dt', null, '室外水平面照度'), h('dd', { class: 'mono' }, `${Math.round(ext.horizontalLux).toLocaleString()} lx`),
          h('dt', null, '法向直射'), h('dd', { class: 'mono' }, `${Math.round(ext.directNormalLux).toLocaleString()} lx`),
          h('dt', null, '散射水平'), h('dd', { class: 'mono' }, `${Math.round(ext.diffuseHorizontalLux).toLocaleString()} lx`),
        ),
      ),
    );
    leftCol.appendChild(skyCard);

    const stdCard = h('section', { class: 'card' },
      h('header', { class: 'card-head' }, h('h3', null, '采光标准')),
      h('div', { class: 'card-body' },
        field('标准', select(project.standard.id, STANDARDS.map((s) => ({ value: s.id, label: s.name })), (v) => {
          const s = STANDARDS.find((x) => x.id === v)!;
          store.updateProject(projectId, (p) => { p.standard = s; p.energy.targetLux = s.requiredAvg; });
          renderLeft(); renderRight(); drawCpuHeat(); baker?.setFalseColorMax(store.settings.falseColorMaxLux, s.requiredAvg);
        })),
        h('div', { class: 'grid-form' },
          field('平均照度标准 (lx)', numInput(project.standard.requiredAvg, (v) => store.updateProject(projectId, (p) => { p.standard.requiredAvg = v; p.energy.targetLux = v; renderRight(); }), { min: 10, max: 2000, step: 10 })),
          field('均匀度 Emin/Eavg', numInput(project.standard.uniformity, (v) => store.updateProject(projectId, (p) => { p.standard.uniformity = clamp01(v); }), { min: 0.1, max: 1, step: 0.05 })),
        ),
        field('伪彩上限 (lx)', numInput(store.settings.falseColorMaxLux, (v) => { void store.updateSettings({ falseColorMaxLux: v }); baker?.setFalseColorMax(v, project.standard.requiredAvg); drawCpuHeat(); }, { min: 50, max: 5000, step: 50 })),
      ),
    );
    leftCol.appendChild(stdCard);

    const calcCard = h('section', { class: 'card' },
      h('header', { class: 'card-head' }, h('h3', null, '计算与年度')),
      h('div', { class: 'card-body' },
        btn('▶ 精算工作面照度 (CPU 路径积分)', () => void runCpu(false), { variant: 'primary' }),
        h('div', { class: 'small muted mt8' }, 'GPU 探针 GI 实时收敛；CPU 精算用于出具平均/最小/均匀度与达标面积。'),
        h('div', { class: 'mt12' }, btn('📅 运行全年 8760 小时采光与节能', () => void runYear(), { variant: 'ghost' })),
        annual ? renderAnnualSummary() : null,
      ),
    );
    leftCol.appendChild(calcCard);
  }

  function clamp01(v: number) { return Math.max(0.05, Math.min(1, v)); }
  function refreshSkyDependent() { renderLeft(); refreshGpuSky(); }

  // ---------- 中：视图 ----------
  const tabs = h('div', { class: 'tabs' },
    h('button', { class: 'active', 'data-v': 'gpu', onclick: () => setView('gpu') }, 'GPU 动态 GI · 探针收敛'),
    h('button', { 'data-v': 'cpu', onclick: () => setView('cpu') }, '精算伪彩 + 等照度线'),
  );
  const viewHead = h('div', { class: 'flex aic jcb' }, tabs, h('div', { id: 'view-actions' }));
  centerCol.appendChild(viewHead);

  const gpuWrap = h('div', { class: 'heatmap-wrap grow', style: 'min-height:420px' });
  const gpuCanvas = h('canvas', { class: 'gl' }) as HTMLCanvasElement;
  gpuWrap.appendChild(gpuCanvas);
  const gpuHud = h('div', { class: 'stage-hud' });
  gpuWrap.appendChild(gpuHud);
  const gpuSide = h('div', { class: 'stage-side' });
  gpuWrap.appendChild(gpuSide);
  centerCol.appendChild(gpuWrap);

  const cpuWrap = h('div', { class: 'heatmap-wrap grow hide', style: 'min-height:420px' });
  const heatCanvas = h('canvas', { class: 'heat' }) as HTMLCanvasElement;
  cpuWrap.appendChild(heatCanvas);
  const legend = h('div', { class: 'heat-legend' },
    h('div', { style: 'display:flex;gap:8px;align-items:stretch' },
      h('div', { class: 'legend-bar' }),
      h('div', { style: 'display:flex;flex-direction:column;justify-content:space-between;height:150px;font-size:11px;line-height:1' },
        h('span', null, `${store.settings.falseColorMaxLux} lx`),
        h('span', null, `${Math.round(store.settings.falseColorMaxLux / 2)}`),
        h('span', null, '0'),
      ),
    ),
  );
  cpuWrap.appendChild(legend);
  centerCol.appendChild(cpuWrap);

  const progressBar = h('div', { class: 'progress light hide' }, h('i', { style: 'width:0%' }));
  const progressLabel = h('div', { class: 'small muted' });
  centerCol.appendChild(progressBar);
  centerCol.appendChild(progressLabel);

  function setView(v: 'gpu' | 'cpu') {
    viewMode = v;
    tabs.querySelectorAll('button').forEach((b) => b.classList.toggle('active', (b as HTMLElement).dataset.v === v));
    gpuWrap.classList.toggle('hide', v !== 'gpu');
    cpuWrap.classList.toggle('hide', v !== 'cpu');
    if (v === 'cpu') requestAnimationFrame(drawCpuHeat);
  }

  // ---------- GPU Baker ----------
  let gpuOk = false;
  try {
    baker = new ProbeBaker(gpuCanvas);
    baker.setQuality({ probesPerFrame: store.settings.gpuProbesPerFrame, samplesPerUpdate: 4, targetSamples: store.settings.probeRays });
    baker.onStats = (s: BakerStats) => { if (alive) renderGpuHud(s); };
    gpuOk = true;
  } catch (e) {
    gpuOk = false;
    gpuWrap.appendChild(h('div', {
      style: 'position:absolute;inset:0;display:grid;place-items:center;color:#ffd76b;background:#1a1710;padding:40px;text-align:center;z-index:10',
    }, `GPU 探针 GI 不可用（${(e as Error).message}）。已自动使用 CPU 精算伪彩；请用支持 EXT_color_buffer_float 的 Chrome/Edge。`));
    setView('cpu');
  }

  function buildGpuScene() {
    if (!baker || !gpuOk) return;
    const scheme = activeScheme();
    const ext = exteriorIlluminance(project.sky).horizontalLux;
    const mesh = buildSceneMesh(project.space, scheme.tubes, store.tables, ext);
    const bvh = buildBVH(mesh, 4);
    const packed = packBVH(mesh, bvh);
    const layout = buildProbeLayout(project.space.width, project.space.depth, project.space.height, project.probeSpacing);
    baker.setScene(mesh, packed, layout);
    const extInfo = exteriorIlluminance(project.sky);
    const sunDir = sunDirection(extInfo.sun);
    const lz = skyZenithScale(project.sky.type, sunDir, extInfo.diffuseHorizontalLux || extInfo.horizontalLux);
    baker.setSky(project.sky.type, sunDir, lz, extInfo.horizontalLux);
    baker.setFalseColorMax(store.settings.falseColorMaxLux, project.standard.requiredAvg);
    baker.resetConvergence();
    baker.start();
    gpuSide.innerHTML = '';
    gpuSide.appendChild(h('div', { class: 'hud-panel' },
      h('h4', null, '动态漫反射 GI'),
      h('div', { class: 'mini' }, `BVH 节点 ${packed.nodeCount} · 三角面 ${packed.triCount} · 探针 ${layout.count}`),
      h('div', { class: 'mini mt8' }, '八面体辐照度 + 深度二阶矩，Chebyshev 可见性穿墙抑制'),
      btn('重置收敛', () => baker?.resetConvergence(), { variant: 'ghost', size: 'sm' }),
    ));
  }

  function refreshGpuSky() {
    if (!baker) return;
    const extInfo = exteriorIlluminance(project.sky);
    const sunDir = sunDirection(extInfo.sun);
    const lz = skyZenithScale(project.sky.type, sunDir, extInfo.diffuseHorizontalLux || extInfo.horizontalLux);
    baker.setSky(project.sky.type, sunDir, lz, extInfo.horizontalLux);
  }

  function renderGpuHud(s: BakerStats) {
    const fpsCls = s.fps >= 30 ? 'fps-good' : s.fps >= 18 ? 'fps-mid' : 'fps-bad';
    gpuHud.innerHTML = '';
    gpuHud.append(
      h('div', { class: `hud-chip ${fpsCls}` }, h('b', null, s.fps.toFixed(0)), ' fps'),
      h('div', { class: 'hud-chip' }, '探针 ', h('b', null, `${s.probes}`)),
      h('div', { class: 'hud-chip' }, '已更新 ', h('b', null, `${s.updatedThisRound}`)),
      h('div', { class: 'hud-chip', style: 'display:flex;gap:8px;align-items:center;min-width:180px' },
        '收敛', h('div', { class: 'progress', style: 'width:90px' }, h('i', { style: `width:${(s.progress * 100).toFixed(0)}%` })), `${(s.progress * 100).toFixed(0)}%`),
    );
  }

  function activeScheme() {
    return project.schemes.find((x) => x.id === project.activeSchemeId) ?? project.schemes[0];
  }

  // ---------- 右：统计 + 问题 ----------
  function renderRight() {
    rightCol.innerHTML = '';
    if (!grid) {
      rightCol.appendChild(h('section', { class: 'card' }, h('div', { class: 'card-body muted small' },
        '点击「精算工作面照度」生成平均/最小照度、均匀度、达标面积与漏光/过亮/眩光清单。GPU 视图可实时预览收敛中的 GI。')));
      return;
    }
    const st = grid.stats;
    const uOk = st.uniformity >= project.standard.uniformity;
    const avgOk = st.avg >= project.standard.requiredAvg;
    const statsCard = h('section', { class: 'card' },
      h('header', { class: 'card-head' }, h('h3', null, '照度指标'), badge(avgOk ? '平均达标' : '平均不足', avgOk ? 'ok' : 'bad')),
      h('div', { class: 'card-body' },
        h('div', { class: 'stat-grid' },
          statBox('平均照度 Eavg', st.avg.toFixed(0), 'lx', avgOk ? 'good' : 'bad', `标准 ${project.standard.requiredAvg}`),
          statBox('最小照度 Emin', st.min.toFixed(0), 'lx', st.min >= project.standard.requiredAvg * project.standard.uniformity ? 'good' : 'warn', ''),
          statBox('均匀度 Emin/Eavg', st.uniformity.toFixed(2), '', uOk ? 'good' : 'bad', `≥ ${project.standard.uniformity}`),
          statBox('Emin/Emax', st.uniformityMax.toFixed(2), '', '', ''),
          statBox('达标面积比例', `${(st.compliantAreaRatio * 100).toFixed(1)}`, '%', st.compliantAreaRatio > 0.8 ? 'good' : 'warn', ''),
          statBox('仿真耗时', grid.elapsedMs.toFixed(0), 'ms', '', grid.engine),
        ),
      ),
    );
    rightCol.appendChild(statsCard);

    const issueCard = h('section', { class: 'card' },
      h('header', { class: 'card-head' }, h('h3', null, `问题清单 (${issues.length})`),
        h('div', { class: 'right' }, badge(issues.some((i) => i.kind === 'leak') ? '存在漏光' : '无漏光', issues.some((i) => i.kind === 'leak') ? 'bad' : 'ok'))),
      h('div', { class: 'card-body' },
        issues.length === 0
          ? h('div', { class: 'empty-ok' }, '✓ 未检出漏光 / 过亮 / 眩光异常')
          : h('div', { class: 'issue-list' }, ...issues.slice(0, 30).map((it) =>
            h('div', { class: `issue ${it.kind}` },
              h('div', { class: 'ico' }, it.kind === 'leak' ? '⛔' : it.kind === 'overbright' ? '🔆' : '👁'),
              h('div', null,
                h('div', null, it.message),
                h('div', { class: 'meta' }, `位置 x=${it.x.toFixed(1)} z=${it.z.toFixed(1)} m · ${kindName(it.kind)}`),
              ),
            ),
          )),
      ),
    );
    rightCol.appendChild(issueCard);
  }

  function statBox(k: string, v: string, unit: string, cls: string, sub: string) {
    return h('div', { class: `stat ${cls}` },
      h('div', { class: 'k' }, k),
      h('div', { class: 'v' }, v, h('small', null, unit)),
      sub ? h('div', { class: 'sub muted' }, sub) : null,
    );
  }
  function kindName(k: LeakPoint['kind']) { return k === 'leak' ? '漏光/插值穿透' : k === 'overbright' ? '过亮' : '眩光估算'; }

  function drawCpuHeat() {
    if (!grid) return;
    const scheme = activeScheme();
    drawHeatmap(heatCanvas, grid, {
      maxLux: store.settings.falseColorMaxLux,
      standardLux: project.standard.requiredAvg,
      showIsolines: true,
      showDeficient: true,
      tubes: scheme.tubes,
      widthM: project.space.width,
      depthM: project.space.depth,
    });
  }

  async function runCpu(quick = false) {
    progressBar.classList.remove('hide');
    const barI = progressBar.querySelector('i')! as HTMLElement;
    progressLabel.textContent = '构建 BVH 与场景…';
    built = buildProjectScene(project, activeScheme(), store.tables);
    grid = await solveWorkplane(built, project, {
      resolution: quick ? 40 : store.settings.heatmapGrid,
      samples: quick ? 10 : 24,
      smoothing: 1,
      onProgress: (p, label) => { barI.style.width = `${(p * 100).toFixed(0)}%`; progressLabel.textContent = label ?? ''; },
    });
    if (!alive) return;
    progressBar.classList.add('hide');
    progressLabel.textContent = `完成：${grid.cols}×${grid.rows} 网格 · ${grid.elapsedMs.toFixed(0)} ms`;
    issues = analyzeIssues(project, grid, built);
    renderRight();
    drawCpuHeat();
    setView('cpu');
    toast('照度精算完成', 'ok');
  }

  async function runYear() {
    toast('开始全年逐时计算（先求采光系数）…', 'info');
    const dc = await solveDaylightCoefficient(project, activeScheme(), store.tables, (p) => {
      progressLabel.textContent = `采光系数求解 ${(p * 100).toFixed(0)}%`;
    });
    if (!alive) return;
    const dcAvg = dc.dc.reduce((a, b) => a + b, 0) / dc.dc.length;
    annual = runAnnual(project, { dcAvg });
    renderLeft();
    renderAnnualChart();
    toast(`全年达标时长 ${annual.occupiedMetHours}/${annual.occupiedTotalHours} h`, 'ok', 3600);
  }

  function renderAnnualSummary(): HTMLElement {
    const a = annual!;
    return h('div', { class: 'mt12 stack gap8' },
      h('div', { class: 'stat-grid' },
        miniStat('采光自主率 DA', `${(a.daylightAutonomy * 100).toFixed(0)}%`, `${a.occupiedMetHours}/${a.occupiedTotalHours}h`),
        miniStat('年节电', Math.round(a.savedKwh).toLocaleString(), 'kWh'),
        miniStat('节省电费', `¥${Math.round(a.savedCost).toLocaleString()}`, ''),
        miniStat('减碳', Math.round(a.co2Kg).toLocaleString(), 'kg CO₂'),
      ),
      h('div', { class: 'small muted' }, `电气照明能耗 ${Math.round(a.lightingEnergyKwh).toLocaleString()} kWh/年 · 相当减少照明用电 ${(a.savedKwh / Math.max(1, project.energy.lpd * project.space.width * project.space.depth / 1000)).toFixed(0)} 个满负荷小时`),
      h('div', { id: 'monthly-chart' }),
    );
  }
  function miniStat(k: string, v: string, sub: string) {
    return h('div', { class: 'metric-mini' }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v), sub ? h('div', { class: 'k' }, sub) : null);
  }
  function renderAnnualChart() {
    const host = leftCol.querySelector('#monthly-chart');
    if (!host || !annual) return;
    host.innerHTML = '';
    const chart = h('div', { class: 'bar-chart' });
    const maxH = Math.max(1, ...annual.monthlyHours);
    for (let m = 0; m < 12; m++) {
      const met = annual.monthlyMet[m];
      const total = annual.monthlyHours[m] || 1;
      const heightPct = (annual.monthlyHours[m] / maxH) * 100;
      const metPct = (met / total) * 100;
      chart.appendChild(h('div', { style: `position:relative;flex:1;height:${heightPct}%` },
        h('div', { class: 'bar', style: `position:absolute;inset:0;opacity:.25` }),
        h('div', { class: 'bar met', style: `position:absolute;left:0;right:0;bottom:0;height:${metPct}%` }),
      ));
    }
    const labels = h('div', { class: 'axis-labels' }, ...Array.from({ length: 12 }, (_, i) => h('span', null, String(i + 1))));
    host.appendChild(h('div', { class: 'small muted', style: 'marginBottom:4px' }, '各月工作时段采光达标小时（绿）/ 总工作小时（浅）'));
    host.appendChild(chart);
    host.appendChild(labels);
  }

  // 初始
  renderLeft();
  renderRight();
  buildGpuScene();
  // 初始：快速自动出一版数
  void runCpu(true);

  const onResize = () => drawCpuHeat();
  window.addEventListener('resize', onResize);

  return () => {
    alive = false;
    window.removeEventListener('resize', onResize);
    baker?.dispose();
    container.classList.remove('nopad');
  };
}
