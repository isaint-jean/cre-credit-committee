/**
 * Single source of truth for the Anthropic model name used by every engine AI
 * call (extraction adapters, narrative builder, handbook LLM-context check,
 * UW intelligence).
 *
 * Previously the model id was hardcoded inline at every call site as
 * 'claude-sonnet-4-20250514'. That model was retired in April 2026; the API
 * began returning `404 not_found_error: model: claude-sonnet-4-20250514`,
 * which silently broke every analysis end-to-end. This constant replaces all
 * 10+ literal sites so future model bumps are a one-line change.
 *
 * Default: `claude-sonnet-4-6` (Sonnet 4.6 — current, supported, same Sonnet
 * tier the engine was originally calibrated against). Override via the
 * CLAUDE_MODEL env var without code changes.
 */
export const CLAUDE_MODEL: string = process.env['CLAUDE_MODEL'] ?? 'claude-sonnet-4-6';
