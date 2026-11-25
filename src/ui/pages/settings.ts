// 设置 / 精度校核：GPU 探针质量、照度标准、数据管理、积分球解析核对、漏光自检
import { store } from '../../core/store';
import { idb } from '../../core/db';
import { STANDARDS } from '../../core/seed';
import { h, btn, field, slider, numInput, select, modal, toast, pickTextFile, downloadText } from '../dom';
import { runIntegratingSphereCheck, type ValidationCase } from '../../core/validation';
import { runLeakSelfTest } from '../../core/issues';

export function renderSettings(): HTMLElement {
  const wrap = h('div', { class: 'stack', style: 'max-width:1080px;margin:0 auto' });
  wrap.appendChild(h('div', { class: 'page-head' },
    h('div', null,
      h('div', { class: 'page-title' }, '设置与精度校核'),
      h('div', { class: 'page-desc' }, '探针 GI 质量、照度标准、厂家参数表与 IndexedDB 数据管理；并用积分球解析解核对仿真精度。'),
    ),
  ));

  wrap.appendChild(validationCard());
  wrap.appendChild(leakCard());
  wrap.appendChild(qualityCard());
  wrap.appendChild(standardsCard());
  wrap.appendChild(dataCard());
  return wrap;
}

function validationCard(): HTMLElement {
  const resultBox = h('div', null, h('div', { class: 'small muted' }, '点击右侧按钮，在浏览器内运行三档空房间白墙工况的蒙特卡洛积分核对（约数秒）。'));
  const runBtn = btn('▶ 运行积分球精度核对', async () => {
    runBtn.disabled = true;
    barWrap.classList.remove('hide');
    try {
      const res = await runIntegratingSphereCheck((p) => {
        bar.style.width = `${Math.round(p * 100)}%`;
        barLabel.textContent = `校核计算中 ${Math.round(p * 100)}%`;
      });
      bar.style.width = '100%';
      barLabel.textContent = '完成';
      renderResult(res.cases, res.worstError, res.pass);
    } catch (e) {
      toast('校核失败：' + (e as Error).message, 'err');
    } finally {
      runBtn.disabled = false;
    }
  }, { variant: 'primary' });

  const bar = h('i', { style: 'width:0%' });
  const barLabel = h('span', { class: 'small mono' }, '0%');
  const barWrap = h('div', { class: 'hide mt12' },
    h('div', { class: 'progress light' }, bar),
    h('div', { class: 'mt8' }, barLabel),
  );

  const card = h('section', { class: 'card' },
    h('header', { class: 'card-head' }, h('h3', null, '精度验收 · 积分球解析核对'), h('div', { class: 'right' }, runBtn)),
    h('div', { class: 'card-body' },
      h('p', { class: 'small', style: 'margin-top:0' },
        '封闭空间、六面同一反射率 ρ 时，积分球能量守恒解析值为 ',
        h('b', { class: 'mono' }, 'E = Φ / [ 2(WD+WH+DH) · (1−ρ) ]'),
        '（全内表面面积加权平均照度）。仿真用同一套 BVH + 多级漫反射积分器计算该平均值，验收线误差 < 5%。'),
      resultBox,
      barWrap,
    ),
  );

  function renderResult(cases: ValidationCase[], worst: number, pass: boolean): void {
    resultBox.innerHTML = '';
    const hero = h('div', { class: `validation-hero ${pass ? 'pass' : ''}`, style: pass ? '' : 'background:var(--bad-soft);border-color:#f0c2bc' },
      h('div', { class: 'ring', style: pass ? '' : 'background:var(--bad)' }, pass ? '✓' : '!'),
      h('div', null,
        h('div', { style: 'font-size:20px;font-weight:800' }, pass ? `全部通过 · 最大误差 ${worst.toFixed(2)}%` : `未通过 · 最大误差 ${worst.toFixed(2)}%`),
        h('div', { class: 'small muted' }, pass ? '误差小于 5% 验收线，平均照度物理可信。' : '误差超过 5%，请提高采样/弹射数后重试。'),
      ),
    );
    resultBox.appendChild(hero);
    const table = h('table', { class: 'data-table' },
      h('thead', null, h('tr', null,
        h('th', null, '工况'), h('th', null, '尺寸'), h('th', null, 'ρ'),
        h('th', { class: 'right' }, '解析值 lx'), h('th', { class: 'right' }, '仿真均值 lx'), h('th', { class: 'right' }, '误差'), h('th', null, '结论'),
      )),
      h('tbody', null, ...cases.map((c) => h('tr', null,
        h('td', null, c.label),
        h('td', { class: 'mono small' }, c.size),
        h('td', { class: 'mono' }, c.rho.toFixed(2)),
        h('td', { class: 'right mono' }, c.analyticLux.toFixed(1)),
        h('td', { class: 'right mono' }, c.simulatedLux.toFixed(1)),
        h('td', { class: `right mono ${c.pass ? '' : 'bad'}`, style: c.pass ? 'color:var(--ok);font-weight:700' : 'color:var(--bad);font-weight:700' }, `${c.errorPct.toFixed(2)}%`),
        h('td', null, c.pass ? badge('PASS', 'ok') : badge('FAIL', 'bad')),
      ))),
    );
    resultBox.appendChild(table);
    resultBox.appendChild(h('p', { class: 'field-hint mt12' }, '命令行可复跑高密度版本：npm run check:physics（Node + tsx，三工况 48 点×128 采样）。'));
  }
  return card;
}

function leakCard(): HTMLElement {
  const out = h('div', { class: 'small muted' }, '尚未运行。');
  const run = btn('运行漏光自检（密封隔墙 + 货架阴影）', () => {
    run.disabled = true;
    setTimeout(() => {
      try {
        const r = runLeakSelfTest();
        out.innerHTML = '';
        out.appendChild(h('div', { class: r.pass ? 'empty-ok' : 'issue leak' },
          r.pass ? `✓ 无漏光：隔墙暗区/亮区=${(r.ratio * 100).toFixed(3)}%（阈值2%），货架下/旁=${(r.shelfShadowRatio * 100).toFixed(1)}%`
            : `✗ 检出漏光：ratio=${(r.ratio * 100).toFixed(2)}% shelf=${(r.shelfShadowRatio * 100).toFixed(1)}%`));
        out.appendChild(h('div', { class: 'small muted mt8 mono' }, `lit=${r.litLux.toFixed(1)}lx sealed=${r.sealedLux.toFixed(2)}lx`));
      } finally {
        run.disabled = false;
      }
    }, 30);
  }, { variant: 'ghost' });
  return h('section', { class: 'card' },
    h('header', { class: 'card-head' }, h('h3', null, '漏光 / 货架遮挡自检'), h('div', { class: 'right' }, run)),
    h('div', { class: 'card-body' },
      h('p', { class: 'small', style: 'margin-top:0' }, '双房间中整面到顶隔墙，仅一侧有灯：BVH 硬遮挡下暗区照度应 < 亮区 2%。GPU 探针另用深度矩 Chebyshev 可见性防止插值穿墙。'),
      out,
    ),
  );
}

function qualityCard(): HTMLElement {
  const s = store.settings;
  const body = h('div', { class: 'grid-form' });
  body.appendChild(field('每帧刷新探针数（越小帧率越高）',
    slider(s.gpuProbesPerFrame, 1, 24, 1, (v) => store.updateSettings({ gpuProbesPerFrame: Math.round(v) }), (v) => `${v}`)));
  body.appendChild(field('每探针光线采样/轮',
    slider(s.probeRays, 16, 128, 8, (v) => store.updateSettings({ probeRays: Math.round(v) }), (v) => `${v} 射线`)));
  body.appendChild(field('探针八面体纹理分辨率',
    select(String(s.probeResolution), [12, 16, 24, 32].map((n) => ({ value: String(n), label: `${n}×${n}` })),
      (v) => store.updateSettings({ probeResolution: parseInt(v) }))));
  body.appendChild(field('工作面网格长边分辨率',
    slider(s.heatmapGrid, 32, 128, 8, (v) => store.updateSettings({ heatmapGrid: Math.round(v) }), (v) => `${v} 格`)));
  body.appendChild(field('伪彩满量程 lx',
    numInput(s.falseColorMaxLux, (v) => store.updateSettings({ falseColorMaxLux: v }), { min: 50, max: 3000, step: 10 })));
  body.appendChild(h('label', { class: 'check-row full' },
    h('input', { type: 'checkbox', checked: s.showProbes, onchange: (e: Event) => store.updateSettings({ showProbes: (e.target as HTMLInputElement).checked }) }),
    '在三维视图显示探针位置'));
  return h('section', { class: 'card' },
    h('header', { class: 'card-head' }, h('h3', null, '仿真与渲染质量')),
    h('div', { class: 'card-body' }, body),
  );
}

function standardsCard(): HTMLElement {
  return h('section', { class: 'card' },
    h('header', { class: 'card-head' }, h('h3', null, '采光/照明标准库')),
    h('div', { style: 'overflow-x:auto' },
      h('table', { class: 'data-table' },
        h('thead', null, h('tr', null, h('th', null, '标准/场景'), h('th', { class: 'right' }, '平均照度 lx'), h('th', { class: 'right' }, '均匀度 Emin/Eavg'), h('th', { class: 'right' }, 'UGR 限值'))),
        h('tbody', null, ...STANDARDS.map((s) => h('tr', null,
          h('td', null, s.name),
          h('td', { class: 'right mono' }, String(s.requiredAvg)),
          h('td', { class: 'right mono' }, s.uniformity.toFixed(2)),
          h('td', { class: 'right mono' }, String(s.ugrLimit ?? '—')),
        ))),
      ),
    ),
  );
}

function dataCard(): HTMLElement {
  const host = h('div', { class: 'row wrap gap12' });
  host.appendChild(btn('导出全部项目/参数 (JSON)', async () => {
    downloadText(`tubelight-backup-${new Date().toISOString().slice(0, 10)}.json`, await idb.exportAll());
    toast('已导出备份文件', 'ok');
  }, { variant: 'primary', icon: '⤓' }));

  const importBtn = btn('导入备份 JSON', async () => {
    const f = await pickTextFile('.json');
    if (!f) return;
    try {
      const res = await idb.importAll(f.text);
      await store.init();
      toast(`导入 ${res.projects} 项目 / ${res.tables} 参数表`, 'ok');
    } catch (e) {
      toast('导入失败：' + (e as Error).message, 'err');
    }
  }, { variant: 'ghost' });
  host.appendChild(importBtn);

  host.appendChild(btn('清空并重建演示数据', () => {
    const body = h('p', { class: 'small' }, '将删除本机所有项目与参数表，并重新生成老厂房、地下车库与白墙校核间。确定？');
    const m = modal('清空数据', h('div', null, body, h('div', { class: 'flex gap12 mt16', style: 'justify-content:flex-end' },
      btn('取消', () => m.close(), { variant: 'ghost' }),
      btn('确定清空', async () => {
        await idb.clearAll();
        location.reload();
      }, { variant: 'danger' }),
    )), { width: 440 });
  }, { variant: 'danger' }));

  return h('section', { class: 'card' },
    h('header', { class: 'card-head' }, h('h3', null, 'IndexedDB 数据管理')),
    h('div', { class: 'card-body' },
      h('p', { class: 'small muted', style: 'margin-top:0' }, '所有项目、方案、选型、天空与能耗参数均保存在浏览器 IndexedDB（tubelight-studio），不上传任何服务器。'),
      host,
    ),
  );
}

function badge(text: string, tone: 'ok' | 'bad'): HTMLElement {
  // 局部简单 badge，避免循环
  const b = document.createElement('span');
  b.className = `badge badge-${tone}`;
  b.textContent = text;
  return b;
}
