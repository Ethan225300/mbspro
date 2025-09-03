import { Injectable, Logger } from '@nestjs/common';
import { RagInfraService } from './rag-infra.service';

// Fallback lightweight Document type to avoid optional dependency in tests
type Document = { pageContent: string; metadata: any };

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

    // Create one document per MBS item (item-level chunking)
    const docs: Document[] = data.map((item: any, idx: number) => {
      let content = '';
      if (item.item_num) {
        // New format with item_num
        content = `MBS Item ${item.item_num}\n`;
        content += `Description: ${item.description || ''}\n`;
        content += `Category: ${item.category || ''}\n`;
        content += `Group: ${item.group || ''}\n`;
        if (item.subgroup) content += `Subgroup: ${item.subgroup}\n`;
        if (item.subheading) content += `Subheading: ${item.subheading}\n`;
        content += `Schedule Fee: ${item.schedule_fee || 'Not specified'}\n`;
        if (item.derived_fee) content += `Derived Fee: ${item.derived_fee}\n`;
        if (item.start_date) content += `Start Date: ${item.start_date}\n`;
        if (item.end_date) content += `End Date: ${item.end_date}\n`;
        if (item.duration_min_minutes !== null) {
          content += `Duration: ${item.duration_min_minutes}`;
          if (item.duration_max_minutes !== null) {
            content += `-${item.duration_max_minutes}`;
          }
          content += ` minutes`;
          if (item.duration_min_inclusive !== null) {
            content += ` (min ${item.duration_min_inclusive ? 'inclusive' : 'exclusive'}`;
            if (item.duration_max_inclusive !== null) {
              content += `, max ${item.duration_max_inclusive ? 'inclusive' : 'exclusive'}`;
            }
            content += `)`;
          }
          content += `\n`;
        }
      } else if (item.ItemNum) {
        // Old format with ItemNum
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
      
      const metadata = { 
        ...item, 
        _id: item.item_num || item.ItemNum || item.id || String(idx), 
        _type: 'mbs_item',
        // Normalize field names for consistency
        code: item.item_num || item.ItemNum,
        description: item.description || item.Description,
        fee: item.schedule_fee || item.ScheduleFee,
        group: item.group || item.Group,
        subgroup: item.subgroup || item.Subgroup,
        subheading: item.subheading,
        derived_fee: item.derived_fee,
        duration_min_minutes: item.duration_min_minutes,
        duration_max_minutes: item.duration_max_minutes,
        duration_min_inclusive: item.duration_min_inclusive,
        duration_max_inclusive: item.duration_max_inclusive,
        start_date: item.start_date,
        end_date: item.end_date
      };
      
      return { pageContent: content, metadata } as Document;
    });

    this.logger.log(`Created ${docs.length} item-level documents, uploading to Pinecone...`);

    const batchSize = 100;
    let totalProcessed = 0;
    const pineconeIndex = this.infra.getPineconeIndex();
    const embeddings = this.infra.getEmbeddings();
    
    for (let i = 0; i < docs.length; i += batchSize) {
      const batch = docs.slice(i, i + batchSize);
      const { PineconeStore } = await import('@langchain/pinecone');
      await PineconeStore.fromDocuments(batch, embeddings!, { pineconeIndex, namespace: 'default' });
      totalProcessed += batch.length;
      this.logger.log(`Processed ${totalProcessed}/${docs.length} items`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    this.logger.log(`Ingestion complete: ${docs.length} items stored in Pinecone`);
    return { chunks: docs.length };
  }
}


