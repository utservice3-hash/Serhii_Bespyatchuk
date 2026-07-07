import { config } from "../config.js";

// Lardi-Trans Extended API. Ported from the Python `lardiweb` service.
// Cloudflare blocks non-browser user agents (Error 1010), so a real browser UA
// is mandatory. Auth is the RAW token (no "Bearer" prefix).
const BASE = "https://api.lardi-trans.com";
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export const LANG = config.lardi.lang;
export const hasLardiToken = () => Boolean(config.lardi.token);

function headers(jsonBody = false): Record<string, string> {
  const h: Record<string, string> = {
    Authorization: config.lardi.token,
    Accept: "application/json",
    "User-Agent": BROWSER_UA,
    "Accept-Language": "uk-UA,uk;q=0.9,ru;q=0.8,en;q=0.7",
  };
  if (jsonBody) h["Content-Type"] = "application/json";
  return h;
}

export async function lardiGet(path: string, params?: Record<string, string | number>): Promise<Response> {
  const qs = params
    ? "?" + new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString()
    : "";
  return fetch(`${BASE}${path}${qs}`, { headers: headers(), signal: AbortSignal.timeout(25000) });
}

export async function lardiPost(path: string, body: unknown): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method: "POST",
    headers: headers(true),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45000),
  });
}
