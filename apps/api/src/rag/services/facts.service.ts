import { Injectable, Logger } from '@nestjs/common';
import { ChatOpenAI } from '@langchain/openai';
import type { NoteFacts } from '../rag.types';

@Injectable()
export class RagFactsService {
  private readonly logger = new Logger(RagFactsService.name);

  extractNoteFactsHeuristic(note: string): Partial<NoteFacts> {
    const text = (note ?? '').toString();
    const t = text.toLowerCase();
    const facts: Partial<NoteFacts> = { keywords: [] } as any;

    // Extract duration with improved exact time detection
    const exactTime = t.match(/(?:exactly|precisely|exact)\s+(\d{1,3})\s*min(?:ute)?s?/);
    const standaloneTime = t.match(/\b(\d{1,3})\s*min(?:ute)?s?\b/);
    const rangeTime = t.match(/(\d{1,3})\s*[-–—]\s*(\d{1,3})\s*min(?:ute)?s?/);
    const a = t.match(/at\s+least\s+(\d{1,3})\s*min(?:ute)?s?\s+and\s+less\s+than\s+(\d{1,3})/);
    const b = t.match(/(?:≥|>=|at\s+least|not\s+less\s+than)\s*(\d{1,3})\s*min/);
    const c = t.match(/(?:more\s+than|>\s*)\s*(\d{1,3})\s*min/);
    const d = t.match(/(?:<|less\s+than)\s*(\d{1,3})\s*min/);
    const e = t.match(/(\d{1,3})\s*\+?\s*min/);
    
    if (exactTime) {
      // Exactly X minutes - set both min and max to X
      const n = +exactTime[1];
      (facts as any).duration_min = n;
      (facts as any).duration_max = n;
      (facts as any).duration_min_inclusive = true;
      (facts as any).duration_max_inclusive = true;
    } else if (standaloneTime && !t.includes('at least') && !t.includes('more than') && !t.includes('less than') && !t.includes('≥') && !t.includes('>=') && !t.includes('>')) {
      // Standalone X minutes without modifiers - treat as exact time
      const n = +standaloneTime[1];
      (facts as any).duration_min = n;
      (facts as any).duration_max = n;
      (facts as any).duration_min_inclusive = true;
      (facts as any).duration_max_inclusive = true;
    } else if (rangeTime) {
      // X-Y minutes range
      (facts as any).duration_min = +rangeTime[1];
      (facts as any).duration_max = +rangeTime[2];
      (facts as any).duration_min_inclusive = true;
      (facts as any).duration_max_inclusive = true;
    } else if (a) {
      (facts as any).duration_min = +a[1];
      (facts as any).duration_max = +a[2];
      (facts as any).duration_min_inclusive = true;
      (facts as any).duration_max_inclusive = false;
    } else if (b) {
      (facts as any).duration_min = +b[1];
      (facts as any).duration_max = null;
      (facts as any).duration_min_inclusive = true;
      (facts as any).duration_max_inclusive = false;
    } else if (c) {
      (facts as any).duration_min = +c[1];
      (facts as any).duration_max = null;
      (facts as any).duration_min_inclusive = false;
      (facts as any).duration_max_inclusive = false;
    } else if (d) {
      (facts as any).duration_min = Math.max(0, +d[1] - 1);
      (facts as any).duration_max = +d[1];
      (facts as any).duration_min_inclusive = true;
      (facts as any).duration_max_inclusive = false;
    } else if (e) {
      (facts as any).duration_min = +e[1];
      (facts as any).duration_max = null;
      (facts as any).duration_min_inclusive = true;
      (facts as any).duration_max_inclusive = false;
    }

    // Extract age
    const ageMatch = t.match(/(?:aged|age)[:\s]+(\d{1,3})\s*(?:years?|yrs?|y|yo|y\.?o\.?)?/);
    if (ageMatch) {
      (facts as any).age = +ageMatch[1];
    } else {
      // Try other age patterns
      const ageMatch2 = t.match(/(\d{1,3})\s*(?:years?\s*old|yrs?\s*old|yo|y\.?o\.?)/);
      if (ageMatch2) {
        (facts as any).age = +ageMatch2[1];
      } else {
        // Try standalone age patterns
        const ageMatch3 = t.match(/\b(\d{1,3})\s*(?:y|yo|y\.?o\.?)\b/);
        if (ageMatch3) {
          (facts as any).age = +ageMatch3[1];
        }
      }
    }

    // Extract modality with improved detection
    if (/\b(?:video|telehealth|zoom|virtual|skype|webex|teams)\b/.test(t)) {
      (facts as any).modality = 'video';
    } else if (/\b(?:phone|telephone|call)\b/.test(t)) {
      (facts as any).modality = 'phone';
    } else {
      // Default to in_person if no telehealth keywords found
      (facts as any).modality = 'in_person';
    }

    // Extract setting
    if (/\bhospital|inpatient\b/.test(t)) (facts as any).setting = 'hospital';
    else if (/\bconsulting\s+rooms?\b/.test(t)) (facts as any).setting = 'consulting_rooms';
    else if (/\bresidential\s+(aged\s+)?care\b/.test(t)) (facts as any).setting = 'residential_care';
    else if (/\bhome\s+visit\b/.test(t)) (facts as any).setting = 'home';

    // Extract other flags
    if (/\bafter[-\s]?hours\b/.test(t)) (facts as any).after_hours = true;
    if (/\bfirst\b/.test(t)) (facts as any).first_or_review = 'first';
    if (/\breview\b/.test(t)) (facts as any).first_or_review = 'review';
    if (/\breferral\b/.test(t)) (facts as any).referral_present = true;

    // Extract GP, Specialist and Emergency context
    // Priority: Specialist > GP (because specialist is more specific)
    if (/\b(?:specialist|consultant|surgeon|anaesthetist|cardiologist|dermatologist|endocrinologist|gastroenterologist|neurologist|oncologist|orthopaedic|psychiatrist|radiologist|urologist|orthopedic|gynaecologist|obstetrician|paediatrician|geriatrician|rheumatologist|nephrologist|haematologist|pulmonologist)\b/.test(t)) {
      (facts as any).is_gp = false;
      (facts as any).is_specialist = true;
    } else if (/\b(?:general practitioner|gp|family doctor|primary care)\b/.test(t)) {
      (facts as any).is_gp = true;
      (facts as any).is_specialist = false;
    }
    // Note: "gp referral" is about referral relationship, not doctor identity
    // So we don't set is_gp=true just because of "gp referral"
    
    if (/\b(?:emergency|ed|emergency department|emergency room|er|urgent care|acute care|trauma|resuscitation|ambulance|paramedic)\b/.test(t)) {
      (facts as any).is_emergency = true;
    } else if (/\b(?:routine|elective|scheduled|appointment|clinic|consultation)\b/.test(t)) {
      (facts as any).is_emergency = false;
    }

    // Extract keywords for flag checking
    const keywords: string[] = [];
    if (/\bconference\b/.test(t)) keywords.push('conference');
    if (/\bteam\b/.test(t)) keywords.push('team');
    if (/\bmultidisciplinary\b/.test(t)) keywords.push('multidisciplinary');
    if (/\busual\s+gp\b/.test(t)) keywords.push('usual gp');
    if (/\busual\s+medical\s+practitioner\b/.test(t)) keywords.push('usual medical practitioner');
    if (/\bhome\s+visit\b/.test(t)) keywords.push('home visit');
    if (/\battendance\s+at\s+home\b/.test(t)) keywords.push('attendance at home');
    if (/\bgp\s+referral\b/.test(t)) keywords.push('gp referral');
    if (/\breferring\s+practitioner\b/.test(t)) keywords.push('referring practitioner');
    if (/\bspecialist\s+referral\b/.test(t)) keywords.push('specialist referral');
    if (/\breferred\s+to\s+specialist\b/.test(t)) keywords.push('referred to specialist');
    
    // Add participant keywords for case conference
    if (/\bspecialist\b/.test(t)) keywords.push('specialist');
    if (/\bdoctor\b/.test(t)) keywords.push('doctor');
    if (/\bpractitioner\b/.test(t)) keywords.push('practitioner');
    if (/\bnurse\b/.test(t)) keywords.push('nurse');
    if (/\btherapist\b/.test(t)) keywords.push('therapist');
    if (/\bconsultant\b/.test(t)) keywords.push('consultant');

    (facts as any).keywords = keywords;

    return facts;
  }

  async extractNoteFacts(note: string): Promise<NoteFacts> {
    const seed = this.extractNoteFactsHeuristic(note);
    this.logger.log(`[AgenticRag][RagFactsService] heuristic facts: ${JSON.stringify(seed)}`);
    const needLLM = 
      seed.duration_min == null ||
      seed.modality == null ||
      seed.setting == null ||
      (seed as any).duration_max === undefined ||
      (seed as any).duration_min_inclusive === undefined ||
      (seed as any).duration_max_inclusive === undefined ||
      (seed as any).age == null;
    if (!needLLM) {
      const facts = {
        duration_min: seed.duration_min ?? null,
        duration_max: (seed as any).duration_max ?? null,
        duration_min_inclusive: (seed as any).duration_min_inclusive ?? (seed.duration_min != null ? true : null),
        duration_max_inclusive: (seed as any).duration_max_inclusive ?? (seed.duration_max != null ? false : null),
        modality: seed.modality ?? null,
        after_hours: seed.after_hours ?? null,
        setting: seed.setting ?? 'other',
        first_or_review: seed.first_or_review ?? null,
        referral_present: seed.referral_present ?? null,
        specialty: seed.specialty ?? null,
        age: (seed as any).age ?? null,
        keywords: seed.keywords ?? [],
        is_gp: (seed as any).is_gp ?? null,
        is_emergency: (seed as any).is_emergency ?? null,
        is_specialist: (seed as any).is_specialist ?? null
      } as NoteFacts;
      this.logger.log(`[AgenticRag][RagFactsService] final facts: ${JSON.stringify(facts)}`);
      return facts;
    }

    const MODEL = process.env.OPENAI_FACTS_MODEL || process.env.OPENAI_CHAT_MODEL || 'gpt-4o-mini';
    const llm = new ChatOpenAI({ modelName: MODEL, temperature: 0 });
    const schema = `{
    "type":"object",
    "properties":{
      "duration_min":{"type":["integer","null"]},
      "duration_max":{"type":["integer","null"]},
      "duration_min_inclusive":{"type":["boolean","null"]},
      "duration_max_inclusive":{"type":["boolean","null"]},
      "modality":{"type":["string","null"],"enum":["in_person","video","phone",null]},
      "after_hours":{"type":["boolean","null"]},
      "setting":{"type":["string","null"],"enum":["consulting_rooms","hospital","residential_care","home","other",null]},
      "first_or_review":{"type":["string","null"],"enum":["first","review",null]},
      "referral_present":{"type":["boolean","null"]},
      "specialty":{"type":["string","null"]},
      "age":{"type":["integer","null"]},
      "keywords":{"type":"array","items":{"type":"string"}},
      "is_gp":{"type":["boolean","null"]},
      "is_emergency":{"type":["boolean","null"]},
      "is_specialist":{"type":["boolean","null"]}
    },
    "required":["duration_min","modality","setting","after_hours","keywords"]
  }`;

    const prompt = `Extract clinical facts from the text as valid JSON per this JSON Schema. Pay special attention to patient age - look for patterns like "Age: 55Y", "55 years old", "aged 55", "55 yo", etc. Unknown -> null. No explanations.\n\nSchema:\n${schema}\n\nText:\n"""${note}"""`;
    try {
      const resp = await llm.invoke([{ role: 'user', content: prompt }]);
      const json = JSON.parse(String((resp as any).content).match(/\{[\s\S]*\}$/)![0]);
      const facts = {
        duration_min: json.duration_min ?? seed.duration_min ?? null,
        duration_max: json.duration_max ?? (seed as any).duration_max ?? null,
        duration_min_inclusive: json.duration_min_inclusive ?? (seed as any).duration_min_inclusive ?? (json.duration_min != null ? true : null),
        duration_max_inclusive: json.duration_max_inclusive ?? (seed as any).duration_max_inclusive ?? (json.duration_max != null ? false : null),
        modality: json.modality ?? seed.modality ?? null,
        after_hours: json.after_hours ?? seed.after_hours ?? null,
        setting: json.setting ?? seed.setting ?? 'other',
        first_or_review: json.first_or_review ?? seed.first_or_review ?? null,
        referral_present: json.referral_present ?? seed.referral_present ?? null,
        specialty: json.specialty ?? seed.specialty ?? null,
        age: json.age ?? (seed as any).age ?? null,
        keywords: Array.isArray(json.keywords) ? json.keywords : (seed.keywords ?? []),
        is_gp: json.is_gp ?? (seed as any).is_gp ?? null,
        is_emergency: json.is_emergency ?? (seed as any).is_emergency ?? null,
        is_specialist: json.is_specialist ?? (seed as any).is_specialist ?? null
      } as NoteFacts;
      this.logger.log(`[AgenticRag][RagFactsService] final facts: ${JSON.stringify(facts)}`);
      return facts;
    } catch {
      const facts = {
        duration_min: seed.duration_min ?? null,
        duration_max: (seed as any).duration_max ?? null,
        duration_min_inclusive: (seed as any).duration_min_inclusive ?? (seed.duration_min != null ? true : null),
        duration_max_inclusive: (seed as any).duration_max_inclusive ?? (seed.duration_max != null ? false : null),
        modality: seed.modality ?? null,
        setting: seed.setting ?? 'other',
        after_hours: seed.after_hours ?? null,
        first_or_review: seed.first_or_review ?? null,
        referral_present: seed.referral_present ?? null,
        specialty: seed.specialty ?? null,
        age: (seed as any).age ?? null,
        keywords: seed.keywords ?? [],
        is_gp: (seed as any).is_gp ?? null,
        is_emergency: (seed as any).is_emergency ?? null,
        is_specialist: (seed as any).is_specialist ?? null
      } as NoteFacts;
      this.logger.log(`[AgenticRag][RagFactsService] final facts: ${JSON.stringify(facts)}`);
      return facts;
    }
  }
}


