/** Fetch JSON and report non-JSON HTTP responses with actionable error details. */
export function apiFetchJSON<T>(endpoint: string, options?: RequestInit): Promise<T>;
