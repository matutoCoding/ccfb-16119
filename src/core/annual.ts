// 全年 8760 小时逐时：室外照度（确定性典型年）→ 室内 DC 缩放 → 达标时长 + 照明节能
import type { AnnualResult, Project } from './types';
import { exteriorIlluminance } from './sky';

/** 非闰年各月天数 */
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

export function hourToDate(h: number): { month: number; day: number; hour: number } {
  let dayIndex = Math.floor(h / 24);
  const hour = h % 24;
  let month = 0;
  while (dayIndex >= MONTH_DAYS[month]) {
    dayIndex -= MONTH_DAYS[month];
    month++;
  }
  return { month: month + 1, day: dayIndex + 1, hour };
}

/** 确定性典型气象年逐时水平面照度 */
export function typicalYearLux(project: Project, h: number): number {
  const { month, day, hour } = hourToDate(h);
  const baseSky = project.sky;
  // 由年积日生成稳定的晴阴系数
  const doy = h / 24;
  const hash = Math.abs(Math.sin(doy * 12.9898 + hour * 78.233) * 43758.5453) % 1;
  const seasonal = 0.15 * Math.cos(((month - 1) / 12) * Math.PI * 2);
  const kt = Math.max(0.15, Math.min(0.95, 0.45 + 0.4 * hash + seasonal));

  const clear = exteriorIlluminance({
    ...baseSky,
    type: 'clear',
    month,
    day,
    hour,
    overrideExteriorLux: null,
  }).horizontalLux;
  const over = exteriorIlluminance({
    ...baseSky,
    type: 'overcast',
    month,
    day,
    hour,
    overrideExteriorLux: null,
  }).horizontalLux;
  // kt 高 -> 偏晴
  return kt * clear + (1 - kt) * over;
}

export interface AnnualInput {
  dcAvg: number; // 平均采光系数（室内平均照度 / 室外水平面照度）
  dc?: Float32Array;
}

export function runAnnual(project: Project, input: AnnualInput): AnnualResult {
  const energy = project.energy;
  const area = project.space.width * project.space.depth;
  const powerKw = (energy.lpd * area) / 1000;

  const hours: number[] = new Array(8760);
  const monthlyMet = new Array(12).fill(0);
  const monthlyHours = new Array(12).fill(0);

  let occupiedMet = 0;
  let occupiedTotal = 0;
  let lightingKwh = 0;

  for (let h = 0; h < 8760; h++) {
    const { month, hour } = hourToDate(h);
    const eOut = typicalYearLux(project, h);
    const eInAvg = Math.max(0, input.dcAvg * eOut);
    hours[h] = eInAvg;

    const occupied = hour >= energy.dayStart && hour < energy.dayEnd;
    if (occupied) {
      occupiedTotal++;
      monthlyHours[month - 1]++;
      if (eInAvg >= energy.targetLux) {
        occupiedMet++;
        monthlyMet[month - 1]++;
      }
      // 光感连续调光：不足部分由电气照明补充
      const electricFrac = Math.max(0, Math.min(1, (energy.targetLux - eInAvg) / energy.targetLux));
      lightingKwh += powerKw * electricFrac;
    }
  }

  // 无采光基准能耗（工作时段满负荷）
  const baselineKwh = powerKw * occupiedTotal;
  const savedKwh = Math.max(0, baselineKwh - lightingKwh);
  const savedCost = savedKwh * energy.electricityPrice;
  const co2Kg = savedKwh * 0.5703; // 全国电网平均排放因子近似

  return {
    hours,
    occupiedMetHours: occupiedMet,
    occupiedTotalHours: occupiedTotal,
    daylightAutonomy: occupiedTotal ? occupiedMet / occupiedTotal : 0,
    lightingEnergyKwh: lightingKwh,
    savedKwh,
    savedCost,
    co2Kg,
    monthlyMet,
    monthlyHours,
  };
}
