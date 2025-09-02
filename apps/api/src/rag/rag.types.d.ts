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
  | "case_conference" | "usual_gp" | "home_only" | "referral_gp" | "referral_specialist";

export interface VerifyReport {
  item_code: string;
  passes: boolean;
  checks: { name: VerifyCheckName; pass: boolean; details?: string }[];
  rationale_markdown: string;
}

export interface VerifiedItem {
  code: string;
  display: string;
  fee?: number | null;
  score: number | null;
  verify: VerifyReport;
}

export interface AgenticRagResult {
  note_facts: NoteFacts;
  items: VerifiedItem[];
  conflicts_resolved: string[];
  iterations: number;
}

