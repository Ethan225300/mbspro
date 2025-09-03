import { Injectable, Logger } from '@nestjs/common';
import { AgentGraphService } from './services/agent-graph.service';
import { RagInfraService } from './services/rag-infra.service';
import { RagIngestService } from './services/ingest.service';
import { RagQueryService } from './services/query.service';
import type { AgenticRagResult } from './rag.types';

export interface RagQueryRequest { query: string; top?: number }

@Injectable()
export class RagService {
  readonly logger = new Logger(RagService.name);
  constructor(
    private readonly infra: RagInfraService,
    private readonly ingestSvc: RagIngestService,
    private readonly querySvc: RagQueryService,
    private readonly agentGraph: AgentGraphService,
  ) {}

  async initIfNeeded() { return this.infra.initIfNeeded(); }
  getStatus() { return this.infra.getStatus(); }
  ingestFromJsonFile(filename: string) { return this.ingestSvc.ingestFromJsonFile(filename); }
  queryRag(query: string, top = 5) { return this.querySvc.queryRag(query, top); }
  agenticQueryRag(note: string, top = 5): Promise<AgenticRagResult> { return this.agentGraph.agenticQueryRag(note, top); }

  async clearVectorDatabase() { return this.infra.clearVectorDatabase(); }

  async refreshVectorDatabase(filename: string = 'MBS-XML-20250701-Version-3.durations.json') { return this.ingestSvc.refreshVectorDatabase(filename); }
}


