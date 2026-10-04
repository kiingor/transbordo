import { readConfig } from "./config.js";
import { buildApp } from "./app.js";
const config = readConfig();
const { app, store, dispatcher } = await buildApp(config);
// One process owns SQLite and the dispatcher; run one replica per volume.
const timer = setInterval(() => {
  void dispatcher.tick().catch(() => app.log.error("Dispatcher failed; delivery remains durable"));
}, 200);
const cleanup = setInterval(() => store.prune(), 3600_000);
app.addHook("onClose", async () => {
  clearInterval(timer);
  clearInterval(cleanup);
});
await app.listen({ host: config.HOST, port: config.PORT });
let closing = false;
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    clearInterval(timer);
    void app.close();
  });
