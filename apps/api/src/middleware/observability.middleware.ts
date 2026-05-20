// Observability middleware (post-6.8 telemetry layer).
//
// Wraps every API request with a side-channel observer. Records latency, status, id
// format (when :id is present), and optional cache metadata populated by handlers via
// res.locals.observability.
//
// Discipline:
//   - Pure side-channel. Does NOT mutate the response body, headers, or status code.
//   - Does NOT make routing decisions. id format is recorded for telemetry only.
//   - Does NOT introduce a parallel id classifier. Reuses dispatchByIdFormat (the
//     single source of truth) wrapped in try/catch to tolerate malformed inputs.
//   - Sink failures are swallowed (in `emit`); a flaky observer cannot break requests.
//   - Does NOT depend on render, stores, or producers. Imports util/observability and
//     util/dispatch-by-id-format only.

import type { Request, Response, NextFunction } from 'express';
import {
  emit,
  type IdFormatLabel,
  type RequestCompletedEvent,
} from '../util/observability.js';
import { dispatchByIdFormat } from '../util/dispatch-by-id-format.js';

// res.locals shape that handlers may optionally populate. The middleware reads but
// never writes to res.locals; handlers OWN the population.
export interface ObservabilityLocals {
  readonly cacheHit?: boolean;
  readonly renderVersion?: string;
}

function classifyIdParamForTelemetry(req: Request): IdFormatLabel | undefined {
  const id = req.params?.id;
  if (typeof id !== 'string' || id.length === 0) return undefined;
  try {
    return dispatchByIdFormat(id);
  } catch {
    return 'malformed';
  }
}

function readObservabilityLocals(res: Response): ObservabilityLocals {
  const locals = (res.locals as { observability?: ObservabilityLocals }).observability;
  if (locals === undefined || locals === null) return {};
  return locals;
}

export function observabilityMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Capture start time as monotonic millis. process.hrtime.bigint() is monotonic; wall-
  // clock Date.now() can step backward on NTP corrections. Latency math must be monotonic.
  const startNs = process.hrtime.bigint();

  res.on('finish', () => {
    const endNs = process.hrtime.bigint();
    const latencyMs = Number(endNs - startNs) / 1_000_000;

    const idFormat = classifyIdParamForTelemetry(req);
    const locals = readObservabilityLocals(res);

    const event: RequestCompletedEvent = {
      type: 'request_completed',
      method: req.method,
      path: req.path,
      status: res.statusCode,
      latencyMs,
      ...(idFormat !== undefined ? { idFormat } : {}),
      ...(locals.cacheHit !== undefined ? { cacheHit: locals.cacheHit } : {}),
      ...(locals.renderVersion !== undefined ? { renderVersion: locals.renderVersion } : {}),
    };

    emit(event);
  });

  next();
}
