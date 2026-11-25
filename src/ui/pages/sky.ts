import { h, mount, button, card, numberField, selectField, toggleField, stat } from '../dom';
import { store } from '../store';
import { Viewport } from '../viewport';
import { buildSkyField, solarPosition } from '../../core/sky/sky';
import { rad2deg } from '../../core/math/vec3';

export function renderSky(root: HTMLElement): void {
  const p = store.current;
  if (!p) {
    mount(root, h('div', { class: 'empty' }, document.createTextNode('请先选择项目')));
    return;
  }
  const viewport = new Viewport();
  const side = h('div', { class: 'side-panel' });

  function renderSide(): void {
    const proj = store.current!;
    const sky = buildSkyField(proj.sky, 256);
    const sun = solarPosition(proj.sky);
    const daylight = sun.altitude > 0;
    mount(side, [
      card('天空模型（CIE）',
        selectField('模型', proj.sky.model, [
          { value: 'overcast', label: 'CIE 全阴天（设计工况）' },
          { value: 'clear', label: 'CIE 晴天（含太阳直射）' },
        ], (v) => store.mutate((x) => {
          x.sky.model = v as 'overcast' | 'clear';
        })),
        proj.sky.model === 'clear'
          ? numberField({ label: 'Linke 浊度', value: proj.sky.turbidity, min: 1, max: 10, step: 0.1,
            onInput: (v) => store.mutate((x) => { x.sky.turbidity = v; }) })
          : null,
      ),
      card('地点与时刻',
        numberField({ label: '纬度', value: proj.sky.latitude, min: -90, max: 90, step: 0.01,
          onInput: (v) => store.mutate((x) => { x.sky.latitude = v; }) }),
        numberField({ label: '经度', value: proj.sky.longitude, min: -180, max: 180, step: 0.01,
          onInput: (v) => store.mutate((x) => { x.sky.longitude = v; }) }),
        numberField({ label: '时区（UTC）', value: proj.sky.timezone, min: -12, max: 14, step: 1,
          onInput: (v) => store.mutate((x) => { x.sky.timezone = v; }) }),
        h('label', { class: 'field' },
          h('span', { class: 'field-label' }, document.createTextNode('日期')),
          dateInput(proj.sky.date, (v) => store.mutate((x) => { x.sky.date = v; })),
        ),
        numberField({ label: '时刻', value: proj.sky.hour, min: 0, max: 24, step: 0.25, unit: 'h',
          onInput: (v) => store.mutate((x) => { x.sky.hour = v; }) }),
        h('div', { class: 'btn-row' },
          ...[6, 9, 12, 15, 18].map((hr) => button(`${hr}:00`, () => store.mutate((x) => { x.sky.hour = hr; }))),
        ),
      ),
      card('采光罩入口计算结果',
        h('div', { class: 'stat-row' },
          stat('水平面照度 Eh', `${sky.horizontalEh.toFixed(0)} lx`,
            proj.sky.manualEh != null ? '手动指定' : '模型计算'),
          stat('太阳高度角', daylight ? `${rad2deg(sun.altitude).toFixed(1)}°` : '地平面下'),
          stat('太阳方位角', `${rad2deg(sun.azimuth).toFixed(1)}°`, '正南 0°，西正'),
        ),
        daylight && proj.sky.model === 'clear'
          ? stat('直射法向照度', `${sky.directNormal.toFixed(0)} lx`)
          : null,
        toggleField('手动指定室外 Eh', proj.sky.manualEh != null, (on) => store.mutate((x) => {
          x.sky.manualEh = on ? 10000 : null;
        })),
        proj.sky.manualEh != null
          ? numberField({ label: '手动 Eh', value: proj.sky.manualEh ?? 10000, unit: 'lux', min: 0, step: 100,
            onInput: (v) => store.mutate((x) => { x.sky.manualEh = v; }) })
          : null,
        h('p', { class: 'muted small' }, document.createTextNode(
          '全阴天默认设计照度 10000 lx（GB 50033 参考值），天顶亮度按 Lz=9Eh/7π 反算',
        )),
      ),
    ]);
  }

  renderSide();
  mount(root, h('div', { class: 'workspace' }, viewport.el, side));
  viewport.start();
  window.addEventListener('hashchange', () => viewport.dispose(), { once: true });
}

function dateInput(value: string, onChange: (v: string) => void): HTMLElement {
  const input = h('input', { type: 'date', value }) as HTMLInputElement;
  input.addEventListener('change', () => onChange(input.value));
  return input;
}
