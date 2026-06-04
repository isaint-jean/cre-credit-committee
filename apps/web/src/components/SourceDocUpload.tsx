'use client';

/**
 * Upload Supporting Documents — the three-bucket bulk-intake UI.
 *
 * Drop files → matcher classifies each into:
 *
 *   1. AUTO-ATTACHED   — single exact name match → row shows uploaded filename
 *                        AND the matched library record's full fileName side
 *                        by side (spot-check safety addition). Undo moves to
 *                        NEEDS-PICK.
 *   2. NEEDS YOUR PICK — ambiguous; user picks a candidate (top 5 ranked) or
 *                        opens "Search all deals" overlay.
 *   3. UNMATCHED       — no candidate; will be bulk-staged on commit, OR the
 *                        user can manually pick a deal which moves the row
 *                        into the resolved set.
 *
 * **Critical safety property**: NO server state changes until "Process All"
 * is clicked. Auto-attached rows are PLANNED, not executed. The component's
 * state machine enforces this; commit calls api.uploadSourceDoc()/
 * uploadSourceDocStaging() only in the COMMITTING phase.
 *
 * Slot dropdown is shown on EVERY row (not just ambiguous ones) — the
 * inferred slot is transparent + overridable.
 */

import { useState, useMemo, useRef } from 'react';
import { api } from '@/lib/api-client';
import {
  SOURCE_DOC_SLOTS,
  SLOT_LABELS,
  inferSlotFromFilename,
  matchFileToDeal,
  type SourceDocSlot,
  type MatchResult,
  type UWRecordLike,
} from '@/lib/source-doc-matching';

interface SourceDocUploadProps {
  isOpen: boolean;
  onClose: () => void;
  /** UW library records (already loaded by parent — page reuses listHistoricalUWs). */
  underwritings: ReadonlyArray<UWRecordLike>;
  /** Called after a successful commit so parent can refresh completeness/library. */
  onCommitted: () => void;
}

type Phase = 'FILE_SELECTION' | 'REVIEW' | 'COMMITTING' | 'COMPLETE';

interface ReviewRow {
  id: string;
  file: File;
  inferredSlot: SourceDocSlot | null;
  chosenSlot: SourceDocSlot | null;
  match: MatchResult;
  bucket: 'auto_attach' | 'needs_pick' | 'unmatched';
  /** For needs_pick: the chosen uwRecord.id; for auto_attach: pre-populated. */
  pickedUwId: string | null;
  commitStatus?: 'pending' | 'success' | 'error';
  commitError?: string;
}

function makeRowId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function buildRow(file: File, underwritings: ReadonlyArray<UWRecordLike>): ReviewRow {
  const inferredSlot = inferSlotFromFilename(file.name);
  const match = matchFileToDeal(file.name, underwritings);
  return {
    id: makeRowId(),
    file,
    inferredSlot,
    chosenSlot: inferredSlot,
    match,
    bucket: match.bucket,
    pickedUwId:
      match.bucket === 'auto_attach' && match.pickedUwRecord ? match.pickedUwRecord.id : null,
  };
}

function bucketRows(rows: ReviewRow[]): {
  auto: ReviewRow[];
  pick: ReviewRow[];
  unmatched: ReviewRow[];
} {
  return {
    auto: rows.filter((r) => r.bucket === 'auto_attach'),
    pick: rows.filter((r) => r.bucket === 'needs_pick'),
    unmatched: rows.filter((r) => r.bucket === 'unmatched'),
  };
}

// ---------------------------------------------------------------------------
// All-deals search overlay
// ---------------------------------------------------------------------------

function AllDealsSearch({
  underwritings,
  onPick,
  onClose,
}: {
  underwritings: ReadonlyArray<UWRecordLike>;
  onPick: (uwId: string) => void;
  onClose: () => void;
}): JSX.Element {
  const [q, setQ] = useState('');
  const filtered = useMemo(() => {
    const needle = q.toLowerCase().trim();
    if (!needle) return underwritings.slice(0, 25);
    return underwritings
      .filter(
        (u) =>
          u.dealName.toLowerCase().includes(needle) ||
          u.fileName.toLowerCase().includes(needle) ||
          (u.city ?? '').toLowerCase().includes(needle) ||
          (u.state ?? '').toLowerCase().includes(needle),
      )
      .slice(0, 25);
  }, [q, underwritings]);

  return (
    <div className="mt-2 p-3 rounded border border-border-secondary bg-bg-tertiary/40">
      <div className="flex items-center justify-between mb-2">
        <input
          autoFocus
          type="text"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search by deal name, file name, city, or state..."
          className="flex-1 px-2 py-1 text-xs rounded bg-bg-primary border border-border-secondary text-text-primary"
        />
        <button onClick={onClose} className="ml-2 text-xs text-text-muted hover:text-text-primary">
          Close
        </button>
      </div>
      <div className="space-y-1 max-h-[200px] overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="text-xs text-text-muted italic">No matches.</div>
        ) : (
          filtered.map((u) => (
            <button
              key={u.id}
              onClick={() => onPick(u.id)}
              className="w-full text-left px-2 py-1.5 rounded text-xs bg-bg-primary hover:bg-bg-secondary border border-transparent hover:border-accent/40"
            >
              <div className="text-text-primary">{u.dealName}</div>
              <div className="text-text-muted truncate">
                {u.fileName} · {u.city ?? '—'}, {u.state ?? '—'}
              </div>
            </button>
          ))
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function SourceDocUpload({
  isOpen,
  onClose,
  underwritings,
  onCommitted,
}: SourceDocUploadProps): JSX.Element | null {
  const [phase, setPhase] = useState<Phase>('FILE_SELECTION');
  const [rows, setRows] = useState<ReviewRow[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [searchOpenForRow, setSearchOpenForRow] = useState<string | null>(null);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [commitSummary, setCommitSummary] = useState<{
    attached: number;
    staged: number;
    errors: number;
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  if (!isOpen) return null;

  // -------------------------------------------------------------------------
  // File intake
  // -------------------------------------------------------------------------
  const handleFiles = (files: FileList | File[]) => {
    const arr = Array.from(files);
    if (arr.length === 0) return;
    const newRows = arr.map((f) => buildRow(f, underwritings));
    setRows((prev) => [...prev, ...newRows]);
    setPhase('REVIEW');
    setGlobalError(null);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files.length > 0) handleFiles(e.dataTransfer.files);
  };

  // -------------------------------------------------------------------------
  // Row mutations
  // -------------------------------------------------------------------------
  const updateRow = (id: string, patch: Partial<ReviewRow>) => {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  };

  const removeRow = (id: string) => {
    setRows((prev) => prev.filter((r) => r.id !== id));
  };

  /** Undo an auto-attach: drop the row into NEEDS-PICK so the user can verify. */
  const undoAutoAttach = (id: string) => {
    updateRow(id, { bucket: 'needs_pick', pickedUwId: null });
  };

  /** User picks a deal from a NEEDS-PICK row or from the search overlay
   *  for an unmatched row. Unmatched rows transition to needs_pick (resolved). */
  const pickDeal = (rowId: string, uwId: string) => {
    const row = rows.find((r) => r.id === rowId);
    if (!row) return;
    updateRow(rowId, {
      bucket: 'needs_pick',
      pickedUwId: uwId,
    });
    setSearchOpenForRow(null);
  };

  /** User explicitly marks a needs_pick row as "None" → it becomes unmatched
   *  and will be staged instead of attached. */
  const skipPick = (rowId: string) => {
    updateRow(rowId, { bucket: 'unmatched', pickedUwId: null });
  };

  // -------------------------------------------------------------------------
  // Process All gating
  // -------------------------------------------------------------------------
  const buckets = useMemo(() => bucketRows(rows), [rows]);

  const allRowsHaveSlot = rows
    .filter((r) => r.bucket !== 'unmatched')
    .every((r) => r.chosenSlot !== null);

  const allPicksResolved = buckets.pick.every((r) => r.pickedUwId !== null);

  const canCommit = rows.length > 0 && allRowsHaveSlot && allPicksResolved;

  // -------------------------------------------------------------------------
  // Commit (the only point at which we touch the server)
  // -------------------------------------------------------------------------
  const processAll = async () => {
    if (!canCommit) return;
    setPhase('COMMITTING');
    setGlobalError(null);

    setRows((prev) => prev.map((r) => ({ ...r, commitStatus: 'pending' })));

    let attached = 0;
    let staged = 0;
    let errors = 0;

    // 1) Attach auto-attach + resolved needs_pick rows to their slots
    const attachable = rows.filter(
      (r) =>
        (r.bucket === 'auto_attach' || r.bucket === 'needs_pick') &&
        r.pickedUwId !== null &&
        r.chosenSlot !== null,
    );

    for (const row of attachable) {
      try {
        await api.uploadSourceDoc(row.pickedUwId!, row.chosenSlot!, [row.file]);
        attached++;
        updateRow(row.id, { commitStatus: 'success' });
      } catch (err) {
        errors++;
        updateRow(row.id, {
          commitStatus: 'error',
          commitError: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 2) Bulk-stage unmatched rows
    const unmatched = rows.filter((r) => r.bucket === 'unmatched');
    if (unmatched.length > 0) {
      try {
        await api.uploadSourceDocStaging(unmatched.map((r) => r.file));
        staged = unmatched.length;
        for (const row of unmatched) {
          updateRow(row.id, { commitStatus: 'success' });
        }
      } catch (err) {
        errors += unmatched.length;
        for (const row of unmatched) {
          updateRow(row.id, {
            commitStatus: 'error',
            commitError: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    setCommitSummary({ attached, staged, errors });
    setPhase('COMPLETE');
    onCommitted();
  };

  // -------------------------------------------------------------------------
  // Reset + close
  // -------------------------------------------------------------------------
  const reset = () => {
    setRows([]);
    setPhase('FILE_SELECTION');
    setCommitSummary(null);
    setGlobalError(null);
    setSearchOpenForRow(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  // -------------------------------------------------------------------------
  // Slot dropdown (shared)
  // -------------------------------------------------------------------------
  const SlotDropdown = ({ row }: { row: ReviewRow }) => (
    <select
      value={row.chosenSlot ?? ''}
      onChange={(e) => {
        const v = e.target.value as SourceDocSlot | '';
        updateRow(row.id, { chosenSlot: v === '' ? null : v });
      }}
      className="px-1.5 py-0.5 text-xs rounded bg-bg-primary border border-border-secondary text-text-primary"
    >
      <option value="">— pick slot —</option>
      {SOURCE_DOC_SLOTS.map((s) => (
        <option key={s} value={s}>
          {SLOT_LABELS[s]}
        </option>
      ))}
    </select>
  );

  // -------------------------------------------------------------------------
  // Lookup helper (memoized for picker rendering)
  // -------------------------------------------------------------------------
  const uwById = useMemo(() => {
    const m = new Map<string, UWRecordLike>();
    for (const u of underwritings) m.set(u.id, u);
    return m;
  }, [underwritings]);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  return (
    <div className="card mb-6 border-accent/30">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-text-primary">
          Upload Supporting Documents
          {phase === 'REVIEW' && ` — Review (${rows.length} file${rows.length !== 1 ? 's' : ''})`}
          {phase === 'COMMITTING' && ' — Processing...'}
          {phase === 'COMPLETE' && ' — Complete'}
        </h3>
        <button
          onClick={handleClose}
          className="text-xs text-text-muted hover:text-text-primary"
        >
          Close
        </button>
      </div>

      {globalError && (
        <div className="mb-3 px-3 py-2 rounded bg-risk-high/10 border border-risk-high/30 text-xs text-risk-high">
          {globalError}
        </div>
      )}

      {/* ============================================================ */}
      {/* FILE_SELECTION: drop zone                                    */}
      {/* ============================================================ */}
      {phase === 'FILE_SELECTION' && (
        <>
          <p className="text-xs text-text-secondary mb-3">
            Drop ASR, CF, rent roll, PCA, seller UW, T-12, or appraisal files. We will match each
            file to a library deal by name. Conservative bias: when uncertain, we flag for your pick.
          </p>
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setIsDragging(true);
            }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
            className={`border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors ${
              isDragging
                ? 'border-accent bg-accent/5'
                : 'border-border-secondary hover:border-accent/50 hover:bg-bg-tertiary/30'
            }`}
          >
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                if (e.target.files) handleFiles(e.target.files);
              }}
            />
            <div className="text-text-muted text-sm mb-1">
              {isDragging ? 'Drop files here...' : 'Drag & drop files here, or click to browse'}
            </div>
            <div className="text-text-muted text-xs">Any supporting document — multiple files supported</div>
          </div>
        </>
      )}

      {/* ============================================================ */}
      {/* REVIEW                                                       */}
      {/* ============================================================ */}
      {phase === 'REVIEW' && (
        <div className="space-y-4">
          {/* Auto-attached bucket */}
          {buckets.auto.length > 0 && (
            <div className="rounded border border-risk-positive/30 bg-risk-positive/5">
              <div className="px-3 py-2 border-b border-risk-positive/20 text-xs font-semibold text-text-primary">
                Auto-attached ({buckets.auto.length}) — spot-check before committing
              </div>
              <div className="divide-y divide-border-secondary">
                {buckets.auto.map((row) => {
                  const matched = row.pickedUwId ? uwById.get(row.pickedUwId) : undefined;
                  return (
                    <div key={row.id} className="px-3 py-2 grid grid-cols-12 gap-2 items-center text-xs">
                      <div className="col-span-2">
                        <SlotDropdown row={row} />
                      </div>
                      <div className="col-span-4 text-text-primary truncate" title={row.file.name}>
                        {row.file.name}
                      </div>
                      <div className="col-span-5 text-text-muted truncate" title={matched?.fileName}>
                        <span className="text-text-muted">→ </span>
                        <span className="text-text-primary">{matched?.fileName ?? '(unknown record)'}</span>
                      </div>
                      <div className="col-span-1 text-right">
                        <button
                          onClick={() => undoAutoAttach(row.id)}
                          className="text-text-muted hover:text-accent underline"
                        >
                          Undo
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Needs-pick bucket */}
          {buckets.pick.length > 0 && (
            <div className="rounded border border-accent/30 bg-accent/5">
              <div className="px-3 py-2 border-b border-accent/20 text-xs font-semibold text-text-primary">
                Needs your pick ({buckets.pick.length})
              </div>
              <div className="divide-y divide-border-secondary">
                {buckets.pick.map((row) => (
                  <div key={row.id} className="px-3 py-2 text-xs">
                    <div className="flex items-start gap-2 mb-2">
                      <div className="w-32 flex-shrink-0">
                        <SlotDropdown row={row} />
                      </div>
                      <div className="flex-1 text-text-primary truncate" title={row.file.name}>
                        {row.file.name}
                      </div>
                      <button
                        onClick={() => removeRow(row.id)}
                        className="text-text-muted hover:text-risk-high"
                      >
                        Remove
                      </button>
                    </div>
                    <div className="ml-32 space-y-1">
                      {row.match.candidates.map((c) => (
                        <label
                          key={c.uwRecord.id}
                          className="flex items-start gap-2 cursor-pointer hover:bg-bg-tertiary/50 rounded px-1.5 py-1"
                        >
                          <input
                            type="radio"
                            name={`pick-${row.id}`}
                            checked={row.pickedUwId === c.uwRecord.id}
                            onChange={() => pickDeal(row.id, c.uwRecord.id)}
                            className="mt-0.5"
                          />
                          <div className="flex-1 min-w-0">
                            <div className="text-text-primary truncate">
                              {c.uwRecord.dealName}{' '}
                              <span className="text-text-muted">
                                ({c.score.toFixed(2)} · {c.reason})
                              </span>
                            </div>
                            <div className="text-text-muted truncate">{c.uwRecord.fileName}</div>
                          </div>
                        </label>
                      ))}
                      <label className="flex items-center gap-2 cursor-pointer hover:bg-bg-tertiary/50 rounded px-1.5 py-1">
                        <input
                          type="radio"
                          name={`pick-${row.id}`}
                          checked={row.bucket === 'unmatched'}
                          onChange={() => skipPick(row.id)}
                        />
                        <span className="text-text-muted italic">None / send to staging</span>
                      </label>
                      <button
                        onClick={() =>
                          setSearchOpenForRow((cur) => (cur === row.id ? null : row.id))
                        }
                        className="text-accent text-xs hover:underline"
                      >
                        {searchOpenForRow === row.id ? 'Hide search' : 'Search all deals'}
                      </button>
                      {searchOpenForRow === row.id && (
                        <AllDealsSearch
                          underwritings={underwritings}
                          onPick={(uwId) => pickDeal(row.id, uwId)}
                          onClose={() => setSearchOpenForRow(null)}
                        />
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Unmatched bucket */}
          {buckets.unmatched.length > 0 && (
            <div className="rounded border border-border-secondary bg-bg-tertiary/30">
              <div className="px-3 py-2 border-b border-border-secondary text-xs font-semibold text-text-primary">
                Unmatched ({buckets.unmatched.length}) — will be staged for later assignment
              </div>
              <div className="divide-y divide-border-secondary">
                {buckets.unmatched.map((row) => (
                  <div key={row.id} className="px-3 py-2 text-xs">
                    <div className="flex items-center gap-2">
                      <div className="w-32 flex-shrink-0">
                        <SlotDropdown row={row} />
                      </div>
                      <div className="flex-1 text-text-primary truncate" title={row.file.name}>
                        {row.file.name}
                      </div>
                      <button
                        onClick={() =>
                          setSearchOpenForRow((cur) => (cur === row.id ? null : row.id))
                        }
                        className="text-accent hover:underline"
                      >
                        {searchOpenForRow === row.id ? 'Hide search' : 'Pick manually'}
                      </button>
                      <button
                        onClick={() => removeRow(row.id)}
                        className="text-text-muted hover:text-risk-high"
                      >
                        Remove
                      </button>
                    </div>
                    {searchOpenForRow === row.id && (
                      <div className="ml-32 mt-2">
                        <AllDealsSearch
                          underwritings={underwritings}
                          onPick={(uwId) => pickDeal(row.id, uwId)}
                          onClose={() => setSearchOpenForRow(null)}
                        />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Gate-status hint + actions */}
          <div className="flex items-center justify-between pt-2">
            <div className="text-xs text-text-muted">
              {!allRowsHaveSlot && (
                <span className="text-risk-high">All rows must have a slot selected. </span>
              )}
              {!allPicksResolved && (
                <span className="text-risk-high">Pick a candidate (or "None") for every Needs-pick row.</span>
              )}
              {canCommit && (
                <span className="text-risk-positive">Ready to commit — no server changes until you click Process All.</span>
              )}
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => fileInputRef.current?.click()}
                className="text-xs text-text-muted hover:text-text-primary underline"
              >
                Add more files
              </button>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={(e) => {
                  if (e.target.files) handleFiles(e.target.files);
                }}
              />
              <button
                onClick={handleClose}
                className="text-xs px-3 py-1.5 rounded border border-border-secondary text-text-primary hover:bg-bg-tertiary"
              >
                Cancel
              </button>
              <button
                onClick={processAll}
                disabled={!canCommit}
                className={`text-xs px-3 py-1.5 rounded ${
                  canCommit
                    ? 'btn-primary'
                    : 'bg-bg-tertiary text-text-muted cursor-not-allowed'
                }`}
              >
                Process All
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ============================================================ */}
      {/* COMMITTING                                                   */}
      {/* ============================================================ */}
      {phase === 'COMMITTING' && (
        <div className="space-y-2">
          <p className="text-xs text-text-secondary">
            Uploading {rows.length} file{rows.length !== 1 ? 's' : ''}...
          </p>
          <div className="w-full h-1.5 bg-bg-tertiary rounded overflow-hidden">
            <div
              className="h-full bg-accent transition-all duration-300"
              style={{
                width: `${
                  (rows.filter((r) => r.commitStatus && r.commitStatus !== 'pending').length /
                    Math.max(1, rows.length)) *
                  100
                }%`,
              }}
            />
          </div>
          <div className="space-y-1 max-h-[240px] overflow-y-auto">
            {rows.map((row) => (
              <div
                key={row.id}
                className="flex items-center justify-between px-2 py-1 rounded bg-bg-tertiary text-xs"
              >
                <span className="text-text-primary truncate mr-2">{row.file.name}</span>
                <span
                  className={
                    row.commitStatus === 'success'
                      ? 'text-risk-positive'
                      : row.commitStatus === 'error'
                        ? 'text-risk-high'
                        : 'text-text-muted'
                  }
                >
                  {row.commitStatus ?? 'queued'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ============================================================ */}
      {/* COMPLETE                                                     */}
      {/* ============================================================ */}
      {phase === 'COMPLETE' && commitSummary && (
        <div className="space-y-3">
          <div className="px-3 py-2 rounded bg-risk-positive/5 border border-risk-positive/20 text-xs">
            <div className="text-text-primary font-semibold mb-1">Summary</div>
            <div className="text-text-secondary">
              {commitSummary.attached} attached to deals · {commitSummary.staged} staged ·{' '}
              <span className={commitSummary.errors > 0 ? 'text-risk-high' : 'text-text-muted'}>
                {commitSummary.errors} error{commitSummary.errors !== 1 ? 's' : ''}
              </span>
            </div>
          </div>
          {commitSummary.errors > 0 && (
            <div className="space-y-1 max-h-[200px] overflow-y-auto">
              {rows
                .filter((r) => r.commitStatus === 'error')
                .map((r) => (
                  <div key={r.id} className="px-2 py-1 rounded bg-risk-high/5 text-xs">
                    <div className="text-text-primary">{r.file.name}</div>
                    <div className="text-risk-high text-[10px]">{r.commitError}</div>
                  </div>
                ))}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <button
              onClick={reset}
              className="text-xs px-3 py-1.5 rounded border border-border-secondary text-text-primary hover:bg-bg-tertiary"
            >
              Upload More
            </button>
            <button onClick={handleClose} className="btn-primary text-xs">
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
