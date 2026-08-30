import type { NodeType, Params } from '../types/circuit'

let seq = 0
export function nextName(prefix: string): string {
  seq += 1
  return `${prefix}${seq}`
}

export function defaultParams(type: NodeType): Params {
  switch (type) {
    case 'vsource':
      return { name: nextName('SRC'), basekv: 115, pu: 1.0, angle: 0, phases: 3, mvasc3: 2000, mvasc1: 2100 }
    case 'busbar':
      return { name: nextName('BUS'), basekv: 12.47 }
    case 'transformer':
      return {
        name: nextName('T'), phases: 3, xhl: 8.0, pctloadloss: 0.5,
        windings: [
          { kv: 115, kva: 10000, conn: 'delta' },
          { kv: 12.47, kva: 10000, conn: 'wye' },
        ],
      }
    case 'load':
      return { name: nextName('LOAD'), kv: 12.47, kw: 1000, pf: 0.95, phases: 3, conn: 'wye', model: 1 }
    case 'breaker':
      return { name: nextName('BRK'), closed: true, normamps: 600, phases: 3 }
    case 'capacitor':
      return { name: nextName('CAP'), kv: 12.47, kvar: 600, phases: 3, conn: 'wye', numsteps: 1 }
    case 'generator':
      return { name: nextName('GEN'), kv: 12.47, kw: 1000, pf: 1.0, phases: 3, conn: 'wye', model: 1, vpu: 1.02 }
    case 'pvsystem':
      return {
        name: nextName('PV'), kv: 12.47, kva: 500, pmpp: 500, pf: 1.0,
        irradiance: 1.0, phases: 3, conn: 'wye', loadshape: '',
      }
    case 'storage':
      return {
        name: nextName('BAT'), kv: 12.47, kwrated: 250, kwhrated: 1000,
        effcharge: 95, effdischarge: 95, reserve: 20, soc: 50,
        phases: 3, conn: 'wye', dispatch: 'follow', loadshape: '',
        pctdischarge: 100, pctcharge: 100, dischargetrigger: 0, chargetrigger: 0,
      }
  }
}

export function defaultLineParams(): Params {
  return {
    name: nextName('LN'), length: 1.0, units: 'km',
    r1: 0.12, x1: 0.38, r0: 0.4, x0: 1.2, normamps: 400, phases: 3,
  }
}

export const NODE_SIZE: Record<NodeType, { w: number; h: number }> = {
  vsource: { w: 48, h: 48 },
  busbar: { w: 240, h: 14 },
  transformer: { w: 48, h: 72 },
  load: { w: 40, h: 52 },
  breaker: { w: 36, h: 56 },
  capacitor: { w: 40, h: 56 },
  generator: { w: 44, h: 56 },
  pvsystem: { w: 44, h: 56 },
  storage: { w: 44, h: 56 },
}
