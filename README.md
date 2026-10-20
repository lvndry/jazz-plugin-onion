# Onion search

Jazz plugin for researching Tor onion services. All egress goes through the local Tor
SOCKS proxy (default `127.0.0.1:9050`), the hostname is resolved inside Tor, and only
`.onion` hosts are accepted — a redirect to the clearnet aborts the fetch.

## Tools

### `search`

Query a dark-web search source. `source` selects the backend:

- **`ahmia`** (default) — the curated Ahmia index. Reliable but opinionated: whole
  categories are filtered (all sexual content, most markets) and its full-text index is
  thin.
- **`searxng`** — unfiltered metasearch through a built-in list of public SearXNG
  instances over onion (Yandex, Bing, …). Instances are shared and rate-limit, so a
  429 falls through to the next instance. Only `.onion` results are returned by default,
  since clearnet results defeat the anonymity.
- **`tor-taxi`** — look up the *official* `.onion` of a named darknet site (query =
  lowercase site name, e.g. `pornhub`) from the tor.taxi anti-phishing directory. Useful
  when Ahmia is full of clones and you need the address a site publishes itself.

Result URLs can be handed straight to `fetch_page`.

### `fetch_page`

GET an onion URL and return its title, readable text, and onion links as untrusted
text.

### `post_page`

POST a body to an onion URL (forms, JSON APIs such as OOPS or SearXNG's own API).
`contentType` defaults to `application/x-www-form-urlencoded`. Marked `mutating`
because the server can act on the request.

## The JavaScript boundary (by design)

The plugin fetches HTML and reads it as text. Pages that render their content in
JavaScript — most modern SPAs, live video, JS-built market catalogs — come back empty or
partial. That is a design boundary, not a bug: it keeps the plugin dependency-free and
its egress surface tiny. For those pages, use Tor Browser, which can execute the page.

## The search-source landscape (honest notes)

- **Ahmia** curation is visible in its results: search adult content and it answers with
  its "abuse material is not allowed" page rather than hits.
- **SearXNG instances over onion** are community-run and rotate. The built-in list was
  verified 2026-10; dead instances are skipped automatically, but a stale list eventually
  means "No SearXNG instance answered" — refresh `SearXngInstances` in `src/sources.ts`.
- **tor.taxi** is maintained by a volunteer and goes stale: it returns HTTP 200 even when
  the listed onion has rotated, so a lookup succeeding does not prove the onion is live.
  As of 2026-10-20 its onion was unreachable even after identity rotation — the source
  degrades to a timeout and the other sources still work. Treat the result as a starting
  point, not ground truth.
- The niche (non-mainstream) corners of the dark web are discovered through forums and
  directories that link current onions, not through any search index. The tools here get
  you to those entry points; the entry points do the rest.

## Tor

Start a local Tor daemon listening on the SOCKS port, e.g.:

```
brew services start tor
```

Or, when using Tor Browser, point the plugin at its SOCKS proxy:

```
JAZZ_TOR_PROXY=127.0.0.1:9150 jazz
```

Cold onion connections (descriptor fetch, introduction, rendezvous) take 45–60 seconds;
the timeout is 90 seconds.

## Develop

```
bun install
bun run typecheck
bun test
```
