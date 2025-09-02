import { Module } from '@nestjs/common';
import { RagService } from './rag.service';
import { RagController } from './rag.controller';
import { RagInfraService } from './services/rag-infra.service';
import { RagIngestService } from './services/ingest.service';
import { RagQueryService } from './services/query.service';
import { RagFactsService } from './services/facts.service';
import { RagVerifyService } from './services/verify.service';
import { AgentGraphService } from './services/agent-graph.service';

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
  ],
  exports: [RagService],
})
export class RagModule {}


