import { Body, Controller, Get, HttpCode, HttpStatus, Post, Logger, BadRequestException } from '@nestjs/common';
import { RagService } from './rag.service';

@Controller('rag')
export class RagController {
  private readonly logger = new Logger(RagController.name);
  constructor(private readonly rag: RagService) {}

  @Get('health')
  health() {
    return { status: 'healthy', timestamp: new Date().toISOString() };
  }

  @Post('ingest')
  @HttpCode(HttpStatus.OK)
  async ingest(@Body() body: { filename: string; token?: string }) {
    const token = (body && (body as any).token) || undefined;
    if (process.env.INGEST_SECRET && token !== process.env.INGEST_SECRET) {
      return { ok: false, error: 'Forbidden' };
    }
    if (!body || !body.filename) return { ok: false, error: 'Missing filename' };
    const result = await this.rag.ingestFromJsonFile(body.filename);
    return { ok: true, ...result };
  }

  @Post('query')
  @HttpCode(HttpStatus.OK)
  async query(@Body() body: { query: string; top?: number }) {
    if (!body || !body.query) return { ok: false, error: 'Missing query' };
    const result = await this.rag.queryRag(String(body.query), Number(body.top) || 5);
    return result;
  }

  @Post('agentic')
  @HttpCode(HttpStatus.OK)
  async agentic(@Body() body: { note: string; top?: number }) {
    this.logger.log(`[AgenticRag] HTTP in: note_len=${(body?.note ?? '').length}, top=${body?.top}`);
    const note = body?.note ?? '';
    if (typeof note !== 'string' || !note.trim()) {
      throw new BadRequestException('note is required and must be a non-empty string');
    }
    const top = Number(body?.top ?? 5);
    const result = await this.rag.agenticQueryRag(note, top);
    return result;
  }

  @Get('status')
  @HttpCode(HttpStatus.OK)
  status() {
    return this.rag.getStatus();
  }
}


