import { Module } from '@nestjs/common';
import { RagService } from './rag.service';
import { RagController } from './rag.controller';
import { RagInfraService } from './services/rag-infra.service';
import { RagIngestService } from './services/ingest.service';
import { RagQueryService } from './services/query.service';
import { RagFactsService } from './services/facts.service';
import { RagVerifyService } from './services/verify.service';
import { AgentGraphService } from './services/agent-graph.service';
import { QueryReflectionService } from './services/query-reflection.service';
import { RagRuleParserService } from './services/rule-parser.service';
import { RetrievalReflectionService } from './services/retrieval-reflection.service';

@Module({
  controllers: [RagController],
  providers: [
    RagService,
    RagInfraService,
    RagIngestService,
    RagQueryService,
    RagFactsService,
    RagVerifyService,
    AgentGraphService,
    QueryReflectionService,
    RagRuleParserService,
    RetrievalReflectionService,
  ],
  exports: [RagService],
})
export class RagModule {}


