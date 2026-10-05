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
    if (url.includes("/instance/delete/") && init.method === "DELETE") {
      provisioned.delete(instance);
      return Response.json({ status: "SUCCESS", error: false });
    }
    if (url.endsWith("/instance/create")) {
      provisioned.add(JSON.parse(String(init.body)).instanceName);
      return Response.json({ instance: { state: "connecting" } });
    }
    if (url.includes("connectionState"))
      return provisioned.has(instance)
        ? Response.json({ instance: { state: "open" } })
        : new Response("{}", { status: 404 });
    if (url.includes("fetchInstances"))
      return Response.json([
        {
          name: new URL(url).searchParams.get("instanceName"),
          profileName: "Perfil sincronizado",
          ownerJid: "5583999990000@s.whatsapp.net",
          connectionStatus: "open",
          profilePicUrl: "https://photo.example.test/profile.png",
        },
      ]);
    if (url.startsWith("https://photo.example.test/"))
      return new Response(
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf0cAAAAASUVORK5CYII=",
          "base64",
        ),
        { headers: { "content-type": "image/png" } },
      );
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
  store.db
    .prepare("UPDATE connections SET webhook_configured=1,state='open',number=? WHERE id=?")
    .run(`558399999000${index}`, c.id);
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
async function screenshot(name: string, fullPage = true) {
  if (!shots) return;
  await mkdir(shots, { recursive: true });
  await page.screenshot({ path: resolve(shots, name), fullPage });
}
try {
  await page.goto(config.PUBLIC_URL);
  await expect(page.getByRole("heading", { name: "Bem-vindo de volta" })).toBeVisible();
  await screenshot("login.png");
  await page.getByLabel("E-mail", { exact: true }).fill("admin@example.test");
  await page.getByLabel("Senha", { exact: true }).fill("browser-test-password");
  await page.getByRole("button", { name: "Entrar no portal" }).click();
  await expect(page.getByRole("heading", { name: "Seus dispositivos" })).toBeVisible();
  await expect(page.locator(".connection-card")).toHaveCount(3);
  await page.getByText("Configurar conexão com o Signal", { exact: true }).click();
  await expect(page.getByLabel("URL da plataforma", { exact: true })).toHaveValue(
    `${config.PUBLIC_URL}/platform`,
  );
  await page
    .getByLabel("Webhook único do Signal")
    .fill(`https://signal.example.test/webhooks/evolution/channel-public-id/${"s".repeat(43)}`);
  await page.getByRole("button", { name: "Salvar conexão da plataforma" }).click();
  await expect(
    page.getByText("Conexão da plataforma com o Signal configurada.", { exact: true }),
  ).toBeVisible();
  await page.getByText("Configurar conexão com o Signal", { exact: true }).click();
  await page
    .getByRole("switch", { name: "Transbordo de Atendimento comercial", exact: true })
    .click();
  await page.getByRole("switch", { name: "Transbordo de Suporte técnico", exact: true }).click();
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
    .getByRole("button", { name: "Gerenciar dispositivo" })
    .click();
  await expect(page.getByRole("heading", { name: "Quem pode chegar ao Signal?" })).toBeVisible();
  const individual = page.getByRole("switch", {
    name: "Ativar transbordo de Ana · teste",
    exact: true,
  });
  const general = page.getByRole("switch", { name: "Ativar transbordo geral", exact: true });
  const ana = page.locator("tbody tr").filter({ hasText: "Ana · teste" });
  const bruno = page.locator("tbody tr").filter({ hasText: "Bruno · teste" });
  await expect(page.getByRole("switch", { name: /^Ativar transbordo de / })).toHaveCount(4);
  for (const control of await page.getByRole("switch", { name: /^Ativar transbordo de / }).all())
    await expect(control).toHaveAttribute("aria-checked", "false");
  await expect(ana.getByText("Desativado", { exact: true })).toBeVisible();
  await individual.click();
  await expect(individual).toHaveAttribute("aria-checked", "true");
  await expect(general).toHaveAttribute("aria-checked", "false");
  await expect(ana.getByText("Ativo · individual", { exact: true })).toBeVisible();
  await expect(bruno.getByText("Desativado", { exact: true })).toBeVisible();
  await general.click();
  await expect(bruno.getByText("Ativo · geral", { exact: true })).toBeVisible();
  await expect(
    bruno.getByRole("switch", { name: "Ativar transbordo de Bruno · teste", exact: true }),
  ).toHaveAttribute("aria-checked", "false");
  await general.click();
  await expect(bruno.getByText("Desativado", { exact: true })).toBeVisible();
  await expect(ana.getByText("Ativo · individual", { exact: true })).toBeVisible();
  await page.getByLabel("Filtrar contatos").selectOption("individual");
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await page.getByLabel("Filtrar contatos").selectOption("all");
  await expect(page.locator("tbody tr")).toHaveCount(4);
  await screenshot("individual-contacts-desktop.png");
  await page.setViewportSize({ width: 390, height: 844 });
  await individual.scrollIntoViewIfNeeded();
  await individual.click();
  await expect(ana.getByText("Desativado", { exact: true })).toBeVisible();
  await individual.click();
  await expect(ana.getByText("Ativo · individual", { exact: true })).toBeVisible();
  await screenshot("individual-contacts-mobile.png", false);
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth))
    throw new Error("Individual contact controls overflow the mobile viewport");
  await expect(individual).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("switch", { name: "Ignorar Ana · teste" }).click();
  await expect(page.getByRole("switch", { name: "Ignorar Ana · teste" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(ana.getByText("Ignorado", { exact: true })).toBeVisible();
  await expect(individual).toHaveAttribute("aria-checked", "true");
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
  await page.getByRole("button", { name: "Todos os dispositivos" }).click();
  await page.getByRole("button", { name: "Adicionar dispositivo", exact: true }).click();
  await page.getByLabel("Nome do dispositivo").fill("Novo número de teste");
  await page.getByRole("button", { name: "Criar dispositivo" }).click();
  await expect(
    page.getByRole("heading", { name: "Novo número de teste", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Conectar WhatsApp", exact: true }).click();
  await expect(page.getByText("Recebimento de webhooks configurado")).toBeVisible();
  await expect(page.getByLabel("Webhook único do Signal")).toHaveCount(0);
  await page.getByRole("button", { name: "Sincronizar perfil", exact: true }).click();
  await expect(page.getByText("Nome e foto do dispositivo sincronizados.")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Perfil sincronizado", exact: true }),
  ).toBeVisible();
  await expect(page.getByAltText("Foto de Perfil sincronizado").first()).toBeVisible();
  await expect
    .poll(() =>
      page
        .getByAltText("Foto de Perfil sincronizado")
        .first()
        .evaluate((img) => (img as HTMLImageElement).naturalWidth),
    )
    .toBeGreaterThan(0);
  await screenshot("device-profile.png");
  await page.getByRole("switch", { name: "Ativar transbordo geral", exact: true }).click();
  await expect(
    page.getByRole("switch", { name: "Ativar transbordo geral", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await dispatcher.tick();
  const added = store.db
    .prepare("SELECT id,instance FROM connections WHERE name=?")
    .get("Novo número de teste")!;
  const platformBeforeRemoval = store.platform();
  await page.getByRole("button", { name: "Remover dispositivo", exact: true }).click();
  const removal = page.getByRole("dialog", { name: "Remover este dispositivo?" });
  await expect(removal).toBeVisible();
  await expect(removal.getByText("Perfil sincronizado", { exact: true })).toBeVisible();
  await expect(
    removal.getByText(/As conversas já recebidas no Signal serão mantidas/),
  ).toBeVisible();
  await removal.getByRole("button", { name: "Cancelar", exact: true }).click();
  await expect(removal).toHaveCount(0);
  if (!store.db.prepare("SELECT 1 FROM connections WHERE id=?").get(String(added.id)))
    throw new Error("Cancel removed the device");
  await page.getByRole("button", { name: "Remover dispositivo", exact: true }).click();
  await screenshot("remove-device-desktop.png", false);
  await page.setViewportSize({ width: 390, height: 844 });
  await screenshot("remove-device-mobile.png", false);
  if (
    !(await removal.evaluate((dialog) => {
      const box = dialog.getBoundingClientRect();
      return box.top >= 0 && box.bottom <= innerHeight && box.right <= innerWidth;
    }))
  )
    throw new Error("Removal dialog does not fit the mobile screen");
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth))
    throw new Error("Removal modal overflows viewport");
  await removal.getByRole("button", { name: "Confirmar remoção", exact: true }).click();
  await expect(
    page.getByText("Dispositivo removido. A conexão da plataforma com o Signal foi mantida."),
  ).toBeVisible();
  await expect(page.locator(".connection-card")).toHaveCount(3);
  if (provisioned.has(String(added.instance)))
    throw new Error("Managed Evolution instance was not removed");
  if (JSON.stringify(store.platform()) !== JSON.stringify(platformBeforeRemoval))
    throw new Error("Removing a device changed the platform");
  await expect(
    page.getByRole("switch", { name: "Transbordo de Suporte técnico", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
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
  await page.getByLabel("E-mail", { exact: true }).fill("operator@example.test");
  await page.getByLabel("Senha", { exact: true }).fill("operator-test-password");
  await page.getByRole("button", { name: "Entrar no portal" }).click();
  await expect(page.getByRole("heading", { name: "Seus dispositivos" })).toBeVisible();
  await expect(page.locator(".connection-card")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Equipe", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Adicionar dispositivo", exact: true }).first().click();
  await page.getByLabel("Nome do dispositivo").fill("Dispositivo do operador");
  await page.getByRole("button", { name: "Criar dispositivo" }).click();
  await expect(
    page.getByRole("heading", { name: "Dispositivo do operador", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Conectar WhatsApp", exact: true }).click();
  await expect(page.getByText("Recebimento de webhooks configurado")).toBeVisible();
  await expect(page.getByRole("button", { name: "Dispositivo e perfil" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Remover dispositivo", exact: true })).toHaveCount(
    0,
  );
  await page.getByRole("button", { name: "Contatos e exceções" }).click();
  await expect(page.getByRole("heading", { name: "Quem pode chegar ao Signal?" })).toBeVisible();
  await page.getByRole("button", { name: "Todos os dispositivos" }).click();
  await expect(page.locator(".connection-card")).toHaveCount(1);
  await expect(page.getByText("Atendimento comercial", { exact: true })).toHaveCount(0);
  await screenshot("operator-owned-devices.png");
  await page.getByTitle("Alterar minha senha", { exact: true }).click();
  const passwordDialog = page.getByRole("dialog", { name: "Alterar minha senha" });
  await passwordDialog.getByLabel("Senha atual", { exact: true }).fill("operator-test-password");
  await passwordDialog.getByLabel("Nova senha", { exact: true }).fill("updated-operator-password");
  await passwordDialog
    .getByLabel("Confirmar nova senha", { exact: true })
    .fill("mistyped-operator-password");
  await passwordDialog.getByRole("button", { name: "Salvar senha" }).click();
  await expect(
    passwordDialog.getByText("A confirmação não corresponde à nova senha."),
  ).toBeVisible();
  await passwordDialog
    .getByLabel("Confirmar nova senha", { exact: true })
    .fill("updated-operator-password");
  await passwordDialog.getByRole("button", { name: "Salvar senha" }).click();
  await expect(page.getByRole("heading", { name: "Bem-vindo de volta" })).toBeVisible();
  await expect(page.getByRole("status")).toHaveText(
    "Senha alterada com sucesso. Entre com a nova senha.",
  );
  await screenshot("password-changed.png");
  await page.getByLabel("E-mail", { exact: true }).fill("operator@example.test");
  await page.getByLabel("Senha", { exact: true }).fill("updated-operator-password");
  await page.getByRole("button", { name: "Entrar no portal" }).click();
  await expect(page.locator(".connection-card")).toHaveCount(1);
  await page.getByRole("button", { name: "Sair", exact: true }).click();
  await page.getByLabel("E-mail", { exact: true }).fill("admin@example.test");
  await page.getByLabel("Senha", { exact: true }).fill("browser-test-password");
  await page.getByRole("button", { name: "Entrar no portal" }).click();
  await expect(page.locator(".connection-card")).toHaveCount(4);
  await page.getByRole("button", { name: "Sair", exact: true }).click();
  if (failures.length) throw new Error(failures.join("\n"));
  console.log(
    "Browser checks passed: login, shared platform setup, individual/general contact overflow, ignore precedence, contact filters, profile/photo sync, new device, removal/cancel, operator ownership and creation, password confirmation/change/login, admin visibility, mobile layout, team and logout.",
  );
  console.log(`Simulated upstream calls: ${upstream.length}. No real messages sent.`);
} finally {
  await browser.close();
  await app.close();
  store.close();
}
