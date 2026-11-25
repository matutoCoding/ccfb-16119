// 极简响应式 DOM 辅助，无框架依赖
export type VNode = HTMLElement | Text | null | undefined | false | VNode[];

type Attrs = Record<string, string | number | boolean | EventListener | undefined | null>;

function isEventListener(v: unknown): v is EventListener {
  return typeof v === 'function';
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: VNode[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && isEventListener(v)) {
      el.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (k === 'class') {
      el.className = String(v);
    } else if (k === 'dataset') {
      Object.assign(el.dataset, v);
    } else {
      el.setAttribute(k, String(v));
    }
  }
  append(el, children);
  return el;
}

export function append(parent: HTMLElement, children: VNode): void {
  const list = Array.isArray(children) ? children : [children];
  for (const c of list) {
    if (!c) continue;
    if (Array.isArray(c)) append(parent, c);
    else parent.append(c);
  }
}

export function clear(el: HTMLElement): void {
  el.replaceChildren();
}

export function text(s: string | number): Text {
  return document.createTextNode(String(s));
}

export function mount(el: HTMLElement, node: VNode): void {
  clear(el);
  append(el, node);
}

export interface FieldOptions {
  label: string;
  value: number | string;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  onInput: (v: number) => void;
}

export function numberField(o: FieldOptions): HTMLElement {
  return h('label', { class: 'field' },
    h('span', { class: 'field-label' }, text(o.label)),
    h('span', { class: 'field-row' },
      h('input', {
        type: 'number',
        value: o.value,
        min: o.min, max: o.max, step: o.step ?? 0.01,
        onInput: (e) => {
          const v = Number((e.target as HTMLInputElement).value);
          if (!Number.isNaN(v)) o.onInput(v);
        },
      }),
      o.unit ? h('em', { class: 'field-unit' }, text(o.unit)) : null,
    ),
  );
}

export function selectField(
  label: string,
  value: string,
  options: { value: string; label: string }[],
  onChange: (v: string) => void,
): HTMLElement {
  return h('label', { class: 'field' },
    h('span', { class: 'field-label' }, text(label)),
    h('select', {
      onChange: (e) => onChange((e.target as HTMLSelectElement).value),
    }, ...options.map((o) => h('option', {
      value: o.value,
      ...(o.value === value ? { selected: true } : {}),
    }, text(o.label)))),
  );
}

export function toggleField(label: string, value: boolean, onChange: (v: boolean) => void): HTMLElement {
  const input = h('input', { type: 'checkbox' }) as HTMLInputElement;
  input.checked = value;
  input.addEventListener('change', () => onChange(input.checked));
  return h('label', { class: 'field field-inline' },
    h('span', { class: 'field-label' }, text(label)),
    input,
  );
}

export function button(label: string, onClick: EventListener, kind: 'primary' | 'ghost' | 'danger' = 'ghost'): HTMLElement {
  return h('button', { class: `btn btn-${kind}`, onClick }, text(label));
}

export function card(title: string, ...children: VNode[]): HTMLElement {
  return h('section', { class: 'card' },
    h('h3', {}, text(title)),
    ...children,
  );
}

export function stat(label: string, value: string, hint = ''): HTMLElement {
  return h('div', { class: 'stat' },
    h('div', { class: 'stat-value' }, text(value)),
    h('div', { class: 'stat-label' }, text(label)),
    hint ? h('div', { class: 'stat-hint' }, text(hint)) : null,
  );
}

export function table(headers: string[], rows: (string | number)[][]): HTMLElement {
  return h('div', { class: 'table-wrap' },
    h('table', { class: 'data-table' },
      h('thead', {}, h('tr', {}, ...headers.map((x) => h('th', {}, text(x))))),
      h('tbody', {}, ...rows.map((r) => h('tr', {}, ...r.map((c) => h('td', {}, text(c)))))),
    ),
  );
}
