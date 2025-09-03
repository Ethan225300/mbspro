import { Injectable } from "@nestjs/common";
import { RuleCandidateDto } from "./dto/evaluate-rule.dto";
import { ValidateSelectionDto } from './dto/validate-selection.dto';
import * as fs from 'fs';
import * as path from 'path';
import { SuggestCandidate } from "../shared/index";

/// Simple rule evaluation service
/// test by pnpm --filter @mbspro/api exec -- jest --testPathPattern=rules --runInBand
@Injectable()
export class RulesService {
  evaluateCandidates(candidates: RuleCandidateDto[]): SuggestCandidate[] {
    const selectedCodes = candidates
      .filter((c) => c.selected)
      .map((c) => c.code);

    return candidates.map((candidate) => {
      const reasons: string[] = [];

      const conflicts =
        candidate.mutuallyExclusiveWith?.filter((c) =>
          selectedCodes.includes(c)
        ) || [];
      if (conflicts.length > 0) {
        reasons.push(
          `Mutually exclusive with selected codes: ${conflicts.join(", ")}`
        );
      }

      // Check time threshold
      if (
        candidate.selected &&
        candidate.timeThreshold &&
        candidate.durationMinutes !== undefined
      ) {
        if (candidate.durationMinutes < candidate.timeThreshold) {
          reasons.push(
            `Duration below required threshold of ${candidate.timeThreshold} minutes`
          );
        }
      }

      // Check telehealth flag mismatch
      if (
        candidate.selected &&
        candidate.flags?.telehealth !== undefined &&
        candidate.context
      ) {
        if (
          (candidate.flags.telehealth && candidate.context !== "telehealth") ||
          (!candidate.flags.telehealth && candidate.context === "telehealth")
        ) {
          reasons.push(`Context mismatch: telehealth flag vs selected context`);
        }
      }

      // Determine status
      let status: "PASS" | "WARN" | "FAIL" = "PASS";
      if (reasons.length > 0) {
        status = candidate.selected ? "FAIL" : "WARN";
      }

      return {
        code: candidate.code,
        title: candidate.title,
        score: 0, // optional, can be reused later
        short_explain: reasons.join("; ") || "All rules passed",
        status,
      };
    });
  }

  private resolveRulesPath(): string | null {
    const envPath = process.env.MBS_RULES_JSON;
    console.log(`[rulesPath] env.MBS_RULES_JSON=${envPath || ''}`);
    console.log('[rules] env.MBS_RULES_JSON=', process.env.MBS_RULES_JSON)
    console.log('[rulesPath] __dirname=', __dirname);
    console.log('[rulesPath] process.cwd()=', process.cwd());
    
    const candidates = [
      // // 1. 如果 env 是绝对路径，直接使用
      // envPath && path.isAbsolute(envPath) ? envPath : null,
      // // 2. 如果 env 是相对路径，相对于 cwd 解析
      // envPath && !path.isAbsolute(envPath) ? path.resolve(process.cwd(), envPath) : null,
      // // 3. 使用 __dirname 作为基础（和 rule-engine.service.ts 一致）
      // path.resolve(__dirname, 'mbs_rules.normalized.json'),
      // 4. 备选路径（和 rule-engine.service.ts 一致）
      path.resolve(process.cwd(), '..', '..', '..', 'suggest', 'mbs_rules.normalized.json'),
      // 5. 使用 __dirname 退4级然后拼接
      path.resolve(__dirname, '..', '..', '..', '..', 'suggest', 'mbs_rules.normalized.json'),
    ].filter(Boolean) as string[];
    
    console.log('[rulesPath] Checking candidates:');
    candidates.forEach((p, i) => {
      console.log(`[rulesPath] ${i + 1}. ${p}`);
    });
    
    for (const p of candidates) {
      try {
        if (fs.existsSync(p)) {
          console.log(`[rulesPath] ✅ FOUND: ${p}`);
          return p;
        } else {
          console.log(`[rulesPath] ❌ not found: ${p}`);
        }
      } catch (e) {
        console.error(`[rulesPath] error checking ${p}: ${e}`);
      }
    }
    console.log('[rulesPath] ❌ No file found in any candidate path');
    return null;
  }

  validateSelection(dto: ValidateSelectionDto) {
    // Load normalized rules to inspect mutual exclusivity and flags
    const rulesPath = process.env.MBS_RULES_JSON || path.resolve(__dirname, '..', '..', '..', '..', 'suggest', 'mbs_rules.normalized.json');
    console.log('[validateSelection] rulesPath=', rulesPath);
    console.log('[validateSelection] __dirname=', __dirname);
    console.log('[validateSelection] process.cwd()=', process.cwd());
    
    let byCode = new Map<string, any>();
    try {
      const rawPath = fs.existsSync(rulesPath) ? rulesPath : path.resolve(__dirname, '..', '..', '..', '..', 'suggest', 'mbs_rules.normalized.json');
      console.log('[validateSelection] trying rawPath=', rawPath);
      console.log('[validateSelection] rawPath exists?', fs.existsSync(rawPath));
      
      const raw = fs.readFileSync(rawPath, 'utf8');
      console.log('[validateSelection] file read successfully, length=', raw.length);
      
      const arr = JSON.parse(raw);
      console.log('[validateSelection] parsed JSON, is array?', Array.isArray(arr));
      console.log('[validateSelection] array length=', arr.length);
      
      if (Array.isArray(arr)) {
        byCode = new Map(arr.map((x: any) => [String(x.code), x]));
        console.log('[validateSelection] byCode map size=', byCode.size);
      }
    } catch (error) {
      console.error('[validateSelection] error loading rules:', error);
    }

    const selected = new Set<string>((dto.selectedCodes || []).map(String));
    const conflicts: Array<{ code: string; with: string[] }> = [];
    for (const code of selected) {
      const item = byCode.get(code);
      const ex = Array.isArray(item?.mutuallyExclusiveWith) ? item.mutuallyExclusiveWith.map(String) : [];
      const overlap = ex.filter((c: string) => selected.has(c));
      if (overlap.length > 0) conflicts.push({ code, with: overlap });
    }

    // Simple blocked rule: if any conflict, mark blocked
    const blocked = conflicts.length > 0;
    const warnings: string[] = conflicts.map((c) => `${c.code} ↔ ${c.with.join(', ')}`);

    return {
      ok: true,
      blocked,
      conflicts,
      warnings,
    };
  }
}
