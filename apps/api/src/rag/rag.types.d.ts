export interface RagQueryDto {
  query: string;
  top?: number;
}


// === 新增：Agentic RAG 所需最小类型 ===
export type NoteFacts = {
  duration_min: number | null;
  duration_max: number | null;
  duration_min_inclusive: boolean | null;
  duration_max_inclusive: boolean | null;

  modality: "in_person" | "video" | "phone" | null;
  after_hours: boolean | null;
  setting: "consulting_rooms" | "hospital" | "residential_care" | "home" | "other" | null;
  first_or_review: "first" | "review" | null;
  referral_present: boolean | null;
  specialty: string | null;
  age: number | null;
  keywords: string[];

  // 新增三个识别点
  is_gp: boolean | null;        // 是否由 GP 出诊
  is_emergency: boolean | null; // 是否急诊（ED / Emergency Dept context）
  is_specialist: boolean | null; // 是否专科医生出诊
};

export type Interval = { min: number | null; max: number | null; left_closed: boolean; right_closed: boolean };

export type Condition = {
  type: "relation_required";
  description: string; // 直接保存人类可读的描述
};

export type ItemFlags = {
  case_conference?: boolean;
  case_conference_min?: number;
  usual_gp_required?: boolean;
  home_only?: boolean;
  referral_gp?: boolean;
  referral_specialist?: boolean;
};

export type ItemRule = {
  code: string;
  group?: string; // Official MBS Group field
  subgroup?: string; // Official MBS Subgroup field
  time_window?: Interval | null;
  age_range?: { min: number | null; max: number | null; left_closed?: boolean; right_closed?: boolean } | null;
  setting_allowed?: Array<"consulting_rooms" | "hospital" | "residential_care"> | null;
  modality_allowed?: Array<"in_person" | "video" | "phone"> | null;
  specialty_required?: string | null;
  referral_required?: boolean | null;
  first_or_review?: "first" | "review" | "either" | null;
  conditions?: Condition[];
  flags?: ItemFlags;
  evidence_spans?: string[];
  confidence: number; // 0~1
};

export type VerifyCheckName =
  | "time_window" | "age" | "modality" | "setting" | "first_or_review" | "referral" | "specialty" | "conditions"
  | "case_conference" | "usual_gp" | "home_only" | "referral_gp" | "referral_specialist" | "keyword_refine"
  | "is_gp" | "is_emergency" | "is_specialist";

export type ItemCategory =
  Array<'GP' | 'Imaging' | 'Specialist' | 'Surgery' | 'Pathology' | 'Emergency' | 'Telehealth' | 'AfterHours' | 'Other'>;

export interface VerifyReport {
  item_code: string;
  passes: boolean;
  checks: { name: VerifyCheckName; pass: boolean; details?: string }[];
  rationale_markdown: string;
  categories: ItemCategory;
}

export interface VerifiedItem {
  code: string;
  display: string;
  fee?: number | null;
  score: number | null;
  verify: VerifyReport;
  group?: string | null;
}

export interface AgenticRagResult {
  note_facts: NoteFacts;
  items: VerifiedItem[];
  conflicts_resolved: string[];
  iterations: number;
}

