import { z } from "zod";
import { readFileSync } from "node:fs";

const url = z.url().refine((value) => {
  const u = new URL(value);
  return (
    ["https:", "http:"].includes(u.protocol) && !u.username && !u.password && !u.search && !u.hash
  );
});

export const configSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().min(1).max(65535).default(3080),
    HOST: z.string().default("127.0.0.1"),
    PUBLIC_URL: url.default("http://localhost:3080"),
    DATABASE_PATH: z.string().default("./data/portal.sqlite"),
    ENCRYPTION_KEY: z
      .string()
      .refine(
        (value) => Buffer.from(value, "base64").length === 32,
        "Use uma chave de 32 bytes em base64",
      ),
    EVOLUTION_URL: z.preprocess((v) => (v === "" ? undefined : v), url.optional()),
    EVOLUTION_API_KEY: z.string().optional(),
    SIGNAL_API_ORIGIN: z.preprocess((v) => (v === "" ? undefined : v), url.optional()),
    ALLOW_PRIVATE_NETWORKS: z.enum(["true", "false"]).default("false"),
  })
  .superRefine((config, ctx) => {
    for (const field of ["PUBLIC_URL", "SIGNAL_API_ORIGIN"] as const) {
      const value = config[field];
      if (value && new URL(value).pathname !== "/")
        ctx.addIssue({
          code: "custom",
          path: [field],
          message: "Use apenas a origem, sem caminho",
        });
    }
    if (config.NODE_ENV === "production") {
      for (const field of ["PUBLIC_URL", "EVOLUTION_URL", "SIGNAL_API_ORIGIN"] as const) {
        if (!config[field]?.startsWith("https://"))
          ctx.addIssue({ code: "custom", path: [field], message: "HTTPS obrigatório em produção" });
      }
      if (config.ALLOW_PRIVATE_NETWORKS === "true")
        ctx.addIssue({
          code: "custom",
          path: ["ALLOW_PRIVATE_NETWORKS"],
          message: "Não permitido em produção",
        });
    }
  });
export type Config = z.infer<typeof configSchema>;
export function readConfig(): Config {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const key of ["ENCRYPTION_KEY", "EVOLUTION_API_KEY"] as const) {
    const file = process.env[`${key}_FILE`];
    if (file) env[key] = readFileSync(file, "utf8").trim();
  }
  return configSchema.parse(env);
}
