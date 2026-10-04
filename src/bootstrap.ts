import { randomUUID } from "node:crypto";
import { z } from "zod";
import { readConfig } from "./config.js";
import { hashPassword } from "./security.js";
import { Store } from "./store.js";
const config = readConfig();
const input = z
  .object({
    BOOTSTRAP_EMAIL: z.email(),
    BOOTSTRAP_PASSWORD: z.string().min(12).max(256),
    BOOTSTRAP_NAME: z.string().min(2).default("Administrador"),
  })
  .parse(process.env);
const store = new Store(config.DATABASE_PATH, config.ENCRYPTION_KEY);
try {
  if (store.db.prepare("SELECT 1 FROM users LIMIT 1").get())
    throw new Error("Administrador já cadastrado. Use a tela Equipe.");
  store.db
    .prepare("INSERT INTO users VALUES(?,?,?,?,?,1)")
    .run(
      randomUUID(),
      input.BOOTSTRAP_NAME,
      input.BOOTSTRAP_EMAIL.toLowerCase(),
      await hashPassword(input.BOOTSTRAP_PASSWORD),
      "admin",
    );
  console.log("Administrador criado. A senha não é registrada nos logs.");
} finally {
  store.close();
}
