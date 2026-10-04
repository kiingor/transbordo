import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { AppError, digest, token, Vault } from "./security.js";

export interface Connection {
  id: string;
  name: string;
  instance: string;
  managed: number;
  overflow: number;
  state: string;
  number: string | null;
  secrets: string;
  bridge_hash: string;
  webhook_hash: string;
  signal_configured: number;
  webhook_configured: number;
  last_sync: number | null;
  created_at: number;
  enabled_at: number | null;
}
export interface Secrets {
  evolutionKey: string;
  webhookToken: string;
  signalUrl?: string;
}
export interface User {
  id: string;
  name: string;
  email: string;
  password: string;
  role: "admin" | "operator";
  active: number;
}
export interface Contact {
  connection_id: string;
  jid: string;
  name: string;
  phone: string | null;
  ignored: number;
  updated_at: number;
}
export interface Delivery {
  id: string;
  connection_id: string;
  dedupe: string;
  event: string;
  peer: string;
  payload: string | null;
  status: string;
  attempts: number;
  next_at: number;
  lease_until: number | null;
  last_error: string | null;
  created_at: number;
}

export class Store {
  readonly db: DatabaseSync;
  readonly vault: Vault;
  constructor(path: string, key: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.vault = new Vault(Buffer.from(key, "base64"));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','operator')), active INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS sessions (
        hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS connections (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, instance TEXT NOT NULL UNIQUE, managed INTEGER NOT NULL,
        overflow INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'close', number TEXT,
        secrets TEXT NOT NULL, bridge_hash TEXT NOT NULL, webhook_hash TEXT NOT NULL,
        signal_configured INTEGER NOT NULL DEFAULT 0, webhook_configured INTEGER NOT NULL DEFAULT 0,
        last_sync INTEGER, enabled_at INTEGER, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS contacts (
        connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE, jid TEXT NOT NULL,
        name TEXT NOT NULL, phone TEXT, ignored INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL,
        PRIMARY KEY(connection_id,jid));
      CREATE TABLE IF NOT EXISTS aliases (
        connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
        alias TEXT NOT NULL, canonical TEXT NOT NULL, PRIMARY KEY(connection_id,alias));
      CREATE TABLE IF NOT EXISTS deliveries (
        id TEXT PRIMARY KEY, connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
        dedupe TEXT NOT NULL, event TEXT NOT NULL, peer TEXT NOT NULL, payload TEXT,
        status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL,
        lease_until INTEGER, last_error TEXT, created_at INTEGER NOT NULL,
        UNIQUE(connection_id,dedupe));
      CREATE INDEX IF NOT EXISTS deliveries_due ON deliveries(status,next_at);
      CREATE INDEX IF NOT EXISTS deliveries_connection ON deliveries(connection_id,created_at);
      CREATE TABLE IF NOT EXISTS audit (
        id INTEGER PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL, connection_id TEXT,
        detail TEXT NOT NULL, created_at INTEGER NOT NULL);
      PRAGMA user_version=1;`);
  }
  transaction<T>(fn: () => T): T {
    if (this.db.isTransaction) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  connection(id: string): Connection {
    const row = this.db.prepare("SELECT * FROM connections WHERE id=?").get(id) as unknown as
      | Connection
      | undefined;
    if (!row) throw new AppError(404, "CONNECTION_NOT_FOUND");
    return row;
  }
  secrets(c: Connection): Secrets {
    return this.vault.open(c.secrets, c.id);
  }
  setSecrets(c: Connection, secrets: Secrets) {
    this.db
      .prepare("UPDATE connections SET secrets=?, signal_configured=? WHERE id=?")
      .run(this.vault.seal(secrets, c.id), secrets.signalUrl ? 1 : 0, c.id);
  }
  createConnection(input: { name: string; instance?: string; evolutionKey?: string }) {
    const id = randomUUID();
    const instance = input.instance ?? `portal-${id}`;
    const bridgeKey = token(),
      webhookToken = token();
    const secrets: Secrets = { evolutionKey: input.evolutionKey ?? token(), webhookToken };
    this.db
      .prepare(`INSERT INTO connections(id,name,instance,managed,secrets,bridge_hash,webhook_hash,created_at)
      VALUES(?,?,?,?,?,?,?,?)`)
      .run(
        id,
        input.name,
        instance,
        input.instance ? 0 : 1,
        this.vault.seal(secrets, id),
        digest(bridgeKey),
        digest(webhookToken),
        Date.now(),
      );
    return { connection: this.connection(id), bridgeKey };
  }
  listConnections() {
    return this.db
      .prepare(`SELECT c.id,c.name,c.instance,c.managed,c.overflow,c.state,c.number,
      c.signal_configured,c.webhook_configured,c.last_sync,c.created_at,
      (SELECT count(*) FROM contacts WHERE connection_id=c.id) AS contacts,
      (SELECT count(*) FROM contacts WHERE connection_id=c.id AND ignored=1) AS ignored,
      (SELECT count(*) FROM deliveries WHERE connection_id=c.id AND status IN ('pending','processing')) AS pending,
      (SELECT count(*) FROM deliveries WHERE connection_id=c.id AND status='failed') AS failed
      FROM connections c ORDER BY c.created_at DESC`)
      .all();
  }
  setOverflow(id: string, enabled: boolean, actor: string) {
    this.transaction(() => {
      const c = this.connection(id);
      if (enabled && (!c.signal_configured || !c.webhook_configured))
        throw new AppError(409, "CONNECTION_SETUP_REQUIRED");
      this.db
        .prepare("UPDATE connections SET overflow=?,enabled_at=? WHERE id=?")
        .run(
          enabled ? 1 : 0,
          enabled && !c.overflow ? Math.floor(Date.now() / 1000) * 1000 : c.enabled_at,
          id,
        );
      if (!enabled) {
        this.db
          .prepare(`UPDATE deliveries SET status='ignored',payload=NULL,last_error='OVERFLOW_DISABLED'
          WHERE connection_id=? AND status='pending'`)
          .run(id);
        this.db
          .prepare(`UPDATE deliveries SET last_error='OVERFLOW_DISABLED'
          WHERE connection_id=? AND status='processing'`)
          .run(id);
      }
      this.audit(actor, enabled ? "overflow.enabled" : "overflow.disabled", id);
    });
  }
  canonical(id: string, jid: string): string {
    const row = this.db
      .prepare("SELECT canonical FROM aliases WHERE connection_id=? AND alias=?")
      .get(id, jid) as { canonical: string } | undefined;
    return row?.canonical ?? jid;
  }
  linkAlias(id: string, alias: string, canonical: string) {
    if (alias === canonical) return;
    this.db
      .prepare(
        `INSERT INTO aliases VALUES(?,?,?) ON CONFLICT(connection_id,alias) DO UPDATE SET canonical=excluded.canonical`,
      )
      .run(id, alias, canonical);
    const old = this.db
      .prepare("SELECT * FROM contacts WHERE connection_id=? AND jid=?")
      .get(id, alias) as unknown as Contact | undefined;
    if (old) {
      this.upsertContact(id, canonical, old.name, old.phone);
      if (old.ignored)
        this.db
          .prepare("UPDATE contacts SET ignored=1 WHERE connection_id=? AND jid=?")
          .run(id, canonical);
    }
  }
  upsertContact(id: string, jid: string, name: string, phone: string | null) {
    this.db
      .prepare(`INSERT INTO contacts VALUES(?,?,?,?,0,?) ON CONFLICT(connection_id,jid) DO UPDATE SET
      name=CASE WHEN excluded.name<>'' THEN excluded.name ELSE contacts.name END,
      phone=COALESCE(excluded.phone,contacts.phone),updated_at=excluded.updated_at`)
      .run(id, jid, name, phone, Date.now());
  }
  isIgnored(id: string, peer: string): boolean {
    const canonical = this.canonical(id, peer);
    return !!this.db
      .prepare("SELECT 1 FROM contacts WHERE connection_id=? AND jid IN (?,?) AND ignored=1")
      .get(id, peer, canonical);
  }
  setIgnored(id: string, jid: string, ignored: boolean, actor: string) {
    const canonical = this.canonical(id, jid);
    this.transaction(() => {
      const changed = this.db
        .prepare("UPDATE contacts SET ignored=? WHERE connection_id=? AND jid IN (?,?)")
        .run(ignored ? 1 : 0, id, jid, canonical);
      if (!changed.changes) throw new AppError(404, "CONTACT_NOT_FOUND");
      if (ignored)
        this.db
          .prepare(`UPDATE deliveries SET
        status=CASE WHEN status='pending' THEN 'ignored' ELSE status END,
        payload=CASE WHEN status='pending' THEN NULL ELSE payload END,last_error='CONTACT_IGNORED'
        WHERE connection_id=? AND status IN ('pending','processing') AND (peer IN (?,?) OR peer IN
          (SELECT alias FROM aliases WHERE connection_id=? AND canonical=?))`)
          .run(id, jid, canonical, id, canonical);
      this.audit(actor, ignored ? "contact.ignored" : "contact.allowed", id);
    });
  }
  enqueue(
    c: Connection,
    dedupe: string,
    event: string,
    peer: string,
    payload: unknown,
    reason?: string,
  ) {
    const id = randomUUID(),
      now = Date.now();
    const result = this.db
      .prepare(`INSERT OR IGNORE INTO deliveries
      (id,connection_id,dedupe,event,peer,payload,status,next_at,last_error,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`)
      .run(
        id,
        c.id,
        dedupe,
        event,
        peer,
        reason ? null : this.vault.seal(payload, id),
        reason ? "ignored" : "pending",
        now,
        reason ?? null,
        now,
      );
    return { duplicate: !result.changes, ignored: !!reason };
  }
  claim(): Delivery | undefined {
    const now = Date.now();
    return this.transaction(() => {
      const row = this.db
        .prepare(`SELECT * FROM deliveries WHERE (status='pending' AND next_at<=?)
        OR (status='processing' AND lease_until<?) ORDER BY created_at,id LIMIT 1`)
        .get(now, now) as unknown as Delivery | undefined;
      if (!row) return;
      this.db
        .prepare(
          `UPDATE deliveries SET status='processing',attempts=attempts+1,lease_until=? WHERE id=?`,
        )
        .run(now + 60_000, row.id);
      return { ...row, attempts: row.attempts + 1 };
    });
  }
  finish(id: string, status: string, error: string | null = null, nextAt = Date.now()) {
    const current = this.db.prepare("SELECT last_error FROM deliveries WHERE id=?").get(id);
    if (
      status !== "delivered" &&
      ["OVERFLOW_DISABLED", "CONTACT_IGNORED"].includes(String(current?.last_error))
    ) {
      status = "ignored";
      error = String(current?.last_error);
    }
    this.db
      .prepare(`UPDATE deliveries SET status=?,last_error=?,next_at=?,lease_until=NULL,
      payload=CASE WHEN ? IN ('delivered','ignored','failed') THEN NULL ELSE payload END
      WHERE id=? AND status='processing'`)
      .run(status, error, nextAt, status, id);
  }
  audit(actor: string, action: string, id: string | null = null, detail = "") {
    this.db
      .prepare("INSERT INTO audit(actor,action,connection_id,detail,created_at) VALUES(?,?,?,?,?)")
      .run(actor, action, id, detail, Date.now());
  }
  prune() {
    const now = Date.now();
    this.db.prepare("DELETE FROM sessions WHERE expires_at<?").run(now);
    this.db
      .prepare(
        `DELETE FROM deliveries WHERE status IN ('delivered','ignored','failed') AND created_at<?`,
      )
      .run(now - 30 * 86400000);
    this.db.prepare("DELETE FROM audit WHERE created_at<?").run(now - 90 * 86400000);
  }
  close() {
    this.db.close();
  }
}
