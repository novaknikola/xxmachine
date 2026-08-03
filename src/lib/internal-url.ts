/**
 * Base URL for calls the app makes to its own API.
 *
 * These used to go out through NEXT_PUBLIC_BASE_URL — over the public
 * hostname, through nginx and back. That put a 300s proxy_read_timeout in
 * front of work that legitimately runs longer: nginx logged 65 timeouts on
 * /api/cron/drive-archive and 16 on /api/queue/process alone, each answered
 * with an HTML 502/504 page that whatever parsed it reported as
 * "Unexpected token '<' ... is not valid JSON".
 *
 * Loopback has no proxy in the path, so a long worker run is bounded by the
 * work itself. Set INTERNAL_BASE_URL to override (e.g. a container hostname).
 *
 * User-facing URLs — OAuth redirects, payment return links — must keep using
 * NEXT_PUBLIC_BASE_URL: the browser has to be able to reach them.
 */
export function internalBaseUrl(): string {
  return process.env.INTERNAL_BASE_URL
    ?? `http://127.0.0.1:${process.env.PORT ?? '3000'}`
}
