// Observability sink (post-6.8 telemetry layer).
//
// Side-channel only. Records request lifecycle events for visibility / metrics / tracing.
// MUST NOT affect control flow. MUST NOT mutate the response. Sink errors are swallowed
// so a failing observer cannot break a request.
//
// Single event type for v1: `request_completed`. Extension to other event types
// (e.g., upstream-call timing, error classification) belongs in a future batch and
// must preserve the side-channel discipline.
//
// Sink implementations:
//   - `consoleSink` (default): one-line JSON to stderr. Production-replaceable.
//   - In-memory ring buffer: tests inject this via `setSink` to capture events.
//
// What this module is NOT:
//   - A control-flow mechanism. Observability never decides anything; it records.
//   - A second identity classifier. ID format is read by calling the existing
//     `dispatchByIdFormat` (single source of truth) with try/catch.
//   - A dependency edge from render into stores/routes. Render imports nothing here.

export type IdFormatLabel = 'legacy' | 'graph' | 'malformed';

export interface RequestCompletedEvent {
  readonly type: 'request_completed';
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly latencyMs: number;
  readonly idFormat?: IdFormatLabel;
  readonly cacheHit?: boolean;
  readonly renderVersion?: string;
}

export type ObservabilityEvent = RequestCompletedEvent;

export interface ObservabilitySink {
  record(event: ObservabilityEvent): void;
}

// Default: one-line JSON to stderr. Production deployments replace this with a sink
// that forwards to a metrics / tracing system.
export const consoleSink: ObservabilitySink = {
  record(event: ObservabilityEvent): void {
    try {
      process.stderr.write(JSON.stringify(event) + '\n');
    } catch {
      // Sink errors are swallowed by design - observability never breaks requests.
    }
  },
};

let activeSink: ObservabilitySink = consoleSink;

export function getSink(): ObservabilitySink {
  return activeSink;
}

// Test-only: swap the active sink. Production code never calls this. Returns the
// previous sink so callers can restore it (in tests, after each scenario).
export function setSink(sink: ObservabilitySink): ObservabilitySink {
  const prev = activeSink;
  activeSink = sink;
  return prev;
}

// Top-level emit helper. Catches sink errors so they cannot propagate into the
// caller's control flow. Production-grade observability layers do this universally;
// the alternative (allowing sink throws to surface) means a flaky telemetry backend
// can take down the application.
export function emit(event: ObservabilityEvent): void {
  try {
    activeSink.record(event);
  } catch {
    // Swallow - observability is side-channel.
  }
}
