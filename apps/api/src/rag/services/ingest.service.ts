import { Injectable, Logger } from '@nestjs/common';
import { CharacterTextSplitter } from 'langchain/text_splitter';
import { RagInfraService } from './rag-infra.service';

// Fallback lightweight Document type to avoid optional dependency in tests
type Document = { pageContent: string; metadata?: any };

@Injectable()
export class RagIngestService {
  private readonly logger = new Logger(RagIngestService.name);
  constructor(private readonly infra: RagInfraService) {}

  async ingestFromJsonFile(filename: string): Promise<{ chunks: number }> {
    await this.infra.initIfNeeded();
    const fs = await import('fs');
    const path = await import('path');

    const DATA_FILE = path.resolve(process.cwd(), 'data', filename);
    if (!fs.existsSync(DATA_FILE)) {
      throw new Error(`Data file not found: ${DATA_FILE}`);
    }

    this.logger.log(`Starting ingestion from: ${DATA_FILE}`);
    const raw = fs.readFileSync(DATA_FILE, 'utf-8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) throw new Error('JSON file must contain an array');

    this.logger.log(`Processing ${data.length} items...`);

    const docs: Document[] = data.map((item: any, idx: number) => {
      let content = '';
      if (item.ItemNum) {
        content = `MBS Item ${item.ItemNum}\n`;
        content += `Description: ${item.Description || ''}\n`;
        content += `Category: ${item.Category || ''}\n`;
        content += `Group: ${item.Group || ''}\n`;
        content += `Schedule Fee: ${item.ScheduleFee || 'Not specified'}\n`;
        if (item.ItemStartDate) content += `Start Date: ${item.ItemStartDate}\n`;
        if (item.ItemEndDate) content += `End Date: ${item.ItemEndDate}\n`;
      } else {
        content = item.text || JSON.stringify(item);
      }
      const metadata = { ...item, _id: item.ItemNum || item.id || String(idx), _type: 'mbs_item' };
      return { pageContent: content, metadata } as Document;
    });

    this.logger.log(`Created ${docs.length} documents, starting embedding...`);
    const splitter = new CharacterTextSplitter({ chunkSize: 2000, chunkOverlap: 100, separator: '\n' });
    const chunks = await splitter.splitDocuments(docs as any);
    this.logger.log(`Split into ${chunks.length} chunks, uploading to Pinecone...`);

    const batchSize = 100;
    let totalProcessed = 0;
    const pineconeIndex = this.infra.getPineconeIndex();
    const embeddings = this.infra.getEmbeddings();
    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize);
      const { PineconeStore } = await import('@langchain/pinecone');
      await PineconeStore.fromDocuments(batch, embeddings!, { pineconeIndex, namespace: 'default' });
      totalProcessed += batch.length;
      this.logger.log(`Processed ${totalProcessed}/${chunks.length} chunks`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    this.logger.log(`Ingestion complete: ${chunks.length} chunks stored in Pinecone`);
    return { chunks: chunks.length };
  }
}


