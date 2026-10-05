import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/app.js";
import { configSchema } from "../src/config.js";
import { hashPassword } from "../src/security.js";
import { Store } from "../src/store.js";

const password = "access-test-password";
const config = configSchema.parse({
  NODE_ENV: "test",
  PUBLIC_URL: "http://localhost:3080",
  DATABASE_PATH: ":memory:",
  ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
  EVOLUTION_URL: "https://evolution.example.test",
  EVOLUTION_API_KEY: "test-server-key",
  SIGNAL_API_ORIGIN: "https://signal.example.test",
});
async function fixture(t: TestContext) {
  const store = new Store(":memory:", config.ENCRYPTION_KEY);
  const calls: string[] = [];
  const built = await buildApp(config, {
    store,
    logger: false,
    transport: async (url) => {
      calls.push(url);
      if (url.includes("connectionState")) return Response.json({ instance: { state: "open" } });
      return Response.json({});
    },
  });
  t.after(async () => {
    await built.app.close();
    store.close();
  });
  const hashed = await hashPassword(password);
  for (const [id, role] of [
    ["admin", "admin"],
    ["alice", "operator"],
    ["bob", "operator"],
  ])
    store.db
      .prepare("INSERT INTO users VALUES(?,?,?,?,?,1)")
      .run(id!, id!, `${id}@example.test`, hashed, role!);
  const login = async (id: string, pass = password) => {
    const result = await built.app.inject({
      method: "POST",
      url: "/api/login",
      headers: { origin: config.PUBLIC_URL },
      payload: { email: `${id}@example.test`, password: pass },
    });
    assert.equal(result.statusCode, 200, result.body);
    const c = result.cookies[0]!;
    return { origin: config.PUBLIC_URL, cookie: `${c.name}=${c.value}` };
  };
  return {
    ...built,
    calls,
    login,
    admin: await login("admin"),
    alice: await login("alice"),
    bob: await login("bob"),
  };
}

test("operators create devices owned by their session and cannot spoof or change the creator", async (t) => {
  const f = await fixture(t);
  for (const field of ["created_by", "createdBy", "ownerId"]) {
    const response = await f.app.inject({
      method: "POST",
      url: "/api/connections",
      headers: f.alice,
      payload: { name: "Spoof", [field]: "bob" },
    });
    assert.equal(response.statusCode, 400);
  }
  const created = await f.app.inject({
    method: "POST",
    url: "/api/connections",
    headers: f.alice,
    payload: { name: "Alice device" },
  });
  assert.equal(created.statusCode, 201, created.body);
  const id = created.json().id;
  assert.equal(f.store.connection(id).created_by, "alice");
  assert.equal(created.json().apiKey, undefined);
  assert.equal(
    f.store.db
      .prepare("SELECT actor FROM audit WHERE connection_id=? AND action='connection.created'")
      .get(id)?.actor,
    "alice",
  );
  const bobDevice = (
    await f.app.inject({
      method: "POST",
      url: "/api/connections",
      headers: f.bob,
      payload: { name: "Bob device" },
    })
  ).json().id;
  for (const [headers, ids] of [
    [f.alice, [id]],
    [f.bob, [bobDevice]],
    [f.admin, [id, bobDevice]],
  ] as const) {
    const list = await f.app.inject({ url: "/api/connections", headers });
    assert.deepEqual(
      list
        .json()
        .connections.map((c: { id: string }) => c.id)
        .sort(),
      [...ids].sort(),
    );
  }
  assert.equal(
    (
      await f.app.inject({
        method: "PATCH",
        url: `/api/connections/${id}`,
        headers: f.alice,
        payload: { created_by: "bob" },
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await f.app.inject({
        method: "PATCH",
        url: `/api/connections/${id}`,
        headers: f.alice,
        payload: { name: "My device" },
      })
    ).statusCode,
    200,
  );
  assert.equal(f.store.connection(id).created_by, "alice");
  assert.equal(
    (
      await f.app.inject({
        method: "POST",
        url: `/api/connections/${id}/connect`,
        headers: f.alice,
        payload: {},
      })
    ).statusCode,
    200,
  );
  assert.ok(f.calls.length > 0);
  for (const [method, suffix] of [
    ["GET", "/integration"],
    ["POST", "/rotate-key"],
    ["DELETE", ""],
  ] as const)
    assert.equal(
      (
        await f.app.inject({
          method,
          url: `/api/connections/${id}${suffix}`,
          headers: f.alice,
          ...(method === "POST" ? { payload: {} } : {}),
        })
      ).statusCode,
      403,
    );
  assert.equal((await f.app.inject({ url: "/api/users", headers: f.alice })).statusCode, 403);
  assert.equal(
    (await f.app.inject({ method: "PATCH", url: "/api/platform", headers: f.alice, payload: {} }))
      .statusCode,
    403,
  );
  assert.equal(
    (await f.app.inject({ url: "/api/platform", headers: f.alice })).json().apiKey,
    undefined,
  );
});

test("ownership blocks every device endpoint before reading or mutating another operator's data", async (t) => {
  const f = await fixture(t);
  const own = f.store.createConnection({ name: "Alice private" }, "alice").connection;
  const other = f.store.createConnection({ name: "Bob private" }, "bob").connection;
  const legacy = f.store.createConnection({ name: "Unknown creator" }).connection;
  f.store.upsertContact(other.id, "558399991111@s.whatsapp.net", "Private contact", "558399991111");
  const requests = [
    { method: "GET", suffix: "/contacts" },
    { method: "GET", suffix: "/photo" },
    { method: "GET", suffix: "/status" },
    { method: "GET", suffix: "/qr" },
    { method: "GET", suffix: "/integration" },
    { method: "POST", suffix: "/connect", payload: {} },
    { method: "POST", suffix: "/profile", payload: {} },
    { method: "POST", suffix: "/sync", payload: {} },
    { method: "POST", suffix: "/rotate-key", payload: {} },
    { method: "POST", suffix: "/contacts", payload: { phone: "558399991111" } },
    {
      method: "PATCH",
      suffix: "/contacts",
      payload: { jid: "558399991111@s.whatsapp.net", overflow: true },
    },
    { method: "PATCH", suffix: "", payload: { name: "Stolen", overflow: true } },
    { method: "DELETE", suffix: "" },
  ] as const;
  const before = f.store.connection(other.id);
  for (const id of [other.id, legacy.id, "00000000-0000-4000-8000-000000000000"])
    for (const request of requests) {
      const response = await f.app.inject({
        method: request.method,
        url: `/api/connections/${id}${request.suffix}`,
        headers: f.alice,
        ...("payload" in request ? { payload: request.payload } : {}),
      });
      assert.equal(
        response.statusCode,
        404,
        `${request.method} ${request.suffix}: ${response.body}`,
      );
      assert.equal(response.json().error, "CONNECTION_NOT_FOUND");
    }
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.store.connection(other.id), before);
  assert.deepEqual(
    (await f.app.inject({ url: "/api/connections", headers: f.alice }))
      .json()
      .connections.map((c: { id: string }) => c.id),
    [own.id],
  );
  assert.equal(
    (await f.app.inject({ url: `/api/connections/${other.id}/contacts`, headers: f.admin })).json()
      .total,
    1,
  );
  assert.equal(
    (await f.app.inject({ url: `/api/connections/${legacy.id}/contacts`, headers: f.admin }))
      .statusCode,
    200,
  );
});

test("activity and filters reveal only owned device events and the operator's own account activity", async (t) => {
  const f = await fixture(t);
  const a = f.store.createConnection({ name: "Alice private" }, "alice").connection;
  const b = f.store.createConnection({ name: "Bob private" }, "bob").connection;
  for (const c of [a, b]) {
    f.store.enqueue(
      c,
      "event",
      "MESSAGES_UPSERT",
      "558399991111@s.whatsapp.net",
      {},
      "OVERFLOW_DISABLED",
    );
    f.store.audit("admin", "contact.ignored", c.id);
  }
  f.store.audit("admin", "platform.signal_configured");
  f.store.audit("alice", "password.changed");
  const activity = (await f.app.inject({ url: "/api/activity", headers: f.alice })).json();
  assert.deepEqual(
    activity.deliveries.map((d: { connection_id: string }) => d.connection_id),
    [a.id],
  );
  assert.ok(activity.audit.some((row: { action: string }) => row.action === "password.changed"));
  assert.ok(activity.audit.some((row: { name: string }) => row.name === a.name));
  assert.ok(
    activity.audit.every(
      (row: { name: string | null; action: string; actor: string }) =>
        row.name === a.name || row.actor === "alice",
    ),
  );
  assert.ok(!JSON.stringify(activity).includes(b.name));
  assert.equal(
    (await f.app.inject({ url: `/api/activity?connectionId=${b.id}`, headers: f.alice }))
      .statusCode,
    404,
  );
  const scoped = (
    await f.app.inject({ url: `/api/activity?connectionId=${a.id}`, headers: f.alice })
  ).json();
  assert.ok(scoped.audit.every((row: { name: string }) => row.name === a.name));
  assert.equal(
    (await f.app.inject({ url: "/api/activity", headers: f.admin })).json().deliveries.length,
    2,
  );
});

test("password changes clear the cookie, revoke every session of that user and accept only the new password", async (t) => {
  const f = await fixture(t),
    secondSession = await f.login("admin");
  const newPassword = "replacement-test-password";
  const change = (current: string) =>
    f.app.inject({
      method: "POST",
      url: "/api/password",
      headers: f.admin,
      payload: { current, password: newPassword },
    });
  assert.equal((await change("wrong-password")).json().error, "INVALID_PASSWORD");
  assert.equal((await f.app.inject({ url: "/api/me", headers: f.admin })).statusCode, 200);
  const result = await change(password);
  assert.equal(result.statusCode, 200);
  assert.match(String(result.headers["set-cookie"]), /Max-Age=0/);
  for (const headers of [f.admin, secondSession])
    assert.equal((await f.app.inject({ url: "/api/me", headers })).statusCode, 401);
  assert.equal((await f.app.inject({ url: "/api/me", headers: f.alice })).statusCode, 200);
  const rejected = await f.app.inject({
    method: "POST",
    url: "/api/login",
    headers: { origin: config.PUBLIC_URL },
    payload: { email: "admin@example.test", password },
  });
  assert.equal(rejected.statusCode, 401);
  assert.ok(await f.login("admin", newPassword));
});

test("v3 migration restores the original creator from audit and leaves unknown devices visible only to admins", async () => {
  const dir = mkdtempSync(join(tmpdir(), "portal-ownership-")),
    path = join(dir, "portal.sqlite");
  try {
    let store = new Store(path, config.ENCRYPTION_KEY);
    for (const id of ["alice", "admin"])
      store.db
        .prepare("INSERT INTO users VALUES(?,?,?,?,?,1)")
        .run(
          id,
          id,
          `${id}@example.test`,
          await hashPassword(password),
          id === "admin" ? "admin" : "operator",
        );
    const known = store.createConnection({ name: "Known" }).connection;
    const unknown = store.createConnection({ name: "Unknown" }).connection;
    store.audit("alice", "connection.created", known.id);
    store.audit("admin", "connection.created", known.id);
    store.setSecrets(known, {
      ...store.secrets(known),
      signalUrl: `https://signal.example.test/webhooks/evolution/abcdefghijklmnop/${"s".repeat(43)}`,
    });
    store.db.prepare("UPDATE connections SET webhook_configured=1 WHERE id=?").run(known.id);
    store.upsertContact(known.id, "558399991111@s.whatsapp.net", "Selected", "558399991111");
    store.setContactPolicy(known.id, "558399991111@s.whatsapp.net", { overflow: true }, "alice");
    const platform = store.platform(),
      profile = store.contactPolicy(store.connection(known.id), "558399991111@s.whatsapp.net");
    store.close();
    const legacy = new DatabaseSync(path);
    legacy.exec(
      "DROP INDEX connections_creator; ALTER TABLE connections DROP COLUMN created_by; PRAGMA user_version=3",
    );
    legacy.close();
    store = new Store(path, config.ENCRYPTION_KEY);
    assert.equal(store.db.prepare("PRAGMA user_version").get()?.user_version, 4);
    assert.equal(store.connection(known.id).created_by, "alice");
    assert.equal(store.connection(unknown.id).created_by, null);
    assert.deepEqual(store.platform(), platform);
    assert.deepEqual(
      store.contactPolicy(store.connection(known.id), "558399991111@s.whatsapp.net"),
      profile,
    );
    store.db.prepare("DELETE FROM audit").run();
    store.close();
    store = new Store(path, config.ENCRYPTION_KEY);
    assert.equal(store.connection(known.id).created_by, "alice");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
