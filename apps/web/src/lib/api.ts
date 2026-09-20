import { API_URL } from './config';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface ApiRequestInit extends RequestInit {
  /** Forwarded explicitly for server-side calls, which don't carry the browser's cookie jar. */
  cookie?: string;
}

export async function apiRequest<T>(path: string, init?: ApiRequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.cookie) headers.set('cookie', init.cookie);
  if (init?.body && !headers.has('content-type')) headers.set('content-type', 'application/json');

  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers,
    credentials: 'include',
    cache: 'no-store',
  });

  if (!res.ok) {
    let message = res.statusText;
    let code: string | undefined;
    try {
      // The API's error envelope nests under `error` (see
      // apps/api/src/common/http-exception.filter.ts and AppError.toPublicJSON) -
      // not `{ message, code }` at the top level.
      const body = (await res.json()) as { error?: { message?: string; code?: string } };
      message = body.error?.message ?? message;
      code = body.error?.code;
    } catch {
      // Response body wasn't JSON - fall back to statusText above.
    }
    throw new ApiError(res.status, code, message);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
