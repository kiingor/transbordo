import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
const scryptAsync = promisify(scrypt);
export const token = () => randomBytes(32).toString("base64url");
export const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export function equalSecret(a: string, b: string): boolean {
  return timingSafeEqual(Buffer.from(digest(a)), Buffer.from(digest(b)));
}
export class Vault {
  constructor(private key: Buffer) {}
  seal(value: unknown, context: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(context));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    return [iv, cipher.getAuthTag(), encrypted].map((v) => v.toString("base64")).join(".");
  }
  open<T>(value: string, context: string): T {
    const [iv, tag, encrypted] = value.split(".").map((v) => Buffer.from(v, "base64"));
    if (!iv || !tag || !encrypted) throw new Error("INVALID_CIPHERTEXT");
    const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(encrypted), decipher.final()]).toString());
  }
}
export async function hashPassword(value: string): Promise<string> {
  const salt = token();
  const key = (await scryptAsync(value, salt, 64)) as Buffer;
  return `${salt}:${key.toString("hex")}`;
}
export async function verifyPassword(value: string, hash: string): Promise<boolean> {
  const [salt, expected] = hash.split(":");
  const actual = (await scryptAsync(value, salt ?? "invalid-user-salt", 64)) as Buffer;
  const reference = Buffer.from(expected ?? "00".repeat(64), "hex");
  return reference.length === actual.length && timingSafeEqual(reference, actual);
}
export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code);
  }
}
