/**
 * Alternate research sources behind the `search` tool.
 *
 * Ahmia is the default, but it filters whole categories (all sexual content, most markets)
 * and its full-text index is thin. These sources complement it:
 *
 * - SearXNG instances over onion: unfiltered metasearch (Yandex, Bing, …) with a JSON API.
 *   Instances are shared and rate-limit (HTTP 429), so requests fall through the list until
 *   one answers.
 * - tor.taxi: an anti-phishing directory that records the *official* .onion of well-known
 *   darknet sites, as a plain-text page per site — the reliable way to get a current
 *   address for a site whose Ahmia results are full of clones.
 */

import { torFetch } from "./tor-http";
import type { TorProxy } from "./tor-http";

/** Public SearXNG instances reachable over onion (verified 2026-10). Rotates over time; drop dead ones. */
export const SearXngInstances = [
  "http://lhdp2wkdwynwfxogmhqndgzfepwu4nbzllfompppmbetrcp732rxrbqd.onion",
  "http://ieqzkvy4bf3xi4bzsfzfax42t4iuqcbqn6oah4uwrm4ip354gavsviad.onion",
  "http://searxngorpgnztkcftpz3ycdpyajd4q55y2nejw3tbszocht5zdh4lyd.onion",
  "http://ls67zxncmcqgn2vg74ckcwxgu5p3e5mf2khues3egkumhcqtbsg4kqyd.onion",
] as const;

/** The anti-phishing directory of official darknet-site onions. */
export const TOR_TAXI_ONION = "http://tortaxip4uzgrbm6s5oss5r5ct364dfe46o5cjxqkvvrjwebxjltd7id.onion";

const SEARXNG_USER_AGENT = "jazz-plugin-onion (Tor; JSON API)";

export interface SearchResult {
  readonly title: string;
  readonly url: string;
  readonly snippet?: string;
  readonly source?: string;
}

/** Builds a SearXNG JSON-API search URL for the given instance and query. */
export function buildSearXngUrl(instance: string, query: string): string {
  const url = new URL("/search", instance);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  return url.toString();
}

/**
 * Parses a SearXNG JSON response into results. Lenient on shape: field names vary by
 * instance configuration (content/snippet, engine/engines).
 */
export function parseSearXngResults(body: string, limit: number): SearchResult[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  const raw = (parsed as { results?: unknown }).results;
  if (!Array.isArray(raw)) {
    return [];
  }
  const results: SearchResult[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const record = item as Record<string, unknown>;
    const url = typeof record["url"] === "string" ? record["url"] : undefined;
    if (url === undefined || url === "") {
      continue;
    }
    const title = typeof record["title"] === "string" && record["title"] !== "" ? record["title"] : url;
    const snippet =
      typeof record["content"] === "string" && record["content"] !== ""
        ? record["content"]
        : typeof record["snippet"] === "string" && record["snippet"] !== ""
          ? record["snippet"]
          : undefined;
    const source = Array.isArray(record["engines"])
      ? (record["engines"] as unknown[]).filter((e): e is string => typeof e === "string").join(", ")
      : typeof record["engine"] === "string"
        ? record["engine"]
        : undefined;
    results.push({
      title,
      url,
      ...(snippet !== undefined ? { snippet } : {}),
      ...(source !== undefined ? { source } : {}),
    });
    if (results.length >= limit) {
      break;
    }
  }
  return results;
}

export interface SearXngSearchOptions {
  readonly query: string;
  readonly limit: number;
  readonly proxy: TorProxy;
  readonly signal: AbortSignal;
  /** Keep non-.onion results (default: keep only onions; clearnet results defeat the anonymity). */
  readonly includeClearnet?: boolean;
  /** Instance list override for tests; defaults to SearXngInstances. */
  readonly instances?: readonly string[];
}

/**
 * Searches through the SearXNG instance list in order, returning the first instance that
 * answers without a rate limit or error. Throws only when every instance fails.
 */
export async function searchSearXng(options: SearXngSearchOptions): Promise<SearchResult[]> {
  const instances = options.instances ?? SearXngInstances;
  const errors: string[] = [];
  for (const instance of instances) {
    const target = buildSearXngUrl(instance, options.query);
    try {
      const response = await torFetch(target, { proxy: options.proxy, signal: options.signal, userAgent: SEARXNG_USER_AGENT });
      if (response.status === 429) {
        errors.push(`${instance}: rate limited`);
        continue;
      }
      if (response.status !== 200) {
        errors.push(`${instance}: HTTP ${response.status}`);
        continue;
      }
      const results = parseSearXngResults(new TextDecoder("utf-8").decode(response.body), options.limit);
      const filtered = options.includeClearnet
        ? results
        : results.filter((result) => isOnionUrl(result.url));
      if (filtered.length > 0) {
        return filtered;
      }
      errors.push(`${instance}: no results`);
    } catch (error) {
      errors.push(`${instance}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`No SearXNG instance answered (${errors.join("; ")})`);
}

export function isOnionUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return /^[a-z2-7]{56}\.onion$/.test(host) || /\.onion$/.test(host);
  } catch {
    return false;
  }
}

/**
 * Looks up a site's official .onion in tor.taxi. `site` is the directory's page name
 * (lowercase, e.g. "pornhub"). Returns the listed onion address and the page text so the
 * caller can present both.
 */
export async function lookupTorTaxi(
  site: string,
  proxy: TorProxy,
  signal: AbortSignal,
): Promise<{ onion: string; url: string }> {
  const name = site.trim().toLowerCase();
  if (!/^[a-z0-9._-]{1,64}$/.test(name)) {
    throw new Error(`Invalid site name "${site}" (letters, digits, dot, dash, underscore only)`);
  }
  const pageUrl = `${TOR_TAXI_ONION}/${name}.html`;
  const response = await torFetch(pageUrl, { proxy, signal });
  if (response.status === 404) {
    throw new Error(`tor.taxi has no page for "${name}"`);
  }
  if (response.status !== 200) {
    throw new Error(`tor.taxi answered HTTP ${response.status}`);
  }
  const text = new TextDecoder("utf-8").decode(response.body);
  const match = text.match(/([a-z2-7]{56})\.onion/);
  if (match === null) {
    throw new Error(`tor.taxi's page for "${name}" lists no onion address (the directory may be stale)`);
  }
  return { onion: `${match[1]}.onion`, url: response.url };
}
