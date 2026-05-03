export function formatCurrency(value: number): string {
  if (Math.abs(value) >= 1_000_000) {
    return '$' + (value / 1_000_000).toFixed(2) + 'M';
  }
  if (Math.abs(value) >= 1_000) {
    return '$' + (value / 1_000).toFixed(0) + 'K';
  }
  return '$' + value.toFixed(0);
}

export function formatCurrencyFull(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);
}

export function formatPercent(value: number, decimals = 2): string {
  return value.toFixed(decimals) + '%';
}

export function formatMultiple(value: number): string {
  return value.toFixed(2) + 'x';
}

// --- Null-safe display formatters (decimal-storage convention) ---
// The contract: financial values are stored as DECIMAL fractions internally
// (0.75 = 75%). Display layer multiplies by 100 ONLY when rendering.
// Underlying data is never mutated. null → "N/A", never coerced to 0.

export function formatDecimalPercent(value: number | null, decimals = 2): string {
  if (value === null || value === undefined) return 'N/A';
  return (value * 100).toFixed(decimals) + '%';
}

export function formatPercentSafe(value: number | null, decimals = 2): string {
  if (value === null || value === undefined) return 'N/A';
  return value.toFixed(decimals) + '%';
}

export function formatMultipleSafe(value: number | null): string {
  if (value === null || value === undefined) return 'N/A';
  return value.toFixed(2) + 'x';
}

export function formatCurrencyFullSafe(value: number | null): string {
  if (value === null || value === undefined) return 'N/A';
  return formatCurrencyFull(value);
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat('en-US').format(value);
}

export function formatBps(value: number): string {
  return (value * 100).toFixed(0) + 'bps';
}
