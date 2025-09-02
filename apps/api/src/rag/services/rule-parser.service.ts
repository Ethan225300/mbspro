import { Injectable } from '@nestjs/common';
import type { Interval, ItemRule, Condition, ItemFlags } from '../rag.types';

@Injectable()
export class RagRuleParserService {
  parseIntervalFromDesc(desc: string): Interval | null {
    const t = (desc || '').toLowerCase();
    const a = t.match(/at\s+least\s+(\d+)\s*min(?:ute)?s?\s+and\s+less\s+than\s+(\d+)/);
    const b = t.match(/(?:≥|>=|at\s+least|not\s+less\s+than)\s+(\d+)\s*min/);
    const c = t.match(/(?:<|less\s+than)\s+(\d+)\s*min/);
    if (a) return { min: +a[1], max: +a[2], left_closed: true, right_closed: false };
    if (b) return { min: +b[1], max: null, left_closed: true, right_closed: false };
    if (c) return { min: 0, max: +c[1], left_closed: true, right_closed: false };
    return null;
  }

  parseAgeRange(desc: string): { min: number | null; max: number | null; left_closed?: boolean; right_closed?: boolean } | null {
    const t = (desc || '').toLowerCase();
    
    // "aged 75 years or more" → { min: 75, max: null, left_closed: true, right_closed: false }
    const a = t.match(/aged\s+(\d+)\s+years?\s+or\s+more/);
    if (a) return { min: +a[1], max: null, left_closed: true, right_closed: false };
    
    // "aged at least 4 years and less than 75 years" → { min: 4, max: 75, left_closed: true, right_closed: false }
    const b = t.match(/aged\s+at\s+least\s+(\d+)\s+years?\s+and\s+less\s+than\s+(\d+)\s+years?/);
    if (b) return { min: +b[1], max: +b[2], left_closed: true, right_closed: false };
    
    // "aged less than 4 years" → { min: 0, max: 4, left_closed: true, right_closed: false }
    const c = t.match(/aged\s+less\s+than\s+(\d+)\s+years?/);
    if (c) return { min: 0, max: +c[1], left_closed: true, right_closed: false };
    
    // "aged between X and Y years" → { min: X, max: Y, left_closed: true, right_closed: false }
    const d = t.match(/aged\s+between\s+(\d+)\s+and\s+(\d+)\s+years?/);
    if (d) return { min: +d[1], max: +d[2], left_closed: true, right_closed: false };
    
    // "aged at least X years" → { min: X, max: null, left_closed: true, right_closed: false }
    const e = t.match(/aged\s+at\s+least\s+(\d+)\s+years?/);
    if (e) return { min: +e[1], max: null, left_closed: true, right_closed: false };
    
    return null;
  }

  parseSetting(desc: string) {
    const t = (desc || '').toLowerCase(); const v: any[] = [];
    if (t.includes('consulting rooms')) v.push('consulting_rooms');
    if (t.includes('hospital') || t.includes('inpatient')) v.push('hospital');
    if (t.includes('residential aged care') || t.includes('residential care')) v.push('residential_care');
    return v.length ? v : null;
  }
  parseModality(desc: string) {
    const t = (desc || '').toLowerCase(); const v: any[] = [];
    if (/\bvideo|telehealth\b/.test(t)) v.push('video');
    if (/\btelephone|phone\b/.test(t)) v.push('phone');
    if (v.length === 0) v.push('in_person');
    return v;
  }
  parseSpecialty(desc: string) {
    const t = (desc || '').toLowerCase();
    if (t.includes('general practitioner')) return 'gp';
    if (t.includes('sexual health medicine specialist')) return 'sexual_health_specialist';
    return null;
  }
  parseReferral(desc: string) {
    return (desc || '').toLowerCase().includes('referral') ? true : null;
  }
  parseFirstOrReview(desc: string) {
    const t = (desc || '').toLowerCase();
    if (t.includes('first attendance') || t.includes('initial consultation') || t.includes('initial assessment')) return 'first';
    if (t.includes('review')) return 'review';
    return null;
  }

  parseConditions(desc: string): Condition[] {
    const conditions: Condition[] = [];
    const t = (desc || '').toLowerCase();
    
    // Only extract conditions for "before/after/follows" patterns
    const beforeAfterPatterns = [
      {
        pattern: /(before or after)\s+(?:a\s+)?(comprehensive|initial|review)\s+(?:assessment|consultation)\s+(?:under\s+)?(?:item\s+)?(\d+(?:\s*,\s*\d+)*)/gi,
        description: (type: string, items: string[]) => `before/after ${type} assessment (${items.join('/')})`
      },
      {
        pattern: /(follows?)\s+(?:an\s+)?(initial|review)\s+(?:assessment|consultation)\s+(?:under\s+)?(?:item\s+)?(\d+(?:\s*,\s*\d+)*)/gi,
        description: (type: string, items: string[]) => `after ${type} assessment (${items.join('/')})`
      }
    ];
    
    for (const { pattern, description } of beforeAfterPatterns) {
      let match;
      while ((match = pattern.exec(t)) !== null) {
        const relation = match[1]; // "before or after" or "follows"
        const assessmentType = match[2]; // "comprehensive", "initial", "review"
        const items = match[3].split(/\s*,\s*/).map(item => item.trim()).filter(item => /^\d+$/.test(item));
        
        if (items.length > 0) {
          conditions.push({
            type: "relation_required",
            description: description(assessmentType, items)
          });
        }
      }
    }
    
    return conditions;
  }

  parseFlags(desc: string): ItemFlags {
    const flags: ItemFlags = {};
    const t = (desc || '').toLowerCase();
    
    // case_conference
    if (t.includes('case conference') || t.includes('multidisciplinary') || t.includes('multidisciplinary meeting')) {
      flags.case_conference = true;
      const match = t.match(/at\s+least\s+(\d+)\s+other\s+(?:formal\s+)?care\s+providers/);
      if (match) {
        flags.case_conference_min = parseInt(match[1]) + 1; // +1 for the specialist
      }
    }
    
    // usual_gp_required
    if (t.includes('usual gp') || t.includes('usual medical practitioner')) {
      flags.usual_gp_required = true;
    }
    
    // home_only
    if (t.includes('home visit') || t.includes('attendance at home')) {
      flags.home_only = true;
    }
    
    // referral_gp
    if (t.includes('gp referral') || t.includes('referring practitioner')) {
      flags.referral_gp = true;
    }
    
    // referral_specialist
    if (t.includes('specialist referral')) {
      flags.referral_specialist = true;
    }
    
    return Object.keys(flags).length > 0 ? flags : undefined;
  }

  buildItemRuleFromDesc(code: string, desc: string, meta?: any): ItemRule {
    const interval: Interval | null = (meta?.duration_min_minutes != null || meta?.duration_max_minutes != null)
      ? {
          min: meta?.duration_min_minutes ?? null,
          max: meta?.duration_max_minutes ?? null,
          left_closed: meta?.duration_min_inclusive ?? true,
          right_closed: meta?.duration_max_inclusive ?? false,
        }
      : this.parseIntervalFromDesc(desc);
    return {
      code,
      time_window: interval,
      age_range: this.parseAgeRange(desc),
      setting_allowed: this.parseSetting(desc),
      modality_allowed: this.parseModality(desc),
      specialty_required: this.parseSpecialty(desc),
      referral_required: this.parseReferral(desc),
      first_or_review: this.parseFirstOrReview(desc) ?? null,
      conditions: this.parseConditions(desc),
      flags: this.parseFlags(desc),
      evidence_spans: [],
      confidence: 0.7,
    };
  }
}


