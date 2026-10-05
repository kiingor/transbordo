import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/app.js";
import { configSchema, type Config } from "../src/config.js";
import { type Transport, syncContacts } from "../src/evolution.js";
import { hashPassword } from "../src/security.js";
import { Store, type Delivery } from "../src/store.js";
import { DatabaseSync } from "node:sqlite";

const password = "portal-test-password-only";
const config: Config = configSchema.parse({
  NODE_ENV: "test",
  PUBLIC_URL: "http://localhost:3080",
  ENCRYPTION_KEY: Buffer.alloc(32, 6).toString("base64"),
  DATABASE_PATH: ":memory:",
  EVOLUTION_URL: "https://evolution.example.test",
  EVOLUTION_API_KEY: "global-test-key-only",
  SIGNAL_API_ORIGIN: "https://signal.example.test",
});
const signalUrl = `https://signal.example.test/webhooks/evolution/abcdefghijklmnop/${"s".repeat(43)}`;

const selectedPeer = "558399991111@s.whatsapp.net";
const otherPeer = "558399992222@s.whatsapp.net";

test("individual activation forwards only chosen contacts and their Signal replies while the general switch stays off", async (t) => {
  const f = await fixture(t);
  f.store.setPlatformWebhook(signalUrl, "admin");
  while (await f.dispatcher.tick()) {
    /* drain device metadata */
  }
  f.calls.length = 0;
  syncContacts(
    f.store,
    f.id,
    [selectedPeer, otherPeer].map((remoteJid) => ({ remoteJid })),
  );
  const list = await f.app.inject({ url: `/api/connections/${f.id}/contacts`, headers: f.headers });
  assert.ok(list.json().contacts.every((contact: { overflow: number }) => contact.overflow === 0));
  const activate = await f.app.inject({
    method: "PATCH",
    url: `/api/connections/${f.id}/contacts`,
    headers: f.headers,
    payload: { jid: selectedPeer, overflow: true },
  });
  assert.equal(activate.statusCode, 200, activate.body);
  assert.equal(f.store.connection(f.id).overflow, 0);
  for (const [index, peer] of [selectedPeer, otherPeer].entries()) {
    const result = await f.app.inject({
      method: "POST",
      url: f.hook,
      payload: f.inbound(`selected-${index}`, peer),
    });
    assert.equal(result.json().events[0].ignored, peer !== selectedPeer);
  }
  while (await f.dispatcher.tick()) {
    /* dispatch only selected contact */
  }
  assert.equal(f.calls.length, 1);
  const sent = JSON.parse(String(f.calls[0]!.init.body));
  assert.equal(sent.instance, f.store.platform().id);
  assert.equal(sent.device.id, f.id);
  assert.equal(sent.data.key.remoteJid, selectedPeer);
  const reply = (peer: string) =>
    f.app.inject({
      method: "POST",
      url: `/platform/message/sendText/${f.id}`,
      headers: { apikey: f.store.platform().apiKey },
      payload: { number: peer, text: "Resposta" },
    });
  assert.equal((await reply(selectedPeer)).statusCode, 200);
  assert.equal((await reply(otherPeer)).json().error, "OVERFLOW_DISABLED");
  assert.equal(f.calls[1]!.url, "https://evolution.example.test/message/sendText/number-one");
  f.store.setOverflow(f.id, true, "admin");
  assert.equal((await reply(otherPeer)).statusCode, 200);
  assert.equal(f.store.contactPolicy(f.store.connection(f.id), otherPeer).individual, false);
  f.store.setIgnored(f.id, selectedPeer, true, "admin");
  assert.equal((await reply(selectedPeer)).json().error, "CONTACT_IGNORED");
  const ignored = await f.app.inject({
    method: "POST",
    url: f.hook,
    payload: f.inbound("ignored-selection"),
  });
  assert.equal(ignored.json().events[0].ignored, true);
  f.store.setOverflow(f.id, false, "admin");
  f.store.setIgnored(f.id, selectedPeer, false, "admin");
  assert.equal((await reply(selectedPeer)).statusCode, 200);
  assert.equal((await reply(otherPeer)).statusCode, 409);
  f.store.setContactPolicy(f.id, selectedPeer, { overflow: false }, "admin");
  assert.equal((await reply(selectedPeer)).statusCode, 409);
});

test("general pause keeps selected contacts queued; disabling an individual selection cancels only when the general switch is off", async (t) => {
  const f = await fixture(t);
  f.store.setOverflow(f.id, true, "admin");
  for (const peer of [selectedPeer, otherPeer])
    await f.app.inject({ method: "POST", url: f.hook, payload: f.inbound(peer, peer) });
  f.store.setContactPolicy(f.id, selectedPeer, { overflow: true }, "admin");
  f.store.setContactPolicy(f.id, selectedPeer, { overflow: false }, "admin");
  assert.equal(
    f.store.db.prepare("SELECT count(*) AS n FROM deliveries WHERE status='pending'").get()?.n,
    2,
  );
  f.store.setContactPolicy(f.id, selectedPeer, { overflow: true }, "admin");
  f.store.setOverflow(f.id, false, "admin");
  assert.equal(
    f.store.db.prepare("SELECT status FROM deliveries WHERE peer=?").get(selectedPeer)?.status,
    "pending",
  );
  assert.equal(
    f.store.db.prepare("SELECT status FROM deliveries WHERE peer=?").get(otherPeer)?.status,
    "ignored",
  );
  f.store.setContactPolicy(f.id, selectedPeer, { overflow: false }, "admin");
  f.store.setContactPolicy(f.id, selectedPeer, { overflow: true }, "admin");
  f.store.setOverflow(f.id, true, "admin");
  assert.equal(await f.dispatcher.tick(), false);
  assert.equal(f.calls.length, 0);
});

test("individual activation and unignoring never replay old messages; changing general mode preserves continuous activation", async (t) => {
  const f = await fixture(t);
  const initial = Math.floor(Date.now() / 1000) * 1000;
  let now = initial;
  t.mock.method(Date, "now", () => now);
  const incoming = async (id: string, timestamp = now) => {
    const payload = f.inbound(id);
    payload.data.messageTimestamp = timestamp / 1000;
    return (await f.app.inject({ method: "POST", url: f.hook, payload })).json().events[0];
  };
  assert.equal((await incoming("received-while-off")).ignored, true);
  now += 10_000;
  f.store.setContactPolicy(f.id, selectedPeer, { overflow: true }, "admin");
  assert.equal((await incoming("received-while-off")).duplicate, true);
  assert.equal((await incoming("late-history", initial)).ignored, true);
  assert.equal((await incoming("new-message")).ignored, false);
  now += 10_000;
  f.store.setOverflow(f.id, true, "admin");
  now += 10_000;
  f.store.setOverflow(f.id, false, "admin");
  assert.equal(
    f.store.contactPolicy(f.store.connection(f.id), selectedPeer).since,
    initial + 10_000,
  );
  assert.equal((await incoming("continuous", initial + 15_000)).ignored, false);
  f.store.setIgnored(f.id, selectedPeer, true, "admin");
  now += 10_000;
  f.store.setIgnored(f.id, selectedPeer, false, "admin");
  assert.equal((await incoming("before-unignore", initial + 25_000)).ignored, true);
  assert.equal((await incoming("after-unignore")).ignored, false);
  assert.equal(f.store.contactPolicy(f.store.connection(f.id), selectedPeer).since, now);
  const old = f.store.db.prepare("SELECT last_error FROM deliveries WHERE status='ignored'").all();
  assert.ok(old.some((row) => row.last_error === "BEFORE_ACTIVATION"));
});

test("sync and LID aliases preserve individual selection and ignore precedence only for their device", async (t) => {
  const f = await fixture(t);
  const lid = "123456789@lid";
  f.store.upsertContact(f.id, lid, "Cliente", null);
  f.store.setContactPolicy(f.id, lid, { overflow: true }, "admin");
  syncContacts(f.store, f.id, [
    { remoteJid: selectedPeer, lid, pushName: "Nome atualizado" },
    { remoteJid: otherPeer },
  ]);
  const c = f.store.connection(f.id);
  assert.equal(f.store.contactPolicy(c, selectedPeer).enabled, true);
  assert.equal(f.store.contactPolicy(c, otherPeer).enabled, false);
  f.store.setIgnored(f.id, selectedPeer, true, "admin");
  assert.equal(f.store.contactPolicy(c, lid).reason, "CONTACT_IGNORED");
  syncContacts(f.store, f.id, [{ remoteJid: lid, phoneNumber: selectedPeer, name: "Atualizado" }]);
  assert.equal(f.store.contactPolicy(c, selectedPeer).individual, true);
  assert.equal(f.store.contactPolicy(c, selectedPeer).ignored, true);
  f.store.setIgnored(f.id, lid, false, "admin");
  const inbound = f.inbound("selected-lid", lid);
  assert.equal(
    (await f.app.inject({ method: "POST", url: f.hook, payload: inbound })).json().events[0]
      .ignored,
    false,
  );
  f.store.setContactPolicy(f.id, lid, { overflow: false }, "admin");
  assert.equal(f.store.contactPolicy(c, selectedPeer).enabled, false);
  const second = f.store.createConnection({ name: "Outro dispositivo" }).connection;
  assert.equal(f.store.contactPolicy(second, selectedPeer).individual, false);
  assert.equal(f.store.contactPolicy(second, lid).enabled, false);
});

test("Signal batches validate every recipient; selective mode supports media and presence", async (t) => {
  const f = await fixture(t);
  f.store.upsertContact(f.id, selectedPeer, "Cliente", "558399991111");
  f.store.setContactPolicy(f.id, selectedPeer, { overflow: true }, "admin");
  const request = (operation: string, payload: Record<string, unknown>) =>
    f.app.inject({
      method: "POST",
      url: `/bridge/${f.id}/${operation}/number-one`,
      headers: { apikey: f.bridgeKey },
      payload,
    });
  assert.equal(
    (await request("chat/whatsappNumbers", { numbers: [selectedPeer, otherPeer] })).statusCode,
    409,
  );
  assert.equal(
    (
      await request("chat/markMessageAsRead", {
        readMessages: [{ remoteJid: selectedPeer }, { remoteJid: otherPeer }],
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (await request("chat/whatsappNumbers", { numbers: [selectedPeer, ""] })).statusCode,
    400,
  );
  assert.equal((await request("chat/sendPresence", { number: otherPeer })).statusCode, 409);
  assert.equal(f.calls.length, 0);
  for (const [operation, payload] of [
    ["chat/whatsappNumbers", { numbers: [selectedPeer] }],
    ["chat/markMessageAsRead", { readMessages: [{ remoteJid: selectedPeer }] }],
    ["chat/sendPresence", { number: selectedPeer }],
    [
      "message/sendMedia",
      { number: selectedPeer, mediatype: "image", media: "data:image/png;base64,AA==" },
    ],
    ["message/sendReaction", { key: { remoteJid: selectedPeer, id: "msg" }, reaction: "👍" }],
    ["chat/getBase64FromMediaMessage", { message: { key: { id: "msg" } } }],
    ["instance/setPresence", { presence: "available" }],
  ] as const) {
    const result = await request(operation, payload);
    assert.equal(result.statusCode, 200, `${operation}: ${result.body}`);
  }
  f.store.setIgnored(f.id, selectedPeer, true, "admin");
  assert.equal(
    (await request("message/sendMedia", { number: selectedPeer })).json().error,
    "CONTACT_IGNORED",
  );
  assert.equal(
    (await request("chat/getBase64FromMediaMessage", { message: { key: { id: "msg" } } }))
      .statusCode,
    409,
  );
});

test("individual selection validates configuration, authorizes operators and prevents webhook changes while effective", async (t) => {
  const f = await fixture(t);
  f.store.upsertContact(f.id, selectedPeer, "Cliente", "558399991111");
  const login = await f.app.inject({
    method: "POST",
    url: "/api/login",
    headers: { origin: config.PUBLIC_URL },
    payload: { email: "operator@example.test", password },
  });
  const cookie = login.cookies[0]!;
  const headers = { origin: config.PUBLIC_URL, cookie: `${cookie.name}=${cookie.value}` };
  const url = `/api/connections/${f.id}/contacts`;
  assert.equal(
    (await f.app.inject({ method: "PATCH", url, headers, payload: { jid: selectedPeer } }))
      .statusCode,
    400,
  );
  assert.equal(
    (
      await f.app.inject({
        method: "PATCH",
        url,
        headers,
        payload: { jid: otherPeer, overflow: true },
      })
    ).statusCode,
    404,
  );
  f.store.db.prepare("UPDATE connections SET webhook_configured=0 WHERE id=?").run(f.id);
  assert.equal(
    (
      await f.app.inject({
        method: "PATCH",
        url,
        headers,
        payload: { jid: selectedPeer, overflow: true },
      })
    ).json().error,
    "CONNECTION_SETUP_REQUIRED",
  );
  f.store.db.prepare("UPDATE connections SET webhook_configured=1 WHERE id=?").run(f.id);
  assert.equal(
    (
      await f.app.inject({
        method: "PATCH",
        url,
        headers,
        payload: { jid: selectedPeer, overflow: true },
      })
    ).statusCode,
    200,
  );
  assert.throws(
    () => f.store.setPlatformWebhook(signalUrl, "admin"),
    /PAUSE_BEFORE_CHANGING_WEBHOOK/,
  );
  assert.equal(
    (
      await f.app.inject({
        method: "PATCH",
        url: `/api/connections/${f.id}`,
        headers: f.headers,
        payload: { signalUrl },
      })
    ).statusCode,
    409,
  );
  const filtered = await f.app.inject({ url: `${url}?overflow=true`, headers });
  assert.equal(filtered.json().total, 1);
  f.store.setIgnored(f.id, selectedPeer, true, "admin");
  assert.equal(f.store.hasActiveOverflow(), false);
  f.store.setPlatformWebhook(signalUrl, "admin");
});

test("stopping individual overflow during an in-flight delivery never resurrects its failed attempt", async (t) => {
  for (const status of [200, 503])
    await t.test(`HTTP ${status}`, async (t) => {
      let release!: (response: Response) => void;
      const f = await fixture(
        t,
        async () =>
          new Promise<Response>((resolve) => {
            release = resolve;
          }),
      );
      f.store.upsertContact(f.id, selectedPeer, "Cliente", "558399991111");
      f.store.setContactPolicy(f.id, selectedPeer, { overflow: true }, "admin");
      await f.app.inject({
        method: "POST",
        url: f.hook,
        payload: f.inbound("individual-in-flight"),
      });
      const pending = f.dispatcher.tick();
      f.store.setContactPolicy(f.id, selectedPeer, { overflow: false }, "admin");
      f.store.setContactPolicy(f.id, selectedPeer, { overflow: true }, "admin");
      release(Response.json({}, { status }));
      await pending;
      assert.equal(
        f.store.db.prepare("SELECT status FROM deliveries").get()?.status,
        status === 200 ? "delivered" : "ignored",
      );
      f.store.db.prepare("UPDATE deliveries SET next_at=0").run();
      await f.dispatcher.tick();
      assert.equal(f.calls.length, 1);
    });
});

for (const version of [1, 2])
  test(`v${version} migration defaults individual overflow off and preserves existing configuration`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "portal-migration-"));
    const path = join(dir, "portal.db");
    try {
      let store = new Store(path, config.ENCRYPTION_KEY);
      const { connection: device } = store.createConnection({
        name: "Existing device",
        instance: "existing",
        evolutionKey: "existing-instance-key",
      });
      const hash = await hashPassword(password);
      store.db
        .prepare("INSERT INTO users VALUES(?,?,?,?,?,1)")
        .run("operator", "Operator", "operator@example.test", hash, "operator");
      store.setSecrets(device, { ...store.secrets(device), signalUrl });
      store.upsertContact(device.id, "5583999991111@s.whatsapp.net", "Contato", "5583999991111");
      store.setIgnored(device.id, "5583999991111@s.whatsapp.net", true, "operator");
      store.upsertContact(device.id, "5583999992222@s.whatsapp.net", "Outro", "5583999992222");
      store.db.prepare("UPDATE connections SET webhook_configured=1 WHERE id=?").run(device.id);
      store.setOverflow(device.id, true, "operator");
      const enabledAt = store.connection(device.id).enabled_at;
      const originalPlatform = store.platform();
      store.enqueue(
        device,
        "old-paused",
        "MESSAGES_UPSERT",
        "5583999991111@s.whatsapp.net",
        {},
        "OVERFLOW_DISABLED",
      );
      store.close();
      const legacy = new DatabaseSync(path);
      if (version === 1)
        for (const name of [
          "profile_name",
          "profile_picture_url",
          "profile_photo",
          "profile_photo_type",
          "profile_synced_at",
        ])
          legacy.exec(`ALTER TABLE connections DROP COLUMN ${name}`);
      if (version === 1) legacy.exec("DROP TABLE platform");
      legacy.exec(
        `ALTER TABLE contacts DROP COLUMN overflow; ALTER TABLE contacts DROP COLUMN enabled_at; PRAGMA user_version=${version}`,
      );
      legacy.close();
      store = new Store(path, config.ENCRYPTION_KEY);
      assert.equal(store.db.prepare("PRAGMA user_version").get()?.user_version, 3);
      assert.equal(
        store.db.prepare("SELECT count(*) AS n FROM contacts WHERE overflow<>0").get()?.n,
        0,
      );
      assert.equal(
        store.contactPolicy(store.connection(device.id), "5583999992222@s.whatsapp.net").since,
        enabledAt,
      );
      assert.equal(store.connection(device.id).overflow, 1);
      if (version === 2) assert.deepEqual(store.platform(), originalPlatform);
      assert.equal(
        store.db.prepare("SELECT password FROM users WHERE id='operator'").get()?.password,
        hash,
      );
      assert.equal(
        store.secrets(store.connection(device.id)).evolutionKey,
        "existing-instance-key",
      );
      assert.equal(store.signalUrl(store.connection(device.id)), signalUrl);
      assert.equal(store.isIgnored(device.id, "5583999991111@s.whatsapp.net"), true);
      assert.equal(
        store.db.prepare("SELECT status FROM deliveries WHERE dedupe='old-paused'").get()?.status,
        "ignored",
      );
      const platform = store.platform();
      assert.ok(
        !JSON.stringify(store.db.prepare("SELECT * FROM platform").get()).includes(platform.apiKey),
      );
      store.close();
      store = new Store(path, config.ENCRYPTION_KEY);
      assert.deepEqual(store.platform(), platform);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
async function fixture(t: TestContext, custom?: Transport) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetcher: Transport = async (url, init) => {
    calls.push({ url, init });
    if (custom) return custom(url, init);
    if (url.includes("connectionState")) return Response.json({ instance: { state: "open" } });
    if (url.includes("findContacts"))
      return Response.json([{ remoteJid: "558399991111@s.whatsapp.net", pushName: "Cliente" }]);
    return Response.json({ key: { id: "sent-1" }, status: "PENDING", apikey: "upstream-secret" });
  };
  const store = new Store(":memory:", config.ENCRYPTION_KEY);
  const built = await buildApp(config, { store, transport: fetcher, logger: false });
  t.after(async () => {
    await built.app.close();
    store.close();
  });
  store.db
    .prepare("INSERT INTO users VALUES(?,?,?,?,?,1)")
    .run("admin", "Admin", "admin@example.test", await hashPassword(password), "admin");
  store.db
    .prepare("INSERT INTO users VALUES(?,?,?,?,?,1)")
    .run("operator", "Operator", "operator@example.test", await hashPassword(password), "operator");
  const login = await built.app.inject({
    method: "POST",
    url: "/api/login",
    headers: { origin: config.PUBLIC_URL },
    payload: { email: "admin@example.test", password },
  });
  assert.equal(login.statusCode, 200, login.body);
  const cookie = login.cookies[0]!;
  const headers = { origin: config.PUBLIC_URL, cookie: `${cookie.name}=${cookie.value}` };
  const created = store.createConnection({
    name: "Atendimento",
    instance: "number-one",
    evolutionKey: "instance-test-key-only",
  });
  store.setSecrets(created.connection, { ...store.secrets(created.connection), signalUrl });
  store.db
    .prepare("UPDATE connections SET webhook_configured=1 WHERE id=?")
    .run(created.connection.id);
  const id = created.connection.id;
  const hook = `/hooks/${id}/${store.secrets(created.connection).webhookToken}`;
  const inbound = (messageId: string, peer = "558399991111@s.whatsapp.net") => ({
    event: "messages.upsert",
    instance: "number-one",
    apikey: "secret-from-evolution",
    destination: "https://old-webhook.test/secret",
    data: {
      key: { id: messageId, remoteJid: peer, fromMe: false },
      messageTimestamp: Math.floor(Date.now() / 1000),
      pushName: "Cliente",
      message: { conversation: "Olá" },
    },
  });
  return { ...built, calls, headers, id, hook, inbound, bridgeKey: created.bridgeKey };
}

test("login requires same origin, isolates admin operations and never exposes credentials", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.app.inject("/api/connections")).statusCode, 401);
  assert.equal(
    (
      await f.app.inject({
        method: "POST",
        url: "/api/login",
        payload: { email: "admin@example.test", password },
      })
    ).statusCode,
    403,
  );
  const list = await f.app.inject({ url: "/api/connections", headers: f.headers });
  assert.equal(list.statusCode, 200);
  for (const secret of [
    "instance-test-key-only",
    f.bridgeKey,
    signalUrl,
    "bridge_hash",
    "webhook_hash",
  ])
    assert.ok(!list.body.includes(secret));
  assert.match(list.headers["cache-control"] as string, /no-store/);
  const operator = await f.app.inject({
    method: "POST",
    url: "/api/login",
    headers: { origin: config.PUBLIC_URL },
    payload: { email: "operator@example.test", password },
  });
  const cookie = operator.cookies[0]!;
  const denied = await f.app.inject({
    method: "POST",
    url: "/api/connections",
    headers: { ...f.headers, cookie: `${cookie.name}=${cookie.value}` },
    payload: { name: "Outro número" },
  });
  assert.equal(denied.statusCode, 403);
  assert.match(operator.headers["set-cookie"] as string, /HttpOnly/);
  assert.match(operator.headers["set-cookie"] as string, /SameSite=Strict/);
});

test("device removal requires an administrator and the portal origin", async (t) => {
  const f = await fixture(t);
  const url = `/api/connections/${f.id}`;
  assert.equal((await f.app.inject({ method: "DELETE", url })).statusCode, 403);
  assert.equal(
    (await f.app.inject({ method: "DELETE", url, headers: { origin: config.PUBLIC_URL } }))
      .statusCode,
    401,
  );
  assert.equal(
    (
      await f.app.inject({
        method: "DELETE",
        url,
        headers: { ...f.headers, origin: "https://other.test" },
      })
    ).statusCode,
    403,
  );
  const login = await f.app.inject({
    method: "POST",
    url: "/api/login",
    headers: { origin: config.PUBLIC_URL },
    payload: { email: "operator@example.test", password },
  });
  const cookie = login.cookies[0]!;
  assert.equal(
    (
      await f.app.inject({
        method: "DELETE",
        url,
        headers: { ...f.headers, cookie: `${cookie.name}=${cookie.value}` },
      })
    ).statusCode,
    403,
  );
  assert.equal(f.store.connection(f.id).name, "Atendimento");
  assert.equal(f.calls.length, 0);
});

test("removing a managed device deletes only its data and preserves the platform and other devices", async (t) => {
  const f = await fixture(t);
  f.store.db.prepare("UPDATE connections SET managed=1 WHERE id=?").run(f.id);
  const other = f.store.createConnection({ name: "Other device" }).connection;
  f.store.setPlatformWebhook(signalUrl, "admin");
  const platform = f.store.platform();
  for (const id of [f.id, other.id]) {
    f.store.upsertContact(id, "558399991111@s.whatsapp.net", "Test", "558399991111");
    f.store.linkAlias(id, "100000000@lid", "558399991111@s.whatsapp.net");
  }
  f.store.setOverflow(f.id, true, "admin");
  await f.app.inject({ method: "POST", url: f.hook, payload: f.inbound("pending-removal") });
  const result = await f.app.inject({
    method: "DELETE",
    url: `/api/connections/${f.id}`,
    headers: f.headers,
  });
  assert.equal(result.statusCode, 200, result.body);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0]?.url, `${config.EVOLUTION_URL}/instance/delete/number-one`);
  assert.equal(f.calls[0]?.init.method, "DELETE");
  assert.equal(new Headers(f.calls[0]?.init.headers).get("apikey"), "instance-test-key-only");
  for (const table of ["contacts", "aliases", "deliveries"])
    assert.equal(
      f.store.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE connection_id=?`).get(f.id)?.n,
      0,
    );
  assert.deepEqual(f.store.platform(), platform);
  assert.equal(
    f.store.db.prepare("SELECT count(*) AS n FROM contacts WHERE connection_id=?").get(other.id)?.n,
    1,
  );
  assert.equal(f.store.connection(other.id).name, "Other device");
  const catalog = await f.app.inject({
    url: "/platform/devices",
    headers: { apikey: platform.apiKey },
  });
  assert.deepEqual(
    catalog.json().devices.map((d: { id: string }) => d.id),
    [other.id],
  );
  assert.equal(
    (await f.app.inject({ method: "POST", url: f.hook, payload: f.inbound("late-hook") }))
      .statusCode,
    401,
  );
  assert.equal(
    (
      await f.app.inject({
        method: "POST",
        url: `/platform/message/sendText/${f.id}`,
        headers: { apikey: platform.apiKey },
        payload: { number: "558399991111", text: "test" },
      })
    ).statusCode,
    404,
  );
  assert.equal(
    (await f.app.inject({ method: "DELETE", url: `/api/connections/${f.id}`, headers: f.headers }))
      .statusCode,
    404,
  );
  assert.equal(
    f.store.db
      .prepare("SELECT actor FROM audit WHERE action='connection.removed' AND connection_id=?")
      .get(f.id)?.actor,
    "admin",
  );
  assert.equal(f.calls.length, 1);
});

test("failed removal keeps a paused device for retry; a missing remote instance permits cleanup", async (t) => {
  let status = 503;
  const f = await fixture(t, async () => new Response("{}", { status }));
  f.store.db.prepare("UPDATE connections SET managed=1 WHERE id=?").run(f.id);
  f.store.setOverflow(f.id, true, "admin");
  await f.app.inject({ method: "POST", url: f.hook, payload: f.inbound("cancel-on-removal") });
  f.store.setContactPolicy(f.id, "558399991111@s.whatsapp.net", { overflow: true }, "admin");
  const result = await f.app.inject({
    method: "DELETE",
    url: `/api/connections/${f.id}`,
    headers: f.headers,
  });
  assert.equal(result.statusCode, 502);
  assert.equal(result.json().error, "EVOLUTION_REMOVE_FAILED");
  assert.equal(f.store.connection(f.id).overflow, 0);
  assert.equal(f.store.hasActiveOverflow(f.id), false);
  assert.equal(
    f.store.db.prepare("SELECT count(*) AS n FROM contacts WHERE connection_id=?").get(f.id)?.n,
    1,
  );
  assert.equal(f.store.db.prepare("SELECT status FROM deliveries").get()?.status, "ignored");
  assert.equal(f.store.db.prepare("SELECT payload FROM deliveries").get()?.payload, null);
  await f.dispatcher.tick();
  assert.equal(f.calls.length, 1);
  status = 404;
  assert.equal(
    (await f.app.inject({ method: "DELETE", url: `/api/connections/${f.id}`, headers: f.headers }))
      .statusCode,
    200,
  );
  assert.throws(() => f.store.connection(f.id), /CONNECTION_NOT_FOUND/);
});

test("imported device removal disables only a webhook still owned by this portal", async (t) => {
  for (const owned of [true, false])
    await t.test(owned ? "portal webhook" : "another integration", async (t) => {
      let webhookUrl = "https://another.example.test/hook";
      const f = await fixture(t, async (url) =>
        url.includes("webhook/find")
          ? Response.json({ url: webhookUrl })
          : Response.json({ enabled: false }),
      );
      if (owned) webhookUrl = `${config.PUBLIC_URL}${f.hook}`;
      const result = await f.app.inject({
        method: "DELETE",
        url: `/api/connections/${f.id}`,
        headers: f.headers,
      });
      assert.equal(result.statusCode, 200, result.body);
      assert.equal(f.calls.length, owned ? 2 : 1);
      assert.ok(f.calls.every((call) => call.init.method !== "DELETE"));
      if (owned) {
        const body = JSON.parse(String(f.calls[1]?.init.body));
        assert.equal(body.webhook.enabled, false);
        assert.equal(body.webhook.url, webhookUrl);
      }
    });
});

test("removal waits for an in-flight connect and prevents recreating the instance", async (t) => {
  const started = Promise.withResolvers<void>();
  const response = Promise.withResolvers<Response>();
  const f = await fixture(t, async (url) => {
    if (url.includes("connectionState")) {
      started.resolve();
      return response.promise;
    }
    return Response.json({ status: "SUCCESS", error: false });
  });
  f.store.db.prepare("UPDATE connections SET managed=1 WHERE id=?").run(f.id);
  const connecting = f.app
    .inject({ method: "POST", url: `/api/connections/${f.id}/connect`, headers: f.headers })
    .then((r) => r);
  await started.promise;
  const deleting = f.app
    .inject({ method: "DELETE", url: `/api/connections/${f.id}`, headers: f.headers })
    .then((r) => r);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    (
      await f.app.inject({
        method: "POST",
        url: `/api/connections/${f.id}/connect`,
        headers: f.headers,
      })
    ).statusCode,
    409,
  );
  assert.equal(f.calls.length, 1);
  response.resolve(new Response("{}", { status: 404 }));
  assert.equal((await connecting).statusCode, 409);
  assert.equal((await deleting).statusCode, 200);
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls.every((call) => !call.url.endsWith("/instance/create")));
});

test("removal drains an in-flight Signal delivery and cancels its retry", async (t) => {
  const started = Promise.withResolvers<void>();
  const response = Promise.withResolvers<Response>();
  const f = await fixture(t, async (url) => {
    if (url === signalUrl) {
      started.resolve();
      return response.promise;
    }
    return Response.json({ status: "SUCCESS", error: false });
  });
  f.store.db.prepare("UPDATE connections SET managed=1 WHERE id=?").run(f.id);
  f.store.setOverflow(f.id, true, "admin");
  await f.app.inject({ method: "POST", url: f.hook, payload: f.inbound("in-flight-removal") });
  const dispatch = f.dispatcher.tick();
  await started.promise;
  const deleting = f.app
    .inject({ method: "DELETE", url: `/api/connections/${f.id}`, headers: f.headers })
    .then((r) => r);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.calls.length, 1);
  assert.equal(
    (
      await f.app.inject({
        method: "PATCH",
        url: `/api/connections/${f.id}`,
        headers: f.headers,
        payload: { overflow: true },
      })
    ).statusCode,
    409,
  );
  response.resolve(new Response("{}", { status: 503 }));
  await dispatch;
  assert.equal((await deleting).statusCode, 200);
  assert.equal(f.calls.length, 2);
  assert.equal(await f.dispatcher.tick(), false);
});

test("paused messages are acknowledged, deduplicated and never replayed on activation", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (await f.app.inject({ method: "POST", url: f.hook, payload: f.inbound("off-1") })).statusCode,
    202,
  );
  const row = f.store.db.prepare("SELECT * FROM deliveries").get() as unknown as Delivery;
  assert.equal(row.status, "ignored");
  assert.equal(row.payload, null);
  f.store.setOverflow(f.id, true, "admin");
  const replay = await f.app.inject({ method: "POST", url: f.hook, payload: f.inbound("off-1") });
  assert.equal(replay.json().events[0].duplicate, true);
  await f.dispatcher.tick();
  assert.equal(f.calls.length, 0);
  const old = f.inbound("old-history");
  old.data.messageTimestamp -= 3600;
  await f.app.inject({ method: "POST", url: f.hook, payload: old });
  assert.equal(
    f.store.db.prepare("SELECT last_error FROM deliveries WHERE id<>?").get(row.id)?.last_error,
    "BEFORE_ACTIVATION",
  );
  await f.dispatcher.tick();
  assert.equal(f.calls.length, 0);
});

test("active webhook reaches Signal durably, with the correct instance and without provider secrets", async (t) => {
  const f = await fixture(t);
  f.store.setOverflow(f.id, true, "admin");
  const request = { method: "POST" as const, url: f.hook, payload: f.inbound("on-1") };
  const accepted = await f.app.inject(request);
  assert.equal(accepted.statusCode, 202);
  assert.equal(f.calls.length, 0);
  assert.equal(f.store.db.prepare("SELECT status FROM deliveries").get()?.status, "pending");
  assert.equal((await f.app.inject(request)).json().events[0].duplicate, true);
  await f.dispatcher.tick();
  await f.dispatcher.tick();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0]?.url, signalUrl);
  const payload = JSON.parse(String(f.calls[0]?.init.body));
  assert.equal(payload.instance, "number-one");
  assert.equal(payload.data.message.conversation, "Olá");
  assert.equal(payload.apikey, undefined);
  assert.equal(payload.destination, undefined);
  const row = f.store.db.prepare("SELECT * FROM deliveries").get();
  assert.equal(row?.status, "delivered");
  assert.equal(row?.payload, null);
});

test("pause cancels queued/retrying deliveries and does not resurrect them", async (t) => {
  const f = await fixture(t, async () => new Response("{}", { status: 503 }));
  f.store.setOverflow(f.id, true, "admin");
  await f.app.inject({ method: "POST", url: f.hook, payload: f.inbound("retry-1") });
  await f.dispatcher.tick();
  assert.equal(f.calls.length, 1);
  assert.equal(f.store.db.prepare("SELECT status FROM deliveries").get()?.status, "pending");
  f.store.setOverflow(f.id, false, "admin");
  f.store.setOverflow(f.id, true, "admin");
  f.store.db.prepare("UPDATE deliveries SET next_at=0").run();
  await f.dispatcher.tick();
  assert.equal(f.calls.length, 1);
  assert.equal(f.store.db.prepare("SELECT status FROM deliveries").get()?.status, "ignored");
});

test("transient Signal errors retry once due; permanent errors are visible and never retried", async (t) => {
  let status = 503;
  const f = await fixture(t, async () => new Response("{}", { status }));
  f.store.setOverflow(f.id, true, "admin");
  await f.app.inject({ method: "POST", url: f.hook, payload: f.inbound("retry-2") });
  await f.dispatcher.tick();
  status = 200;
  f.store.db.prepare("UPDATE deliveries SET next_at=0").run();
  await f.dispatcher.tick();
  assert.equal(f.calls.length, 2);
  assert.equal(f.store.db.prepare("SELECT status FROM deliveries").get()?.status, "delivered");
  status = 401;
  await f.app.inject({ method: "POST", url: f.hook, payload: f.inbound("invalid-auth") });
  await f.dispatcher.tick();
  await f.dispatcher.tick();
  assert.equal(f.calls.length, 3);
  assert.equal(
    f.store.db.prepare("SELECT last_error FROM deliveries WHERE status='failed'").get()?.last_error,
    "SIGNAL_HTTP_401",
  );
});

test("contact sync preserves exclusions, resolves LID aliases and scopes them to the number", async (t) => {
  const f = await fixture(t);
  f.store.setOverflow(f.id, true, "admin");
  f.store.upsertContact(f.id, "558399991111@s.whatsapp.net", "Nome anterior", "558399991111");
  f.store.setIgnored(f.id, "558399991111@s.whatsapp.net", true, "admin");
  syncContacts(f.store, f.id, [
    { remoteJid: "558399991111@s.whatsapp.net", pushName: "Nome atualizado" },
  ]);
  const inbound = f.inbound("lid-1", "123456789@lid");
  Object.assign(inbound.data.key, { remoteJidAlt: "558399991111@s.whatsapp.net" });
  await f.app.inject({ method: "POST", url: f.hook, payload: inbound });
  assert.equal(f.store.isIgnored(f.id, "123456789@lid"), true);
  await f.dispatcher.tick();
  assert.equal(f.calls.length, 0);
  const second = f.store.createConnection({
    name: "Segundo",
    instance: "number-two",
    evolutionKey: "another-instance-key",
  }).connection;
  assert.equal(f.store.isIgnored(second.id, "558399991111@s.whatsapp.net"), false);
  const list = await f.app.inject({
    url: `/api/connections/${f.id}/contacts?ignored=true`,
    headers: f.headers,
  });
  assert.equal(list.statusCode, 200);
  assert.equal(list.json().total, 1);
});

test("ignoring a contact cancels an already queued message", async (t) => {
  const f = await fixture(t);
  f.store.setOverflow(f.id, true, "admin");
  await f.app.inject({ method: "POST", url: f.hook, payload: f.inbound("ignore-queued") });
  f.store.setIgnored(f.id, "558399991111@s.whatsapp.net", true, "admin");
  await f.dispatcher.tick();
  assert.equal(f.calls.length, 0);
  assert.equal(
    f.store.db.prepare("SELECT last_error FROM deliveries").get()?.last_error,
    "CONTACT_IGNORED",
  );
});

test("webhook secrets, connection key and instance identity cannot be used across numbers", async (t) => {
  const f = await fixture(t);
  f.store.setOverflow(f.id, true, "admin");
  assert.equal(
    (await f.app.inject({ method: "POST", url: `/hooks/${f.id}/wrong`, payload: f.inbound("x") }))
      .statusCode,
    401,
  );
  assert.equal(
    (
      await f.app.inject({
        method: "POST",
        url: f.hook,
        payload: { ...f.inbound("x"), instance: "number-two" },
      })
    ).statusCode,
    403,
  );
  const second = f.store.createConnection({
    name: "Segundo",
    instance: "number-two",
    evolutionKey: "another-instance-key",
  });
  const path = `/bridge/${f.id}/message/sendText/number-one`;
  assert.equal(
    (
      await f.app.inject({
        method: "POST",
        url: path,
        headers: { apikey: second.bridgeKey },
        payload: { number: "558399991111", text: "Resposta" },
      })
    ).statusCode,
    401,
  );
  assert.equal(
    (
      await f.app.inject({
        method: "POST",
        url: `/bridge/${f.id}/message/sendText/number-two`,
        headers: { apikey: f.bridgeKey },
        payload: { number: "558399991111", text: "Resposta" },
      })
    ).statusCode,
    403,
  );
  assert.equal(f.calls.length, 0);
});

test("Signal replies use the instance key and obey pause/exclusions; remote administration is forbidden", async (t) => {
  const f = await fixture(t);
  f.store.setOverflow(f.id, true, "admin");
  const request = {
    method: "POST" as const,
    url: `/bridge/${f.id}/message/sendText/number-one`,
    headers: { apikey: f.bridgeKey },
    payload: { number: "558399991111", text: "Resposta do Signal" },
  };
  const sent = await f.app.inject(request);
  assert.equal(sent.statusCode, 200);
  assert.equal(sent.json().key.id, "sent-1");
  assert.equal(sent.json().apikey, undefined);
  assert.equal(f.calls[0]?.url, "https://evolution.example.test/message/sendText/number-one");
  assert.equal(
    (f.calls[0]?.init.headers as Record<string, string>).apikey,
    "instance-test-key-only",
  );
  f.store.upsertContact(f.id, "558399991111@s.whatsapp.net", "", "558399991111");
  f.store.setIgnored(f.id, "558399991111@s.whatsapp.net", true, "admin");
  assert.equal((await f.app.inject(request)).statusCode, 409);
  f.store.setOverflow(f.id, false, "admin");
  assert.equal((await f.app.inject(request)).json().error, "CONTACT_IGNORED");
  assert.equal(
    (
      await f.app.inject({
        method: "POST",
        url: `/bridge/${f.id}/webhook/set/number-one`,
        headers: request.headers,
        payload: {},
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await f.app.inject({
        method: "DELETE",
        url: `/bridge/${f.id}/instance/delete/number-one`,
        headers: request.headers,
      })
    ).statusCode,
    403,
  );
  assert.equal(f.calls.length, 1);
});

test("ambiguous outbound network failures return 424, never a retryable gateway 500", async (t) => {
  const f = await fixture(t, async () => {
    throw new Error("upstream socket lost with secret");
  });
  f.store.setOverflow(f.id, true, "admin");
  const response = await f.app.inject({
    method: "POST",
    url: `/bridge/${f.id}/message/sendText/number-one`,
    headers: { apikey: f.bridgeKey },
    payload: { number: "558399991111", text: "Resposta" },
  });
  assert.equal(response.statusCode, 424);
  assert.equal(response.json().error, "DELIVERY_UNKNOWN");
  assert.ok(!response.body.includes("secret"));
});

test("Signal destination is constrained to its configured origin and webhook path", async (t) => {
  const f = await fixture(t);
  for (const signalUrl of [
    "https://attacker.test/webhooks/evolution/abcdefghijklmnop/secret",
    "https://signal.example.test/admin/v1/tenants",
    "http://127.0.0.1:22",
  ]) {
    assert.equal(
      (
        await f.app.inject({
          method: "PATCH",
          url: `/api/connections/${f.id}`,
          headers: f.headers,
          payload: { signalUrl },
        })
      ).statusCode,
      400,
    );
  }
  assert.equal(f.calls.length, 0);
});

test("batches validate atomically and status events preserve distinct delivery states", async (t) => {
  const f = await fixture(t);
  f.store.setOverflow(f.id, true, "admin");
  const root = f.inbound("batch");
  const invalid = await f.app.inject({
    method: "POST",
    url: f.hook,
    payload: { ...root, data: [root.data, {}] },
  });
  assert.equal(invalid.statusCode, 400);
  assert.equal(f.store.db.prepare("SELECT count(*) AS total FROM deliveries").get()?.total, 0);
  for (const status of ["DELIVERY_ACK", "READ", "READ"])
    await f.app.inject({
      method: "POST",
      url: f.hook,
      payload: {
        instance: root.instance,
        event: "messages.update",
        data: { keyId: "batch", remoteJid: root.data.key.remoteJid, fromMe: true, status },
      },
    });
  assert.equal(f.store.db.prepare("SELECT count(*) AS total FROM deliveries").get()?.total, 2);
});

test("queued messages survive a database reopen and payload is encrypted at rest", () => {
  const dir = mkdtempSync(join(tmpdir(), "portal-durable-")),
    path = join(dir, "portal.sqlite");
  let store = new Store(path, config.ENCRYPTION_KEY);
  try {
    const { connection: c } = store.createConnection({ name: "Durável" });
    store.enqueue(c, "key", "MESSAGES_UPSERT", "558399991111@s.whatsapp.net", {
      text: "conteúdo reservado",
    });
    const stored = store.db.prepare("SELECT payload FROM deliveries").get()?.payload as string;
    assert.ok(!stored.includes("conteúdo reservado"));
    store.close();
    store = new Store(path, config.ENCRYPTION_KEY);
    const job = store.claim()!;
    assert.equal(job.attempts, 1);
    assert.deepEqual(store.vault.open(job.payload!, job.id), { text: "conteúdo reservado" });
    assert.throws(() => store.vault.open(job.payload!, "another-id"));
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a pause during an in-flight delivery preserves its actual result and never restarts it", async (t) => {
  for (const status of [200, 503]) {
    await t.test(`upstream HTTP ${status}`, async (t) => {
      let release!: (response: Response) => void;
      const f = await fixture(
        t,
        async () =>
          new Promise<Response>((resolve) => {
            release = resolve;
          }),
      );
      f.store.setOverflow(f.id, true, "admin");
      await f.app.inject({ method: "POST", url: f.hook, payload: f.inbound("in-flight") });
      const pending = f.dispatcher.tick();
      f.store.setOverflow(f.id, false, "admin");
      f.store.setOverflow(f.id, true, "admin");
      release(Response.json({}, { status }));
      await pending;
      assert.equal(
        f.store.db.prepare("SELECT status FROM deliveries").get()?.status,
        status === 200 ? "delivered" : "ignored",
      );
      f.store.db.prepare("UPDATE deliveries SET next_at=0").run();
      await f.dispatcher.tick();
      assert.equal(f.calls.length, 1);
    });
  }
});

test("an unresolved LID cannot bypass a configured contact exclusion", async (t) => {
  const f = await fixture(t);
  f.store.setOverflow(f.id, true, "admin");
  f.store.upsertContact(f.id, "558399991111@s.whatsapp.net", "", "558399991111");
  f.store.setIgnored(f.id, "558399991111@s.whatsapp.net", true, "admin");
  await f.app.inject({
    method: "POST",
    url: f.hook,
    payload: f.inbound("unknown-lid", "123456789@lid"),
  });
  await f.dispatcher.tick();
  assert.equal(f.calls.length, 0);
  assert.equal(
    f.store.db.prepare("SELECT last_error FROM deliveries").get()?.last_error,
    "IDENTITY_UNRESOLVED",
  );
});

test("production login rate limits use the client IP only through the configured proxy", async (t) => {
  const production = configSchema.parse({
    ...config,
    NODE_ENV: "production",
    PUBLIC_URL: "https://portal.example.test",
    TRUST_PROXY: "10.0.1.0/24",
  });
  const { app } = await buildApp(production, { logger: false });
  t.after(() => app.close());
  const attempt = (remoteAddress: string, forwardedFor: string) =>
    app.inject({
      method: "POST",
      url: "/api/login",
      remoteAddress,
      headers: { origin: production.PUBLIC_URL, "x-forwarded-for": forwardedFor },
      payload: { email: "absent@example.test", password: "incorrect" },
    });
  for (let i = 0; i < 8; i++)
    assert.equal((await attempt("10.0.1.7", "198.51.100.10")).statusCode, 401);
  assert.equal((await attempt("10.0.1.7", "198.51.100.10")).statusCode, 429);
  assert.equal((await attempt("10.0.1.7", "198.51.100.11")).statusCode, 401);
  for (let i = 0; i < 8; i++)
    assert.equal((await attempt("198.51.100.12", `203.0.113.${i}`)).statusCode, 401);
  assert.equal((await attempt("198.51.100.12", "203.0.113.200")).statusCode, 429);
});

test("one platform webhook and key route two devices independently", async (t) => {
  const f = await fixture(t);
  const second = f.store.createConnection({
    name: "Segundo dispositivo",
    instance: "number-two",
    evolutionKey: "second-instance-private-key",
  }).connection;
  f.store.db.prepare("UPDATE connections SET webhook_configured=1").run();
  f.store.setPlatformWebhook(signalUrl, "admin");
  while (await f.dispatcher.tick()) {
    /* publish metadata separately from messages */
  }
  f.calls.length = 0;
  for (const id of [f.id, second.id]) f.store.setOverflow(id, true, "admin");
  await f.app.inject({ method: "POST", url: f.hook, payload: f.inbound("same-message-id") });
  const secondHook = `/hooks/${second.id}/${f.store.secrets(second).webhookToken}`;
  await f.app.inject({
    method: "POST",
    url: secondHook,
    payload: { ...f.inbound("same-message-id"), instance: second.instance },
  });
  while (await f.dispatcher.tick()) {
    /* drain */
  }
  assert.equal(f.calls.length, 2);
  const payloads = f.calls.map((call) => JSON.parse(String(call.init.body)));
  assert.deepEqual(new Set(payloads.map((body) => body.device.id)), new Set([f.id, second.id]));
  for (const call of f.calls) assert.equal(call.url, signalUrl);
  for (const body of payloads) {
    assert.equal(body.instance, f.store.platform().id);
    assert.equal(body.platformId, f.store.platform().id);
  }
  f.calls.length = 0;
  const key = f.store.platform().apiKey;
  for (const id of [f.id, second.id]) {
    const reply = await f.app.inject({
      method: "POST",
      url: `/platform/message/sendText/${id}`,
      headers: { apikey: key },
      payload: { number: "558399991111", text: "Resposta" },
    });
    assert.equal(reply.statusCode, 200, reply.body);
  }
  assert.match(f.calls[0]!.url, /sendText\/number-one$/);
  assert.match(f.calls[1]!.url, /sendText\/number-two$/);
  assert.equal(
    (f.calls[1]!.init.headers as Record<string, string>).apikey,
    "second-instance-private-key",
  );
  f.store.setOverflow(f.id, false, "operator");
  assert.equal(
    (
      await f.app.inject({
        method: "POST",
        url: `/platform/message/sendText/${f.id}`,
        headers: { apikey: key },
        payload: { number: "558399991111", text: "Pausado" },
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (
      await f.app.inject({
        method: "POST",
        url: `/platform/message/sendText/${second.id}`,
        headers: { apikey: key },
        payload: { number: "558399991111", text: "Ativo" },
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await f.app.inject({
        method: "POST",
        url: `/platform/message/sendText/${f.store.platform().id}`,
        headers: { apikey: key },
        payload: { number: "558399991111", text: "Sem dispositivo" },
      })
    ).statusCode,
    409,
  );
});

test("platform key is admin-only; device keys cannot access the platform; profile updates work while paused", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.app.inject("/api/platform")).statusCode, 401);
  const info = await f.app.inject({ url: "/api/platform", headers: f.headers });
  assert.equal(info.json().apiKey, f.store.platform().apiKey);
  const login = await f.app.inject({
    method: "POST",
    url: "/api/login",
    headers: { origin: config.PUBLIC_URL },
    payload: { email: "operator@example.test", password },
  });
  const cookie = login.cookies[0]!;
  const operatorHeaders = { ...f.headers, cookie: `${cookie.name}=${cookie.value}` };
  const operator = await f.app.inject({ url: "/api/platform", headers: operatorHeaders });
  assert.equal(operator.json().apiKey, undefined);
  assert.equal(
    (
      await f.app.inject({
        method: "PATCH",
        url: "/api/platform",
        headers: operatorHeaders,
        payload: { signalUrl },
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (await f.app.inject({ url: "/platform/devices", headers: { apikey: f.bridgeKey } })).statusCode,
    401,
  );
  f.store.setPlatformWebhook(signalUrl, "admin");
  f.store.setOverflow(f.id, false, "admin");
  await f.dispatcher.tick();
  assert.equal(JSON.parse(String(f.calls[0]!.init.body)).event, "DEVICE_UPDATE");
  const photo = await f.app.inject(`/api/connections/${f.id}/photo`);
  assert.equal(photo.statusCode, 401);
});

test("profile synchronization selects the device, caches its photo and clears a removed photo", async (t) => {
  let picture: string | null = "https://photos.example.test/own.jpg";
  const bytes = Buffer.from([255, 216, 255, 217]);
  const f = await fixture(t, async (url, init) => {
    if (url.includes("fetchInstances"))
      return Response.json([
        { name: "another-device", profileName: "Outro", ownerJid: "551100001111@s.whatsapp.net" },
        {
          name: "number-one",
          profileName: "Nome WhatsApp",
          ownerJid: "558398887777:3@s.whatsapp.net",
          profilePicUrl: picture,
          connectionStatus: "open",
          token: "must-not-leak",
        },
      ]);
    assert.equal(url, picture);
    assert.equal((init.headers as Record<string, string> | undefined)?.apikey, undefined);
    return new Response(bytes, { headers: { "content-type": "image/jpeg" } });
  });
  const result = await f.app.inject({
    method: "POST",
    url: `/api/connections/${f.id}/profile`,
    headers: f.headers,
    payload: {},
  });
  assert.equal(result.statusCode, 200, result.body);
  assert.equal(result.json().profileName, "Nome WhatsApp");
  assert.equal(result.json().number, "558398887777");
  assert.equal(result.json().hasPhoto, true);
  assert.ok(!result.body.includes("must-not-leak"));
  const photo = await f.app.inject({ url: `/api/connections/${f.id}/photo`, headers: f.headers });
  assert.equal(photo.statusCode, 200);
  assert.equal(photo.headers["content-type"], "image/jpeg");
  assert.deepEqual(photo.rawPayload, bytes);
  picture = null;
  await f.evolution.syncProfile(f.store.connection(f.id));
  assert.equal(f.store.connection(f.id).profile_photo, null);
});

test("changing the shared webhook requires all devices paused and does not replay old messages", async (t) => {
  const f = await fixture(t);
  f.store.setOverflow(f.id, true, "admin");
  assert.throws(
    () => f.store.setPlatformWebhook(signalUrl, "admin"),
    /PAUSE_BEFORE_CHANGING_WEBHOOK/,
  );
  await f.app.inject({ method: "POST", url: f.hook, payload: f.inbound("before-platform") });
  f.store.setOverflow(f.id, false, "admin");
  f.store.setPlatformWebhook(signalUrl, "admin");
  f.store.setOverflow(f.id, true, "admin");
  while (await f.dispatcher.tick()) {
    /* only metadata may be sent */
  }
  assert.ok(f.calls.every((call) => JSON.parse(String(call.init.body)).event === "DEVICE_UPDATE"));
  assert.equal(f.store.secrets(f.store.connection(f.id)).signalUrl, undefined);
});

test("profile name falls back to the live account when Evolution's instance table has no name", async (t) => {
  let profileJid = "5583999990000@s.whatsapp.net";
  const f = await fixture(t, async (url, init) => {
    if (url.includes("fetchInstances"))
      return Response.json([
        {
          name: "number-one",
          ownerJid: "5583999990000:12@s.whatsapp.net",
          profileName: null,
          profilePicUrl: null,
          connectionStatus: "open",
        },
      ]);
    assert.ok(url.endsWith("/chat/fetchProfile/number-one"));
    assert.deepEqual(JSON.parse(String(init.body)), { number: "5583999990000" });
    assert.equal((init.headers as Record<string, string>).apikey, "instance-test-key-only");
    return Response.json({ wuid: profileJid, name: "Nome do WhatsApp", numberExists: true });
  });
  await f.evolution.syncProfile(f.store.connection(f.id));
  assert.equal(f.store.connection(f.id).profile_name, "Nome do WhatsApp");
  profileJid = "5583999999999@s.whatsapp.net";
  await f.evolution.syncProfile(f.store.connection(f.id));
  assert.equal(f.store.connection(f.id).profile_name, null);
});
