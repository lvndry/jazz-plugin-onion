/** Regex-based HTML reduction: enough to turn onion pages and Ahmia results into readable text. */

import { isOnionHost } from "./tor-http";

export interface PageLink {
  readonly text: string;
  readonly url: string;
}

export interface SearchResult {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  copy: "©",
  laquo: "«",
  raquo: "»",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith("#")) {
      const codePoint =
        entity[1] === "x" || entity[1] === "X"
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10);
      return codePoint > 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : match;
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function attribute(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  const value = match?.[1] ?? match?.[2] ?? match?.[3];
  return value === undefined ? undefined : decodeEntities(value);
}

export function pageTitle(html: string): string {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  return title === undefined ? "" : stripTags(title);
}

const INVISIBLE_ELEMENTS = /<(script|style|noscript|svg|template|head)\b[\s\S]*?<\/\1\s*>/gi;
const BLOCK_BOUNDARY =
  /<\/?(p|div|br|li|ul|ol|tr|table|section|article|header|footer|nav|main|aside|h[1-6]|pre|blockquote|form|hr)\b[^>]*>/gi;

export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(INVISIBLE_ELEMENTS, "")
      .replace(BLOCK_BOUNDARY, "\n")
      .replace(/<[^>]*>/g, " "),
  )
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v ]+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

/** Absolute links to onion hosts, deduplicated by URL in document order. */
export function onionLinks(html: string, baseUrl: string): PageLink[] {
  const links = new Map<string, PageLink>();
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)) {
    const href = attribute(` ${match[1] ?? ""}`, "href");
    if (href === undefined) {
      continue;
    }
    let url: URL;
    try {
      url = new URL(href, baseUrl);
    } catch {
      continue;
    }
    if ((url.protocol === "http:" || url.protocol === "https:") && isOnionHost(url.hostname)) {
      url.hash = "";
      const key = url.toString();
      if (!links.has(key)) {
        links.set(key, { text: stripTags(match[2] ?? ""), url: key });
      }
    }
  }
  return [...links.values()];
}

/** Hidden inputs of the page's search form; Ahmia rejects searches that omit its rotating token. */
export function hiddenFormFields(html: string): Array<[string, string]> {
  const fields: Array<[string, string]> = [];
  for (const match of html.matchAll(/<input\b[^>]*>/gi)) {
    const tag = match[0];
    if (attribute(tag, "type")?.toLowerCase() !== "hidden") {
      continue;
    }
    const name = attribute(tag, "name");
    if (name !== undefined) {
      fields.push([name, attribute(tag, "value") ?? ""]);
    }
  }
  return fields;
}

/** Ahmia wraps result links in `/search/redirect?...&redirect_url=<target>`; unwrap to the target. */
function unwrapRedirect(href: string, baseUrl: string): string | undefined {
  let url: URL;
  try {
    url = new URL(href, baseUrl);
  } catch {
    return undefined;
  }
  const target = url.searchParams.get("redirect_url");
  return target ?? url.toString();
}

export function parseAhmiaResults(html: string, baseUrl: string): SearchResult[] {
  const results: SearchResult[] = [];
  const blocks = html.split(/<li\b[^>]*class\s*=\s*["'][^"']*\bresult\b[^"']*["'][^>]*>/i).slice(1);
  for (const block of blocks) {
    const item = block.split(/<\/li\s*>/i)[0] ?? "";
    const anchor = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/i.exec(item);
    const href = anchor ? attribute(` ${anchor[1] ?? ""}`, "href") : undefined;
    const url = href === undefined ? undefined : unwrapRedirect(href, baseUrl);
    if (url === undefined) {
      continue;
    }
    const snippet = /<p\b[^>]*>([\s\S]*?)<\/p\s*>/i.exec(item)?.[1];
    results.push({
      title: stripTags(anchor?.[2] ?? "") || url,
      url,
      snippet: snippet === undefined ? "" : stripTags(snippet),
    });
  }
  return results;
}
