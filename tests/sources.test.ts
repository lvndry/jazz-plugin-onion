import { describe, expect, test } from "bun:test";
import { createServer, type Server, type Socket } from "node:net";
import {
  buildSearXngUrl,
  isOnionUrl,
  parseSearXngResults,
  searchSearXng,
  lookupTorTaxi,
} from "../src/sources";
import type { TorProxy } from "../src/tor-http";

describe("buildSearXngUrl", () => {
  test("targets the JSON API of the given instance", () => {
    const url = buildSearXngUrl(
      "http://lhdp2wkdwynwfxogmhqndgzfepwu4nbzllfompppmbetrcp732rxrbqd.onion",
      "teen videos",
    );
    const parsed = new URL(url);
    expect(parsed.host.endsWith(".onion")).toBe(true);
    expect(parsed.pathname).toBe("/search");
    expect(parsed.searchParams.get("q")).toBe("teen videos");
    expect(parsed.searchParams.get("format")).toBe("json");
  });
});

describe("parseSearXngResults", () => {
  test("extracts title, url, snippet and engine, honoring the limit", () => {
    const body = JSON.stringify({
      results: [
        {
          title: "First",
          url: "http://lhdp2wkdwynwfxogmhqndgzfepwu4nbzllfompppmbetrcp732rxrbqd.onion/a",
          content: "a snippet",
          engines: ["yandex", "bing"],
        },
        {
          title: "",
          url: "http://ieqzkvy4bf3xi4bzsfzfax42t4iuqcbqn6oah4uwrm4ip354gavsviad.onion/b",
          snippet: "fallback snippet",
          engine: "duckduckgo",
        },
        { url: "http://searxngorpgnztkcftpz3ycdpyajd4q55y2nejw3tbszocht5zdh4lyd.onion/c" },
      ],
    });
    const results = parseSearXngResults(body, 10);
    expect(results).toHaveLength(3);
    const [first, second, third] = results;
    expect(first).toEqual({
      title: "First",
      url: "http://lhdp2wkdwynwfxogmhqndgzfepwu4nbzllfompppmbetrcp732rxrbqd.onion/a",
      snippet: "a snippet",
      source: "yandex, bing",
    });
    expect(second?.title).toBe("http://ieqzkvy4bf3xi4bzsfzfax42t4iuqcbqn6oah4uwrm4ip354gavsviad.onion/b");
    expect(second?.snippet).toBe("fallback snippet");
    expect(second?.source).toBe("duckduckgo");
    expect(third?.title).toBe("http://searxngorpgnztkcftpz3ycdpyajd4q55y2nejw3tbszocht5zdh4lyd.onion/c");
    expect(parseSearXngResults(body, 1)).toHaveLength(1);
  });

  test("tolerates malformed JSON and non-array results", () => {
    expect(parseSearXngResults("not json", 10)).toEqual([]);
    expect(parseSearXngResults('{"results": "nope"}', 10)).toEqual([]);
    expect(parseSearXngResults('{"results": [{"title": "no url"}]}', 10)).toEqual([]);
  });
});

describe("isOnionUrl", () => {
  test("accepts onion URLs and rejects clearnet or garbage", () => {
    expect(
      isOnionUrl("http://lhdp2wkdwynwfxogmhqndgzfepwu4nbzllfompppmbetrcp732rxrbqd.onion/x"),
    ).toBe(true);
    expect(isOnionUrl("https://www.example.com/x")).toBe(false);
    expect(isOnionUrl("not a url")).toBe(false);
  });
});

/**
 * A fake Tor endpoint: buffers the SOCKS5 greeting + domain connect, then treats the next
 * bytes as an HTTP request and replies with one HTTP response. `respond` sees the HTTP
 * request text and the connected domain, so tests can branch per instance.
 */
function fakeTorEndpoint(
  respond: (request: string, domain: string) => { status: number; body: string },
): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer((socket: Socket) => {
      socket.once("error", reject);
      let stage: "greeting" | "connect" | "http" = "greeting";
      let domain = "";
      let buffered = Buffer.alloc(0);
      socket.on("data", (chunk: Buffer) => {
        buffered = Buffer.concat([buffered, chunk]);
        if (stage === "greeting" && buffered.length >= 3) {
          buffered = buffered.subarray(3);
          socket.write(Buffer.from([0x05, 0x00]));
          stage = "connect";
        }
        if (stage === "connect" && buffered.length >= 5) {
          const hostLength = buffered[4] ?? 0;
          if (buffered.length < 7 + hostLength) {
            return;
          }
          domain = buffered.subarray(5, 5 + hostLength).toString();
          buffered = buffered.subarray(7 + hostLength);
          socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          stage = "http";
        }
        if (stage === "http" && buffered.includes("\r\n\r\n")) {
          const { status, body } = respond(buffered.toString(), domain);
          socket.end(
            `HTTP/1.1 ${status} Test\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
          );
        }
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("expected a TCP address"));
        return;
      }
      resolve({ server, port: address.port });
    });
  });
}

const FIRST_ONION = "lhdp2wkdwynwfxogmhqndgzfepwu4nbzllfompppmbetrcp732rxrbqd.onion";
const SECOND_ONION = "ieqzkvy4bf3xi4bzsfzfax42t4iuqcbqn6oah4uwrm4ip354gavsviad.onion";

describe("searchSearXng", () => {
  test("falls through a rate-limited instance to the next one", async () => {
    const endpoint = await fakeTorEndpoint((request, domain) => {
      if (domain === FIRST_ONION) {
        return { status: 429, body: "Too Many Requests" };
      }
      expect(request).toContain("GET /search?q=neon+cats&format=json");
      return {
        status: 200,
        body: JSON.stringify({
          results: [
            {
              title: "Neon cats",
              url: `http://${SECOND_ONION}/neon-cats`,
              engines: ["yandex"],
            },
            { title: "clearnet noise", url: "https://example.com/neon" },
          ],
        }),
      };
    });
    try {
      const proxy: TorProxy = { host: "127.0.0.1", port: endpoint.port };
      const results = await searchSearXng({
        query: "neon cats",
        limit: 10,
        proxy,
        signal: AbortSignal.timeout(5000),
        instances: [`http://${FIRST_ONION}`, `http://${SECOND_ONION}`],
      });
      // Clearnet results are dropped by default; only the onion result survives.
      expect(results).toEqual([
        {
          title: "Neon cats",
          url: `http://${SECOND_ONION}/neon-cats`,
          source: "yandex",
        },
      ]);
    } finally {
      endpoint.server.close();
    }
  });

  test("reports every failure when all instances rate-limit", async () => {
    const endpoint = await fakeTorEndpoint(() => ({ status: 429, body: "Too Many Requests" }));
    try {
      const proxy: TorProxy = { host: "127.0.0.1", port: endpoint.port };
      await expect(
        searchSearXng({
          query: "neon cats",
          limit: 10,
          proxy,
          signal: AbortSignal.timeout(5000),
          instances: [`http://${FIRST_ONION}`, `http://${SECOND_ONION}`],
        }),
      ).rejects.toThrow("No SearXNG instance answered");
    } finally {
      endpoint.server.close();
    }
  });
});

describe("lookupTorTaxi", () => {
  test("rejects names that could not be a directory page", async () => {
    const proxy: TorProxy = { host: "127.0.0.1", port: 1 };
    await expect(lookupTorTaxi("has spaces", proxy, AbortSignal.timeout(1000))).rejects.toThrow(
      "Invalid site name",
    );
  });

  test("extracts the listed onion from the page", async () => {
    const endpoint = await fakeTorEndpoint((request) => {
      expect(request).toContain("GET /pornhub.html");
      return {
        status: 200,
        body: "tor.taxi - PornHub\n\npornhubvybmsymdol4iibwgwtkpwmeyd6luq2gxajgjzfjvotyt5zhyd.onion\n",
      };
    });
    try {
      const proxy: TorProxy = { host: "127.0.0.1", port: endpoint.port };
      const { onion } = await lookupTorTaxi("PornHub", proxy, AbortSignal.timeout(5000));
      expect(onion).toBe("pornhubvybmsymdol4iibwgwtkpwmeyd6luq2gxajgjzfjvotyt5zhyd.onion");
    } finally {
      endpoint.server.close();
    }
  });
});
