import type { Config } from "./config.js";
import { fetchProviderUrl } from "./provider-url.js";
import { AppError } from "./security.js";
import type { Connection, Store } from "./store.js";

export type Json = Record<string, unknown>;
export const object = (value: unknown): Json =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
export const string = (value: unknown): string => (typeof value === "string" ? value : "");
export type Transport = (url: string, init: RequestInit) => Promise<Response>;
export function transport(config: Config): Transport {
  return (url, init) =>
    fetchProviderUrl(url, init, {
      policy: {
        environment: config.NODE_ENV,
        allowPrivateNetworks: config.ALLOW_PRIVATE_NETWORKS === "true",
      },
      timeoutMs: 25_000,
      maxRequestBytes: 24 * 1024 * 1024,
      maxResponseBytes: 24 * 1024 * 1024,
    });
}
export class Evolution {
  constructor(
    readonly config: Config,
    readonly store: Store,
    readonly fetcher: Transport = transport(config),
  ) {}
  async request(
    c: Connection,
    path: string,
    method = "GET",
    body?: unknown,
    global = false,
  ): Promise<Response> {
    if (!this.config.EVOLUTION_URL) throw new AppError(503, "EVOLUTION_NOT_CONFIGURED");
    const key = global ? this.config.EVOLUTION_API_KEY : this.store.secrets(c).evolutionKey;
    if (!key) throw new AppError(503, "EVOLUTION_NOT_CONFIGURED");
    return this.fetcher(`${this.config.EVOLUTION_URL.replace(/\/+$/, "")}/${path}`, {
      method,
      headers: { apikey: key, "content-type": "application/json", accept: "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "manual",
    });
  }
  async json(
    c: Connection,
    path: string,
    method = "GET",
    body?: unknown,
    global = false,
  ): Promise<unknown> {
    const response = await this.request(c, path, method, body, global);
    if (!response.ok)
      throw new AppError(response.status >= 500 ? 503 : 422, `EVOLUTION_HTTP_${response.status}`);
    try {
      return await response.json();
    } catch {
      throw new AppError(502, "EVOLUTION_INVALID_RESPONSE");
    }
  }
  webhook(c: Connection) {
    return {
      enabled: true,
      url: `${this.config.PUBLIC_URL.replace(/\/+$/, "")}/hooks/${c.id}/${this.store.secrets(c).webhookToken}`,
      webhookByEvents: false,
      webhookBase64: false,
      byEvents: false,
      base64: false,
      events: [
        "MESSAGES_UPSERT",
        "MESSAGES_UPDATE",
        "CONNECTION_UPDATE",
        "CONTACTS_UPSERT",
        "CONTACTS_UPDATE",
      ],
    };
  }
  async connect(c: Connection) {
    // A persisted connection is reserved before provisioning. Retrying this operation reuses
    // its instance name and never creates a second number after an ambiguous response.
    let existing = await this.request(
      c,
      `instance/connectionState/${encodeURIComponent(c.instance)}`,
    );
    if (existing.status === 404 && c.managed) {
      await this.json(
        c,
        "instance/create",
        "POST",
        {
          instanceName: c.instance,
          token: this.store.secrets(c).evolutionKey,
          integration: "WHATSAPP-BAILEYS",
          qrcode: true,
          groupsIgnore: true,
          alwaysOnline: false,
          rejectCall: false,
          readMessages: false,
          readStatus: false,
          syncFullHistory: false,
          webhook: this.webhook(c),
        },
        true,
      );
    } else if (!existing.ok) {
      throw new AppError(422, `EVOLUTION_HTTP_${existing.status}`);
    }
    await this.json(c, `webhook/set/${encodeURIComponent(c.instance)}`, "POST", {
      webhook: this.webhook(c),
    });
    this.store.db.prepare("UPDATE connections SET webhook_configured=1 WHERE id=?").run(c.id);
    return this.pair(c);
  }
  async status(c: Connection) {
    const payload = object(
      await this.json(c, `instance/connectionState/${encodeURIComponent(c.instance)}`),
    );
    const state = string(object(payload.instance).state) || string(payload.state) || "close";
    this.store.db.prepare("UPDATE connections SET state=? WHERE id=?").run(state, c.id);
    return { state };
  }
  async pair(c: Connection) {
    const { state } = await this.status(c);
    if (state === "open") return { state, qrCode: null };
    const payload = object(
      await this.json(c, `instance/connect/${encodeURIComponent(c.instance)}`),
    );
    const qr = string(payload.base64) || string(object(payload.qrcode).base64);
    return { state, qrCode: /^data:image\/png;base64,[A-Za-z0-9+/=\r\n]+$/.test(qr) ? qr : null };
  }
  async sync(c: Connection) {
    const payload = await this.json(
      c,
      `chat/findContacts/${encodeURIComponent(c.instance)}`,
      "POST",
      { where: {} },
    );
    const rows = Array.isArray(payload) ? payload : object(payload).contacts;
    if (!Array.isArray(rows)) throw new AppError(502, "EVOLUTION_INVALID_CONTACTS");
    if (rows.length > 100_000) throw new AppError(413, "CONTACT_LIMIT_EXCEEDED");
    this.store.transaction(() => {
      syncContacts(this.store, c.id, rows);
      this.store.db.prepare("UPDATE connections SET last_sync=? WHERE id=?").run(Date.now(), c.id);
    });
    return { synced: rows.length };
  }
}

export function normalizeJid(input: string): string {
  const value = input.trim();
  if (/^\d+(?::\d+)?@(s\.whatsapp\.net|c\.us|lid)$/.test(value)) {
    return value.replace(/:\d+@/, "@").replace(/@c\.us$/, "@s.whatsapp.net");
  }
  const phone = value.replace(/[+\s().-]/g, "");
  return /^\d{5,32}$/.test(phone) ? `${phone}@s.whatsapp.net` : value;
}
export const isPerson = (jid: string) => /^\d{5,32}@(s\.whatsapp\.net|lid)$/.test(jid);
export function syncContacts(store: Store, id: string, values: unknown[]) {
  for (const value of values) {
    const item = object(value);
    const jid = normalizeJid(string(item.remoteJid) || string(item.id));
    if (!isPerson(jid)) continue;
    const alternate = normalizeJid(string(item.remoteJidAlt) || string(item.phoneNumber));
    const canonical =
      jid.endsWith("@lid") && alternate.endsWith("@s.whatsapp.net") ? alternate : jid;
    const phone = canonical.endsWith("@s.whatsapp.net") ? canonical.split("@")[0]! : null;
    store.upsertContact(
      id,
      canonical,
      string(item.name) || string(item.pushName) || string(item.verifiedName),
      phone,
    );
    if (jid !== canonical) store.linkAlias(id, jid, canonical);
    const lid = normalizeJid(string(item.lid));
    if (lid.endsWith("@lid") && canonical.endsWith("@s.whatsapp.net"))
      store.linkAlias(id, lid, canonical);
  }
}
