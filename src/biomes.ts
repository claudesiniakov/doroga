import { mulberry32, smoothstep } from './noise';

export type BiomeId = 'coast' | 'city' | 'suburb' | 'desert' | 'forest';
export const BIOME_IDS: BiomeId[] = ['coast', 'city', 'suburb', 'desert', 'forest'];

export type Weights = Record<BiomeId, number>;

export interface Segment {
  index: number;
  id: BiomeId;
  start: number;
  end: number;
  /** Для побережья: с какой стороны море (+1 справа, -1 слева). */
  seaSide: number;
  /** Название населённого пункта на въездном знаке. */
  town: string;
}

/** Описание районов — данными: новый район добавляется сюда, генератор не меняется. */
export const BIOMES: Record<BiomeId, { towns: string[]; length: [number, number]; next: BiomeId[] }> = {
  coast: { towns: ['Береговое', 'Солнечная Бухта', 'Маяк'], length: [1800, 3000], next: ['suburb', 'forest', 'city'] },
  city: { towns: ['Новоград', 'Светлогорск', 'Приморск'], length: [1500, 2400], next: ['suburb', 'coast'] },
  suburb: { towns: ['Сосновка', 'Заречье', 'Дубки', 'Луговое'], length: [1500, 2600], next: ['city', 'forest', 'desert', 'coast'] },
  desert: { towns: ['Песчаный', 'Сухой Лог', 'Каменка'], length: [2000, 3200], next: ['suburb', 'forest'] },
  forest: { towns: ['Еловое', 'Лесной', 'Кедровый'], length: [1800, 3000], next: ['suburb', 'desert', 'coast'] },
};

const BLEND = 260; // ширина плавного перехода между районами, м

export class BiomeMap {
  readonly segments: Segment[] = [];
  private rnd: () => number;

  constructor(seed: number) {
    this.rnd = mulberry32(seed * 31 + 5);
    // начинаем с побережья на закате
    this.push('coast', 0);
  }

  private push(id: BiomeId, start: number) {
    const def = BIOMES[id];
    const len = def.length[0] + this.rnd() * (def.length[1] - def.length[0]);
    this.segments.push({
      index: this.segments.length, id, start, end: start + len,
      seaSide: this.rnd() < 0.5 ? -1 : 1,
      town: def.towns[Math.floor(this.rnd() * def.towns.length)],
    });
  }

  private ensure(s: number) {
    while (this.segments[this.segments.length - 1].end < s + BLEND * 2) {
      const last = this.segments[this.segments.length - 1];
      const opts = BIOMES[last.id].next;
      this.push(opts[Math.floor(this.rnd() * opts.length)], last.end);
    }
  }

  segmentAt(s: number): Segment {
    this.ensure(s);
    let lo = 0, hi = this.segments.length - 1;
    while (lo < hi) {
      const m = (lo + hi + 1) >> 1;
      if (this.segments[m].start <= s) lo = m; else hi = m - 1;
    }
    return this.segments[lo];
  }

  /** Веса районов в точке s (сумма = 1), с плавным переходом на стыках. */
  weights(s: number, out?: Weights): Weights {
    const w = out ?? ({ coast: 0, city: 0, suburb: 0, desert: 0, forest: 0 } as Weights);
    for (const id of BIOME_IDS) w[id] = 0;
    const seg = this.segmentAt(s);
    const prev = seg.index > 0 ? this.segments[seg.index - 1] : null;
    const next = this.segmentAt(seg.end + 1);
    let a = 1;
    if (prev && s < seg.start + BLEND / 2) {
      const t = smoothstep(seg.start - BLEND / 2, seg.start + BLEND / 2, s);
      w[prev.id] += 1 - t; a = t;
    } else if (s > seg.end - BLEND / 2) {
      const t = smoothstep(seg.end - BLEND / 2, seg.end + BLEND / 2, s);
      w[next.id] += t; a = 1 - t;
    }
    w[seg.id] += a;
    return w;
  }

  /** Ближайший сегмент побережья, влияющий на точку s (для уровня моря). */
  coastNear(s: number, ahead = BLEND, behind = BLEND): Segment | null {
    for (const probe of [s, s + ahead, s - behind]) {
      if (probe < 0) continue;
      const seg = this.segmentAt(probe);
      if (seg.id === 'coast') return seg;
    }
    return null;
  }
}
