import { chromium, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { buildApp } from "../src/app.js";
import { configSchema } from "../src/config.js";
import { hashPassword } from "../src/security.js";
import { Store } from "../src/store.js";

const config = configSchema.parse({
  NODE_ENV: "test",
  PORT: 3091,
  PUBLIC_URL: "http://127.0.0.1:3091",
  ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  EVOLUTION_URL: "https://evolution.example.test",
  EVOLUTION_API_KEY: "test-only-server-key",
  SIGNAL_API_ORIGIN: "https://signal.example.test",
});
const store = new Store(":memory:", config.ENCRYPTION_KEY);
store.db
  .prepare("INSERT INTO users VALUES(?,?,?,?,?,1)")
  .run(
    "admin",
    "Equipe Softcom",
    "admin@example.test",
    await hashPassword("browser-test-password"),
    "admin",
  );
const provisioned = new Set<string>();
const upstream: string[] = [];
const { app, dispatcher } = await buildApp(config, {
  store,
  logger: false,
  transport: async (url, init) => {
    upstream.push(url);
    const instance = url.split("/").at(-1)!;
    if (url.endsWith("/instance/create")) {
      provisioned.add(JSON.parse(String(init.body)).instanceName);
      return Response.json({ instance: { state: "connecting" } });
    }
    if (url.includes("connectionState"))
      return provisioned.has(instance)
        ? Response.json({ instance: { state: "open" } })
        : new Response("{}", { status: 404 });
    if (url.includes("findContacts"))
      return Response.json([
        { remoteJid: "5583999990001@s.whatsapp.net", pushName: "Contato de teste" },
      ]);
    return Response.json({ key: { id: "browser-reply" }, status: "PENDING" });
  },
});
for (const [index, name] of ["Atendimento comercial", "Suporte técnico", "Financeiro"].entries()) {
  const { connection: c } = store.createConnection({
    name,
    instance: `browser-${index}`,
    evolutionKey: "test-only-instance-key",
  });
  provisioned.add(c.instance);
  store.setSecrets(c, {
    ...store.secrets(c),
    signalUrl: `https://signal.example.test/webhooks/evolution/channel-public-id/${"s".repeat(43)}`,
  });
  store.db
    .prepare("UPDATE connections SET webhook_configured=1,state='open',number=? WHERE id=?")
    .run(`558399999000${index}`, c.id);
  if (index !== 2) store.setOverflow(c.id, true, "admin");
  for (const [n, contact] of [
    "Ana · teste",
    "Bruno · teste",
    "Carla · teste",
    "Diego · teste",
  ].entries()) {
    const phone = `558398888000${n}`;
    store.upsertContact(c.id, `${phone}@s.whatsapp.net`, contact, phone);
    if (n === 2) store.setIgnored(c.id, `${phone}@s.whatsapp.net`, true, "admin");
  }
}
await app.listen({ host: "127.0.0.1", port: config.PORT });
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_CHANNEL === "chromium"
    ? {}
    : { channel: process.env.PLAYWRIGHT_CHANNEL ?? "chrome" }),
});
const page = await browser.newPage({
  viewport: { width: 1440, height: 1000 },
  deviceScaleFactor: 1,
});
const failures: string[] = [];
page.on("pageerror", (e) => failures.push(e.message));
page.on("console", (e) => {
  if (e.type() === "error" && !e.text().includes("401") && !e.text().includes("favicon"))
    failures.push(e.text());
});
const shots = process.env.PORTAL_SCREENSHOTS;
async function screenshot(name: string) {
  if (!shots) return;
  await mkdir(shots, { recursive: true });
  await page.screenshot({ path: resolve(shots, name), fullPage: true });
}
try {
  await page.goto(config.PUBLIC_URL);
  await expect(page.getByRole("heading", { name: "Bem-vindo de volta" })).toBeVisible();
  await screenshot("login.png");
  await page.getByLabel("E-mail", { exact: true }).fill("admin@example.test");
  await page.getByLabel("Senha", { exact: true }).fill("browser-test-password");
  await page.getByRole("button", { name: "Entrar no portal" }).click();
  await expect(page.getByRole("heading", { name: "Seus números" })).toBeVisible();
  await expect(page.locator(".connection-card")).toHaveCount(3);
  await screenshot("desktop.png");
  const toggle = page.getByRole("switch", {
    name: "Transbordo de Atendimento comercial",
    exact: true,
  });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await page
    .locator(".connection-card")
    .filter({ hasText: "Atendimento comercial" })
    .getByRole("button", { name: "Gerenciar conexão" })
    .click();
  await expect(page.getByRole("heading", { name: "Quem pode chegar ao Signal?" })).toBeVisible();
  await page.getByRole("switch", { name: "Ignorar Ana · teste" }).click();
  await expect(page.getByRole("switch", { name: "Ignorar Ana · teste" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await page.getByLabel("Buscar contato").fill("Ana");
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await page.getByLabel("Buscar contato").fill("");
  await expect(page.locator("tbody tr")).toHaveCount(4);
  await screenshot("contacts.png");
  await page.getByRole("button", { name: "Sincronizar", exact: true }).click();
  await expect(page.getByText("Contatos sincronizados sem alterar as exceções.")).toBeVisible();
  await expect(page.getByRole("switch", { name: "Ignorar Ana · teste" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await page.getByRole("button", { name: "Ignorar número", exact: true }).click();
  await page.getByLabel("Número com DDI e DDD").fill("5583999997777");
  await page.getByRole("button", { name: "Ignorar contato", exact: true }).click();
  await expect(page.getByText("Número adicionado à lista de ignorados.")).toBeVisible();
  await page.getByRole("button", { name: "Todos os números" }).click();
  await page.getByRole("button", { name: "Adicionar número", exact: true }).click();
  await page.getByLabel("Nome da conexão").fill("Novo número de teste");
  await page.getByRole("button", { name: "Criar conexão" }).click();
  await expect(
    page.getByRole("heading", { name: "Novo número de teste", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Conectar WhatsApp", exact: true }).click();
  await expect(page.getByText("Recebimento de webhooks configurado")).toBeVisible();
  await page
    .getByLabel("Webhook gerado pelo Signal")
    .fill(`https://signal.example.test/webhooks/evolution/channel-public-id/${"s".repeat(43)}`);
  await page.getByRole("button", { name: "Salvar webhook" }).click();
  await expect(
    page.getByText("Webhook do Signal salvo. Você já pode ativar o transbordo."),
  ).toBeVisible();
  await page.getByRole("switch", { name: "Ativar transbordo", exact: true }).click();
  await expect(
    page.getByRole("switch", { name: "Ativar transbordo", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await dispatcher.tick();
  await page.getByRole("button", { name: "Todos os números" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await screenshot("mobile.png");
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth))
    throw new Error("Mobile layout overflows viewport");
  await page.getByRole("button", { name: "Atividade", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Encaminhamentos recentes" })).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "Equipe", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Acessos da equipe" })).toBeVisible();
  await page.getByRole("button", { name: "Adicionar pessoa" }).click();
  await page.getByLabel("Nome", { exact: true }).fill("Operador de teste");
  await page.getByLabel("E-mail", { exact: true }).fill("operator@example.test");
  await page.getByLabel("Senha inicial").fill("operator-test-password");
  await page.getByRole("button", { name: "Criar acesso" }).click();
  await expect(page.getByText("Operador de teste", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Sair", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Bem-vindo de volta" })).toBeVisible();
  if (failures.length) throw new Error(failures.join("\n"));
  console.log(
    "Browser checks passed: login, number isolation, pause, contacts, sync, new connection, Signal setup, mobile layout, team and logout.",
  );
  console.log(`Simulated upstream calls: ${upstream.length}. No real messages sent.`);
} finally {
  await browser.close();
  await app.close();
  store.close();
}
