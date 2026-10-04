import Fastify, { type FastifyRequest, LogController } from "fastify";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { z } from "zod";
import type { Config } from "./config.js";
import { Evolution, normalizeJid, isPerson, object, type Transport } from "./evolution.js";
import { AppError, digest, equalSecret, hashPassword, token, verifyPassword } from "./security.js";
import { bridge, Dispatcher, receive, validSignalUrl } from "./routing.js";
import { Store, type User } from "./store.js";

const loginSchema = z
  .object({ email: z.email().max(254), password: z.string().min(1).max(256) })
  .strict();
const newConnection = z
  .object({
    name: z.string().trim().min(2).max(120),
    instance: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,120}$/)
      .optional(),
    evolutionKey: z.string().min(16).max(1000).optional(),
  })
  .strict()
  .refine((v) => !!v.instance === !!v.evolutionKey);
const newUser = loginSchema.extend({
  password: z.string().min(12).max(256),
  name: z.string().trim().min(2).max(120),
  role: z.enum(["admin", "operator"]),
});
const pageSchema = z.object({
  search: z.string().max(150).default(""),
  ignored: z.enum(["all", "true", "false"]).default("all"),
  page: z.coerce.number().int().min(1).max(10000).default(1),
});
const safeUser = (u: User) => ({ id: u.id, name: u.name, email: u.email, role: u.role });

export async function buildApp(
  config: Config,
  options: { store?: Store; transport?: Transport; logger?: boolean; publicDir?: string } = {},
) {
  const store = options.store ?? new Store(config.DATABASE_PATH, config.ENCRYPTION_KEY);
  const evolution = new Evolution(config, store, options.transport);
  const dispatcher = new Dispatcher(store, config, options.transport);
  const app = Fastify({
    logger: options.logger ?? true,
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 24 * 1024 * 1024,
    requestTimeout: 35_000,
    // Reverse proxy forwards to loopback; headers from untrusted clients never establish identity.
    trustProxy: config.NODE_ENV === "production" ? "127.0.0.1" : false,
  });
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
        upgradeInsecureRequests: config.NODE_ENV === "production" ? [] : null,
      },
    },
    hsts: config.NODE_ENV === "production",
  });
  await app.register(rateLimit, { global: true, max: 300, timeWindow: "1 minute" });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof z.ZodError) return reply.code(400).send({ error: "INVALID_INPUT" });
    if (error instanceof AppError) return reply.code(error.status).send({ error: error.code });
    if (
      (error as { code?: string }).code === "ERR_SQLITE_ERROR" &&
      /UNIQUE/.test((error as Error).message)
    )
      return reply.code(409).send({ error: "ALREADY_EXISTS" });
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500)
      return reply
        .code(status)
        .send({ error: status === 429 ? "TOO_MANY_REQUESTS" : "INVALID_REQUEST" });
    request.log.error(
      { code: "REQUEST_FAILED", route: request.routeOptions.url },
      "Portal request failed",
    );
    return reply.code(500).send({ error: "REQUEST_FAILED" });
  });
  app.addHook("onSend", async (request, reply) => {
    if (!request.url.startsWith("/assets/")) reply.header("cache-control", "no-store");
  });
  const origin = new URL(config.PUBLIC_URL).origin;
  function csrf(request: FastifyRequest) {
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method) && request.headers.origin !== origin)
      throw new AppError(403, "INVALID_ORIGIN");
  }
  function session(request: FastifyRequest): User {
    const cookie = request.headers.cookie
      ?.split(";")
      .map((v) => v.trim())
      .find((v) => v.startsWith("portal_session="))
      ?.slice(15);
    if (!cookie) throw new AppError(401, "LOGIN_REQUIRED");
    const user = store.db
      .prepare(`SELECT u.* FROM users u JOIN sessions s ON s.user_id=u.id
      WHERE s.hash=? AND s.expires_at>? AND u.active=1`)
      .get(digest(cookie), Date.now()) as unknown as User | undefined;
    if (!user) throw new AppError(401, "LOGIN_REQUIRED");
    return user;
  }
  function admin(request: FastifyRequest) {
    const user = session(request);
    if (user.role !== "admin") throw new AppError(403, "ADMIN_REQUIRED");
    return user;
  }
  const cookie = (value: string, maxAge: number) =>
    `portal_session=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${config.PUBLIC_URL.startsWith("https:") ? "; Secure" : ""}`;
  app.get("/health", async () => {
    store.db.prepare("SELECT 1").get();
    return { ok: true };
  });
  await app.register(async (api) => {
    api.addHook("onRequest", async (request) => {
      csrf(request);
      if (request.routeOptions.url !== "/api/login") session(request);
    });
    api.post(
      "/api/login",
      { config: { rateLimit: { max: 8, timeWindow: "1 minute" } }, bodyLimit: 4096 },
      async (request, reply) => {
        const body = loginSchema.parse(request.body);
        const user = store.db
          .prepare("SELECT * FROM users WHERE email=? COLLATE NOCASE")
          .get(body.email.trim()) as unknown as User | undefined;
        const valid = await verifyPassword(body.password, user?.password ?? "");
        if (!valid || !user?.active) throw new AppError(401, "INVALID_LOGIN");
        const value = token();
        store.db
          .prepare("INSERT INTO sessions VALUES(?,?,?)")
          .run(digest(value), user.id, Date.now() + 12 * 3600_000);
        store.audit(user.id, "session.created");
        reply.header("set-cookie", cookie(value, 12 * 3600));
        return { user: safeUser(user) };
      },
    );
    api.post("/api/logout", async (request, reply) => {
      const value = request.headers.cookie
        ?.split(";")
        .map((v) => v.trim())
        .find((v) => v.startsWith("portal_session="))
        ?.slice(15);
      if (value) store.db.prepare("DELETE FROM sessions WHERE hash=?").run(digest(value));
      reply.header("set-cookie", cookie("", 0));
      return { ok: true };
    });
    api.get("/api/me", async (request) => ({
      user: safeUser(session(request)),
      setup: {
        evolution: !!(config.EVOLUTION_URL && config.EVOLUTION_API_KEY),
        signal: !!config.SIGNAL_API_ORIGIN,
      },
    }));
    api.post("/api/password", { bodyLimit: 4096 }, async (request) => {
      const user = session(request);
      const body = z
        .object({ current: z.string().max(256), password: z.string().min(12).max(256) })
        .strict()
        .parse(request.body);
      if (!(await verifyPassword(body.current, user.password)))
        throw new AppError(401, "INVALID_PASSWORD");
      const hash = await hashPassword(body.password);
      store.transaction(() => {
        store.db.prepare("UPDATE users SET password=? WHERE id=?").run(hash, user.id);
        store.db.prepare("DELETE FROM sessions WHERE user_id=?").run(user.id);
        store.audit(user.id, "password.changed");
      });
      return { ok: true };
    });
    api.get("/api/users", async (request) => {
      admin(request);
      return {
        users: store.db.prepare("SELECT id,name,email,role,active FROM users ORDER BY name").all(),
      };
    });
    api.post("/api/users", { bodyLimit: 4096 }, async (request) => {
      const actor = admin(request),
        body = newUser.parse(request.body),
        id = randomUUID();
      const password = await hashPassword(body.password);
      store.db
        .prepare("INSERT INTO users VALUES(?,?,?,?,?,1)")
        .run(id, body.name, body.email.toLowerCase(), password, body.role);
      store.audit(actor.id, "user.created");
      return { id };
    });
    api.patch<{ Params: { id: string } }>("/api/users/:id", async (request) => {
      const actor = admin(request),
        { active } = z.object({ active: z.boolean() }).strict().parse(request.body);
      if (request.params.id === actor.id) throw new AppError(409, "CANNOT_DISABLE_SELF");
      store.transaction(() => {
        store.db
          .prepare("UPDATE users SET active=? WHERE id=?")
          .run(active ? 1 : 0, request.params.id);
        if (!active)
          store.db.prepare("DELETE FROM sessions WHERE user_id=?").run(request.params.id);
        store.audit(actor.id, active ? "user.enabled" : "user.disabled");
      });
      return { ok: true };
    });
    api.get("/api/connections", async () => ({ connections: store.listConnections() }));
    api.post("/api/connections", { bodyLimit: 8192 }, async (request, reply) => {
      const user = admin(request),
        body = newConnection.parse(request.body);
      if (!config.EVOLUTION_URL || (!body.instance && !config.EVOLUTION_API_KEY))
        throw new AppError(503, "EVOLUTION_NOT_CONFIGURED");
      const created = store.createConnection(body);
      store.audit(user.id, "connection.created", created.connection.id);
      reply.code(201);
      return {
        id: created.connection.id,
        ...integration(created.connection.id, created.bridgeKey),
      };
    });
    api.patch<{ Params: { id: string } }>(
      "/api/connections/:id",
      { bodyLimit: 8192 },
      async (request) => {
        const user = session(request);
        const body = z
          .object({
            name: z.string().trim().min(2).max(120).optional(),
            overflow: z.boolean().optional(),
            signalUrl: z.string().max(8192).optional(),
          })
          .strict()
          .parse(request.body);
        if ((body.name !== undefined || body.signalUrl !== undefined) && user.role !== "admin")
          throw new AppError(403, "ADMIN_REQUIRED");
        const c = store.connection(request.params.id);
        store.transaction(() => {
          if (body.name !== undefined)
            store.db.prepare("UPDATE connections SET name=? WHERE id=?").run(body.name, c.id);
          if (body.signalUrl !== undefined) {
            if (c.overflow) throw new AppError(409, "PAUSE_BEFORE_CHANGING_WEBHOOK");
            store.setSecrets(c, {
              ...store.secrets(c),
              signalUrl: validSignalUrl(body.signalUrl, config),
            });
            store.audit(user.id, "connection.signal_configured", c.id);
          }
          if (body.overflow !== undefined) store.setOverflow(c.id, body.overflow, user.id);
        });
        return { ok: true };
      },
    );
    api.get<{ Params: { id: string } }>("/api/connections/:id/integration", async (request) => {
      admin(request);
      return integration(request.params.id);
    });
    api.post<{ Params: { id: string } }>("/api/connections/:id/rotate-key", async (request) => {
      const user = admin(request),
        c = store.connection(request.params.id),
        key = token();
      store.db.prepare("UPDATE connections SET bridge_hash=? WHERE id=?").run(digest(key), c.id);
      store.audit(user.id, "connection.key_rotated", c.id);
      return integration(c.id, key);
    });
    api.post<{ Params: { id: string } }>("/api/connections/:id/connect", async (request) => {
      const user = admin(request),
        c = store.connection(request.params.id);
      const result = await evolution.connect(c);
      store.audit(user.id, "connection.webhook_installed", c.id);
      return result;
    });
    api.get<{ Params: { id: string } }>("/api/connections/:id/status", async (request) =>
      evolution.status(store.connection(request.params.id)),
    );
    api.get<{ Params: { id: string } }>("/api/connections/:id/qr", async (request) => {
      admin(request);
      return evolution.pair(store.connection(request.params.id));
    });
    api.post<{ Params: { id: string } }>("/api/connections/:id/sync", async (request) => {
      const user = session(request),
        c = store.connection(request.params.id);
      const result = await evolution.sync(c);
      store.audit(user.id, "contacts.synced", c.id, `${result.synced}`);
      return result;
    });
    api.get<{ Params: { id: string } }>("/api/connections/:id/contacts", async (request) => {
      const c = store.connection(request.params.id),
        query = pageSchema.parse(request.query);
      const clause = `connection_id=? AND (name LIKE ? ESCAPE '\\' OR jid LIKE ? ESCAPE '\\') ${query.ignored === "all" ? "" : `AND ignored=${query.ignored === "true" ? 1 : 0}`}`;
      const term = `%${query.search.replace(/[\\%_]/g, "\\$&")}%`;
      const rows = store.db
        .prepare(
          `SELECT * FROM contacts WHERE ${clause} ORDER BY ignored DESC,name,jid LIMIT 50 OFFSET ?`,
        )
        .all(c.id, term, term, (query.page - 1) * 50);
      const total = store.db
        .prepare(`SELECT count(*) AS count FROM contacts WHERE ${clause}`)
        .get(c.id, term, term);
      return { contacts: rows, total: total?.count ?? 0, page: query.page };
    });
    api.post<{ Params: { id: string } }>("/api/connections/:id/contacts", async (request) => {
      const user = session(request),
        c = store.connection(request.params.id);
      const body = z
        .object({
          phone: z.string().max(60),
          name: z.string().max(120).default(""),
          ignored: z.boolean().default(true),
        })
        .strict()
        .parse(request.body);
      const jid = normalizeJid(body.phone);
      if (!isPerson(jid)) throw new AppError(400, "INVALID_PHONE");
      store.upsertContact(
        c.id,
        jid,
        body.name,
        jid.endsWith("@s.whatsapp.net") ? jid.split("@")[0]! : null,
      );
      store.setIgnored(c.id, jid, body.ignored, user.id);
      return { ok: true };
    });
    api.patch<{ Params: { id: string } }>("/api/connections/:id/contacts", async (request) => {
      const user = session(request),
        c = store.connection(request.params.id);
      const body = z
        .object({ jid: z.string().max(100), ignored: z.boolean() })
        .strict()
        .parse(request.body);
      store.setIgnored(c.id, normalizeJid(body.jid), body.ignored, user.id);
      return { ok: true };
    });
    api.get("/api/activity", async (request) => {
      const { connectionId } = z.object({ connectionId: z.uuid().optional() }).parse(request.query);
      return {
        deliveries: store.db
          .prepare(`SELECT d.id,d.connection_id,c.name,d.event,d.status,d.attempts,d.last_error,d.created_at
        FROM deliveries d JOIN connections c ON c.id=d.connection_id
        ${connectionId ? "WHERE c.id=?" : ""} ORDER BY d.created_at DESC LIMIT 100`)
          .all(...(connectionId ? [connectionId] : [])),
        audit: store.db
          .prepare(`SELECT a.id,COALESCE(u.name,'Sistema') AS actor,a.action,c.name,a.created_at
          FROM audit a LEFT JOIN users u ON u.id=a.actor LEFT JOIN connections c ON c.id=a.connection_id
          ORDER BY a.created_at DESC LIMIT 50`)
          .all(),
      };
    });
  });

  function integration(id: string, key?: string) {
    const c = store.connection(id);
    return {
      baseUrl: `${config.PUBLIC_URL.replace(/\/+$/, "")}/bridge/${c.id}`,
      instance: c.instance,
      ...(key ? { apiKey: key } : {}),
      signalConfigured: !!c.signal_configured,
    };
  }
  app.post<{ Params: { id: string; secret: string } }>(
    "/hooks/:id/:secret",
    {
      bodyLimit: 2 * 1024 * 1024,
      config: { rateLimit: { max: 3000, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      let c;
      try {
        c = store.connection(request.params.id);
      } catch {
        throw new AppError(401, "INVALID_WEBHOOK");
      }
      if (!equalSecret(digest(request.params.secret), c.webhook_hash))
        throw new AppError(401, "INVALID_WEBHOOK");
      const result = receive(store, c, request.body);
      reply.code(202);
      return result;
    },
  );
  app.route<{ Params: { id: string; category: string; action: string; instance: string } }>({
    method: ["GET", "POST", "PUT", "DELETE"],
    url: "/bridge/:id/:category/:action/:instance",
    config: { rateLimit: { max: 1000, timeWindow: "1 minute" } },
    handler: async (request, reply) => {
      let c;
      try {
        c = store.connection(request.params.id);
      } catch {
        throw new AppError(401, "INVALID_API_KEY");
      }
      const key = request.headers.apikey;
      if (typeof key !== "string" || !equalSecret(digest(key), c.bridge_hash))
        throw new AppError(401, "INVALID_API_KEY");
      const { category, action, instance } = request.params;
      const result = await bridge(
        evolution,
        c,
        request.method,
        category,
        action,
        instance,
        request.body,
      );
      if (category === "message")
        store.audit(
          "signal",
          result.status < 300 ? "response.sent" : "response.failed",
          c.id,
          String(result.status),
        );
      return reply.code(result.status).send(result.body);
    },
  });
  const publicDir = options.publicDir ?? resolve("dist/public");
  app.get("/", async (_request, reply) =>
    reply.type("text/html").send(await readFile(resolve(publicDir, "index.html"))),
  );
  app.get("/favicon.svg", async (_request, reply) =>
    reply.type("image/svg+xml").send(await readFile(resolve(publicDir, "favicon.svg"))),
  );
  app.get("/assets/app.js", async (_request, reply) =>
    reply.type("text/javascript").send(await readFile(resolve(publicDir, "app.js"))),
  );
  app.get("/assets/app.css", async (_request, reply) =>
    reply.type("text/css").send(await readFile(resolve(publicDir, "app.css"))),
  );
  app.addHook("onClose", async () => {
    await dispatcher.stop();
    if (!options.store) store.close();
  });
  return { app, store, dispatcher };
}
