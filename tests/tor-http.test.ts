import { afterEach, describe, expect, it } from "bun:test";
import { createServer, type Server, type Socket } from "node:net";
import {
  decodeChunked,
  isOnionHost,
  torFetch,
  torProxyFromEnvironment,
  type TorProxy,
} from "../src/tor-http";

const ONION = "juhanurmihxlp77nkq76byazcldy2hlmovfu2epvl5ankdibsot4csyd.onion";

interface FakeTor {
  readonly proxy: TorProxy;
  readonly requests: Array<{ host: string; port: number; request: string }>;
}

let server: Server | undefined;

afterEach(() => {
  server?.close();
  server = undefined;
});

/** A SOCKS5 proxy that answers every CONNECT itself with the HTTP response `respond` builds. */
async function startFakeTor(
  respond: (request: string) => string,
  replyCode = 0x00,
): Promise<FakeTor> {
  const requests: FakeTor["requests"] = [];
  server = createServer((socket: Socket) => {
    let stage: "greeting" | "connect" | "http" = "greeting";
    let target = { host: "", port: 0 };
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
        target = {
          host: buffered.subarray(5, 5 + hostLength).toString(),
          port: buffered.readUInt16BE(5 + hostLength),
        };
        buffered = buffered.subarray(7 + hostLength);
        socket.write(Buffer.from([0x05, replyCode, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        if (replyCode !== 0x00) {
          socket.end();
          return;
        }
        stage = "http";
      }
      if (stage === "http" && buffered.includes("\r\n\r\n")) {
        const request = buffered.toString();
        requests.push({ ...target, request });
        socket.end(respond(request));
      }
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("fake Tor did not bind");
  }
  return { proxy: { host: "127.0.0.1", port: address.port }, requests };
}

const signal = () => new AbortController().signal;

describe("isOnionHost", () => {
  it("accepts v3 onion hosts and subdomains", () => {
    expect(isOnionHost(ONION)).toBe(true);
    expect(isOnionHost(`www.${ONION}`)).toBe(true);
    expect(isOnionHost(ONION.toUpperCase())).toBe(true);
  });

  it("rejects clearnet hosts and retired v2 addresses", () => {
    expect(isOnionHost("example.com")).toBe(false);
    expect(isOnionHost("expyuzz4wqqyqhjn.onion")).toBe(false);
    expect(isOnionHost(`${ONION}.evil.com`)).toBe(false);
  });
});

describe("torProxyFromEnvironment", () => {
  it("defaults to the Tor daemon port", () => {
    expect(torProxyFromEnvironment(undefined)).toEqual({ host: "127.0.0.1", port: 9050 });
  });

  it("parses host:port", () => {
    expect(torProxyFromEnvironment("127.0.0.1:9150")).toEqual({ host: "127.0.0.1", port: 9150 });
  });

  it("rejects malformed values", () => {
    expect(() => torProxyFromEnvironment("9150")).toThrow("host:port");
    expect(() => torProxyFromEnvironment("localhost:99999")).toThrow("host:port");
  });
});

describe("decodeChunked", () => {
  it("joins chunks and stops at the terminator", () => {
    expect(
      decodeChunked(Buffer.from("5\r\nhello\r\n6;ext=1\r\n world\r\n0\r\n\r\n")).toString(),
    ).toBe("hello world");
  });

  it("keeps a truncated final chunk", () => {
    expect(decodeChunked(Buffer.from("5\r\nhel")).toString()).toBe("hel");
  });
});

describe("torFetch", () => {
  it("hands the onion hostname to the proxy unresolved and sends a GET", async () => {
    const fakeTor = await startFakeTor(
      () => "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 5\r\n\r\nhello",
    );
    const response = await torFetch(`http://${ONION}/path?q=1`, {
      proxy: fakeTor.proxy,
      signal: signal(),
    });
    expect(response.status).toBe(200);
    expect(Buffer.from(response.body).toString()).toBe("hello");
    expect(fakeTor.requests[0]?.host).toBe(ONION);
    expect(fakeTor.requests[0]?.port).toBe(80);
    expect(fakeTor.requests[0]?.request).toStartWith(
      `GET /path?q=1 HTTP/1.1\r\nHost: ${ONION}\r\n`,
    );
  });

  it("decodes chunked bodies", async () => {
    const fakeTor = await startFakeTor(
      () => "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n0\r\n\r\n",
    );
    const response = await torFetch(`http://${ONION}/`, { proxy: fakeTor.proxy, signal: signal() });
    expect(Buffer.from(response.body).toString()).toBe("abc");
  });

  it("follows redirects between onion hosts", async () => {
    const fakeTor = await startFakeTor((request) =>
      request.startsWith("GET /old")
        ? "HTTP/1.1 301 Moved\r\nLocation: /new\r\nContent-Length: 0\r\n\r\n"
        : "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok",
    );
    const response = await torFetch(`http://${ONION}/old`, {
      proxy: fakeTor.proxy,
      signal: signal(),
    });
    expect(response.url).toBe(`http://${ONION}/new`);
    expect(fakeTor.requests).toHaveLength(2);
  });

  it("refuses a redirect to the clearnet", async () => {
    const fakeTor = await startFakeTor(
      () => "HTTP/1.1 302 Found\r\nLocation: http://example.com/\r\nContent-Length: 0\r\n\r\n",
    );
    await expect(
      torFetch(`http://${ONION}/`, { proxy: fakeTor.proxy, signal: signal() }),
    ).rejects.toThrow("example.com is not a v3 .onion address");
    expect(fakeTor.requests).toHaveLength(1);
  });

  it("refuses clearnet URLs before connecting", async () => {
    const fakeTor = await startFakeTor(() => "HTTP/1.1 200 OK\r\n\r\n");
    await expect(
      torFetch("https://example.com/", { proxy: fakeTor.proxy, signal: signal() }),
    ).rejects.toThrow("not a v3 .onion address");
    expect(fakeTor.requests).toHaveLength(0);
  });

  it("explains Tor's onion-service failure codes", async () => {
    const fakeTor = await startFakeTor(() => "", 0xf0);
    await expect(
      torFetch(`http://${ONION}/`, { proxy: fakeTor.proxy, signal: signal() }),
    ).rejects.toThrow("descriptor not found");
  });

  it("caps the response size", async () => {
    const fakeTor = await startFakeTor(() => `HTTP/1.1 200 OK\r\n\r\n${"x".repeat(10_000)}`);
    const response = await torFetch(`http://${ONION}/`, {
      proxy: fakeTor.proxy,
      signal: signal(),
      maxResponseBytes: 1_000,
    });
    expect(response.truncated).toBe(true);
  });

  it("reports when Tor is not running", async () => {
    await expect(
      torFetch(`http://${ONION}/`, { proxy: { host: "127.0.0.1", port: 1 }, signal: signal() }),
    ).rejects.toThrow("Tor is not reachable");
  });
});
