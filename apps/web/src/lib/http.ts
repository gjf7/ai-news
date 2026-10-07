export type ApiError = {
  code: string;
  message: string;
  requestId: string;
};

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | undefined;

  constructor(status: number, error: ApiError) {
    super(error.message);
    this.name = "HttpError";
    this.status = status;
    this.code = error.code;
    this.requestId = error.requestId;
  }
}

/**
 * Thin fetch wrapper. Any non-2xx response is turned into an HttpError so
 * callers never have to branch on `response.ok`.
 */
export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("content-type", "application/json");

  const response = await fetch(path, {
    ...init,
    headers,
    credentials: "same-origin",
  });

  if (!response.ok) {
    const fallback: ApiError = {
      code: "http_error",
      message: response.statusText || "Request failed",
      requestId: "",
    };
    const body = await response.json().catch(() => ({ error: fallback }));
    throw new HttpError(response.status, body.error ?? fallback);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}
