import { EventEmitter } from 'events';
import { v4 as uuid } from 'uuid';
import { BatchJob, BatchJobResult, AssetType } from '@cre/shared';
import {
  ingestAutoClassified,
  postIngestionIntelligenceUpdate,
} from './uw-intelligence.service.js';

// ---------------------------------------------------------------------------
// In-memory batch job store
// ---------------------------------------------------------------------------

const batchJobs = new Map<string, BatchJob>();

// ---------------------------------------------------------------------------
// Batch Queue — processes files sequentially with progress tracking
// ---------------------------------------------------------------------------

class BatchQueue extends EventEmitter {
  private processing = false;
  private queue: { jobId: string; files: { buffer: Buffer; name: string }[] }[] = [];
  private PERSIST_INTERVAL = 10; // persist UWs every N files

  enqueue(files: { buffer: Buffer; name: string }[]): string {
    const jobId = uuid();
    const now = new Date().toISOString();

    batchJobs.set(jobId, {
      id: jobId,
      status: 'queued',
      totalFiles: files.length,
      processed: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
      results: [],
      createdAt: now,
      completedAt: null,
      error: null,
    });

    this.queue.push({ jobId, files });
    this.processNext();
    return jobId;
  }

  private async processNext(): Promise<void> {
    if (this.processing || this.queue.length === 0) return;
    this.processing = true;

    const { jobId, files } = this.queue.shift()!;
    const job = batchJobs.get(jobId)!;
    job.status = 'processing';

    const affectedAssetTypes = new Set<AssetType>();

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      let result: BatchJobResult;

      try {
        const record = await this.processFileWithRetry(file.buffer, file.name);

        if ((record as any)._skipped) {
          result = {
            fileName: file.name,
            status: 'skipped',
            id: record.id,
            dealName: record.dealName,
            assetType: record.assetType,
            loanType: record.loanType,
            skipReason: (record as any)._skipReason || 'Duplicate detected',
          };
          job.skipped++;
        } else {
          result = {
            fileName: file.name,
            status: 'success',
            id: record.id,
            dealName: record.dealName,
            assetType: record.assetType,
            loanType: record.loanType,
          };
          job.succeeded++;
          affectedAssetTypes.add(record.assetType);
        }
      } catch (err: any) {
        result = {
          fileName: file.name,
          status: 'error',
          error: err.message || 'Processing failed',
        };
        job.failed++;
      } finally {
        // Release buffer for GC
        (file as any).buffer = null;
        if (typeof (globalThis as any).gc === 'function') (globalThis as any).gc();
      }

      job.results.push(result);
      job.processed++;
      this.emit('progress', { jobId, processed: job.processed, total: job.totalFiles });
    }

    job.status = 'completed';
    job.completedAt = new Date().toISOString();

    // Trigger post-ingestion intelligence update for affected asset types
    if (affectedAssetTypes.size > 0 && job.succeeded > 0) {
      try {
        const result = postIngestionIntelligenceUpdate([...affectedAssetTypes] as AssetType[]);
        console.log(`[Batch Queue] Post-ingestion update: updated rules for [${result.updated.join(', ')}], skipped [${result.skipped.join(', ')}]`);
      } catch (err: any) {
        console.error('[Batch Queue] Post-ingestion intelligence update failed:', err.message);
      }
    }

    this.emit('completed', { jobId, job, affectedAssetTypes: [...affectedAssetTypes] });

    this.processing = false;
    this.processNext();
  }

  private async processFileWithRetry(buffer: Buffer, name: string, maxRetries = 3): Promise<any> {
    let lastError: Error | null = null;
    const delays = [5000, 15000, 45000]; // exponential backoff

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await ingestAutoClassified(buffer, name);
      } catch (err: any) {
        lastError = err;
        // Only retry on rate limit or transient errors
        const isRetryable = err.status === 429 || err.status === 529 || err.status >= 500;
        if (!isRetryable || attempt === maxRetries - 1) throw err;
        await new Promise(resolve => setTimeout(resolve, delays[attempt]));
      }
    }
    throw lastError;
  }
}

export const batchQueue = new BatchQueue();

// ---------------------------------------------------------------------------
// Job state accessors
// ---------------------------------------------------------------------------

export function getBatchJob(jobId: string): BatchJob | null {
  return batchJobs.get(jobId) || null;
}

export function listBatchJobs(): BatchJob[] {
  return Array.from(batchJobs.values()).sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
}
