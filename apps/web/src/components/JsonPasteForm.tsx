'use client';

import { useState } from 'react';

interface JsonPasteFormProps {
  /** Heading text rendered above the textarea. */
  readonly label: string;
  /** Placeholder shown when the textarea is empty. Defaults to a minimal example. */
  readonly placeholder?: string;
  /** Optional pretty-printed example to seed the textarea on mount. The user can
   *  overwrite it; provided as a starting point for "what shape does this take?" */
  readonly exampleJson?: object;
  /** Submission handler. Called with the parsed object (typed unknown — the
   *  component does not validate the shape beyond "valid JSON object").
   *  Should resolve to `{ id, inserted }` matching the registry POST contract. */
  readonly onSubmit: (parsed: unknown) => Promise<{ id: string; inserted: boolean }>;
}

interface ValidationState {
  readonly kind: 'idle' | 'valid' | 'parse-error';
  /** When 'valid', the parsed value. When 'parse-error', the error message. */
  readonly message: string;
}

/** A reusable JSON-paste form for the registry admin pages. Validates on blur
 *  and on submit, not per-keystroke (avoids noisy red as the user types).
 *  "Format JSON" pretty-prints the textarea via JSON.parse + JSON.stringify(_, null, 2).
 *  Submit is disabled until the textarea parses to a non-array JSON object. */
export function JsonPasteForm({
  label,
  placeholder,
  exampleJson,
  onSubmit,
}: JsonPasteFormProps): JSX.Element {
  const initial = exampleJson === undefined ? '' : JSON.stringify(exampleJson, null, 2);
  const [text, setText] = useState<string>(initial);
  const [validation, setValidation] = useState<ValidationState>({ kind: 'idle', message: '' });
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [result, setResult] = useState<{ id: string; inserted: boolean } | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  function tryParse(): { ok: true; value: object } | { ok: false; message: string } {
    if (text.trim().length === 0) {
      return { ok: false, message: 'Paste JSON to continue' };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      const err = e as Error;
      return { ok: false, message: err.message };
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, message: 'Expected a JSON object (got null, array, or primitive)' };
    }
    return { ok: true, value: parsed };
  }

  function handleBlur(): void {
    const r = tryParse();
    setValidation(r.ok
      ? { kind: 'valid', message: 'Valid JSON object' }
      : { kind: 'parse-error', message: r.message });
  }

  function handleFormat(): void {
    const r = tryParse();
    if (!r.ok) {
      setValidation({ kind: 'parse-error', message: r.message });
      return;
    }
    setText(JSON.stringify(r.value, null, 2));
    setValidation({ kind: 'valid', message: 'Valid JSON object (formatted)' });
  }

  async function handleSubmit(): Promise<void> {
    const r = tryParse();
    if (!r.ok) {
      setValidation({ kind: 'parse-error', message: r.message });
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    setResult(null);
    try {
      const response = await onSubmit(r.value);
      setResult(response);
    } catch (e) {
      const err = e as Error;
      setSubmitError(err.message ?? 'Submit failed');
    } finally {
      setSubmitting(false);
    }
  }

  const parseOk = validation.kind !== 'parse-error' && text.trim().length > 0;

  return (
    <div className="card mb-6">
      <h3 className="text-sm font-semibold text-text-primary mb-3">{label}</h3>

      <textarea
        className="input-field w-full font-mono text-xs"
        rows={14}
        spellCheck={false}
        placeholder={placeholder ?? 'Paste JSON here...'}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          // Reset validation status on edit so the user isn't staring at a
          // stale error from a previous attempt.
          if (validation.kind !== 'idle') setValidation({ kind: 'idle', message: '' });
          if (result !== null) setResult(null);
          if (submitError !== null) setSubmitError(null);
        }}
        onBlur={handleBlur}
      />

      <div className="flex items-center gap-2 mt-3">
        <button
          type="button"
          onClick={handleFormat}
          className="btn-secondary text-xs"
          disabled={text.trim().length === 0}
        >
          Format JSON
        </button>
        <button
          type="button"
          onClick={handleSubmit}
          className="btn-primary text-xs"
          disabled={!parseOk || submitting}
        >
          {submitting ? 'Submitting...' : 'Submit'}
        </button>
      </div>

      {/* Validation status */}
      {validation.kind === 'parse-error' && (
        <div className="mt-3 text-xs text-risk-high">
          <span className="font-semibold">Parse error: </span>
          <span className="font-mono">{validation.message}</span>
        </div>
      )}
      {validation.kind === 'valid' && submitError === null && result === null && (
        <div className="mt-3 text-xs text-text-muted">{validation.message}</div>
      )}

      {/* Submit error */}
      {submitError !== null && (
        <div className="mt-3 text-xs text-risk-high">
          <span className="font-semibold">Submit failed: </span>
          <span className="font-mono">{submitError}</span>
        </div>
      )}

      {/* Success */}
      {result !== null && (
        <div className="mt-3 text-xs text-accent">
          <div>
            <span className="font-semibold">{result.inserted ? 'Inserted' : 'Already existed'}:</span>{' '}
            <span className="font-mono break-all">{result.id}</span>
          </div>
        </div>
      )}
    </div>
  );
}
