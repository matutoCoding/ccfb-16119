import type { BoxObject, PipeCatalog, Project, Scheme } from '../types';
import { uid } from '../types';
import { defaultCatalog } from '../core/pipes/catalog';

function box(
  kind: BoxObject['kind'],
  name: string,
  center: [number, number, number],
  size: [number, number, number],
  reflectance: number,
  rotationY = 0,
): BoxObject {
  return {
    id: uid(kind),
    kind,
    name,
    center,
    size,
    rotationY,
    reflectance,
    color: [reflectance, reflectance * 0.98, reflectance * 0.95],
  };
}

/** 带货架的老厂房（城市更新改仓库）：30×18×7m，6m 柱网，4 排高位货架 */
export function factoryProject(): { project: Project; catalog: PipeCatalog } {
  const catalog = defaultCatalog();
  const now = Date.now();
  const objects: BoxObject[] = [];

  // 柱网 6m：X 向 5 跨、Z 向 3 跨 → 柱位 4×2 排
  for (let ix = 0; ix < 4; ix++) {
    for (let iz = 0; iz < 2; iz++) {
      objects.push(box('column', `柱${ix + 1}-${iz + 1}`,
        [6 + ix * 6, 3.5, 6 + iz * 6], [0.5, 7, 0.5], 0.35));
    }
  }
  // 纵向主梁
  for (let iz = 0; iz < 2; iz++) {
    objects.push(box('beam', `主梁Z${iz + 1}`, [15, 6.7, 6 + iz * 6], [30, 0.6, 0.4], 0.5));
  }
  // 4 排货架：每排长 20m、高 4.5m、深 1.2m，沿 X 向
  const shelfZ = [3.0, 7.2, 10.8, 15.0];
  shelfZ.forEach((z, i) => {
    objects.push(box('shelf', `货架排${i + 1}`, [15, 2.25, z], [20, 4.5, 1.2], 0.3));
  });
  // 端部隔墙（办公间隔出 6m）
  objects.push(box('partition', '端部隔墙', [27, 3.5, 9], [0.2, 7, 18], 0.6));
  // 侧窗（北墙高位带形窗 2 樘）
  objects.push(box('window', '侧窗A', [8, 5.2, 0.02], [5, 1.6, 0.05], 0.1));
  objects.push(box('window', '侧窗B', [18, 5.2, 0.02], [5, 1.6, 0.05], 0.1));

  const scheme: Scheme = {
    id: uid('scheme'),
    name: '方案A：12 管均匀布置',
    createdAt: now,
    pipes: [
      ...gridPipes(3, 4, [5, 15], [2.5, 15.5], 0.53, 6.5),
    ],
  };

  const project: Project = {
    id: uid('proj'),
    name: '城东老厂房改造仓库',
    createdAt: now,
    updatedAt: now,
    kind: 'factory',
    room: {
      width: 30, depth: 18, height: 7,
      bayX: 6, bayZ: 6,
      wallReflectance: 0.5,
      floorReflectance: 0.2,
      ceilingReflectance: 0.7,
    },
    objects,
    schemes: [scheme],
    activeSchemeId: scheme.id,
    sky: {
      model: 'overcast',
      latitude: 31.23,
      longitude: 121.47,
      timezone: 8,
      date: '2026-03-20',
      hour: 12,
      turbidity: 3.5,
      manualEh: null,
    },
    probe: { spacing: 3, workPlaneHeight: 0.75, raysPerProbe: 128, probesPerFrame: 16 },
    catalogId: catalog.id,
    standardMinLux: 300,
    notes: '业主验收：工作面平均照度≥300lux，货架通道无暗区',
  };
  return { project, catalog };
}

/** 地下车库：36×20×3.6m，双车道，柱网 8m，无外窗 */
export function garageProject(): { project: Project; catalog: PipeCatalog } {
  const catalog = defaultCatalog();
  const now = Date.now();
  const objects: BoxObject[] = [];

  for (let ix = 0; ix < 4; ix++) {
    for (let iz = 0; iz < 2; iz++) {
      objects.push(box('column', `柱${ix + 1}-${iz + 1}`,
        [4 + ix * 8, 1.8, 6.7 + iz * 6.7], [0.6, 3.6, 0.6], 0.3));
    }
  }
  // 通风/喷淋梁网（横梁 3 道纵梁 4 道）
  for (let ix = 0; ix < 3; ix++) {
    objects.push(box('beam', `横梁${ix + 1}`, [8 + ix * 8, 3.35, 10], [0.5, 0.5, 20], 0.5));
  }
  for (let iz = 0; iz < 4; iz++) {
    objects.push(box('beam', `纵梁${iz + 1}`, [18, 3.4, 4 + iz * 4], [36, 0.4, 0.4], 0.5));
  }
  // 车位挡车/设备间（矮隔墙）
  objects.push(box('partition', '设备间', [34, 1.6, 3], [4, 3.2, 6], 0.45));

  const scheme: Scheme = {
    id: uid('scheme'),
    name: '方案A：8 管车道布置',
    createdAt: now,
    pipes: gridPipes(4, 2, [4.5, 31.5], [7, 13], 0.75, 3.2),
  };

  const project: Project = {
    id: uid('proj'),
    name: '中心广场地下车库 B1',
    createdAt: now,
    updatedAt: now,
    kind: 'garage',
    room: {
      width: 36, depth: 20, height: 3.6,
      bayX: 8, bayZ: 6.7,
      wallReflectance: 0.4,
      floorReflectance: 0.15,
      ceilingReflectance: 0.6,
    },
    objects,
    schemes: [scheme],
    activeSchemeId: scheme.id,
    sky: {
      model: 'overcast',
      latitude: 39.9,
      longitude: 116.4,
      timezone: 8,
      date: '2026-06-21',
      hour: 12,
      turbidity: 3.5,
      manualEh: null,
    },
    probe: { spacing: 3, workPlaneHeight: 0.05, raysPerProbe: 128, probesPerFrame: 16 },
    catalogId: catalog.id,
    standardMinLux: 75,
    notes: '车库车道标准 75lux，全靠导光管，无侧窗',
  };
  return { project, catalog };
}

function gridPipes(
  nx: number, nz: number,
  xRange: [number, number], zRange: [number, number],
  diameter: number, length: number,
) {
  const pipes = [];
  for (let ix = 0; ix < nx; ix++) {
    for (let iz = 0; iz < nz; iz++) {
      const x = nx === 1 ? (xRange[0] + xRange[1]) / 2 :
        xRange[0] + (ix * (xRange[1] - xRange[0])) / (nx - 1);
      const z = nz === 1 ? (zRange[0] + zRange[1]) / 2 :
        zRange[0] + (iz * (zRange[1] - zRange[0])) / (nz - 1);
      pipes.push({
        id: uid('pipe'),
        name: `管${ix + 1}-${iz + 1}`,
        x, z, diameter, length,
        elbowCount: 0,
        domeModel: 'dome_std',
        diffuserModel: 'diff_flat',
        enabled: true,
      });
    }
  }
  return pipes;
}
