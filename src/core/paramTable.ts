// 厂家参数表 CSV/JSON 导入与模板
import type { TubeParamTable } from './types';
import { uid } from './util';

/**
 * 支持的 CSV 形如：
 *   diameter_mm,length_m,efficiency
 *   530,1,0.99
 *   530,2,0.965
 * 也支持宽表： diameter, 0.6,1,2,3... 作为管长列。
 */
export function parseParamCsv(text: string, name = '导入的参数表'): TubeParamTable {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) throw new Error('CSV 为空');
  const rows = lines.map((l) => l.split(/[,\t;]/).map((c) => c.trim()));
  const header = rows[0].map((h) => h.toLowerCase());

  const transmission: TubeParamTable['transmission'] = {};
  const diameters = new Set<number>();

  const diaIdx = header.findIndex((h) => h.includes('diam') || h.includes('管径') || h === 'd');
  const lenIdx = header.findIndex((h) => h.includes('length') || h.includes('管长') || h === 'l');
  const effIdx = header.findIndex((h) => h.includes('eff') || h.includes('效率') || h.includes('transmission') || h.includes('传输'));

  if (diaIdx >= 0 && lenIdx >= 0 && effIdx >= 0) {
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const dia = Math.round(parseFloat(r[diaIdx]));
      const len = parseFloat(r[lenIdx]);
      let eff = parseFloat(r[effIdx]);
      if (!isFinite(dia) || !isFinite(len) || !isFinite(eff)) continue;
      if (eff > 1) eff /= 100; // 百分数
      diameters.add(dia);
      (transmission[String(dia)] ??= []).push({ length: len, efficiency: eff });
    }
  } else {
    // 宽表：第一列管径，其余表头为管长
    const lengthCols = header.slice(1).map((h, idx) => ({ idx: idx + 1, len: parseFloat(h) })).filter((x) => isFinite(x.len));
    for (let i = 1; i < rows.length; i++) {
      const dia = Math.round(parseFloat(rows[i][0]));
      if (!isFinite(dia)) continue;
      diameters.add(dia);
      transmission[String(dia)] = lengthCols
        .map(({ idx, len }) => {
          let eff = parseFloat(rows[i][idx]);
          if (!isFinite(eff)) return null;
          if (eff > 1) eff /= 100;
          return { length: len, efficiency: eff };
        })
        .filter((x): x is { length: number; efficiency: number } => !!x)
        .sort((a, b) => a.length - b.length);
    }
  }

  if (!diameters.size) throw new Error('未能从 CSV 解析出管径/管长/效率，请使用模板格式');

  return {
    id: uid('tbl'),
    name,
    vendor: '导入',
    diameters: [...diameters].sort((a, b) => a - b),
    domes: [
      { id: 'dome-std', name: '标准采光罩', transmittance: 0.92 },
      { id: 'dome-crystal', name: '高透采光罩', transmittance: 0.95 },
    ],
    diffusers: [
      { id: 'diff-lambert', name: '朗伯漫射器', transmittance: 0.86, distribution: 'lambert' },
      { id: 'diff-wide', name: '广角漫射器', transmittance: 0.88, distribution: 'wide' },
    ],
    transmission,
    elbowFactor: 0.92,
    maintenanceFactor: 0.85,
    importedAt: Date.now(),
  };
}

export function paramCsvTemplate(): string {
  return [
    'diameter_mm,length_m,efficiency',
    '350,1,0.96',
    '350,2,0.91',
    '350,3,0.86',
    '350,4,0.81',
    '530,1,0.99',
    '530,2,0.965',
    '530,3,0.94',
    '530,4,0.91',
    '530,6,0.85',
    '650,1,0.995',
    '650,3,0.965',
    '650,6,0.91',
  ].join('\n');
}
