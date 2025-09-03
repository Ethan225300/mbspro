import { Injectable, Logger } from '@nestjs/common';
import { ChatOpenAI } from '@langchain/openai';
import { RagInfraService } from './rag-infra.service';

@Injectable()
export class RagQueryService {
  private readonly logger = new Logger(RagQueryService.name);
  constructor(private readonly infra: RagInfraService) {}
  
  // Lazy import to avoid circular deps
  private async getRetrievalReflection() {
    try {
      const mod = await import('./retrieval-reflection.service');
      return new mod.RetrievalReflectionService();
    } catch (e) {
      this.logger.warn(`RetrievalReflectionService not available: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  async queryRag(query: string, top = 5, opts?: { excludeCodes?: string[]; enableStage2Reflection?: boolean; enableLLMReflection?: boolean }) {
    await this.infra.initIfNeeded();
    const MODEL = process.env.OPENAI_CHAT_MODEL || 'gpt-4o';
    const COHERE_MODEL = process.env.COHERE_RERANK_MODEL || 'rerank-english-v3.0';
    const RERANK_CANDIDATES = Math.min(Math.max(parseInt(process.env.RERANK_CANDIDATES || '150') || 150, 30), 200);

    const topK = Math.min(Math.max(parseInt(String(top)) || 5, 1), 15);
    const qRaw = (typeof query === 'string' ? query : '').trim();
    if (!qRaw) throw new Error('RAG: empty query');

    // Parse inline constraints section to build Pinecone metadata filter and clean query for embedding
    const parseConstraints = (text: string) => {
      const parts = text.split(/\n#constraints[\s\S]*/i);
      const cleanQuery = parts[0].trim();
      const constraintsMatch = text.match(/\n#constraints[\s\S]*/i);
      const constraintLine = constraintsMatch ? constraintsMatch[0] : '';
      const tokens = constraintLine.replace(/#constraints/i, '').split(/\s+/).map((t) => t.trim()).filter(Boolean);
      const must: string[] = [];
      const mustNot: string[] = [];
      for (const t of tokens) {
        if (t.startsWith('+')) must.push(t.substring(1));
        else if (t.startsWith('-')) mustNot.push(t.substring(1));
      }
      // Build Pinecone filter from known keys present in metadata
      const filter: any = {};
      const bannedCodes: string[] = [];
      const pushIn = (key: string, val: string) => {
        if (!val) return;
        if (!filter[key]) filter[key] = { $in: [] };
        if (!filter[key].$in.includes(val)) filter[key].$in.push(val);
      };
      // must tokens → build include/range filters
      for (const tok of must) {
        const [k, v] = tok.split(':');
        if (!k || v == null) continue;
        const key = String(k).toLowerCase();
        const val = String(v);
        if (key === 'code') pushIn('code', val);
        else if (key === 'group') pushIn('group', val);
        else if (key === 'subgroup') pushIn('subgroup', val);
        else if (key === 'duration') {
          // duration buckets: <6, 6-20, 20-40, >=40
          if (val.startsWith('<')) {
            const n = Number(val.slice(1));
            if (Number.isFinite(n)) filter['duration_max_minutes'] = { ...(filter['duration_max_minutes'] || {}), $lt: n };
          } else if (val.startsWith('>=')) {
            const n = Number(val.slice(2));
            if (Number.isFinite(n)) filter['duration_min_minutes'] = { ...(filter['duration_min_minutes'] || {}), $gte: n };
          } else if (/^\d+\-\d+$/.test(val)) {
            const [a, b] = val.split('-').map((x) => Number(x));
            if (Number.isFinite(a)) filter['duration_min_minutes'] = { ...(filter['duration_min_minutes'] || {}), $gte: a };
            if (Number.isFinite(b)) filter['duration_max_minutes'] = { ...(filter['duration_max_minutes'] || {}), $lte: b };
          }
        }
      }
      // must_not tokens
      for (const tok of mustNot) {
        const [k, v] = tok.split(':');
        if (!k || v == null) continue;
        const key = String(k).toLowerCase();
        const val = String(v);
        if (key === 'code') bannedCodes.push(val);
      }
      // prune empty $in arrays and empty objects
      for (const key of Object.keys(filter)) {
        const val = filter[key];
        if (val && typeof val === 'object' && Array.isArray(val.$in) && val.$in.length === 0) delete filter[key];
        const v2 = filter[key];
        if (v2 && typeof v2 === 'object' && Object.keys(v2).length === 0) delete filter[key];
      }
      return { cleanQuery, filter, bannedCodes } as { cleanQuery: string; filter: any; bannedCodes: string[] };
    };

    const { cleanQuery, filter: pineconeFilter, bannedCodes: constraintBans } = parseConstraints(qRaw);
    const q = cleanQuery;

    const vectorStore = this.infra.getVectorStore();
    // Only pass filter when it has at least one key; otherwise Pinecone errors
    const hasFilter = pineconeFilter && typeof pineconeFilter === 'object' && Object.keys(pineconeFilter).length > 0;
    let candidateDocs: any[] = [];
    if (vectorStore) {
      try {
        candidateDocs = hasFilter
          ? await (vectorStore as any).similaritySearch(q, RERANK_CANDIDATES, pineconeFilter)
          : await (vectorStore as any).similaritySearch(q, RERANK_CANDIDATES);
      } catch (e) {
        this.logger.warn(`RAG similaritySearch with filter failed, retrying without filter. Error=${e instanceof Error ? e.message : String(e)}`);
        candidateDocs = await (vectorStore as any).similaritySearch(q, RERANK_CANDIDATES);
      }
    }

    let reranked: { doc: any; score: number }[] = candidateDocs.map((d: any) => ({ doc: d, score: 0 }));
    const cohere = this.infra.getCohere();
    if (cohere) {
      const topN = Math.min(candidateDocs.length, Math.max(topK + 5, 12));
      this.logger.log(`[AgenticRag][RagQueryService] rerank start: candidates=${candidateDocs.length}, topN=${topN}`);
      this.logger.log(`RAG rerank: using Cohere model=${COHERE_MODEL}, candidates=${candidateDocs.length}, topN=${topN}`);
      const rerankResp: any = await cohere.rerank({ model: COHERE_MODEL, query: q, documents: candidateDocs.map((d) => ({ text: d.pageContent })), topN });
      const resultsArray = (rerankResp?.results || []).map((r: any) => ({ index: r.index, score: r.relevanceScore ?? r.relevance_score ?? 0 }));
      reranked = resultsArray
        .filter((r: any) => r.index >= 0 && r.index < candidateDocs.length)
        .map((r: any) => ({ doc: candidateDocs[r.index], score: r.score }))
        .sort((a: any, b: any) => b.score - a.score);
      this.logger.log(`RAG rerank: results=${resultsArray.length}`);
    } else {
      this.logger.log('RAG rerank: skipped (Cohere not configured)');
    }

    const contextLimit = Math.min(topK + 6, reranked.length);
    let source = reranked.length > 0 ? reranked : candidateDocs.map((d) => ({ doc: d, score: 0 }));

    // Stage-2 Reflection (after rerank, before LLM) - gated per mode
    const enableStage2 = !!opts?.enableStage2Reflection;
    const mustTokens: string[] = [];
    const mustNotTokens: string[] = [];
    if (enableStage2) {
      const constraintsMatch = qRaw.match(/\n#constraints[\s\S]*/i);
      if (constraintsMatch) {
        const tokens = constraintsMatch[0].replace(/#constraints/i, '').split(/\s+/).map((t) => t.trim()).filter(Boolean);
        for (const t of tokens) {
          if (t.startsWith('+')) mustTokens.push(t.substring(1));
          else if (t.startsWith('-')) mustNotTokens.push(t.substring(1));
        }
      }
      try {
        const rr = await this.getRetrievalReflection();
        if (rr && source.length > 0) {
          const reflected = rr.rerankWithReflection({ cleanQuery: q, mustTokens, mustNotTokens, candidates: source.slice(0, Math.min(source.length, Math.max(topK + 7, 12))) });
          if (Array.isArray(reflected) && reflected.length) source = reflected;
        }
      } catch (e) {
        this.logger.warn(`Reflection rerank failed, continue with cohere order. Err=${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // Optional: LLM-based reflection rerank for precision (small token cost) - gated per mode
    try {
      const ENABLE_LLM_REFLECT_ENV = (process.env.ENABLE_REFLECTION_LLM_RERANK || 'true').toLowerCase() === 'true';
      const enableLLMReflect = !!opts?.enableLLMReflection && ENABLE_LLM_REFLECT_ENV;
      if (enableLLMReflect && source.length > 0) {
        const REFLECT_TOP = Math.min(Math.max(parseInt(process.env.REFLECTION_RERANK_TOP || '15') || 15, 5), Math.min(25, source.length));
        const MODEL_REFLECT = process.env.OPENAI_CHAT_MODEL_REFLECTION || 'gpt-4o-mini';

        // Build compact candidate list for scoring
        const items = source.slice(0, REFLECT_TOP).map(({ doc, score }: any) => {
          const meta: any = doc?.metadata || {};
          const code = String((meta.ItemNum ?? meta.itemNum ?? meta._id ?? meta.code) ?? '');
          const title = String((meta.title ?? meta.description ?? meta.Description ?? (doc?.pageContent?.split('\n')?.[0] ?? '')) ?? '');
          const group = meta.group ?? meta.Group ?? null;
          const subgroup = meta.subgroup ?? meta.Subgroup ?? null;
          const dmin = typeof meta.duration_min_minutes === 'number' ? meta.duration_min_minutes : null;
          const dmax = typeof meta.duration_max_minutes === 'number' ? meta.duration_max_minutes : null;
          const fee = typeof meta.schedule_fee === 'number' ? meta.schedule_fee : (typeof meta.fee === 'number' ? meta.fee : null);
          const cohere = typeof score === 'number' ? Number(score.toFixed(4)) : null;
          return { code, title, group, subgroup, duration_min: dmin, duration_max: dmax, fee, cohere };
        });

        const rubric = [
          '1) Respect +must and -must_not constraints strictly.',
          '2) Prefer correct duration bucket alignment.',
          '3) Prefer matching group/subgroup when relevant.',
          '4) Bias toward higher cohere but do not override clinical mismatches.',
          '5) Penalize obviously irrelevant or conflicting candidates.',
        ].join(' ');

        const reflectPrompt = `You are a clinical coding assistant for Australian MBS items. Rerank the following candidates for this case with strict rule awareness.\n\nCase: ${q}\nConstraints: +${mustTokens.join(' +')} ${mustNotTokens.map((t)=>'-'+t).join(' ')}\nRubric: ${rubric}\n\nCandidates (JSON array):\n${JSON.stringify(items, null, 2)}\n\nReturn ONLY JSON with field \"reranked\": [{\"code\": string, \"score\": number}], ordered by descending score.`;

        const reflectLLM = new ChatOpenAI({ modelName: MODEL_REFLECT, temperature: 0.1 });
        const resp = await reflectLLM.invoke([{ role: 'user', content: reflectPrompt }]);
        const content = (resp as any).content as string;
        const jsonMatch = typeof content === 'string' ? content.match(/\{[\s\S]*\}/) : null;
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          const arr = Array.isArray(parsed?.reranked) ? parsed.reranked : [];
          if (arr.length) {
            const scoreByCode = new Map<string, number>();
            for (const r of arr) {
              const c = String(r.code ?? '');
              if (!c) continue;
              const s = typeof r.score === 'number' ? r.score : 0;
              scoreByCode.set(c, s);
            }
            // reorder source
            const withScores = source.map((x: any) => {
              const meta: any = x?.doc?.metadata || {};
              const code = String((meta.ItemNum ?? meta.itemNum ?? meta._id ?? meta.code) ?? '');
              const s = scoreByCode.has(code) ? (scoreByCode.get(code) as number) : -1e9; // unseen go last
              return { x, s };
            });
            withScores.sort((a: any, b: any) => b.s - a.s);
            source = withScores.map((y: any) => y.x);
            this.logger.log(`[RAG] LLM reflection rerank applied: top=${REFLECT_TOP}, model=${MODEL_REFLECT}`);
          }
        }
      }
    } catch (e) {
      this.logger.warn(`LLM reflection rerank skipped due to error: ${e instanceof Error ? e.message : String(e)}`);
    }

    const itemBestScore = new Map<string, number>();
    for (const { doc, score } of source) {
      const meta: any = doc.metadata || {};
      const itemNum = meta.ItemNum ?? meta.itemNum ?? meta._id;
      if (itemNum === undefined || itemNum === null) continue;
      const key = String(itemNum);
      const prev = itemBestScore.get(key);
      const val = typeof score === 'number' ? score : 0;
      if (prev === undefined || val > prev) itemBestScore.set(key, val);
    }

    const llm = new ChatOpenAI({ modelName: MODEL, temperature: 0 });
    const currentDate = new Date().toISOString().split('T')[0];
    const bannedForPrompt = ([...(opts?.excludeCodes || []), ...constraintBans]).map(String).slice(-80);
    const banSection = bannedForPrompt.length
      ? `\n\nDo NOT include any of these item codes in your results:\n${bannedForPrompt.join(', ')}`
      : '';
    const context = source.slice(0, contextLimit).map((r: any) => r.doc.pageContent).join('\n---\n');
    const prompt = `Return the top ${topK} most relevant MBS candidates (single items or bundles). Each must follow MBS rules (validity, no conflicts).${banSection}\n\nCurrent date: ${currentDate}.\n\nContext:\n${context}\n\nCase: ${q}\nAnswer (JSON only):\n\n{\n  "results": [\n    {\n      "itemNum": "123",\n      "title": "brief description",\n      "match_reason": "why this bundle or item matches the query",\n      "match_score": 0.0,\n      "fee": ""\n    }\n  ]\n}`;

    let parsedResults: any = null;
    try {
      const resp = await llm.invoke([{ role: 'user', content: prompt }]);
      const content = (resp as any).content as string;
      const jsonMatch = typeof content === 'string' ? content.match(/\{[\s\S]*\}/) : null;
      if (jsonMatch) parsedResults = JSON.parse(jsonMatch[0]);
      if (!parsedResults) return { ok: true, answer: (resp as any).content };
    } catch (err) {
      this.logger.warn(`RAG LLM call failed, returning empty results. Error: ${String(err)}`);
      return { ok: true, results: [] };
    }

    const metaByItemNum = new Map<string, any>();
    for (const { doc } of source) {
      const meta: any = doc?.metadata || {};
      const itemNum = meta.ItemNum ?? meta.itemNum ?? meta._id;
      if (itemNum === undefined || itemNum === null) continue;
      const code = String(itemNum);
      const normalized = {
        ...meta,
        description: meta.description ?? meta.Description ?? undefined,
        duration_min_minutes: meta.duration_min_minutes ?? undefined,
        duration_max_minutes: meta.duration_max_minutes ?? undefined,
        duration_min_inclusive: meta.duration_min_inclusive ?? true,
        duration_max_inclusive: meta.duration_max_inclusive ?? false,
        group: meta.group ?? meta.Group ?? undefined,
        subgroup: meta.subgroup ?? meta.Subgroup ?? undefined,
      };
      if (!metaByItemNum.has(code)) metaByItemNum.set(code, normalized);
    }

    if (parsedResults && Array.isArray(parsedResults.results)) {
      // local filter to exclude banned codes
      if (opts?.excludeCodes?.length) {
        const ban = new Set(opts.excludeCodes.map(String));
        parsedResults.results = (parsedResults.results || []).filter((r: any) => {
          const num = String(r.itemNum ?? r.item_num ?? r.code ?? '');
          return num && !ban.has(num);
        });
      }

      parsedResults.results = parsedResults.results.map((item: any) => {
        const num = item.itemNum ?? item.ItemNum;
        const nums: any[] = item.itemNums || item.ItemNums;
        let score: number | null = null;
        if (num !== undefined && num !== null) {
          const key = String(num);
          score = itemBestScore.has(key) ? (itemBestScore.get(key) as number) : null;
        } else if (Array.isArray(nums) && nums.length > 0) {
          const scores = nums.map((n: any) => String(n)).map((k: string) => (itemBestScore.has(k) ? (itemBestScore.get(k) as number) : null)).filter((s: number | null) => s !== null) as number[];
          if (scores.length > 0) score = Math.max(...scores);
        }
        const formatted = typeof score === 'number' ? Number(score.toFixed(4)) : null;
        const code = num != null ? String(num) : (Array.isArray(nums) && nums.length > 0 ? String(nums[0]) : undefined);
        const meta = code ? metaByItemNum.get(code) : undefined;
        return { ...item, match_score: formatted, meta, description: item.description ?? meta?.description ?? item.title ?? undefined };
      });
    }
    return { ok: true, ...parsedResults };
  }
}


