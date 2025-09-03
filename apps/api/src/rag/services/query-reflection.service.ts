import { Injectable, Logger } from '@nestjs/common';
import { ChatOpenAI } from '@langchain/openai';
import type { NoteFacts } from '../rag.types';

export interface QueryReflectionResult {
  enhancedQuery: string;
  reflectionInsights: string[];
  completenessScore: number;
  missingInfo: string[];
  keyConstraints: string[];
  shouldProceed: boolean;
}

@Injectable()
export class QueryReflectionService {
  private readonly logger = new Logger(QueryReflectionService.name);

  async reflect(originalNote: string, facts: NoteFacts): Promise<QueryReflectionResult> {
    this.logger.log(`[QueryReflection] Reflecting on note: ${originalNote.substring(0, 100)}...`);
    
    try {
      // 1. 启发式预检查
      const heuristicAnalysis = this.analyzeQueryHeuristically(originalNote, facts);
      
      // 2. LLM深度反思 (仅在需要时)
      let llmEnhancement = null;
      if (heuristicAnalysis.completenessScore < 0.8 || heuristicAnalysis.needsLLM) {
        llmEnhancement = await this.performLLMReflection(originalNote, facts, heuristicAnalysis);
      }

      // 3. 合并结果
      const result = this.mergeReflectionResults(originalNote, facts, heuristicAnalysis, llmEnhancement);
      
      this.logger.log(`[QueryReflection] Complete - Score: ${result.completenessScore}, Enhanced: ${result.enhancedQuery !== originalNote}`);
      return result;

    } catch (error) {
      this.logger.error(`[QueryReflection] Error: ${error}`);
      // Fallback: 返回原始查询，不阻断流程
      return {
        enhancedQuery: originalNote,
        reflectionInsights: ['Reflection failed, using original query'],
        completenessScore: 0.5,
        missingInfo: [],
        keyConstraints: [],
        shouldProceed: true
      };
    }
  }

  private analyzeQueryHeuristically(note: string, facts: NoteFacts): any {
    const text = note.toLowerCase();
    const insights: string[] = [];
    const missingInfo: string[] = [];
    let completenessScore = 0.6; // 基础分
    let needsLLM = false;

    // 检查持续时间信息
    if (facts.duration_min !== null) {
      completenessScore += 0.15;
      insights.push('Duration information extracted');
    } else {
      missingInfo.push('时间持续信息不明确');
      if (!/\b\d+\s*min|minute|hour|时间/i.test(text)) {
        needsLLM = true;
      }
    }

    // 检查年龄信息  
    if (facts.age !== null) {
      completenessScore += 0.1;
      insights.push('Patient age identified');
    } else if (!/age|aged|years?\s*old|岁|年龄/i.test(text)) {
      missingInfo.push('患者年龄未提及');
    }

    // 检查就诊模式
    if (facts.modality && facts.modality !== 'in_person') {
      completenessScore += 0.1;
      insights.push(`Consultation modality: ${facts.modality}`);
    } else if (/telehealth|video|phone|远程|电话|视频/.test(text)) {
      insights.push('Telehealth keywords detected');
    }

    // 检查医学术语标准化需求
    const nonStandardTerms = this.detectNonStandardTerms(text);
    if (nonStandardTerms.length > 0) {
      needsLLM = true;
      insights.push(`Non-standard terms detected: ${nonStandardTerms.join(', ')}`);
    }

    // 检查临床上下文完整性
    const hasSymptoms = /pain|ache|症状|疼痛|不适/.test(text);
    const hasDiagnosis = /diagnosis|diagnosed|诊断|疾病/.test(text);
    const hasProcedure = /procedure|treatment|手术|治疗/.test(text);
    
    if (!hasSymptoms && !hasDiagnosis && !hasProcedure) {
      missingInfo.push('临床背景信息不够具体');
      needsLLM = true;
    }

    return {
      completenessScore: Math.min(1.0, completenessScore),
      missingInfo,
      insights,
      needsLLM,
      nonStandardTerms
    };
  }

  private detectNonStandardTerms(text: string): string[] {
    const commonAbbreviations: { [key: string]: string } = {
      'mi': 'myocardial infarction',
      'copd': 'chronic obstructive pulmonary disease', 
      'dm': 'diabetes mellitus',
      'htn': 'hypertension',
      'af': 'atrial fibrillation',
      'dvt': 'deep vein thrombosis',
      'pe': 'pulmonary embolism'
    };

    const detected: string[] = [];
    for (const [abbrev, full] of Object.entries(commonAbbreviations)) {
      const regex = new RegExp(`\\b${abbrev}\\b`, 'i');
      if (regex.test(text)) {
        detected.push(abbrev);
      }
    }
    return detected;
  }

  private async performLLMReflection(originalNote: string, facts: NoteFacts, heuristic: any): Promise<any> {
    const MODEL = process.env.OPENAI_CHAT_MODEL || 'gpt-4o-mini';
    const llm = new ChatOpenAI({ modelName: MODEL, temperature: 0.1 });

    const prompt = `作为资深医疗编码专家，请评估和优化这个MBS项目检索查询：

原始查询: "${originalNote}"

已提取事实:
- 持续时间: ${facts.duration_min ? `${facts.duration_min}分钟` : '未明确'}
- 患者年龄: ${facts.age ? `${facts.age}岁` : '未知'}
- 就诊方式: ${facts.modality || '面对面'}
- 就诊地点: ${facts.setting || '未指定'}
- 专科类型: ${facts.specialty || '未指定'}

当前问题: ${heuristic.missingInfo.join('、')}

请从以下角度优化查询：
1. 补全关键临床信息
2. 标准化医学术语和缩写
3. 明确时间和年龄约束
4. 识别可能的干扰词或无关信息
5. 生成结构化约束条件

返回JSON格式：
{
  "enhanced_query": "优化后的查询文本",
  "standardized_terms": {"mi": "myocardial infarction"},
  "added_constraints": ["duration:20-40", "age:>=65"],
  "removed_noise": ["今天", "请帮忙"],
  "confidence": 0.85,
  "reasoning": "优化的原因和逻辑"
}`;

    try {
      const response = await llm.invoke([{ role: 'user', content: prompt }]);
      const content = (response as any).content as string;
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return parsed;
      } else {
        throw new Error('No valid JSON found in LLM response');
      }
    } catch (error) {
      this.logger.warn(`[QueryReflection] LLM reflection failed: ${error}`);
      return null;
    }
  }

  private mergeReflectionResults(
    originalNote: string, 
    facts: NoteFacts, 
    heuristic: any, 
    llmResult: any
  ): QueryReflectionResult {
    let enhancedQuery = originalNote;
    const insights = [...heuristic.insights];
    const constraints: string[] = [];

    // 使用LLM结果优化查询
    if (llmResult && llmResult.enhanced_query) {
      enhancedQuery = llmResult.enhanced_query;
      insights.push('Query enhanced by LLM reflection');
      
      if (llmResult.added_constraints) {
        constraints.push(...llmResult.added_constraints);
      }
      
      if (llmResult.reasoning) {
        insights.push(`LLM reasoning: ${llmResult.reasoning}`);
      }
    }

    // 基于facts生成约束条件
    if (facts.duration_min !== null) {
      const durationConstraint = this.generateDurationConstraint(facts);
      if (durationConstraint) constraints.push(durationConstraint);
    }

    if (facts.modality && facts.modality !== 'in_person') {
      constraints.push(`modality:${facts.modality}`);
    }

    if (facts.setting && facts.setting !== 'other') {
      constraints.push(`setting:${facts.setting}`);
    }

    // 计算最终完整性得分
    let finalScore = heuristic.completenessScore;
    if (llmResult && llmResult.confidence) {
      finalScore = (finalScore + llmResult.confidence) / 2;
    }

    return {
      enhancedQuery,
      reflectionInsights: insights,
      completenessScore: finalScore,
      missingInfo: heuristic.missingInfo,
      keyConstraints: constraints,
      shouldProceed: true
    };
  }

  private generateDurationConstraint(facts: NoteFacts): string | null {
    if (facts.duration_min === null) return null;
    
    const min = facts.duration_min;
    const max = facts.duration_max;
    
    if (max !== null && max !== undefined) {
      return `duration:${min}-${max}`;
    } else {
      // 单一时间点，生成范围
      if (min < 6) return 'duration:<6';
      else if (min < 20) return 'duration:6-20';  
      else if (min < 40) return 'duration:20-40';
      else return 'duration:>=40';
    }
  }
}