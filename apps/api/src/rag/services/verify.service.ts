import { Injectable, Logger } from '@nestjs/common';
import type { Interval, ItemRule, NoteFacts, VerifyReport, VerifiedItem } from '../rag.types';

@Injectable()
export class RagVerifyService {
  private readonly logger = new Logger(RagVerifyService.name);

  intervalsOverlap(fMin: number, fMax: number, rMin: number, rMax: number) {
    return fMin < rMax && fMax > rMin;
  }
  
  checkTimeWindow(facts: NoteFacts, rule: any) {
    const win: Interval | { min?: number | null; max?: number | null } | null = (rule?.time_window ?? rule?.timeThreshold ?? null);
    if (!win) return { pass: true, details: '' };
    const fMin = facts.duration_min ?? 0;
    const fMax = facts.duration_max ?? Infinity;
    const rMin = (win as any).min ?? 0;
    const rMax = (win as any).max ?? Infinity;
    const overlap = this.intervalsOverlap(fMin, fMax, rMin, rMax);
    this.logger.log(`[AgenticRag] time_window: note=[${fMin},${Number.isFinite(fMax)?fMax:'∞'}), rule=[${rMin},${Number.isFinite(rMax)?rMax:'∞'}), overlap=${overlap}`);
    
    if (overlap) {
      const fullContain = fMin <= rMin && (Number.isFinite(fMax) && fMax >= rMax);
      if (fullContain) {
        return { pass: true, details: '' };
      } else {
        return { pass: true, details: 'soft_pass_overlap' };
      }
    }
    return { pass: false, details: `duration [${fMin},${Number.isFinite(fMax)?fMax:'∞'}) not overlapping rule [${rMin},${Number.isFinite(rMax)?rMax:'∞'})` };
  }
  
  checkAgeRange(facts: NoteFacts, rule: ItemRule) {
    const ageRange = rule.age_range;
    if (!ageRange) return { pass: true, details: '' };
    
    const patientAge = facts.age;
    if (patientAge === null) return { pass: true, details: 'soft_info_missing: unknown age' };
    
    const min = ageRange.min ?? 0;
    const max = ageRange.max ?? Infinity;
    const leftClosed = ageRange.left_closed ?? true;
    const rightClosed = ageRange.right_closed ?? false;
    
    // Check if age is within range
    const minCheck = leftClosed ? patientAge >= min : patientAge > min;
    const maxCheck = rightClosed ? patientAge <= max : patientAge < max;
    
    if (minCheck && maxCheck) {
      return { pass: true, details: '' };
    } else {
      const minStr = min === 0 ? '0' : min.toString();
      const maxStr = max === Infinity ? '∞' : max.toString();
      const leftBracket = leftClosed ? '[' : '(';
      const rightBracket = rightClosed ? ']' : ')';
      return { pass: false, details: `require age ${leftBracket}${minStr},${maxStr}${rightBracket}` };
    }
  }
  
  checkEnum<T extends string>(val: T | null, allowed?: T[] | null) {
    if (!allowed || !allowed.length) return { pass: true, details: '' };
    if (val == null) return { pass: false, details: 'missing' };
    return allowed.includes(val) ? { pass: true, details: '' } : { pass: false, details: `require ${allowed.join('|')}` };
  }

  checkConditions(facts: NoteFacts, rule: ItemRule) {
    if (!rule.conditions || rule.conditions.length === 0) {
      return { pass: true, details: '' };
    }
    
    // Only handle "before/after/follows" conditions
    const descs = rule.conditions.map(c => {
      if (c.type === "relation_required") {
        return `need to confirm ${c.description ?? 'satisfies sequence conditions'}`;
      }
      return null;
    }).filter(Boolean);
    
    if (descs.length > 0) {
      return { 
        pass: true, 
        details: `soft_info_missing: ${descs.join('; ')}` 
      };
    }
    
    return { pass: true, details: '' };
  }

  checkFlags(facts: NoteFacts, rule: ItemRule) {
    const results: { [key: string]: { pass: boolean; details?: string } } = {};
    
    if (!rule.flags) {
      return results;
    }
    
    const noteText = (facts.keywords || []).join(' ').toLowerCase();
    
    // case_conference
    if (rule.flags.case_conference) {
      const hasConferenceKeywords = noteText.includes('conference') || noteText.includes('team') || noteText.includes('multidisciplinary');
      if (!hasConferenceKeywords) {
        results.case_conference = { pass: true, details: 'soft_info_missing: conference/team not mentioned' };
      } else if (rule.flags.case_conference_min) {
        // Simple heuristic: count "specialist", "doctor", "practitioner" etc.
        const participantCount = (noteText.match(/\b(specialist|doctor|practitioner|nurse|therapist|consultant)\b/g) || []).length;
        if (participantCount < rule.flags.case_conference_min) {
          results.case_conference = { pass: false, details: `require team ≥${rule.flags.case_conference_min}` };
        } else {
          results.case_conference = { pass: true, details: '' };
        }
      } else {
        results.case_conference = { pass: true, details: '' };
      }
    }
    
    // usual_gp_required
    if (rule.flags.usual_gp_required) {
      const hasUsualGp = noteText.includes('usual gp') || noteText.includes('usual medical practitioner');
      if (!hasUsualGp) {
        results.usual_gp = { pass: true, details: 'soft_info_missing: not confirmed' };
      } else {
        results.usual_gp = { pass: true, details: '' };
      }
    }
    
    // home_only
    if (rule.flags.home_only) {
      // Check if note mentions home visit in keywords
      const hasHomeVisit = noteText.includes('home visit') || noteText.includes('home setting') || noteText.includes('attendance at home');
      if (!hasHomeVisit) {
        results.home_only = { pass: false, details: 'require home setting' };
      } else {
        results.home_only = { pass: true, details: '' };
      }
    }
    
    // referral_gp
    if (rule.flags.referral_gp) {
      if (facts.referral_present !== true) {
        results.referral_gp = { pass: false, details: 'GP referral required' };
      } else {
        results.referral_gp = { pass: true, details: '' };
      }
    }
    
    // referral_specialist
    if (rule.flags.referral_specialist) {
      const hasSpecialistReferral = noteText.includes('specialist referral') || noteText.includes('referred to specialist');
      if (!hasSpecialistReferral) {
        results.referral_specialist = { pass: true, details: 'soft_info_missing: not mentioned' };
      } else {
        results.referral_specialist = { pass: true, details: '' };
      }
    }
    
    return results;
  }

  triTime(note: NoteFacts, rule: ItemRule) {
    const r = this.checkTimeWindow(note, rule);
    if (!r.pass && String(r.details || '').startsWith('duration')) return { result: 'FAIL', details: r.details } as const;
    if (r.pass && String(r.details || '').includes('soft_pass_overlap')) return { result: 'SOFT', details: r.details } as const;
    return { result: 'PASS', details: '' } as const;
  }
  
  triAge(note: NoteFacts, rule: ItemRule) {
    const r = this.checkAgeRange(note, rule);
    if (!r.pass && String(r.details || '').startsWith('require age')) return { result: 'FAIL', details: r.details } as const;
    if (r.pass && String(r.details || '').includes('soft_info_missing')) return { result: 'SOFT', details: r.details } as const;
    return { result: 'PASS', details: '' } as const;
  }
  
  triEnum<T extends string>(val: T | null, allowed?: T[] | null) {
    if (!allowed || !allowed.length) return { result: 'PASS', details: '' } as const;
    if (val == null) return { result: 'SOFT', details: 'unknown' } as const;
    return allowed.includes(val) ? { result: 'PASS', details: '' } as const : { result: 'FAIL', details: `require ${allowed.join('|')}` } as const;
  }
  
  triFirstOrReview(val: string | null, req?: string | null) {
    if (!req || req === 'either') return { result: 'PASS', details: '' } as const;
    if (!val) return { result: 'SOFT', details: 'unknown visit type' } as const;
    return val === req ? { result: 'PASS', details: '' } as const : { result: 'FAIL', details: `require ${req}` } as const;
  }
  
  triReferral(present: boolean | null, required?: boolean | null) {
    if (required == null) return { result: 'PASS', details: '' } as const;
    if (present == null) return { result: 'SOFT', details: 'unknown referral' } as const;
    return present === required ? { result: 'PASS', details: '' } as const : { result: 'FAIL', details: required ? 'referral required' : 'referral not required' } as const;
  }
  
  triSpecialty(val: string | null, req?: string | null) {
    if (!req) return { result: 'PASS', details: '' } as const;
    if (!val) return { result: 'SOFT', details: 'unknown specialty' } as const;
    return val.toLowerCase() === (req || '').toLowerCase() ? { result: 'PASS', details: '' } as const : { result: 'FAIL', details: `require ${req}` } as const;
  }

  triConditions(note: NoteFacts, rule: ItemRule) {
    const r = this.checkConditions(note, rule);
    if (!r.pass) return { result: 'FAIL', details: r.details } as const;
    if (r.pass && String(r.details || '').includes('soft_info_missing')) return { result: 'SOFT', details: r.details } as const;
    return { result: 'PASS', details: '' } as const;
  }

  triFlags(note: NoteFacts, rule: ItemRule) {
    const flagChecks = this.checkFlags(note, rule);
    const results: Array<{ name: VerifyReport['checks'][number]['name']; result: 'PASS'|'SOFT'|'FAIL'; details: string }> = [];
    
    for (const [flagName, check] of Object.entries(flagChecks)) {
      if (check.pass && String(check.details || '').includes('soft_info_missing')) {
        results.push({ name: flagName as VerifyReport['checks'][number]['name'], result: 'SOFT', details: check.details || '' });
      } else if (!check.pass) {
        results.push({ name: flagName as VerifyReport['checks'][number]['name'], result: 'FAIL', details: check.details || '' });
      } else {
        results.push({ name: flagName as VerifyReport['checks'][number]['name'], result: 'PASS', details: check.details || '' });
      }
    }
    
    return results;
  }

  verifyOneTri(note: NoteFacts, rule: ItemRule): { report: VerifyReport; hardFail: boolean; soft: boolean } {
    const triChecks: Array<{ name: VerifyReport['checks'][number]['name']; result: 'PASS'|'SOFT'|'FAIL'; details: string }> = [];
    const t = this.triTime(note, rule); triChecks.push({ name: 'time_window', result: t.result, details: t.details || '' });
    const a = this.triAge(note, rule); triChecks.push({ name: 'age', result: a.result, details: a.details || '' });
    const m = this.triEnum(note.modality, rule.modality_allowed ?? null); triChecks.push({ name: 'modality', result: m.result, details: m.details || '' });
    const s = this.triEnum(note.setting, rule.setting_allowed ?? null); triChecks.push({ name: 'setting', result: s.result, details: s.details || '' });
    const fr = this.triFirstOrReview(note.first_or_review ?? null, rule.first_or_review ?? null); triChecks.push({ name: 'first_or_review', result: fr.result, details: fr.details || '' });
    const rr = this.triReferral(note.referral_present ?? null, rule.referral_required ?? null); triChecks.push({ name: 'referral', result: rr.result, details: rr.details || '' });
    const sp = this.triSpecialty(note.specialty ?? null, rule.specialty_required ?? null); triChecks.push({ name: 'specialty', result: sp.result, details: sp.details || '' });
    const c = this.triConditions(note, rule); triChecks.push({ name: 'conditions', result: c.result, details: c.details || '' });
    
    // Add flag checks
    const flagChecks = this.triFlags(note, rule);
    triChecks.push(...flagChecks);

    const hasHardFail = triChecks.some((c) => c.result === 'FAIL');
    const hasSoft = triChecks.some((c) => c.result === 'SOFT');
    const checks: VerifyReport['checks'] = triChecks.map((c) => ({ name: c.name, pass: c.result !== 'FAIL', details: c.result === 'SOFT' ? (c.details || 'uncertain') : c.details }));
    const passes = !hasHardFail;
    const rationale_markdown = hasHardFail
      ? `**${rule.code}** ❌ Failed:\n${triChecks.filter((c)=>c.result==='FAIL').map((c)=>`- ${c.name}: ${c.details}`).join('\n')}`
      : hasSoft
        ? `**${rule.code}** ⚠️ Partially uncertain:\n${triChecks.filter((c)=>c.result==='SOFT').map((c)=>`- ${c.name}: ${c.details || 'uncertain'}`).join('\n')}`
        : `**${rule.code}** ✅ Passed: duration/setting/modality/specialty/referral requirements all match.`;
    return { report: { item_code: rule.code, passes, checks, rationale_markdown } as VerifyReport, hardFail: hasHardFail, soft: hasSoft };
  }

  resolveTimeConflicts(items: VerifiedItem[], _facts: NoteFacts) {
    return { final: items, notes: [] as string[] };
  }

  logBatchSummary(results: any[], passItems: VerifiedItem[], softCount: number) {
    const total = results.length;
    const passCount = passItems.length;
    const failCount = total - passCount;
    this.logger.log(`[AgenticRag][RagVerifyService] verify: total=${total}, pass=${passCount}, fail=${failCount}, soft=${softCount}`);
  }

  logItemDetails(item: VerifiedItem) {
    const rep = item.verify;
    const code = item.code || rep.item_code;
    if (rep.passes) {
      this.logger.log(`[AgenticRag][RagVerifyService] Verify ${code}: passes=true`);
    } else {
      const failedChecks = rep.checks.filter(c => !c.pass).map(c => c.name);
      this.logger.warn(`[AgenticRag][RagVerifyService] Verify ${code}: passes=false, failedChecks=[${failedChecks.join(',')}]`);
    }
    for (const c of rep.checks) {
      const status = c.pass ? '✅' : '❌';
      let details = c.details || '';
      // Special handling for soft pass overlap
      if (c.name === 'time_window' && details.includes('soft_pass_overlap')) {
        details = 'soft_pass_overlap';
      }
      // Special handling for flag checks with soft_info_missing
      if (c.pass && details.includes('soft_info_missing:')) {
        const softDetails = details.replace('soft_info_missing:', '').trim();
        this.logger.log(`[AgenticRag][RagVerifyService]   - ${c.name}: ⚠️ ${softDetails}`);
      } else {
        this.logger.log(`[AgenticRag][RagVerifyService]   - ${c.name}: ${status} ${details}`);
      }
    }
  }
}


