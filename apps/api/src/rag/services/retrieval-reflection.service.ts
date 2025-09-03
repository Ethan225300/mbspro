import { Injectable, Logger } from '@nestjs/common';

type RerankCandidate = { doc: any; score: number };

export interface ReflectionInput {
  cleanQuery: string;
  mustTokens: string[];      // e.g. ["group:Gp", "duration:6-20"]
  mustNotTokens: string[];   // e.g. ["code:123"]
  candidates: RerankCandidate[]; // Cohere reranked candidates (top ~12-20)
}

@Injectable()
export class RetrievalReflectionService {
  private readonly logger = new Logger(RetrievalReflectionService.name);

  rerankWithReflection(input: ReflectionInput): RerankCandidate[] {
    const { candidates, mustTokens, mustNotTokens } = input;
    if (!Array.isArray(candidates) || candidates.length === 0) return candidates ?? [];

    const must: Array<{ key: string; val: string }> = [];
    const mustNot: Array<{ key: string; val: string }> = [];

    for (const t of mustTokens || []) {
      const [k, v] = String(t).split(':');
      if (k && v != null) must.push({ key: k.toLowerCase(), val: String(v) });
    }
    for (const t of mustNotTokens || []) {
      const [k, v] = String(t).split(':');
      if (k && v != null) mustNot.push({ key: k.toLowerCase(), val: String(v) });
    }

    const scored: Array<RerankCandidate & { _score: number }> = [];
    for (const c of candidates) {
      const meta: any = c?.doc?.metadata || {};
      let s = 0;
      const reasons: string[] = [];

      // base: normalized cohere score (0-1) if available
      const base = typeof c?.score === 'number' ? Math.max(0, Math.min(1, c.score)) : 0;
      s += base * 0.5;

      // must matches
      for (const { key, val } of must) {
        if (key === 'code') {
          const code = String(meta.code ?? meta.ItemNum ?? meta.item_num ?? meta._id ?? '');
          if (code && code === String(val)) { s += 3; reasons.push(`match:code`); }
        } else if (key === 'group') {
          const g = String(meta.group ?? meta.Group ?? '');
          if (g && g.toLowerCase() === String(val).toLowerCase()) { s += 2; reasons.push(`match:group`); }
        } else if (key === 'subgroup') {
          const sg = String(meta.subgroup ?? meta.Subgroup ?? '');
          if (sg && sg.toLowerCase() === String(val).toLowerCase()) { s += 1.5; reasons.push(`match:subgroup`); }
        } else if (key === 'duration') {
          const minM = typeof meta.duration_min_minutes === 'number' ? meta.duration_min_minutes : null;
          const maxM = typeof meta.duration_max_minutes === 'number' ? meta.duration_max_minutes : null;
          const probe = (minM != null && maxM != null) ? (minM + maxM) / 2 : (minM != null ? minM : (maxM != null ? maxM : null));
          if (probe != null) {
            const v = String(val);
            let ok = false;
            if (v.startsWith('<')) {
              const n = Number(v.slice(1));
              ok = Number.isFinite(n) ? probe < n : false;
            } else if (v.startsWith('>=')) {
              const n = Number(v.slice(2));
              ok = Number.isFinite(n) ? probe >= n : false;
            } else if (/^\d+\-\d+$/.test(v)) {
              const [a, b] = v.split('-').map((x) => Number(x));
              ok = (Number.isFinite(a) ? probe >= a : true) && (Number.isFinite(b) ? probe <= b : true);
            }
            if (ok) { s += 1.5; reasons.push('match:duration'); }
          }
        }
      }

      // must_not exclusions
      let excluded = false;
      for (const { key, val } of mustNot) {
        if (key === 'code') {
          const code = String(meta.code ?? meta.ItemNum ?? meta.item_num ?? meta._id ?? '');
          if (code && code === String(val)) { excluded = true; reasons.push('ban:code'); break; }
        }
      }
      if (excluded) continue;

      scored.push({ ...c, _score: s });
    }

    const out = scored.sort((a, b) => b._score - a._score).map(({ _score, ...rest }) => rest);
    this.logger.log(`Reflection rerank: in=${candidates.length}, out=${out.length}`);
    return out;
  }
}


