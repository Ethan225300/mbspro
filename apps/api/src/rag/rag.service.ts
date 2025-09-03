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

  async clearVectorDatabase() {
    await this.infra.initIfNeeded();
    const pineconeIndex = this.infra.getPineconeIndex();
    if (!pineconeIndex) {
      throw new Error('Pinecone not configured');
    }
    
    this.logger.log('Clearing all vectors from Pinecone database...');
    await pineconeIndex.namespace('default').deleteAll();
    this.logger.log('Successfully cleared all vectors from the database');
    
    return { message: 'Database cleared successfully' };
  }

  async refreshVectorDatabase(filename: string = 'MBS-XML-20250701-Version-3.durations.json') {
    await this.infra.initIfNeeded();
    const pineconeIndex = this.infra.getPineconeIndex();
    if (!pineconeIndex) {
      throw new Error('Pinecone not configured');
    }

    this.logger.log('Step 1: Clearing all vectors from the database...');
    await pineconeIndex.namespace('default').deleteAll();
    this.logger.log('✅ Successfully cleared all vectors from the database');

    this.logger.log(`Step 2: Loading new MBS data from ${filename}...`);
    const result = await this.ingestSvc.ingestFromJsonFile(filename);
    
    this.logger.log(`✅ Successfully uploaded ${result.chunks} chunks to Pinecone`);
    this.logger.log('✅ Database refresh complete!');
    
    return { 
      message: 'Database refresh complete',
      chunks: result.chunks 
    };
  }
}


