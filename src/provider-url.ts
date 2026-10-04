import { lookup } from "node:dns/promises";
import * as http from "node:http";
import * as https from "node:https";
import type { LookupFunction } from "node:net";
import { BlockList, isIP } from "node:net";

export interface ProviderUrlPolicy {
  environment: "development" | "test" | "production";
  allowPrivateNetworks: boolean;
}

export interface ResolvedProviderUrlTarget {
  url: URL;
  address: string;
  family: 4 | 6;
  /** A DNS lookup callback that never consults DNS again. */
  lookup: LookupFunction;
}

export type ProviderUrlResolver = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<Array<{ address: string; family: number }>>;

export interface ProviderFetchOptions {
  policy: ProviderUrlPolicy;
  timeoutMs: number;
  maxRequestBytes?: number | undefined;
  maxResponseBytes?: number | undefined;
  resolver?: ProviderUrlResolver | undefined;
}

export async function assertProviderUrlAllowed(
  value: string,
  policy: ProviderUrlPolicy,
): Promise<void> {
  await resolveProviderUrlTarget(value, policy);
}

/**
 * Resolves and validates every address, then returns one address that callers
 * can pin on the socket. Pinning prevents a second DNS lookup from turning a
 * validated public hostname into a private destination (DNS rebinding).
 */
export async function resolveProviderUrlTarget(
  value: string,
  policy: ProviderUrlPolicy,
  dependencies: { resolver?: ProviderUrlResolver | undefined } = {},
): Promise<ResolvedProviderUrlTarget> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("PROVIDER_URL_NOT_ALLOWED");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("PROVIDER_URL_NOT_ALLOWED");
  }
  if (policy.environment === "production" && url.protocol !== "https:") {
    throw new Error("PROVIDER_HTTPS_REQUIRED");
  }

  const privateNetworksAllowed = policy.environment !== "production" && policy.allowPrivateNetworks;

  const hostname = url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (!privateNetworksAllowed && (hostname === "localhost" || hostname.endsWith(".local"))) {
    throw new Error("PROVIDER_PRIVATE_HOST_BLOCKED");
  }

  const literalFamily = isIP(hostname);
  const resolver: ProviderUrlResolver = dependencies.resolver ?? lookup;
  const addresses = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : await resolver(hostname, { all: true, verbatim: true });
  if (addresses.length === 0) throw new Error("PROVIDER_HOST_UNRESOLVED");
  if (
    addresses.some(({ address, family }) => ![4, 6].includes(family) || isIP(address) !== family)
  ) {
    throw new Error("PROVIDER_HOST_UNRESOLVED");
  }
  if (
    !privateNetworksAllowed &&
    addresses.some(({ address, family }) =>
      family === 6
        ? blockedProviderIpv6Addresses.check(address, "ipv6")
        : blockedProviderIpv4Addresses.check(address, "ipv4"),
    )
  ) {
    throw new Error("PROVIDER_PRIVATE_ADDRESS_BLOCKED");
  }
  const selected = addresses[0];
  if (!selected) throw new Error("PROVIDER_HOST_UNRESOLVED");
  return {
    url,
    address: selected.address,
    family: selected.family === 6 ? 6 : 4,
    lookup: pinnedLookup(selected.address, selected.family === 6 ? 6 : 4),
  };
}

/**
 * Fetch-compatible HTTP transport for administrator-configured destinations.
 *
 * Each invocation performs a fresh all-address DNS validation and opens a new
 * socket whose lookup callback is pinned to the selected validated address.
 * Keeping the URL hostname in the request options preserves HTTP Host and TLS
 * SNI, while `agent: false` prevents a connection validated by an earlier
 * invocation from being silently reused. Redirects are returned, never
 * followed, and the timeout covers DNS, upload, and response download.
 */
export async function fetchProviderUrl(
  value: string | URL | Request,
  init: RequestInit = {},
  options: ProviderFetchOptions,
): Promise<Response> {
  const timeoutMs = Math.max(1, Math.trunc(options.timeoutMs));
  const maxRequestBytes = Math.max(1, Math.trunc(options.maxRequestBytes ?? 32 * 1024 * 1024));
  const maxResponseBytes = Math.max(1, Math.trunc(options.maxResponseBytes ?? 32 * 1024 * 1024));
  const deadline = Date.now() + timeoutMs;
  const request = new Request(value, { ...init, redirect: "manual" });
  if (request.signal.aborted) throw requestAbortError(request.signal);
  const target = await withDeadline(
    resolveProviderUrlTarget(request.url, options.policy, { resolver: options.resolver }),
    timeoutMs,
    request.signal,
  );
  const body = await readBoundedRequestBody(request, maxRequestBytes, deadline);
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) throw timeoutError();

  return new Promise<Response>((resolve, reject) => {
    const requestModule = target.url.protocol === "https:" ? https : http;
    const requestHostname = target.url.hostname.replace(/^\[|\]$/g, "");
    const tlsServername = requestHostname.replace(/\.$/, "");
    const headers = Object.fromEntries(request.headers.entries());
    // Never let a caller route a validated socket to a different HTTP virtual host.
    headers.host = target.url.host;
    if (!request.headers.has("accept-encoding")) headers["accept-encoding"] = "identity";
    const declaredRequestBytes = request.headers.get("content-length");
    if (declaredRequestBytes !== null) {
      if (
        !/^\d+$/.test(declaredRequestBytes) ||
        Number(declaredRequestBytes) !== (body?.byteLength ?? 0)
      ) {
        throw requestContentLengthMismatchError();
      }
    } else if (body) {
      headers["content-length"] = String(body.byteLength);
    }
    let settled = false;
    const finish = (operation: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.signal.removeEventListener("abort", abort);
      operation();
    };
    const outbound = requestModule.request(
      {
        protocol: target.url.protocol,
        hostname: requestHostname,
        port: target.url.port || undefined,
        path: `${target.url.pathname}${target.url.search}`,
        method: request.method,
        headers,
        lookup: target.lookup,
        family: target.family,
        agent: false,
        ...(target.url.protocol === "https:" && isIP(tlsServername) === 0
          ? { servername: tlsServername }
          : {}),
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        let responseBytes = 0;
        const declaredBytes = Number(incoming.headers["content-length"]);
        if (Number.isFinite(declaredBytes) && declaredBytes > maxResponseBytes) {
          incoming.destroy(responseTooLargeError());
        }
        incoming.on("data", (chunk: Buffer | Uint8Array) => {
          responseBytes += chunk.byteLength;
          if (responseBytes > maxResponseBytes) {
            incoming.destroy(responseTooLargeError());
            return;
          }
          chunks.push(Buffer.from(chunk));
        });
        incoming.once("error", (error) => finish(() => reject(error)));
        incoming.once("end", () => {
          const responseHeaders = new Headers();
          for (const [name, raw] of Object.entries(incoming.headers)) {
            if (Array.isArray(raw)) {
              for (const entry of raw) responseHeaders.append(name, entry);
            } else if (raw !== undefined) responseHeaders.set(name, raw);
          }
          finish(() => {
            const status = incoming.statusCode ?? 502;
            const responseBody =
              request.method === "HEAD" || [204, 205, 304].includes(status)
                ? null
                : Buffer.concat(chunks);
            resolve(
              new Response(responseBody, {
                status,
                ...(incoming.statusMessage ? { statusText: incoming.statusMessage } : {}),
                headers: responseHeaders,
              }),
            );
          });
        });
      },
    );
    const abort = () =>
      outbound.destroy(request.signal.reason ?? new DOMException("Aborted", "AbortError"));
    const timer = setTimeout(() => outbound.destroy(timeoutError()), remainingMs);
    timer.unref();
    request.signal.addEventListener("abort", abort, { once: true });
    outbound.once("error", (error) => finish(() => reject(error)));
    if (request.signal.aborted) abort();
    else outbound.end(body);
  });
}

function pinnedLookup(address: string, family: 4 | 6): LookupFunction {
  return (_hostname, options, callback) => {
    if (typeof options === "number") callback(null, address, family);
    else if (options?.all) callback(null, [{ address, family }]);
    else callback(null, address, family);
  };
}

async function readBoundedRequestBody(
  request: Request,
  maximum: number,
  deadline: number,
): Promise<Buffer | undefined> {
  if (!request.body) return undefined;
  const declared = request.headers.get("content-length");
  if (declared !== null && (/^\d+$/.test(declared) ? Number(declared) : Number.NaN) > maximum) {
    throw requestTooLargeError();
  }
  const reader = request.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await withDeadline(reader.read(), deadline - Date.now(), request.signal);
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximum) {
        await reader.cancel().catch(() => undefined);
        throw requestTooLargeError();
      }
      chunks.push(Buffer.from(next.value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

async function withDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  if (timeoutMs <= 0) throw timeoutError();
  if (signal?.aborted) throw requestAbortError(signal);
  let timer: NodeJS.Timeout | undefined;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(timeoutError()), timeoutMs);
        timer.unref();
      }),
      ...(signal
        ? [
            new Promise<never>((_resolve, reject) => {
              abort = () => reject(requestAbortError(signal));
              signal.addEventListener("abort", abort, { once: true });
            }),
          ]
        : []),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && abort) signal.removeEventListener("abort", abort);
  }
}

function requestAbortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError");
}

function timeoutError(): Error {
  const error = new Error("PROVIDER_REQUEST_TIMEOUT") as Error & { code: string };
  error.name = "TimeoutError";
  error.code = "ETIMEDOUT";
  return error;
}

function responseTooLargeError(): Error {
  const error = new Error("PROVIDER_RESPONSE_TOO_LARGE") as Error & { code: string };
  error.code = "ERR_RESPONSE_TOO_LARGE";
  return error;
}

function requestContentLengthMismatchError(): Error {
  const error = new Error("REQUEST_CONTENT_LENGTH_MISMATCH") as Error & { code: string };
  error.code = "ERR_REQUEST_CONTENT_LENGTH_MISMATCH";
  return error;
}

function requestTooLargeError(): Error {
  const error = new Error("REQUEST_BODY_TOO_LARGE") as Error & { code: string };
  error.code = "ERR_REQUEST_TOO_LARGE";
  return error;
}

// Keep families in separate lists. Node's BlockList normalizes IPv4 through
// IPv4-mapped IPv6 when both families share an instance, which made the
// ::ffff:0:0/96 rule accidentally match every public IPv4 address.
const blockedProviderIpv4Addresses = new BlockList();
const blockedProviderIpv6Addresses = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["192.175.48.0", 24],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blockedProviderIpv4Addresses.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 96],
  ["::ffff:0:0", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  blockedProviderIpv6Addresses.addSubnet(network, prefix, "ipv6");
}
