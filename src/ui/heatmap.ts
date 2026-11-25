// 工作面照度网格 -> Canvas 伪彩 + 等照度线 + 不达标区域 + 灯具位置
import type { IlluminanceGrid, TubeInstance } from '../core/types';
import { falseColor, extractIsolines } from '../core/grid';

export interface HeatmapOptions {
  maxLux: number;
  standardLux?: number;
  showIsolines?: boolean;
  showDeficient?: boolean;
  tubes?: TubeInstance[];
  widthM?: number;
  depthM?: number;
  isoLevels?: number[];
}

/**
 * 绘制到给定 canvas（会设置 backing store）。
 * 采用 “世界 米 -> 画布” 等比适配，Y 轴 z 向下。
 */
export function drawHeatmap(canvas: HTMLCanvasElement, grid: IlluminanceGrid, opts: HeatmapOptions): void {
  const parent = canvas.parentElement;
  const cssW = canvas.clientWidth || parent?.clientWidth || 600;
  const cssH = canvas.clientHeight || parent?.clientHeight || 400;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const W = opts.widthM ?? grid.x0 * -2;
  const D = opts.depthM ?? (grid.z0 * -2);
  // 等比包含
  const pad = 34;
  const scale = Math.min((cssW - pad * 2) / W, (cssH - pad * 2) / D);
  const drawW = W * scale;
  const drawH = D * scale;
  const ox = (cssW - drawW) / 2;
  const oy = (cssH - drawH) / 2;
  // 世界坐标 x∈[-W/2,W/2], z∈[-D/2,D/2] -> 画布
  const X = (x: number) => ox + (x + W / 2) * scale;
  const Z = (z: number) => oy + (z + D / 2) * scale;

  // 背景
  ctx.fillStyle = '#0b1220';
  ctx.fillRect(0, 0, cssW, cssH);

  // 伪彩：逐格 fillRect
  const cw = grid.dx * scale + 1;
  const ch = grid.dz * scale + 1;
  for (let r = 0; r < grid.rows; r++) {
    for (let c = 0; c < grid.cols; c++) {
      const v = grid.values[r * grid.cols + c];
      const t = Math.pow(Math.min(1, v / opts.maxLux), 0.62); // 感知拉伸
      const [rr, gg, bb] = falseColor(t);
      ctx.fillStyle = `rgb(${rr},${gg},${bb})`;
      const x = grid.x0 + c * grid.dx;
      const z = grid.z0 + r * grid.dz;
      ctx.fillRect(X(x), Z(z), cw, ch);
    }
  }

  // 货架占地掩膜
  if (grid.masked) {
    for (let r = 0; r < grid.rows; r++) {
      for (let c = 0; c < grid.cols; c++) {
        if (!grid.masked[r * grid.cols + c]) continue;
        const x = grid.x0 + c * grid.dx;
        const z = grid.z0 + r * grid.dz;
        ctx.fillStyle = 'rgba(122, 84, 44, 0.72)';
        ctx.fillRect(X(x), Z(z), cw, ch);
        ctx.strokeStyle = 'rgba(255, 220, 170, 0.35)';
        ctx.lineWidth = 1;
        ctx.strokeRect(X(x) + 0.5, Z(z) + 0.5, cw - 1, ch - 1);
      }
    }
  }

  // 不达标区域斜纹/描边
  if (opts.showDeficient && opts.standardLux) {
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,.85)';
    ctx.lineWidth = 1.4;
    // 沿 deficient 边界简单描格
    for (let r = 0; r < grid.rows; r++) {
      for (let c = 0; c < grid.cols; c++) {
        if (!grid.deficient[r * grid.cols + c]) continue;
        const x = grid.x0 + c * grid.dx;
        const z = grid.z0 + r * grid.dz;
        ctx.fillStyle = 'rgba(10,16,30,.28)';
        ctx.fillRect(X(x), Z(z), cw, ch);
      }
    }
    // 标准等值线加粗红色
    ctx.restore();
  }

  // 等照度线
  if (opts.showIsolines) {
    const levels = opts.isoLevels ?? defaultIsoLevels(opts.maxLux, opts.standardLux);
    const segs = extractIsolines(grid, levels);
    ctx.lineWidth = 1.1;
    ctx.font = '600 10px ui-monospace, monospace';
    for (const s of segs) {
      const isStd = opts.standardLux && Math.abs(s.level - opts.standardLux) < 1;
      ctx.strokeStyle = isStd ? 'rgba(255,255,255,.95)' : 'rgba(255,255,255,.42)';
      ctx.lineWidth = isStd ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(X(s.x1), Z(s.z1));
      ctx.lineTo(X(s.x2), Z(s.z2));
      ctx.stroke();
    }
    // 等值线数值标注（稀疏）
    ctx.fillStyle = 'rgba(255,255,255,.92)';
    let lastLabel = 0;
    for (const s of segs) {
      if (s.level !== (opts.standardLux ?? -1) && s.level % 100 !== 0) continue;
      if (Math.abs(s.x1 + s.z1 - lastLabel) < 0.01) continue;
      if (Math.random() < 0.04) {
        const mx = (s.x1 + s.x2) / 2;
        const mz = (s.z1 + s.z2) / 2;
        ctx.fillText(`${s.level}`, X(mx) + 2, Z(mz) - 2);
        lastLabel = s.x1 + s.z1;
      }
    }
  }

  // 房间外框
  ctx.strokeStyle = 'rgba(255,255,255,.9)';
  ctx.lineWidth = 2;
  ctx.strokeRect(X(-W / 2), Z(-D / 2), W * scale, D * scale);

  // 灯管位置
  if (opts.tubes) {
    for (const t of opts.tubes) {
      if (!t.enabled) continue;
      const px = X(t.x);
      const pz = Z(t.z);
      const rad = Math.max(4, (t.diameter / 1000 / 2) * scale);
      ctx.beginPath();
      ctx.arc(px, pz, rad + 3, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,236,170,.25)';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(px, pz, rad, 0, Math.PI * 2);
      ctx.fillStyle = '#ffe9a8';
      ctx.fill();
      ctx.strokeStyle = '#b9821f';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }

  // 坐标轴 / 比例尺
  ctx.fillStyle = 'rgba(255,255,255,.75)';
  ctx.font = '11px system-ui';
  ctx.fillText(`${W.toFixed(0)} m`, ox + drawW - 30, oy + drawH + 18);
  ctx.fillText(`${D.toFixed(0)} m`, ox - 26, oy + 10);
}

export function defaultIsoLevels(maxLux: number, std?: number): number[] {
  const levels: number[] = [];
  const step = maxLux <= 200 ? 25 : maxLux <= 400 ? 50 : 100;
  for (let v = step; v < maxLux; v += step) levels.push(v);
  if (std && !levels.some((l) => Math.abs(l - std) < 1)) levels.push(std);
  return levels.sort((a, b) => a - b);
}

/** 离屏渲染成 dataURL，用于项目缩略图 / 对比卡片 */
export function heatmapToDataURL(grid: IlluminanceGrid, opts: HeatmapOptions, w = 480, h = 300): string {
  const canvas = document.createElement('canvas');
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  document.body.appendChild(canvas);
  drawHeatmap(canvas, grid, { ...opts });
  const url = canvas.toDataURL('image/png');
  canvas.remove();
  return url;
}
