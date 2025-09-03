import { Injectable, Logger } from '@nestjs/common';
import type { Interval, ItemRule, NoteFacts, VerifyReport, VerifiedItem, ItemCategory } from '../rag.types';

@Injectable()
export class RagVerifyService {
  private readonly logger = new Logger(RagVerifyService.name);

  getCategoriesFromGroup(group: string, subgroup?: string): ItemCategory {
    const categories: ItemCategory = [];

    if (group.startsWith('A1') || group.startsWith('A7')) categories.push('GP');
    if (group.startsWith('A3') || group.startsWith('A4') || group.startsWith('A28') || group.startsWith('A29')) categories.push('Specialist');
    if (group.startsWith('A40')) categories.push('Telehealth');
    if (group.startsWith('A11') || group.startsWith('A22') || group.startsWith('A23')) categories.push('AfterHours');
    if (group.startsWith('A21')) categories.push('Emergency');
    if (group.startsWith('T1') && subgroup === '14') categories.push('Emergency');
    if (group.startsWith('I')) categories.push('Imaging');
    if (group.startsWith('T8') || group.toLowerCase().includes('anaes')) categories.push('Surgery');
    if (group.startsWith('P')) categories.push('Pathology');

    if (categories.length === 0) categories.push('Other');
    return categories;
  }

  refineByKeywords(note: NoteFacts, code: string, display: string, group?: string, subgroup?: string): { result: 'PASS'|'SOFT'|'FAIL', details: string } {
    const noteText = (note.keywords || []).join(' ').toLowerCase();
    const displayLower = display.toLowerCase();
    
    // Surgery/Procedures auto-fail logic
    if (group && this.getCategoriesFromGroup(group, subgroup).includes('Surgery')) {
      const surgeryKeywords = ['operation', 'surgery', 'anaesthesia', 'incision', 'drainage', 'procedure', 'reduction', 'repair', 'open', 'closed reduction', 'orif', 'fixation'];
      const hasSurgeryKeywords = surgeryKeywords.some(keyword => noteText.includes(keyword));
      
      if (!hasSurgeryKeywords) {
        return { result: 'SOFT', details: 'surgery/anaesthesia not mentioned' };
      }
    }
    
    // CT with contrast refinement
    if (displayLower.includes('ct') && (displayLower.includes('with contrast') || displayLower.includes('contrast enhanced'))) {
      const contrastKeywords = ['with contrast', 'intravenous contrast', 'iv contrast', 'contrast enhanced'];
      const hasContrastKeywords = contrastKeywords.some(keyword => noteText.includes(keyword));
      
      if (!hasContrastKeywords) {
        return { result: 'SOFT', details: 'contrast not mentioned' };
      }
    }
    
    // CT without contrast refinement
    if (displayLower.includes('ct') && !displayLower.includes('with contrast')) {
      if (noteText.includes('ct')) {
        // Check for relevant body regions
        const bodyRegions = ['brain', 'facial', 'face', 'head', 'chest', 'abdomen', 'spine', 'neck', 'pelvis', 'extremity', 'limb'];
        const hasRelevantRegion = bodyRegions.some(region => noteText.includes(region));
        
        if (hasRelevantRegion) {
          return { result: 'PASS', details: '' };
        }
      }
    }
    
    // Ultrasound refinement
    if (displayLower.includes('ultrasound') || displayLower.includes('sonography') || displayLower.includes('us ')) {
      const ultrasoundKeywords = ['ultrasound', 'sonography', 'us'];
      const hasUltrasoundKeywords = ultrasoundKeywords.some(keyword => noteText.includes(keyword));
      
      if (!hasUltrasoundKeywords) {
        return { result: 'SOFT', details: 'ultrasound not mentioned' };
      }
    }
    
    return { result: 'PASS', details: '' };
  }

  intervalsOverlap(fMin: number, fMax: number, rMin: number, rMax: number) {
    return fMin < rMax && fMax > rMin;
  }
  
  checkTimeWindow(facts: NoteFacts, rule: any) {
    const win: Interval | { min?: number | null; max?: number | null } | null =
      (rule?.time_window ?? rule?.timeThreshold ?? null);
    if (!win) return { pass: true, details: '' };
  
    const fMin = facts.duration_min ?? 0;
    const fMax = facts.duration_max ?? Infinity;
    const rMin = (win as any).min ?? 0;
    const rMax = (win as any).max ?? Infinity;

    this.logger.log(
      `[AgenticRag] time_window: note=[${fMin},${Number.isFinite(fMax) ? fMax : '∞'}), rule=[${rMin},${Number.isFinite(rMax) ? rMax : '∞'})`
    );
  
    // 硬通过：fact 区间完全包含在规则区间内
    const inside =
      fMin >= rMin &&
      fMax <= rMax;
  
    if (inside) {
      return { pass: true, details: '' };
    }
  
    // 软通过：只要有交集
    const overlap = this.intervalsOverlap(fMin, fMax, rMin, rMax);
    if (overlap) {
      return { pass: true, details: 'soft_pass_overlap' };
    }
  
    // 否则失败
    return {
      pass: false,
      details: `duration [${fMin},${Number.isFinite(fMax) ? fMax : '∞'}) not in rule [${rMin},${Number.isFinite(rMax) ? rMax : '∞'})`,
    };
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
    if (val == null) return { pass: true, details: 'soft_info_missing: missing' };
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
        results.home_only = { pass: true, details: 'soft_info_missing: home setting not mentioned' };
      } else {
        results.home_only = { pass: true, details: '' };
      }
    }
    
    // referral_gp
    if (rule.flags.referral_gp) {
      if (facts.referral_present === null) {
        results.referral_gp = { pass: true, details: 'soft_info_missing: referral not specified, GP referral may be required' };
      } else if (facts.referral_present === false) {
        results.referral_gp = { pass: false, details: 'GP referral required' };
      } else {
        results.referral_gp = { pass: true, details: 'referral present' };
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
  
  triModality(noteModality: string | null, ruleModalityAllowed?: string[] | null) {
    // If rule doesn't specify modality requirements, always pass
    if (!ruleModalityAllowed || ruleModalityAllowed.length === 0) {
      return { result: 'PASS', details: '' } as const;
    }
    
    // If note modality is null (shouldn't happen with new logic), default to in_person
    const actualModality = noteModality || 'in_person';
    
    // Check if the actual modality is allowed
    if (ruleModalityAllowed.includes(actualModality)) {
      return { result: 'PASS', details: actualModality } as const;
    }
    
    // If modality is not allowed, check if it's a clear conflict
    // Only FAIL if there's a clear mismatch, otherwise SOFT
    const isTelehealthOnly = ruleModalityAllowed.includes('video') && !ruleModalityAllowed.includes('in_person');
    const isPhoneOnly = ruleModalityAllowed.includes('phone') && !ruleModalityAllowed.includes('in_person');
    const isInPersonOnly = ruleModalityAllowed.includes('in_person') && !ruleModalityAllowed.includes('video') && !ruleModalityAllowed.includes('phone');
    
    if (isTelehealthOnly && actualModality === 'in_person') {
      return { result: 'SOFT', details: 'telehealth not mentioned' } as const;
    } else if (isPhoneOnly && actualModality === 'in_person') {
      return { result: 'SOFT', details: 'phone consultation not mentioned' } as const;
    } else if (isInPersonOnly && (actualModality === 'video' || actualModality === 'phone')) {
      return { result: 'FAIL', details: 'in-person consultation required, but telehealth/phone used' } as const;
    } else {
      return { result: 'SOFT', details: `modality not specified, ${ruleModalityAllowed.join('|')} may be required` } as const;
    }
  }
  
  triSetting(noteSetting: string | null, ruleSettingAllowed?: string[] | null, noteText?: string) {
    // If rule doesn't specify setting requirements, always pass
    if (!ruleSettingAllowed || ruleSettingAllowed.length === 0) {
      return { result: 'PASS', details: '' } as const;
    }
    
    // If note setting is null or 'other', check for conflicting evidence
    if (!noteSetting || noteSetting === 'other') {
      // Check if note contains telehealth/remote keywords that would conflict with hospital/consulting_rooms
      const telehealthKeywords = ['telehealth', 'phone', 'home visit', 'video', 'virtual', 'remote'];
      const hasTelehealthKeywords = noteText && telehealthKeywords.some(keyword => 
        noteText.toLowerCase().includes(keyword)
      );
      
      if (hasTelehealthKeywords) {
        return { result: 'FAIL', details: 'telehealth/remote setting conflicts with hospital/consulting rooms requirement' } as const;
      }
      
      // If no conflicting evidence, mark as SOFT
      const requiredSettings = ruleSettingAllowed.join('/');
      return { result: 'SOFT', details: `setting not specified, ${requiredSettings} may be required` } as const;
    }
    
    // If note has a specific setting, check if it's allowed
    if (ruleSettingAllowed.includes(noteSetting)) {
      return { result: 'PASS', details: noteSetting } as const;
    }
    
    // If setting is explicitly not allowed, check if it's a clear conflict
    const hospitalKeywords = ['hospital', 'consulting rooms', 'clinic'];
    const hasHospitalKeywords = noteText && hospitalKeywords.some(keyword => 
      noteText.toLowerCase().includes(keyword)
    );
    
    if (hasHospitalKeywords && !ruleSettingAllowed.includes('hospital') && !ruleSettingAllowed.includes('consulting_rooms')) {
      return { result: 'FAIL', details: 'hospital/consulting rooms setting conflicts with requirement' } as const;
    }
    
    // If no clear conflict, mark as SOFT
    return { result: 'SOFT', details: `setting not specified, ${ruleSettingAllowed.join('|')} may be required` } as const;
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
  
    triIsGp(noteIsGp: boolean | null, ruleCategories: ItemCategory) {
    // If rule is not GP-specific, always pass
    if (!ruleCategories.includes('GP')) {
      return { result: 'PASS', details: '' } as const;
    }
    
    // If note doesn't specify GP context
    if (noteIsGp === null) {
      return { result: 'SOFT', details: 'GP context not specified, may be required' } as const;
    }
    
    // If rule requires GP but note shows non-GP
    if (noteIsGp === false) {
      return { result: 'FAIL', details: 'Requires GP attendance, but specialist/ED context found' } as const;
    }
    
    // If rule requires GP and note shows GP
    if (noteIsGp === true) {
      return { result: 'PASS', details: 'GP attendance matched' } as const;
    }
    
    return { result: 'SOFT', details: 'GP context uncertain' } as const;
  }
  
  triIsSpecialist(noteIsSpecialist: boolean | null, ruleCategories: ItemCategory) {
    // If rule is not Specialist-specific, always pass
    if (!ruleCategories.includes('Specialist')) {
      return { result: 'PASS', details: '' } as const;
    }
    
    // If note doesn't specify specialist context
    if (noteIsSpecialist === null) {
      return { result: 'SOFT', details: 'Specialist context not specified, may be required' } as const;
    }
    
    // If rule requires specialist but note shows non-specialist
    if (noteIsSpecialist === false) {
      return { result: 'FAIL', details: 'Requires specialist, but GP/ED context found' } as const;
    }
    
    // If rule requires specialist and note shows specialist
    if (noteIsSpecialist === true) {
      return { result: 'PASS', details: 'Specialist attendance matched' } as const;
    }
    
    return { result: 'SOFT', details: 'Specialist context uncertain' } as const;
  }
  
  triIsEmergency(noteIsEmergency: boolean | null, ruleCategories: ItemCategory) {
    // If rule is not emergency-specific, always pass
    if (!ruleCategories.includes('Emergency')) {
      return { result: 'PASS', details: '' } as const;
    }
    
    // If note doesn't specify emergency context
    if (noteIsEmergency === null) {
      return { result: 'SOFT', details: 'Emergency context not specified, may be required' } as const;
    }
    
    // If rule requires emergency but note shows non-emergency
    if (noteIsEmergency === false) {
      return { result: 'FAIL', details: 'Requires ED attendance, but no ED context found' } as const;
    }
    
    // If rule requires emergency and note shows emergency
    if (noteIsEmergency === true) {
      return { result: 'PASS', details: 'ED attendance matched' } as const;
    }
    
    return { result: 'SOFT', details: 'Emergency context uncertain' } as const;
  }
  
  triReferral(noteReferral: boolean | null, ruleReferralRequired?: boolean | null) {
    // 如果规则不要求 referral，直接 PASS
    if (!ruleReferralRequired) {
      return { result: 'PASS', details: '' } as const;
    }

    // 如果规则要求 referral，但 noteReferral 是 null（病例未写明）
    if (noteReferral === null) {
      return { result: 'SOFT', details: 'referral not specified, GP referral may be required' } as const;
    }

    // 如果规则要求 referral，但明确写了没有 referral
    if (noteReferral === false) {
      return { result: 'FAIL', details: 'GP referral required' } as const;
    }

    // 如果规则要求 referral，且明确有 referral
    if (noteReferral === true) {
      return { result: 'PASS', details: 'referral present' } as const;
    }

    // 默认情况
    return { result: 'SOFT', details: 'referral status uncertain' } as const;
  }
  
  triSpecialty(val: string | null, req?: string | null) {
    if (!req) return { result: 'PASS', details: '' } as const;
    if (!val) return { result: 'SOFT', details: 'check if the specialist type matches the required specialty' } as const;
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
    // Determine categories from Group field
    const categories: ItemCategory = rule.group ? this.getCategoriesFromGroup(rule.group, rule.subgroup) : ['Other'];
    const noteText = (note.keywords || []).join(' ').toLowerCase();
    
    // Auto-fail Surgery/Anaesthesia items if note doesn't mention surgery/anaesthesia
    if (categories.includes('Surgery')) {
      const surgeryKeywords = ['operation', 'surgery', 'anaesthesia', 'incision', 'drainage', 'procedure', 'reduction', 'repair', 'open', 'closed reduction', 'orif', 'fixation'];
      const hasSurgeryKeywords = surgeryKeywords.some(keyword => noteText.includes(keyword));
      
      if (!hasSurgeryKeywords) {
        // Don't auto-fail, let the normal verification process handle it
        // This will be handled by the keyword_refine check which returns SOFT
      }
    }
    
    const triChecks: Array<{ name: VerifyReport['checks'][number]['name']; result: 'PASS'|'SOFT'|'FAIL'; details: string }> = [];
    const t = this.triTime(note, rule); triChecks.push({ name: 'time_window', result: t.result, details: t.details || '' });
    const a = this.triAge(note, rule); triChecks.push({ name: 'age', result: a.result, details: a.details || '' });
    const m = this.triModality(note.modality, rule.modality_allowed ?? null); triChecks.push({ name: 'modality', result: m.result, details: m.details || '' });
    const s = this.triSetting(note.setting, rule.setting_allowed ?? null, noteText); triChecks.push({ name: 'setting', result: s.result, details: s.details || '' });
    const fr = this.triFirstOrReview(note.first_or_review ?? null, rule.first_or_review ?? null); triChecks.push({ name: 'first_or_review', result: fr.result, details: fr.details || '' });
    const r = this.triReferral(note.referral_present ?? null, rule.referral_required ?? null);
    triChecks.push({ name: 'referral', result: r.result, details: r.details || '' });
    const sp = this.triSpecialty(note.specialty ?? null, rule.specialty_required ?? null); triChecks.push({ name: 'specialty', result: sp.result, details: sp.details || '' });
    const c = this.triConditions(note, rule); triChecks.push({ name: 'conditions', result: c.result, details: c.details || '' });
    
    // Add GP, Specialist and Emergency context checks
    const g = this.triIsGp(note.is_gp ?? null, categories); triChecks.push({ name: 'is_gp', result: g.result, details: g.details || '' });
    const e = this.triIsEmergency(note.is_emergency ?? null, categories); triChecks.push({ name: 'is_emergency', result: e.result, details: e.details || '' });
    const spec = this.triIsSpecialist(note.is_specialist ?? null, categories); triChecks.push({ name: 'is_specialist', result: spec.result, details: spec.details || '' });
    
    // Add flag checks
    const flagChecks = this.triFlags(note, rule);
    triChecks.push(...flagChecks);

    // Add keyword refinement check
    const keywordRefine = this.refineByKeywords(note, rule.code, rule.evidence_spans?.join(' ') || '', rule.group, rule.subgroup);
    triChecks.push({ name: 'keyword_refine', result: keywordRefine.result, details: keywordRefine.details });

    const hasHardFail = triChecks.some((c) => c.result === 'FAIL');
    const hasSoft = triChecks.some((c) => c.result === 'SOFT');
    const checks: VerifyReport['checks'] = triChecks.map((c) => ({ name: c.name, pass: c.result !== 'FAIL', details: c.result === 'SOFT' ? (c.details || 'uncertain') : c.details }));
    const passes = !hasHardFail;
    
    // Build rationale with category-specific messages and keyword refinement
    let rationale_markdown: string;
    if (hasHardFail) {
      const failChecks = triChecks.filter((c) => c.result === 'FAIL');
      const failDetails = failChecks.map((c) => `- ${c.name}: ${c.details}`).join('\n');
      rationale_markdown = `**${rule.code}** ❌ Failed:\n${failDetails}`;
    } else if (hasSoft) {
      const softChecks = triChecks.filter((c) => c.result === 'SOFT');
      const softDetails = softChecks.map((c) => `- ${c.name}: ${c.details || 'uncertain'}`).join('\n');
      rationale_markdown = `**${rule.code}** ⚠️ Uncertain:\n${softDetails}`;
    } else {
      rationale_markdown = `**${rule.code}** ✅ Passed: all requirements satisfied.`;
    }
    
    return { 
      report: { 
        item_code: rule.code, 
        passes, 
        checks, 
        rationale_markdown,
        categories 
      } as VerifyReport, 
      hardFail: hasHardFail, 
      soft: hasSoft 
    };
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
    const categories = rep.categories ? rep.categories.join(', ') : 'Unknown';
    const group = (item as any).group || 'Unknown'; // Add group info if available
    
    // Check for keyword refinement results
    const keywordCheck = rep.checks.find(c => c.name === 'keyword_refine');
    const keywordResult = keywordCheck?.details || '';
    
    if (rep.passes) {
      this.logger.log(`[AgenticRag][RagVerifyService] Verify ${code} (group=${group}, categories=${categories}): passes=true`);
    } else {
      const failedChecks = rep.checks.filter(c => !c.pass).map(c => c.name);
      this.logger.warn(`[AgenticRag][RagVerifyService] Verify ${code} (group=${group}, categories=${categories}): passes=false, failedChecks=[${failedChecks.join(',')}]`);
    }
    
    // Log keyword refinement decision if present
    if (keywordCheck && keywordCheck.details) {
      const status = !keywordCheck.pass ? 'FAIL' 
        : (keywordCheck.details.includes('not mentioned') ? 'SOFT' : 'PASS');
      this.logger.log(`[AgenticRag][RagVerifyService] Verify ${code} (group=${group}, categories=${categories}): ${status} – ${keywordCheck.details}`);
    }
    
    for (const c of rep.checks) {
      let status = '✅';
      let details = c.details || '';
      
      // Determine status based on details content
      if (!c.pass) {
        status = '❌';
      } else if (details.includes('soft_pass_overlap') || 
                 details.includes('soft_info_missing') || 
                 details.includes('not specified') ||
                 details.includes('not mentioned') ||
                 details.includes('uncertain')) {
        status = '⚠️';
      }
      
      // Special handling for time_window soft pass overlap
      if (c.name === 'time_window' && details.includes('soft_pass_overlap')) {
        details = 'soft_pass_overlap';
      }
      
      // Special handling for flag checks with soft_info_missing
      if (details.includes('soft_info_missing:')) {
        const softDetails = details.replace('soft_info_missing:', '').trim();
        this.logger.log(`[AgenticRag][RagVerifyService]   - ${c.name}: ⚠️ ${softDetails}`);
      } else {
        this.logger.log(`[AgenticRag][RagVerifyService]   - ${c.name}: ${status} ${details}`);
      }
    }
  }
}


