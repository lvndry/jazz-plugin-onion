/**
 * A dependency-free HTTP/1.1 client (GET and POST) that tunnels through a Tor SOCKS5 proxy.
 * The hostname is handed to the proxy unresolved (SOCKS5 domain address type), so `.onion`
 * names resolve inside Tor and no DNS query ever leaves the machine.
 */

import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";

export interface TorProxy {
  readonly host: string;
  readonly port: number;
}

export interface HttpResponse {
  readonly url: string;
  readonly status: number;
  readonly headers: ReadonlyMap<string, string>;
  readonly body: Uint8Array;
  readonly truncated: boolean;
}

export interface TorFetchOptions {
  readonly proxy: TorProxy;
  readonly signal: AbortSignal;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  /** Override the request User-Agent (e.g. for APIs that reject browser agents). */
  readonly userAgent?: string;
}

interface TorRequest {
  readonly method: "GET" | "POST";
  readonly body: Uint8Array | undefined;
  readonly contentType: string | undefined;
}

const DEFAULT_TOR_PROXY: TorProxy = { host: "127.0.0.1", port: 9050 };
/** A cold onion connection (descriptor fetch, intro, rendezvous) measured 45-60s live. */
const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 5;
/** Tor Browser's user agent, so requests blend in with ordinary Tor traffic. */
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; rv:128.0) Gecko/20100101 Firefox/128.0";

const SOCKS_VERSION = 0x05;
const SOCKS_NO_AUTH = 0x00;
const SOCKS_CONNECT = 0x01;
const SOCKS_ADDRESS_IPV4 = 0x01;
const SOCKS_ADDRESS_DOMAIN = 0x03;
const SOCKS_ADDRESS_IPV6 = 0x04;
const SOCKS_SUCCEEDED = 0x00;

/** RFC 1928 reply codes plus Tor's extended onion-service codes (0xF0+). */
const SOCKS_REPLY_MESSAGES: Record<number, string> = {
  0x01: "general SOCKS server failure",
  0x02: "connection not allowed by ruleset",
  0x03: "network unreachable",
  0x04: "host unreachable (the onion service may be offline)",
  0x05: "connection refused",
  0x06: "TTL expired (the onion service did not answer in time)",
  0x07: "command not supported",
  0x08: "address type not supported",
  0xf0: "onion service descriptor not found (the service is offline or the address is wrong)",
  0xf1: "onion service descriptor is invalid",
  0xf2: "onion service introduction failed",
  0xf3: "onion service rendezvous failed",
  0xf4: "onion service requires client authorization",
  0xf5: "onion service client authorization was rejected",
  0xf6: "invalid onion address",
  0xf7: "onion service introduction timed out",
};

const V3_ONION_HOST = /^(?:[a-z0-9-]+\.)*[a-z2-7]{56}\.onion$/;

export function isOnionHost(hostname: string): boolean {
  return V3_ONION_HOST.test(hostname.toLowerCase());
}

/** Parses `JAZZ_TOR_PROXY` (`host:port`); Tor Browser users point it at 127.0.0.1:9150. */
export function torProxyFromEnvironment(value: string | undefined): TorProxy {
  if (value === undefined || value.trim() === "") {
    return DEFAULT_TOR_PROXY;
  }
  const separator = value.lastIndexOf(":");
  const port = Number(value.slice(separator + 1));
  if (separator <= 0 || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`JAZZ_TOR_PROXY must be host:port, got "${value}"`);
  }
  return { host: value.slice(0, separator), port };
}

class SocketReader {
  private buffered = Buffer.alloc(0);
  private waiter: (() => void) | undefined;
  private failure: Error | undefined;

  constructor(private readonly socket: Socket) {
    socket.on("data", this.onData);
    socket.on("error", this.onError);
    socket.on("close", this.onClose);
  }

  private readonly onData = (chunk: Buffer): void => {
    this.buffered = Buffer.concat([this.buffered, chunk]);
    this.waiter?.();
  };

  private readonly onError = (error: Error): void => {
    this.failure = error;
    this.waiter?.();
  };

  private readonly onClose = (): void => {
    this.failure ??= new Error("Tor proxy closed the connection");
    this.waiter?.();
  };

  async read(length: number): Promise<Buffer> {
    while (this.buffered.length < length) {
      if (this.failure) {
        throw this.failure;
      }
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
      this.waiter = undefined;
    }
    const result = this.buffered.subarray(0, length);
    this.buffered = this.buffered.subarray(length);
    return result;
  }

  detach(): void {
    this.socket.off("data", this.onData);
    this.socket.off("error", this.onError);
    this.socket.off("close", this.onClose);
    this.socket.pause();
  }
}

function connectToProxy(proxy: TorProxy): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host: proxy.host, port: proxy.port });
    socket.once("connect", () => {
      socket.off("error", reject);
      resolve(socket);
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNREFUSED") {
        reject(
          new Error(
            `Tor is not reachable at ${proxy.host}:${proxy.port}. Start it with \`tor\` (or \`brew services start tor\`), or set JAZZ_TOR_PROXY.`,
          ),
        );
        return;
      }
      reject(error);
    });
  });
}

async function socksConnect(socket: Socket, hostname: string, port: number): Promise<void> {
  const reader = new SocketReader(socket);
  try {
    socket.write(Buffer.from([SOCKS_VERSION, 1, SOCKS_NO_AUTH]));
    const greeting = await reader.read(2);
    if (greeting[0] !== SOCKS_VERSION || greeting[1] !== SOCKS_NO_AUTH) {
      throw new Error("Tor proxy refused unauthenticated SOCKS5");
    }

    const hostBytes = Buffer.from(hostname, "utf8");
    if (hostBytes.length > 255) {
      throw new Error("hostname is too long for SOCKS5");
    }
    const request = Buffer.alloc(7 + hostBytes.length);
    request.set([SOCKS_VERSION, SOCKS_CONNECT, 0x00, SOCKS_ADDRESS_DOMAIN, hostBytes.length], 0);
    hostBytes.copy(request, 5);
    request.writeUInt16BE(port, 5 + hostBytes.length);
    socket.write(request);

    const reply = await reader.read(4);
    const replyCode = reply[1] ?? 0xff;
    if (replyCode !== SOCKS_SUCCEEDED) {
      const reason = SOCKS_REPLY_MESSAGES[replyCode] ?? `SOCKS error 0x${replyCode.toString(16)}`;
      throw new Error(`Tor could not reach ${hostname}: ${reason}`);
    }
    const addressType = reply[3];
    if (addressType === SOCKS_ADDRESS_IPV4) {
      await reader.read(4 + 2);
    } else if (addressType === SOCKS_ADDRESS_IPV6) {
      await reader.read(16 + 2);
    } else if (addressType === SOCKS_ADDRESS_DOMAIN) {
      const [domainLength = 0] = await reader.read(1);
      await reader.read(domainLength + 2);
    } else {
      throw new Error("Tor proxy sent an unknown SOCKS5 address type");
    }
  } finally {
    reader.detach();
  }
}

function upgradeToTls(socket: Socket, hostname: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    // An onion address is the hash of the service's key, so Tor already authenticates the
    // endpoint; onion HTTPS certificates are mostly self-signed and would otherwise fail.
    const secure = tlsConnect({ socket, servername: hostname, rejectUnauthorized: false });
    secure.once("secureConnect", () => resolve(secure));
    secure.once("error", reject);
  });
}

function headerEndIndex(buffer: Buffer): number {
  return buffer.indexOf("\r\n\r\n");
}

type BodyFraming =
  | { readonly kind: "length"; readonly totalBytes: number }
  | { readonly kind: "chunked" }
  | { readonly kind: "until-close" };

function bodyFraming(head: string, headerEnd: number): BodyFraming {
  const lowered = head.toLowerCase();
  if (/\r\ntransfer-encoding:[^\r]*chunked/.test(lowered)) {
    return { kind: "chunked" };
  }
  const contentLength = /\r\ncontent-length:\s*(\d+)/.exec(lowered)?.[1];
  if (contentLength !== undefined) {
    return { kind: "length", totalBytes: headerEnd + 4 + Number(contentLength) };
  }
  return { kind: "until-close" };
}

const CHUNKED_TERMINATOR = "0\r\n\r\n";

/**
 * Reads until the server closes, the body's declared framing is satisfied (some servers ignore
 * `Connection: close`), or the byte cap is hit.
 */
function readResponse(
  socket: Socket,
  maxResponseBytes: number,
): Promise<{ raw: Buffer; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    let framing: BodyFraming | undefined;
    let tail = "";
    const finish = (truncated: boolean): void => {
      socket.destroy();
      resolve({ raw: Buffer.concat(chunks), truncated });
    };
    socket.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      received += chunk.length;
      if (received >= maxResponseBytes) {
        finish(true);
        return;
      }
      if (framing === undefined) {
        const soFar = Buffer.concat(chunks);
        const headerEnd = headerEndIndex(soFar);
        if (headerEnd >= 0) {
          framing = bodyFraming(soFar.subarray(0, headerEnd).toString("latin1"), headerEnd);
        }
      }
      tail = (tail + chunk.subarray(-CHUNKED_TERMINATOR.length).toString("latin1")).slice(
        -CHUNKED_TERMINATOR.length,
      );
      if (
        (framing?.kind === "length" && received >= framing.totalBytes) ||
        (framing?.kind === "chunked" && tail === CHUNKED_TERMINATOR)
      ) {
        finish(false);
      }
    });
    socket.once("end", () => finish(false));
    socket.once("error", reject);
    socket.resume();
  });
}

export function decodeChunked(body: Buffer): Buffer {
  const parts: Buffer[] = [];
  let offset = 0;
  while (offset < body.length) {
    const lineEnd = body.indexOf("\r\n", offset);
    if (lineEnd < 0) {
      break;
    }
    const size = Number.parseInt(
      body.subarray(offset, lineEnd).toString("latin1").split(";")[0] ?? "",
      16,
    );
    if (!Number.isFinite(size) || size === 0) {
      break;
    }
    const start = lineEnd + 2;
    parts.push(body.subarray(start, Math.min(start + size, body.length)));
    offset = start + size + 2;
  }
  return Buffer.concat(parts);
}

export function parseHttpResponse(raw: Buffer, url: string, truncated: boolean): HttpResponse {
  const headerEnd = headerEndIndex(raw);
  if (headerEnd < 0) {
    throw new Error(`${url} returned no HTTP response`);
  }
  const [statusLine = "", ...headerLines] = raw
    .subarray(0, headerEnd)
    .toString("latin1")
    .split("\r\n");
  const status = Number(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(statusLine)?.[1]);
  if (!Number.isInteger(status)) {
    throw new Error(`${url} returned a malformed status line`);
  }
  const headers = new Map<string, string>();
  for (const line of headerLines) {
    const separator = line.indexOf(":");
    if (separator > 0) {
      headers.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim());
    }
  }
  const rawBody = raw.subarray(headerEnd + 4);
  const body = headers.get("transfer-encoding")?.toLowerCase().includes("chunked")
    ? decodeChunked(rawBody)
    : rawBody;
  return { url, status, headers, body, truncated };
}

async function requestOnce(
  target: URL,
  request: TorRequest,
  options: TorFetchOptions,
  signal: AbortSignal,
): Promise<HttpResponse> {
  const secure = target.protocol === "https:";
  const port = target.port === "" ? (secure ? 443 : 80) : Number(target.port);
  let socket = await connectToProxy(options.proxy);
  const abort = (): void => {
    socket.destroy(new Error("request aborted"));
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    await socksConnect(socket, target.hostname, port);
    if (secure) {
      socket = await upgradeToTls(socket, target.hostname);
    }
    const hostHeader = target.port === "" ? target.hostname : `${target.hostname}:${target.port}`;
    const lines = [
      `${request.method} ${target.pathname}${target.search} HTTP/1.1`,
      `Host: ${hostHeader}`,
      `User-Agent: ${options.userAgent ?? USER_AGENT}`,
      "Accept: text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
      "Accept-Language: en-US,en;q=0.5",
      "Accept-Encoding: identity",
    ];
    if (request.method === "POST") {
      lines.push(`Content-Type: ${request.contentType ?? "application/x-www-form-urlencoded"}`);
      lines.push(`Content-Length: ${request.body?.byteLength ?? 0}`);
    }
    lines.push("Connection: close", "", "");
    socket.write(lines.join("\r\n"));
    if (request.body !== undefined) {
      socket.write(Buffer.from(request.body));
    }
    const { raw, truncated } = await readResponse(
      socket,
      options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
    );
    return parseHttpResponse(raw, target.toString(), truncated);
  } catch (error) {
    if (signal.aborted) {
      throw new Error(`Request to ${target.hostname} timed out or was cancelled`);
    }
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
    socket.destroy();
  }
}

async function followRedirects(
  url: string,
  options: TorFetchOptions,
  request: TorRequest,
): Promise<HttpResponse> {
  const signal = AbortSignal.any([
    options.signal,
    AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  ]);
  let target = new URL(url);
  let current = request;
  for (let redirects = 0; ; redirects++) {
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      throw new Error(`Unsupported protocol ${target.protocol}`);
    }
    if (!isOnionHost(target.hostname)) {
      throw new Error(`${target.hostname} is not a v3 .onion address`);
    }
    const response = await requestOnce(target, current, options, signal);
    const location = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || location === undefined) {
      return response;
    }
    if (redirects >= MAX_REDIRECTS) {
      throw new Error(`Too many redirects from ${url}`);
    }
    target = new URL(location, target);
    // 301/302/303 drop the body and switch to GET; 307/308 keep method and body.
    if (response.status === 303 || (current.method === "POST" && response.status <= 302)) {
      current = { method: "GET", body: undefined, contentType: undefined };
    }
  }
}

/** GETs an onion URL over Tor, following redirects that stay on onion hosts. */
export function torFetch(url: string, options: TorFetchOptions): Promise<HttpResponse> {
  return followRedirects(url, options, { method: "GET", body: undefined, contentType: undefined });
}

/**
 * POSTs a body to an onion URL over Tor. `contentType` defaults to
 * `application/x-www-form-urlencoded` when omitted.
 */
export function torPost(
  url: string,
  body: string,
  options: TorFetchOptions,
  contentType?: string,
): Promise<HttpResponse> {
  return followRedirects(url, options, {
    method: "POST",
    body: new TextEncoder().encode(body),
    contentType,
  });
}
