import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";
import { deleteKey, readJson, writeJson } from "./store.js";

const sessionTtlSeconds = 60 * 60 * 6;
const sessionKeyPrefix = "facturas-ai:sri-session:";

export type SriCredentials = {
  ruc: string;
  username: string;
  password: string;
};

export type SriSession = {
  id: string;
  ruc: string;
  username: string;
  encryptedPassword: string;
  createdAt: string;
  expiresAt: string;
};

function encryptionKey() {
  const secret = process.env.SRI_SESSION_SECRET || process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!secret) {
    throw new Error("Configura SRI_SESSION_SECRET en Vercel para cifrar sesiones SRI.");
  }

  return createHash("sha256").update(secret).digest();
}

function encrypt(value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("base64"), tag.toString("base64"), encrypted.toString("base64")].join(".");
}

function decrypt(value: string) {
  const [ivRaw, tagRaw, encryptedRaw] = value.split(".");
  if (!ivRaw || !tagRaw || !encryptedRaw) {
    throw new Error("La sesion SRI guardada no es valida.");
  }

  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivRaw, "base64"));
  decipher.setAuthTag(Buffer.from(tagRaw, "base64"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedRaw, "base64")),
    decipher.final(),
  ]);

  return decrypted.toString("utf8");
}

function cleanDigits(value: string) {
  return value.replace(/\D/g, "");
}

export function validateSriCredentials(input: Partial<SriCredentials>) {
  const ruc = cleanDigits(String(input.ruc || input.username || ""));
  const username = cleanDigits(String(input.username || input.ruc || ""));
  const password = String(input.password || "");

  if (ruc.length !== 13) {
    throw new Error("Ingresa un RUC valido de 13 digitos.");
  }

  if (username.length !== 13) {
    throw new Error("El usuario SRI normalmente es el RUC de 13 digitos.");
  }

  if (password.length < 4) {
    throw new Error("Ingresa la clave del SRI.");
  }

  return { ruc, username, password };
}

export async function createSriSession(input: Partial<SriCredentials>) {
  const credentials = validateSriCredentials(input);
  const id = randomBytes(24).toString("base64url");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + sessionTtlSeconds * 1000);
  const session: SriSession = {
    id,
    ruc: credentials.ruc,
    username: credentials.username,
    encryptedPassword: encrypt(credentials.password),
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };

  await writeJson(`${sessionKeyPrefix}${id}`, session, { expiresInSeconds: sessionTtlSeconds });

  return {
    id,
    ruc: session.ruc,
    username: session.username,
    expiresAt: session.expiresAt,
  };
}

export async function readSriSession(sessionId: string) {
  const session = await readJson<SriSession>(`${sessionKeyPrefix}${sessionId}`);
  if (!session) {
    throw new Error("La sesion SRI expiro. Inicia sesion nuevamente.");
  }

  return {
    ...session,
    password: decrypt(session.encryptedPassword),
  };
}

export async function deleteSriSession(sessionId: string) {
  await deleteKey(`${sessionKeyPrefix}${sessionId}`);
}
