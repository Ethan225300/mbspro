import { Injectable, Logger } from '@nestjs/common';
import { Pinecone } from '@pinecone-database/pinecone';
import { PineconeStore } from '@langchain/pinecone';
import { MistralAIEmbeddings } from '@langchain/mistralai';
import { OpenAIEmbeddings } from '@langchain/openai';
import { CohereClient } from 'cohere-ai';

@Injectable()
export class RagInfraService {
  readonly logger = new Logger(RagInfraService.name);

  private pinecone?: Pinecone;
  private pineconeIndex: any;
  private vectorStore?: PineconeStore;
  private embeddings?: MistralAIEmbeddings | OpenAIEmbeddings;
  private cohere?: CohereClient | null;

  async initIfNeeded(): Promise<void> {
    if (this.vectorStore) return;

    const indexName = process.env.PINECONE_INDEX || 'mbspro-mistral-embed';
    const embedProvider = process.env.EMBED_PROVIDER || 'mistral';
    const embedModel = embedProvider === 'mistral'
      ? process.env.MISTRAL_EMBED_MODEL || 'mistral-embed'
      : process.env.OPENAI_EMBED_MODEL || 'text-embedding-3-small';

    if (!process.env.PINECONE_API_KEY) {
      this.logger.warn('RAG init: Missing PINECONE_API_KEY, vector search disabled (fallback mode).');
      this.vectorStore = undefined as any;
      this.cohere = process.env.COHERE_API_KEY ? new CohereClient({ token: process.env.COHERE_API_KEY }) : null;
      return;
    }

    if (embedProvider === 'mistral') {
      if (!process.env.MISTRAL_API_KEY) throw new Error('Missing MISTRAL_API_KEY');
      this.embeddings = new MistralAIEmbeddings({ apiKey: process.env.MISTRAL_API_KEY, model: embedModel });
    } else {
      if (!process.env.OPENAI_API_KEY) throw new Error('Missing OPENAI_API_KEY');
      this.embeddings = new OpenAIEmbeddings({ model: embedModel });
    }

    this.pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
    this.pineconeIndex = this.pinecone.Index(indexName);
    this.vectorStore = new PineconeStore(this.embeddings!, {
      pineconeIndex: this.pineconeIndex,
      namespace: 'default',
    });

    this.cohere = process.env.COHERE_API_KEY ? new CohereClient({ token: process.env.COHERE_API_KEY }) : null;
    this.logger.log(`[AgenticRag][RagInfraService] RAG init: pinecone index=${indexName}, embedProvider=${embedProvider}, embedModel=${embedModel}, cohere=${this.cohere ? 'on' : 'off'}`);
  }

  getStatus() {
    const indexName = process.env.PINECONE_INDEX || 'mbspro-mistral-embed';
    const cohereModel = process.env.COHERE_RERANK_MODEL || 'rerank-english-v3.0';
    const rerankCandidates = parseInt(process.env.RERANK_CANDIDATES || '60') || 60;
    return {
      pineconeConfigured: !!process.env.PINECONE_API_KEY,
      cohereConfigured: !!process.env.COHERE_API_KEY,
      indexName,
      cohereModel,
      rerankCandidates,
    };
  }

  getVectorStore() { return this.vectorStore; }
  getCohere() { return this.cohere; }
  getPineconeIndex() { return this.pineconeIndex; }
  getEmbeddings() { return this.embeddings; }

  // Maintenance operations for the vector database
  async clearVectorDatabase() {
    await this.initIfNeeded();
    const pineconeIndex = this.getPineconeIndex();
    if (!pineconeIndex) {
      throw new Error('Pinecone not configured');
    }
    this.logger.log('Clearing all vectors from Pinecone database...');
    await pineconeIndex.namespace('default').deleteAll();
    this.logger.log('Successfully cleared all vectors from the database');
    return { message: 'Database cleared successfully' };
  }
}


