import { h, mount, button, card, numberField, selectField, toggleField, table } from '../dom';
import { store } from '../store';
import { Viewport } from '../viewport';
import type { BoxObject, ObjectKind, Vec3 } from '../../types';
import { uid } from '../../types';

const KIND_LABELS: Record<ObjectKind, string> = {
  shelf: '货架', partition: '隔墙', beam: '梁', window: '侧窗', column: '柱', other: '其他',
};

export function renderModel(root: HTMLElement): void {
  const p = store.current;
  if (!p) {
    mount(root, h('div', { class: 'empty' }, document.createTextNode('请先选择项目')));
    return;
  }
  const viewport = new Viewport();
  const side = h('div', { class: 'side-panel' });

  function renderSide(): void {
    const proj = store.current!;
    mount(side, [
      card('空间（柱网/层高）',
        numberField({ label: '宽 X', value: proj.room.width, unit: 'm', min: 3, max: 200, onInput: (v) => store.mutate((x) => { x.room.width = v; }) }),
        numberField({ label: '深 Z', value: proj.room.depth, unit: 'm', min: 3, max: 200, onInput: (v) => store.mutate((x) => { x.room.depth = v; }) }),
        numberField({ label: '层高 Y', value: proj.room.height, unit: 'm', min: 2, max: 30, onInput: (v) => store.mutate((x) => { x.room.height = v; }) }),
        numberField({ label: '柱网 X 间距', value: proj.room.bayX, unit: 'm', onInput: (v) => store.mutate((x) => { x.room.bayX = v; }) }),
        numberField({ label: '柱网 Z 间距', value: proj.room.bayZ, unit: 'm', onInput: (v) => store.mutate((x) => { x.room.bayZ = v; }) }),
      ),
      card('表面反射率',
        numberField({ label: '墙面', value: proj.room.wallReflectance, min: 0.02, max: 0.95, step: 0.01, onInput: (v) => store.mutate((x) => { x.room.wallReflectance = v; }) }),
        numberField({ label: '地面', value: proj.room.floorReflectance, min: 0.02, max: 0.95, step: 0.01, onInput: (v) => store.mutate((x) => { x.room.floorReflectance = v; }) }),
        numberField({ label: '顶棚', value: proj.room.ceilingReflectance, min: 0.02, max: 0.95, step: 0.01, onInput: (v) => store.mutate((x) => { x.room.ceilingReflectance = v; }) }),
      ),
      card('构件库',
        ...(Object.keys(KIND_LABELS) as ObjectKind[]).map((kind) =>
          button(`添加${KIND_LABELS[kind]}`, () => addObject(kind), kind === 'window' ? 'primary' : 'ghost'),
        ),
      ),
      card(`构件列表（${proj.objects.length}）`,
        h('div', { class: 'object-list' },
          ...proj.objects.map((o) =>
            h('div', { class: 'object-item' },
              h('div', { class: 'object-item-head' },
                h('strong', {}, document.createTextNode(`${KIND_LABELS[o.kind]} · ${o.name}`)),
                button('编辑', () => editObject(o.id)),
                button('删除', () => store.mutate((x) => {
                  x.objects = x.objects.filter((q) => q.id !== o.id);
                }), 'danger'),
              ),
              h('div', { class: 'muted small' }, document.createTextNode(
                `中心(${o.center.map((v) => v.toFixed(2)).join(', ')}) 尺寸(${o.size.map((v) => v.toFixed(2)).join(', ')}) ρ=${o.reflectance}`,
              )),
            ),
          ),
        ),
      ),
      card('探针参数',
        numberField({ label: '探针间距', value: proj.probe.spacing, unit: 'm', min: 1, max: 8, step: 0.5, onInput: (v) => store.mutate((x) => { x.probe.spacing = v; }) }),
        selectField('每探针光线数', String(proj.probe.raysPerProbe), [64, 128, 256].map((n) => ({ value: String(n), label: `${n} 条` })), (v) => store.mutate((x) => { x.probe.raysPerProbe = Number(v); })),
        numberField({ label: '每帧更新探针', value: proj.probe.probesPerFrame, min: 1, max: 64, step: 1, onInput: (v) => store.mutate((x) => { x.probe.probesPerFrame = v; }) }),
      ),
      card('视口显示',
        toggleField('探针辐照度球', viewport.viz === 1, (on) => { viewport.setViz(on ? 1 : 0); renderSide(); }),
        toggleField('探针深度矩', viewport.viz === 2, (on) => { viewport.setViz(on ? 2 : 0); renderSide(); }),
      ),
    ]);
  }

  function addObject(kind: ObjectKind): void {
    const proj = store.current!;
    const size: Vec3 = kind === 'window' ? [3, 1.5, 0.05]
      : kind === 'beam' ? [proj.room.width, 0.5, 0.4]
      : kind === 'column' ? [0.5, proj.room.height, 0.5]
      : kind === 'shelf' ? [6, 3, 1.2]
      : [4, 3, 0.2];
    const rho = kind === 'window' ? 0.1 : kind === 'shelf' ? 0.3 : 0.5;
    const obj: BoxObject = {
      id: uid(kind),
      kind,
      name: `${KIND_LABELS[kind]}${proj.objects.filter((o) => o.kind === kind).length + 1}`,
      center: [proj.room.width / 2, size[1] / 2, proj.room.depth / 2],
      size,
      rotationY: 0,
      reflectance: rho,
      color: [rho, rho * 0.98, rho * 0.95],
    };
    store.mutate((x) => x.objects.push(obj));
  }

  function editObject(id: string): void {
    const proj = store.current!;
    const o = proj.objects.find((q) => q.id === id);
    if (!o) return;
    mount(side, objectEditor(o, () => renderSide()));
  }

  renderSide();
  mount(root, h('div', { class: 'workspace' }, viewport.el, side));
  viewport.start();

  const unsub = store.subscribe(() => {
    if (location.hash.slice(1) !== 'model') return;
    renderSide();
  });
  // 页面切换时由 router 容器整体重建，这里仅停止渲染
  window.addEventListener('hashchange', () => {
    unsub();
    viewport.dispose();
  }, { once: true });
}

function objectEditor(o: BoxObject, onDone: () => void): HTMLElement {
  const f = (label: string, path: 'center' | 'size', axis: 0 | 1 | 2) =>
    numberField({
      label,
      value: o[path][axis],
      step: 0.1,
      onInput: (v) => store.mutate((p) => {
        const obj = p.objects.find((q) => q.id === o.id);
        if (obj) {
          obj[path][axis] = v;
          obj.color = [obj.reflectance, obj.reflectance * 0.98, obj.reflectance * 0.95];
        }
      }),
    });
  return h('div', { class: 'editor-overlay' },
    h('div', { class: 'editor-dialog card' },
      h('h3', {}, document.createTextNode(`编辑 ${o.name}`)),
      h('div', { class: 'grid-3' },
        f('中心 X', 'center', 0), f('中心 Y', 'center', 1), f('中心 Z', 'center', 2),
        f('尺寸 X', 'size', 0), f('尺寸 Y', 'size', 1), f('尺寸 Z', 'size', 2),
      ),
      numberField({ label: '绕 Y 旋转(°)', value: Math.round((o.rotationY * 180) / Math.PI), step: 1, onInput: (v) => store.mutate((p) => {
        const obj = p.objects.find((q) => q.id === o.id);
        if (obj) obj.rotationY = (v * Math.PI) / 180;
      }) }),
      numberField({ label: '表面反射率', value: o.reflectance, min: 0.02, max: 0.95, step: 0.01, onInput: (v) => store.mutate((p) => {
        const obj = p.objects.find((q) => q.id === o.id);
        if (obj) {
          obj.reflectance = v;
          obj.color = [v, v * 0.98, v * 0.95];
        }
      }) }),
      h('div', { class: 'dialog-actions' }, button('完成', onDone, 'primary')),
    ),
  );
}
