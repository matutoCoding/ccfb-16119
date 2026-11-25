// 交互式 2D 平面画布：房间/柱网/构件/导光管，支持点选、拖动、空白添加
import type { Project } from '../core/types';

export interface PlanHandle {
  redraw: () => void;
  destroy: () => void;
}

interface Opts {
  selectedId: () => string | null;
  onSelect: (tubeId: string | null) => void;
  onChange: () => void;
  onAddAt: (x: number, z: number) => void;
}

export function drawPlanCanvas(canvas: HTMLCanvasElement, project: Project, opts: Opts): PlanHandle {
  const ctx = canvas.getContext('2d')!;
  let w = 0,
    h = 0,
    dpr = 1;
  let scale = 1,
    ox = 0,
    oy = 0;
  let dragId: string | null = null;
  let moved = false;

  const scheme = () => project.schemes.find((s) => s.id === project.activeSchemeId) ?? project.schemes[0];

  function resize(): void {
    const parent = canvas.parentElement;
    w = parent?.clientWidth ?? canvas.clientWidth ?? 600;
    h = parent?.clientHeight ?? canvas.clientHeight ?? 400;
    dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    computeTransform();
  }

  function computeTransform(): void {
    const W = project.space.width,
      D = project.space.depth;
    const pad = 56;
    scale = Math.min((w - pad * 2) / W, (h - pad * 2) / D);
    ox = (w - W * scale) / 2;
    oy = (h - D * scale) / 2;
  }
  const X = (x: number) => ox + (x + project.space.width / 2) * scale;
  const Z = (z: number) => oy + (z + project.space.depth / 2) * scale;
  const invX = (px: number) => (px - ox) / scale - project.space.width / 2;
  const invZ = (py: number) => (py - oy) / scale - project.space.depth / 2;

  function redraw(): void {
    if (!canvas.isConnected) return;
    resize();
    ctx.clearRect(0, 0, w, h);
    // 背景点阵
    ctx.fillStyle = '#0e1626';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(120,150,200,.12)';
    for (let gx = 0; gx < w; gx += 24) ctx.fillRect(gx, 0, 1, h);
    for (let gy = 0; gy < h; gy += 24) ctx.fillRect(0, gy, w, 1);

    const W = project.space.width,
      D = project.space.depth;
    // 地面
    ctx.fillStyle = 'rgba(120,150,200,.10)';
    ctx.fillRect(X(-W / 2), Z(-D / 2), W * scale, D * scale);

    // 柱网
    const g = project.space.grid;
    const totalX = g.baysX * g.spanX,
      totalZ = g.baysZ * g.spanZ;
    for (let ix = 0; ix <= g.baysX; ix++)
      for (let iz = 0; iz <= g.baysZ; iz++) {
        const x = -totalX / 2 + ix * g.spanX;
        const z = -totalZ / 2 + iz * g.spanZ;
        const cs = Math.max(3, g.columnSize * scale);
        ctx.fillStyle = 'rgba(185,192,208,.85)';
        ctx.fillRect(X(x) - cs / 2, Z(z) - cs / 2, cs, cs);
      }

    // 构件
    for (const o of project.space.objects) {
      ctx.save();
      ctx.translate(X(o.x), Z(o.z));
      ctx.rotate(-(o.rotation || 0));
      if (o.kind === 'shelf') {
        ctx.fillStyle = 'rgba(214,158,92,.85)';
        ctx.strokeStyle = 'rgba(255,220,170,.9)';
        ctx.lineWidth = 1.5;
        const lw = o.length * scale,
          ld = o.depth * scale;
        roundRect(-lw / 2, -ld / 2, lw, ld, 3);
        ctx.fill();
        ctx.stroke();
        // 层板线
        ctx.strokeStyle = 'rgba(80,50,20,.5)';
        ctx.lineWidth = 1;
        for (let i = 1; i < o.levels; i++) {
          const yy = -ld / 2 + (ld * i) / o.levels;
          ctx.beginPath();
          ctx.moveTo(-lw / 2 + 2, yy);
          ctx.lineTo(lw / 2 - 2, yy);
          ctx.stroke();
        }
      } else if (o.kind === 'partition') {
        ctx.fillStyle = 'rgba(220,228,245,.92)';
        ctx.fillRect(-(o.length * scale) / 2, -Math.max(2.5, o.thickness * scale) / 2, o.length * scale, Math.max(2.5, o.thickness * scale));
      } else if (o.kind === 'beam') {
        ctx.strokeStyle = 'rgba(154,167,189,.55)';
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 5]);
        ctx.beginPath();
        ctx.moveTo(-(o.length * scale) / 2, 0);
        ctx.lineTo((o.length * scale) / 2, 0);
        ctx.stroke();
        ctx.setLineDash([]);
      } else if (o.kind === 'window') {
        ctx.fillStyle = 'rgba(111,195,255,.95)';
        ctx.fillRect(-(o.width * scale) / 2, -3, o.width * scale, 6);
      }
      ctx.restore();
    }

    // 墙
    ctx.strokeStyle = 'rgba(235,242,255,.95)';
    ctx.lineWidth = 3;
    ctx.strokeRect(X(-W / 2), Z(-D / 2), W * scale, D * scale);

    // 尺寸标注
    ctx.fillStyle = 'rgba(200,214,240,.8)';
    ctx.font = '12px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.fillText(`${W.toFixed(1)} m`, ox + (W * scale) / 2, oy + D * scale + 24);
    ctx.save();
    ctx.translate(ox - 26, oy + (D * scale) / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText(`${D.toFixed(1)} m`, 0, 0);
    ctx.restore();
    ctx.textAlign = 'left';

    // 管道
    const sel = opts.selectedId();
    for (const t of scheme()?.tubes ?? []) {
      const px = X(t.x),
        pz = Z(t.z);
      const rad = Math.max(7, (t.diameter / 1000 / 2) * scale + 3);
      if (t.id === sel) {
        ctx.beginPath();
        ctx.arc(px, pz, rad + 7, 0, Math.PI * 2);
        ctx.strokeStyle = '#57b8ff';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      const grad = ctx.createRadialGradient(px - rad / 3, pz - rad / 3, 1, px, pz, rad);
      grad.addColorStop(0, '#fff6d8');
      grad.addColorStop(1, t.enabled ? '#f2b53c' : '#7a6a45');
      ctx.beginPath();
      ctx.arc(px, pz, rad, 0, Math.PI * 2);
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.strokeStyle = '#8a5e12';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.fillStyle = '#5a3d08';
      ctx.font = 'bold 10px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(t.diameter).slice(0, 2), px, pz + 0.5);
      ctx.textBaseline = 'alphabetic';
    }
  }

  function roundRect(x: number, y: number, ww: number, hh: number, r: number): void {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + ww, y, x + ww, y + hh, r);
    ctx.arcTo(x + ww, y + hh, x, y + hh, r);
    ctx.arcTo(x, y + hh, x, y, r);
    ctx.arcTo(x, y, x + ww, y, r);
    ctx.closePath();
  }

  function eventPos(e: PointerEvent | MouseEvent): { mx: number; my: number } {
    const rect = canvas.getBoundingClientRect();
    return { mx: e.clientX - rect.left, my: e.clientY - rect.top };
  }

  function hitTube(mx: number, my: number): string | null {
    const tubes = scheme()?.tubes ?? [];
    for (let i = tubes.length - 1; i >= 0; i--) {
      const t = tubes[i];
      const rad = Math.max(10, (t.diameter / 1000 / 2) * scale + 6);
      if (Math.hypot(X(t.x) - mx, Z(t.z) - my) <= rad) return t.id;
    }
    return null;
  }

  function onDown(e: PointerEvent): void {
    const { mx, my } = eventPos(e);
    const id = hitTube(mx, my);
    moved = false;
    if (id) {
      dragId = id;
      opts.onSelect(id);
      canvas.setPointerCapture(e.pointerId);
    } else {
      dragId = '__pending_blank__';
    }
  }
  function onMove(e: PointerEvent): void {
    if (!dragId) return;
    moved = true;
    const { mx, my } = eventPos(e);
    const x = invX(mx),
      z = invZ(my);
    if (dragId === '__pending_blank__') return;
    const t = scheme()?.tubes.find((tt) => tt.id === dragId);
    if (t) {
      t.x = Math.max(-project.space.width / 2 + 0.3, Math.min(project.space.width / 2 - 0.3, x));
      t.z = Math.max(-project.space.depth / 2 + 0.3, Math.min(project.space.depth / 2 - 0.3, z));
      redraw();
    }
  }
  function onUp(e: PointerEvent): void {
    const { mx, my } = eventPos(e);
    if (dragId === '__pending_blank__' && !moved) {
      // 确认点在房间内
      const x = invX(mx),
        z = invZ(my);
      if (Math.abs(x) <= project.space.width / 2 && Math.abs(z) <= project.space.depth / 2) {
        opts.onAddAt(x, z);
      }
    } else if (dragId && dragId !== '__pending_blank__') {
      opts.onChange();
    }
    dragId = null;
  }

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  const ro = new ResizeObserver(() => redraw());
  if (canvas.parentElement) ro.observe(canvas.parentElement);
  redraw();

  return {
    redraw,
    destroy() {
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      ro.disconnect();
    },
  };
}
