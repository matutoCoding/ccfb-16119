// 极简 hyperscript + 通用 UI 组件
export type Child = Node | string | number | false | null | undefined | Child[];

export type ElProps<K extends keyof HTMLElementTagNameMap> = Omit<
  Partial<HTMLElementTagNameMap[K]>,
  'style' | 'class' | 'dataset'
> & {
  class?: string;
  style?: string | Partial<CSSStyleDeclaration>;
  dataset?: Record<string, string>;
  html?: string;
  [eventHandler: `on${string}`]: unknown;
  [dataAttr: `data-${string}`]: unknown;
};

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: ElProps<K> | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = String(v);
      else if (k === 'style' && typeof v === 'string') el.setAttribute('style', v);
      else if (k === 'dataset') {
        for (const [dk, dv] of Object.entries(v as Record<string, string>)) el.dataset[dk] = dv;
      } else if (k.startsWith('on') && typeof v === 'function') {
        el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      } else if (k === 'html') {
        el.innerHTML = String(v);
      } else if (k.startsWith('data-') || k.startsWith('aria-')) {
        el.setAttribute(k, String(v));
      } else {
        try {
          // @ts-expect-error 通用属性赋值
          el[k] = v;
        } catch {
          el.setAttribute(k, String(v));
        }
      }
    }
  }
  appendChildren(el, children);
  return el;
}

export function appendChildren(el: HTMLElement, children: Child[]): void {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) appendChildren(el, c);
    else if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
}

export function clear(el: HTMLElement): void {
  el.innerHTML = '';
}

// ---- 表单字段 ----
export function field(label: string, input: HTMLElement, hint?: string): HTMLElement {
  return h('label', { class: 'field' },
    h('span', { class: 'field-label' }, label),
    input,
    hint ? h('span', { class: 'field-hint' }, hint) : null,
  );
}

export function numInput(
  value: number,
  onInput: (v: number) => void,
  opts: { min?: number; max?: number; step?: number; unit?: string; disabled?: boolean } = {},
): HTMLElement {
  const wrap = h('div', { class: 'num-input' + (opts.unit ? ' has-unit' : '') });
  const input = h('input', {
    type: 'number',
    value: String(round(value, opts.step)),
    min: opts.min != null ? String(opts.min) : undefined,
    max: opts.max != null ? String(opts.max) : undefined,
    step: opts.step != null ? String(opts.step) : 'any',
    disabled: opts.disabled,
  }) as HTMLInputElement;
  input.addEventListener('change', () => {
    const v = parseFloat(input.value);
    if (isFinite(v)) onInput(clampOpts(v, opts.min, opts.max));
  });
  wrap.appendChild(input);
  if (opts.unit) wrap.appendChild(h('span', { class: 'unit' }, opts.unit));
  return wrap;
}

function round(v: number, step?: number): number {
  if (!step || step >= 1) return Math.round(v * 1000) / 1000;
  const d = Math.round(-Math.log10(step));
  return Number(v.toFixed(Math.max(0, d + 1)));
}
function clampOpts(v: number, min?: number, max?: number): number {
  if (min != null && v < min) v = min;
  if (max != null && v > max) v = max;
  return v;
}

export function slider(
  value: number,
  min: number,
  max: number,
  step: number,
  onInput: (v: number) => void,
  fmt?: (v: number) => string,
): HTMLElement {
  const val = h('span', { class: 'slider-val' }, fmt ? fmt(value) : String(value));
  const input = h('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(value) }) as HTMLInputElement;
  input.addEventListener('input', () => {
    const v = parseFloat(input.value);
    val.textContent = fmt ? fmt(v) : String(v);
    onInput(v);
  });
  return h('div', { class: 'slider-row' }, input, val);
}

export function select<T extends string>(
  value: T,
  options: { value: T; label: string }[],
  onChange: (v: T) => void,
): HTMLElement {
  const sel = h('select') as HTMLSelectElement;
  for (const o of options) {
    const op = h('option', { value: o.value }, o.label) as HTMLOptionElement;
    if (o.value === value) op.selected = true;
    sel.appendChild(op);
  }
  sel.addEventListener('change', () => onChange(sel.value as T));
  return sel;
}

export function btn(
  label: string,
  onClick: (e: MouseEvent) => void,
  opts: { variant?: 'primary' | 'ghost' | 'danger' | 'subtle'; icon?: string; disabled?: boolean; title?: string; size?: 'sm' } = {},
): HTMLButtonElement {
  const b = h('button', {
    class: `btn btn-${opts.variant ?? 'subtle'}${opts.size === 'sm' ? ' btn-sm' : ''}`,
    disabled: opts.disabled,
    title: opts.title,
    onclick: onClick,
  }) as HTMLButtonElement;
  if (opts.icon) b.appendChild(h('span', { class: 'btn-icon' }, opts.icon));
  b.appendChild(document.createTextNode(label));
  return b;
}

export function badge(text: string, tone: 'ok' | 'warn' | 'bad' | 'info' | 'neutral' = 'neutral'): HTMLElement {
  return h('span', { class: `badge badge-${tone}` }, text);
}

export function card(title: string | null, ...body: Child[]): HTMLElement {
  return h('section', { class: 'card' },
    title ? h('header', { class: 'card-head' }, h('h3', null, title)) : null,
    h('div', { class: 'card-body' }, ...body),
  );
}

// ---- Toast ----
let toastHost: HTMLElement | null = null;
export function toast(message: string, tone: 'ok' | 'err' | 'info' = 'info', ms = 2600): void {
  if (!toastHost) {
    toastHost = h('div', { class: 'toast-host' });
    document.body.appendChild(toastHost);
  }
  const t = h('div', { class: `toast toast-${tone}` }, message);
  toastHost.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => t.remove(), 300);
  }, ms);
}

// ---- Modal ----
export function modal(title: string, content: HTMLElement, opts: { width?: number } = {}): { close: () => void; root: HTMLElement } {
  const overlay = h('div', { class: 'modal-overlay' });
  const dialog = h('div', { class: 'modal', style: opts.width ? `max-width:${opts.width}px` : '' },
    h('header', { class: 'modal-head' },
      h('h3', null, title),
      h('button', { class: 'modal-x', onclick: () => close() }, '×'),
    ),
    h('div', { class: 'modal-body' }, content),
  );
  overlay.appendChild(dialog);
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) close();
  });
  document.body.appendChild(overlay);
  function close(): void {
    overlay.classList.add('closing');
    setTimeout(() => overlay.remove(), 180);
  }
  return { close, root: overlay };
}

/** 触发文件选择并读取文本 */
export function pickTextFile(accept: string): Promise<{ name: string; text: string } | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => {
      const f = input.files?.[0];
      if (!f) return resolve(null);
      const reader = new FileReader();
      reader.onload = () => resolve({ name: f.name, text: String(reader.result) });
      reader.readAsText(f);
    };
    input.click();
  });
}

export function downloadText(filename: string, text: string, mime = 'application/json'): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 轮询直到 WebGL/异步就绪的小工具 */
export function rafThrottle<A extends unknown[]>(fn: (...args: A) => void): (...args: A) => void {
  let scheduled = false;
  let lastArgs: A;
  return (...args: A) => {
    lastArgs = args;
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      fn(...lastArgs);
    });
  };
}
