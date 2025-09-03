import { Injectable, Logger } from '@nestjs/common';
import { RagFactsService } from './facts.service';
import { RagQueryService } from './query.service';
import { RagVerifyService } from './verify.service';
import type { AgenticRagResult, NoteFacts, VerifiedItem } from '../rag.types';

@Injectable()
export class AgentGraphService {
  private readonly logger = new Logger(AgentGraphService.name);

  constructor(
    private readonly facts: RagFactsService,
    private readonly query: RagQueryService,
    private readonly verify: RagVerifyService,
  ) {}

  buildRefineHints(facts: NoteFacts, failedCodes: string[]) {
    const must: string[] = [];
    if (facts.duration_min != null) {
      const d = facts.duration_min;
      if (d < 6) must.push('duration:<6');
      else if (d < 20) must.push('duration:6-20');
      else if (d < 40) must.push('duration:20-40');
      else must.push('duration:>=40');
    }
    if (facts.modality) must.push(`modality:${facts.modality}`);
    if (facts.setting && facts.setting !== 'other') must.push(`setting:${facts.setting}`);
    if (facts.specialty) must.push(`specialty:${facts.specialty}`);
    if (facts.first_or_review) must.push(`visit:${facts.first_or_review}`);
    const must_not = failedCodes.map((c) => `code:${c}`);
    return { must, must_not } as { must: string[]; must_not: string[] };
  }

  async queryRagWithConstraints(note: string, c: { must: string[]; must_not: string[] }, top: number, opts?: { excludeCodes?: string[] }) {
    const base = ((note ?? '') as string).trim();
    const must = (c?.must ?? []).map((s: string) => `+${s}`).join(' ');
    const mustNot = (c?.must_not ?? []).map((s: string) => `-${s}`).join(' ');
    const constraints = `#constraints\n${must} ${mustNot}`.trim();
    const augmented = base.length ? `${base}\n\n${constraints}` : constraints;
    return this.query.queryRag(augmented, top, { excludeCodes: opts?.excludeCodes });
  }

  async verifyBatch(facts: NoteFacts, ragResp: any) {
    const verified: VerifiedItem[] = [];
    const failedCodes: string[] = [];
    const softCodes: string[] = [];
    const passedCodes: string[] = [];
    const seenCodes: string[] = [];
    const resultsArr = (ragResp?.results ?? []);
    for (const r of resultsArr) {
      const code = String(r.itemNum ?? r.item_num ?? r.code ?? '');
      if (!code) continue;
      seenCodes.push(code);
      const display = r.title ?? r.desc ?? '';
      const fee = (() => {
        const f = r.fee ?? r.schedule_fee ?? r.meta?.schedule_fee ?? null;
        if (typeof f === 'number') return f;
        if (typeof f === 'string') {
          const n = Number(f.replace(/[^\d.]/g, ''));
          return Number.isFinite(n) ? n : null;
        }
        return null;
      })();
      const desc = r.meta?.description ?? r.description ?? r.desc ?? r.context ?? r.title ?? '';
      const { RagRuleParserService } = await import('./rule-parser.service');
      const parser = new RagRuleParserService();
      const rule = parser.buildItemRuleFromDesc(code, desc, r.meta ?? {});
      const tri = this.verify.verifyOneTri(facts, rule);
      if (tri.report.passes) {
        if (tri.soft) softCodes.push(code);
        passedCodes.push(code);
        verified.push({ code, display, fee, score: r.match_score ?? null, verify: tri.report, group: r.meta?.group || r.meta?.Group || null });
      } else {
        failedCodes.push(code);
      }
    }
    const { final, notes } = this.verify.resolveTimeConflicts(verified, facts);
    const passItems = final;
    return { items: passItems, conflicts_resolved: notes, failedCodes, softCodes, passedCodes, seenCodes } as { items: VerifiedItem[]; conflicts_resolved: string[]; failedCodes: string[]; softCodes: string[]; passedCodes: string[]; seenCodes: string[] };
  }

  async agenticQueryRag(note: string, top: number = 5): Promise<AgenticRagResult> {
    this.logger.log(`[AgenticRag] Service in: note_len=${(note ?? '').length}, top=${top}`);
    try {
      try { await import('@langchain/langgraph'); } catch (e) { this.logger.warn(`[AgenticRag] LangGraph import failed: ${e instanceof Error ? e.stack : e}`); }
      const { Annotation, StateGraph, START, END } = await import('@langchain/langgraph');
      const AgentState = (Annotation as any).Root({ note: (Annotation as any)(), topN: (Annotation as any)(), iterations: (Annotation as any)(), done: (Annotation as any)(), facts: (Annotation as any)(), proposal: (Annotation as any)(), vetted: (Annotation as any)(), refine: (Annotation as any)(), accepted: (Annotation as any)(), seenCodes: (Annotation as any)(), bannedCodes: (Annotation as any)(), });
      const g = new StateGraph(AgentState as any);
      (g as any).addNode('extract_facts', async (s: any) => ({ facts: await this.facts.extractNoteFacts(s.note ?? '') }));
      (g as any).addNode('propose', async (s: any) => {
        const iteration = s.iterations ?? 0;
        const baseTop = Number(s.topN || 5);
        const k = (iteration === 0) ? baseTop + 3 : baseTop;
        this.logger.log(`[AgenticRag][AgentGraphService] Iteration ${iteration} - propose: topN=${k} (base=${baseTop})`);
        const q = String(s.note || '');
        const banned = Array.isArray(s.bannedCodes) ? s.bannedCodes.map(String) : [];
        const maxTries = 3;
        const seenSet = new Set<string>();
        let merged: any[] = [];
        for (let attempt = 0; attempt < maxTries; attempt++) {
          const resp = await this.query.queryRag(q, k, { excludeCodes: banned });
          const arr = Array.isArray(resp?.results) ? resp.results : [];
          for (const r of arr) {
            const code = String(r.itemNum ?? r.item_num ?? r.code ?? '');
            if (!code) continue;
            if (!seenSet.has(code) && !banned.includes(code)) {
              seenSet.add(code);
              merged.push(r);
            }
          }
          if (merged.length >= k) break;
        }
        merged = merged.filter((r: any) => {
          const code = String(r.itemNum ?? r.item_num ?? r.code ?? '');
          return code && !banned.includes(code);
        });
        const count = merged.length;
        this.logger.log(`[AgenticRag][AgentGraphService] propose: out results=${count}`);
        return { proposal: { ok: true, results: merged } };
      });
      (g as any).addNode('verify', async (s: any) => {
        const vetted = await this.verifyBatch(s.facts, s.proposal);
        const prev = Array.isArray(s.accepted) ? s.accepted : [];
        const currentPass = Array.isArray(vetted.items) ? vetted.items : [];
        const mergedMap = new Map<string, any>();
        for (const it of [...prev, ...currentPass]) mergedMap.set(String(it.code), it);
        const accepted = Array.from(mergedMap.values());
        const prevBanned = Array.isArray(s.bannedCodes) ? s.bannedCodes.map(String) : [];
        const bannedSet = new Set<string>(prevBanned);
        for (const c of [...(vetted.failedCodes || []), ...(vetted.passedCodes || []), ...(vetted.seenCodes || [])]) bannedSet.add(String(c));
        const bannedCodes = Array.from(bannedSet);
        const noNew = (currentPass.length === 0) && ((vetted.failedCodes?.length || 0) === 0);
        const done = noNew || (accepted.length >= (s.topN ?? 5));
        
        // Log stop conditions
        if (noNew) {
          this.logger.log('[AgenticRag] stop: no new results after filtering');
        } else if (accepted.length >= (s.topN ?? 5)) {
          this.logger.log(`[AgenticRag] stop: reached target topN=${s.topN}, accepted=${accepted.length}`);
        }
        
        // Log all verification results (both pass and fail)
        const allResults = (s.proposal?.results ?? []);
        for (const r of allResults) {
          const code = String(r.itemNum ?? r.item_num ?? r.code ?? '');
          if (!code) continue;
          const desc = r.meta?.description ?? r.description ?? r.desc ?? r.context ?? r.title ?? '';
          const { RagRuleParserService } = await import('./rule-parser.service');
          const parser = new RagRuleParserService();
          const rule = parser.buildItemRuleFromDesc(code, desc, r.meta ?? {});
          const tri = this.verify.verifyOneTri(s.facts, rule);
          this.verify.logItemDetails({ code, verify: tri.report, group: r.meta?.group || r.meta?.Group || null } as any);
        }
        const softCount = (vetted.softCodes ?? []).length;
        this.verify.logBatchSummary(allResults, currentPass, softCount);
        return { vetted, accepted, done, bannedCodes, seenCodes: vetted.seenCodes || [] };
      });
      (g as any).addNode('critic', async (s: any) => ({ refine: this.buildRefineHints(s.facts, (s.bannedCodes || []).map((c: any) => String(c))) }));
      (g as any).addNode('refine_propose', async (s: any) => {
        const iteration = (s.iterations ?? 0) + 1;
        this.logger.log(`[AgenticRag][AgentGraphService] Iteration ${iteration} - propose: topN=${s.topN ?? 5}`);
        const banned = Array.isArray(s.bannedCodes) ? s.bannedCodes.map(String) : [];
        const k = Number(s.topN || 5);
        const maxTries = 3;
        const seenSet = new Set<string>();
        let merged: any[] = [];
        for (let attempt = 0; attempt < maxTries; attempt++) {
          const resp = await this.queryRagWithConstraints(s.note ?? '', s.refine, k, { excludeCodes: banned });
          const arr = Array.isArray(resp?.results) ? resp.results : [];
          for (const r of arr) {
            const code = String(r.itemNum ?? r.item_num ?? r.code ?? '');
            if (!code) continue;
            if (!seenSet.has(code) && !banned.includes(code)) {
              seenSet.add(code);
              merged.push(r);
            }
          }
          if (merged.length >= k) break;
        }
        merged = merged.filter((r: any) => {
          const code = String(r.itemNum ?? r.item_num ?? r.code ?? '');
          return code && !banned.includes(code);
        });
        const count = merged.length;
        this.logger.log(`[AgenticRag][AgentGraphService] propose: out results=${count}`);
        return { proposal: { ok: true, results: merged }, iterations: iteration };
      });
      (g as any).addEdge(START, 'extract_facts');
      (g as any).addEdge('extract_facts', 'propose');
      (g as any).addEdge('propose', 'verify');
      (g as any).addConditionalEdges('verify', (s: any) => {
        const maxIterationsReached = (s.iterations ?? 0) >= 2;
        if (maxIterationsReached) {
          this.logger.log(`[AgenticRag] stop: reached max iterations=${s.iterations}`);
        }
        return ((s.done || maxIterationsReached) ? 'end' : 'critic');
      }, { end: END, critic: 'critic' } as any);
      (g as any).addEdge('critic', 'refine_propose');
      (g as any).addEdge('refine_propose', 'verify');
      const graph = (g as any).compile();
      const initialTop = Math.min(Math.max(top ?? 5, 1), 10);
      const initialNote = String(note ?? '');
      const out = await graph.invoke({ note: initialNote, topN: initialTop, iterations: 0, done: false, bannedCodes: [], seenCodes: [] });
      const accepted = Array.isArray((out as any).accepted) ? (out as any).accepted : [];
      return { note_facts: out.facts!, items: accepted.slice(0, initialTop), conflicts_resolved: out.vetted?.conflicts_resolved ?? [], iterations: out.iterations ?? 1 } as AgenticRagResult;
    } catch (e) {
      const initialTop = Math.min(Math.max(top ?? 5, 1), 10);
      const initialNote = String(note ?? '');
      const facts = await this.facts.extractNoteFacts(initialNote);
      const proposal = await this.query.queryRag(initialNote, initialTop);
      const vetted = await this.verifyBatch(facts, proposal);
      if ((vetted.items?.length ?? 0) < initialTop) {
        const refine = this.buildRefineHints(facts, [...(vetted.failedCodes || []), ...(vetted.passedCodes || []), ...(vetted.seenCodes || [])]);
        const proposal2 = await this.queryRagWithConstraints(initialNote, refine, initialTop);
        const vetted2 = await this.verifyBatch(facts, proposal2);
        const seen = new Set((vetted.items ?? []).map((x: any) => x.code));
        for (const it of (vetted2.items ?? [])) if (!seen.has(it.code)) (vetted.items as any[]).push(it);
      }
      return { note_facts: facts, items: (vetted.items ?? []).slice(0, initialTop), conflicts_resolved: vetted.conflicts_resolved, iterations: 1 } as AgenticRagResult;
    }
  }
}


