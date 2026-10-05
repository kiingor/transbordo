import type { Config } from "./config.js";
import { setTimeout as delay } from "node:timers/promises";
import {
  type Evolution,
  isPerson,
  normalizeJid,
  object,
  string,
  syncContacts,
  transport,
  type Transport,
} from "./evolution.js";
import { AppError, digest } from "./security.js";
import type { Connection, Store } from "./store.js";

export function validSignalUrl(value: string, config: Config): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AppError(400, "INVALID_SIGNAL_WEBHOOK");
  }
  if (!config.SIGNAL_API_ORIGIN) throw new AppError(503, "SIGNAL_NOT_CONFIGURED");
  if (
    url.origin !== new URL(config.SIGNAL_API_ORIGIN).origin ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^\/webhooks\/evolution\/[A-Za-z0-9_-]{16,64}\/[A-Za-z0-9_-]{32,128}$/.test(url.pathname)
  ) {
    throw new AppError(400, "INVALID_SIGNAL_WEBHOOK");
  }
  return url.toString();
}
// Provider callback URLs and keys are not part of the Signal message contract.
function scrub(value: unknown, depth = 0): unknown {
  if (depth > 40) return null;
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key]) => !/apikey|authorization|password|secret|token|destination|server_url/i.test(key),
      )
      .map(([key, item]) => [key, scrub(item, depth + 1)]),
  );
}

export function receive(store: Store, c: Connection, input: unknown) {
  const root = object(input);
  if (root.instance !== c.instance) throw new AppError(403, "INSTANCE_MISMATCH");
  const event = string(root.event)
    .toUpperCase()
    .replace(/[.\s-]/g, "_");
  if (event === "CONNECTION_UPDATE") {
    const data = object(root.data);
    const state = string(data.state) || "close";
    const sender = normalizeJid(string(root.sender));
    store.db
      .prepare("UPDATE connections SET state=?,number=COALESCE(?,number) WHERE id=?")
      .run(state, sender.endsWith("@s.whatsapp.net") ? sender.split("@")[0]! : null, c.id);
    store.queueDeviceUpdate(c.id);
    return { accepted: true, status: "connection" };
  }
  if (["CONTACTS_SET", "CONTACTS_UPSERT", "CONTACTS_UPDATE"].includes(event)) {
    syncContacts(store, c.id, Array.isArray(root.data) ? root.data : [root.data]);
    return { accepted: true, status: "contacts" };
  }
  if (!["MESSAGES_UPSERT", "MESSAGES_UPDATE", "MESSAGES_STATUS"].includes(event)) {
    return { accepted: true, status: "ignored" };
  }
  const dataList = Array.isArray(root.data) ? root.data : [root.data];
  if (!dataList.length || dataList.length > 1000) throw new AppError(400, "INVALID_EVENT");
  return store.transaction(() => {
    const results = dataList.map((raw) => {
      const data = object(raw),
        key = object(data.key);
      const peer = normalizeJid(string(key.remoteJid) || string(data.remoteJid));
      const messageId = string(key.id) || string(data.keyId) || string(data.id);
      if (!peer || !messageId) throw new AppError(400, "INVALID_EVENT");
      const alternate = normalizeJid(
        string(key.remoteJidAlt) ||
          string(data.remoteJidAlt) ||
          string(key.senderPn) ||
          string(data.senderPn),
      );
      if (isPerson(peer)) {
        const canonical =
          peer.endsWith("@lid") && alternate.endsWith("@s.whatsapp.net")
            ? alternate
            : store.canonical(c.id, peer);
        store.upsertContact(
          c.id,
          canonical,
          key.fromMe || data.fromMe ? "" : string(data.pushName),
          canonical.endsWith("@s.whatsapp.net") ? canonical.split("@")[0]! : null,
        );
        if (canonical !== peer) store.linkAlias(c.id, peer, canonical);
      }
      const clean = scrub({ ...root, data: raw });
      const status =
        event === "MESSAGES_UPSERT" ? "" : JSON.stringify(data.status ?? data.update ?? "");
      const dedupe = digest(`${event}:${messageId}:${peer}:${status}`);
      const timestamp = Number(data.messageTimestamp);
      const occurredAt =
        Number.isFinite(timestamp) && timestamp > 0
          ? timestamp < 1e12
            ? timestamp * 1000
            : timestamp
          : Date.parse(string(root.date_time));
      const unresolvedWithExclusions =
        peer.endsWith("@lid") &&
        store.canonical(c.id, peer) === peer &&
        !!store.db
          .prepare("SELECT 1 FROM contacts WHERE connection_id=? AND ignored=1 LIMIT 1")
          .get(c.id);
      const policy = store.contactPolicy(c, peer);
      const reason = !isPerson(peer)
        ? "UNSUPPORTED_CHAT"
        : policy.reason
          ? policy.reason
          : event === "MESSAGES_UPSERT" && policy.since && occurredAt < policy.since
            ? "BEFORE_ACTIVATION"
            : unresolvedWithExclusions
              ? "IDENTITY_UNRESOLVED"
              : !store.signalUrl(c)
                ? "SIGNAL_NOT_CONFIGURED"
                : undefined;
      return store.enqueue(c, dedupe, event, peer, clean, reason);
    });
    return { accepted: true, events: results };
  });
}

export class Dispatcher {
  private running = false;
  private stopped = false;
  private activeDevice: string | undefined;
  constructor(
    private store: Store,
    private config: Config,
    private fetcher: Transport = transport(config),
  ) {}
  async tick(): Promise<boolean> {
    if (this.running || this.stopped) return false;
    this.running = true;
    try {
      const job = this.store.claim();
      if (!job) return false;
      const c = this.store.connection(job.connection_id);
      this.activeDevice = c.id;
      const policy = this.store.contactPolicy(c, job.peer);
      if (
        !job.payload ||
        job.last_error === "DESTINATION_CHANGED" ||
        (job.event !== "DEVICE_UPDATE" &&
          (!policy.enabled ||
            ["OVERFLOW_DISABLED", "CONTACT_IGNORED"].includes(job.last_error ?? "")))
      ) {
        this.store.finish(
          job.id,
          "ignored",
          job.last_error ?? policy.reason ?? "OVERFLOW_DISABLED",
        );
        return true;
      }
      if (Date.now() - job.created_at > 24 * 3600_000) {
        this.store.finish(job.id, "failed", "DELIVERY_EXPIRED");
        return true;
      }
      let error = "SIGNAL_UNREACHABLE";
      let retryable = true;
      try {
        const url = validSignalUrl(this.store.signalUrl(c) ?? "", this.config);
        let payload = this.store.vault.open<Record<string, unknown>>(job.payload, job.id);
        if (this.store.platform().signalUrl) {
          payload = {
            ...payload,
            ...this.store.deviceEnvelope(c),
            instance: this.store.platform().id,
          };
        }
        const response = await this.fetcher(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
          redirect: "manual",
        });
        if (response.ok) {
          this.store.finish(job.id, "delivered");
          return true;
        }
        error = `SIGNAL_HTTP_${response.status}`;
        retryable = response.status === 429 || response.status >= 500;
      } catch (e) {
        if (e instanceof AppError) {
          error = e.code;
          retryable = false;
        }
      }
      const retry = retryable && job.attempts < 12;
      this.store.finish(
        job.id,
        retry ? "pending" : "failed",
        error,
        Date.now() + Math.min(300_000, 1000 * 2 ** job.attempts),
      );
      return true;
    } finally {
      this.activeDevice = undefined;
      this.running = false;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    while (this.running) await delay(25);
  }
  async waitForDevice(id: string): Promise<void> {
    while (this.activeDevice === id) await delay(25);
  }
}

const bridgeRoutes = new Set([
  "GET instance/connectionState",
  "POST message/sendText",
  "POST message/sendList",
  "POST message/sendMedia",
  "POST message/sendWhatsAppAudio",
  "POST message/sendContact",
  "POST message/sendReaction",
  "POST chat/whatsappNumbers",
  "POST chat/getBase64FromMediaMessage",
  "POST chat/sendPresence",
  "POST chat/markMessageAsRead",
  "POST instance/setPresence",
  "GET settings/find",
]);
export async function bridge(
  evolution: Evolution,
  c: Connection,
  method: string,
  category: string,
  action: string,
  instance: string,
  body: unknown,
) {
  if (instance !== c.instance) throw new AppError(403, "INSTANCE_MISMATCH");
  const route = `${method} ${category}/${action}`;
  if (!bridgeRoutes.has(route)) throw new AppError(403, "BRIDGE_OPERATION_NOT_ALLOWED");
  const data = object(body);
  if (method !== "GET") {
    const values =
      action === "whatsappNumbers"
        ? data.numbers
        : action === "markMessageAsRead"
          ? Array.isArray(data.readMessages)
            ? data.readMessages.map((v) => object(v).remoteJid)
            : []
          : [data.number ?? object(data.key).remoteJid];
    const peers = (Array.isArray(values) ? values : []).map((v) => normalizeJid(string(v)));
    if ((category === "message" || action === "sendPresence") && peers.length !== 1)
      throw new AppError(400, "INVALID_RECIPIENT");
    // Signal retrieves media by message ID, without a recipient. These two operations
    // do not send messages; allow them when this device has any effective overflow.
    if (action === "setPresence" || action === "getBase64FromMediaMessage") {
      if (!evolution.store.hasActiveOverflow(c.id)) throw new AppError(409, "OVERFLOW_DISABLED");
    } else {
      if (!peers.length || peers.some((peer) => !isPerson(peer)))
        throw new AppError(400, "INVALID_RECIPIENT");
      for (const peer of peers) {
        const policy = evolution.store.contactPolicy(c, peer);
        if (policy.reason) throw new AppError(409, policy.reason);
      }
    }
  }
  try {
    const response = await evolution.request(
      c,
      `${category}/${action}/${encodeURIComponent(c.instance)}`,
      method,
      method === "GET" ? undefined : body,
    );
    // Do not expose upstream error bodies or headers, which may contain credentials.
    if (!response.ok)
      return { status: response.status, body: { error: `EVOLUTION_HTTP_${response.status}` } };
    return { status: response.status, body: scrub(await response.json()) };
  } catch (error) {
    if (error instanceof AppError) throw error;
    // Evolution may have accepted the message before the socket failed. Signal understands
    // 424 as ambiguous and must not automatically repeat a possibly delivered message.
    if (category === "message") return { status: 424, body: { error: "DELIVERY_UNKNOWN" } };
    throw new AppError(502, "EVOLUTION_UNREACHABLE");
  }
}
