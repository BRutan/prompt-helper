/**
 * Fetch JSON from the prompt-helper API without losing the real HTTP error.
 * In particular, Safari reports "The string did not match the expected pattern"
 * when response.json() sees an nginx HTML error page or a text 404 response.
 * @param {string} endpoint
 * @param {RequestInit} [options]
 * @returns {Promise<unknown>}
 */
export async function apiFetchJSON(endpoint, options = {}) {
  const method = options.method || 'GET';
  let response;
  try {
    response = await fetch(endpoint, options);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`${method} ${endpoint} failed before receiving an HTTP response: ${detail}. Check that the frontend and backend containers are running.`);
  }

  const contentType = response.headers.get('content-type') || '';
  let body;
  try {
    body = await response.text();
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`${method} ${endpoint} returned HTTP ${response.status}, but the response body could not be read: ${detail}`);
  }

  const label = `${method} ${endpoint}: HTTP ${response.status}`;
  const preview = body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
  const jsonType = /^application\/(?:[\w.-]+\+)?json(?:\s*;|\s*$)/i.test(contentType);
  if (!jsonType) {
    const reason = preview || '(empty response body)';
    const hint = response.status === 404 && endpoint.includes('/batch-diff')
      ? ' The batch endpoint is missing from the running backend; rebuild and restart it with make build-up.'
      : response.status === 502 || response.status === 503 || response.status === 504
        ? ' The proxy cannot reach a healthy backend; inspect docker compose logs --tail=100 backend frontend.'
        : '';
    throw new Error(`${label} returned ${contentType || 'no content-type'} instead of JSON: ${reason}.${hint}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`${label} returned invalid JSON: ${detail}. Response preview: ${preview || '(empty)'}`);
  }
  if (!response.ok) {
    const message = parsed && typeof parsed === 'object' && typeof parsed.error === 'string'
      ? parsed.error : preview || response.statusText || 'unknown API error';
    throw new Error(`${label}: ${message}`);
  }
  return parsed;
}
