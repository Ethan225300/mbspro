import { Injectable, Logger } from '@nestjs/common';
import { ChatOpenAI } from '@langchain/openai';
import { RagInfraService } from './rag-infra.service';

@Injectable()
export class RagQueryService {
  private readonly logger = new Logger(RagQueryService.name);
  constructor(private readonly infra: RagInfraService) {}

  async queryRag(query: string, top = 5, opts?: { excludeCodes?: string[] }) {
    await this.infra.initIfNeeded();
    const MODEL = process.env.OPENAI_CHAT_MODEL || 'gpt-4o';
    const COHERE_MODEL = process.env.COHERE_RERANK_MODEL || 'rerank-english-v3.0';
    const RERANK_CANDIDATES = Math.min(Math.max(parseInt(process.env.RERANK_CANDIDATES || '150') || 150, 30), 200);

    const topK = Math.min(Math.max(parseInt(String(top)) || 5, 1), 15);
    const q = (typeof query === 'string' ? query : '').trim();
    if (!q) throw new Error('RAG: empty query');

    const vectorStore = this.infra.getVectorStore();
    const candidateDocs: any[] = vectorStore ? await vectorStore.similaritySearch(q, RERANK_CANDIDATES) : [];

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
    const source = reranked.length > 0 ? reranked : candidateDocs.map((d) => ({ doc: d, score: 0 }));

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
    const bannedForPrompt = (opts?.excludeCodes || []).map(String).slice(-80);
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


