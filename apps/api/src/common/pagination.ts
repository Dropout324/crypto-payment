import { ValidationError } from '@gateway/shared';

/**
 * Cursor pagination, shared by every list endpoint in this codebase.
 *
 * The cursor is the last-seen row id: ids are ULIDs, which sort
 * lexicographically by creation time, so `id > cursor, ORDER BY id ASC` is a
 * stable, index-friendly page boundary. Never OFFSET: it degrades on large
 * tables and can skip or duplicate rows under concurrent inserts.
 *
 * Usage: query with `take: limit + 1`, then pass the result to `paginate()`.
 */

export const DEFAULT_PAGE_LIMIT = 20;
export const MAX_PAGE_LIMIT = 100;

export function parseLimit(raw: string | undefined, options: { default?: number; max?: number } = {}): number {
  const fallback = options.default ?? DEFAULT_PAGE_LIMIT;
  const max = options.max ?? MAX_PAGE_LIMIT;
  if (raw === undefined) return fallback;

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    throw new ValidationError(`limit must be an integer between 1 and ${max}`);
  }
  return parsed;
}

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
}

/** Splits a `take: limit + 1` result into one page plus the next cursor (null once the extra row is absent). */
export function paginate<T extends { id: string }>(rows: T[], limit: number): CursorPage<T> {
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return { items, nextCursor: rows.length > limit && last ? last.id : null };
}
