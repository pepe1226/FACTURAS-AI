import { Redis } from "@upstash/redis";
import type { InvoiceResult } from "./types.js";

const invoicesKey = "facturas-ai:invoices";

let redisClient: Redis | null = null;

function redisConfig() {
  return {
    url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
  };
}

export function hasRedisConfigured() {
  const { url, token } = redisConfig();
  return Boolean(url && token);
}

export function getRedis() {
  if (redisClient) return redisClient;

  const { url, token } = redisConfig();

  if (!url || !token) {
    throw new Error(
      "Falta configurar Redis en Vercel: UPSTASH_REDIS_REST_URL y UPSTASH_REDIS_REST_TOKEN.",
    );
  }

  redisClient = new Redis({ url, token });
  return redisClient;
}

export async function readInvoices(): Promise<InvoiceResult[]> {
  if (!hasRedisConfigured()) return [];

  const invoices = await getRedis().get<InvoiceResult[]>(invoicesKey);
  return Array.isArray(invoices) ? invoices : [];
}

export async function writeInvoices(invoices: InvoiceResult[]) {
  await getRedis().set(invoicesKey, invoices);
}

export async function upsertInvoice(invoice: InvoiceResult) {
  const invoices = await readInvoices();
  const nextInvoices = [invoice, ...invoices.filter((item) => item.id !== invoice.id)];
  await writeInvoices(nextInvoices);
  return invoice;
}

export async function deleteInvoiceItem(invoiceId: string, itemIndex: number) {
  const invoices = await readInvoices();
  const nextInvoices = invoices
    .map((invoice) => {
      if (invoice.id !== invoiceId) return invoice;
      return {
        ...invoice,
        items: invoice.items.filter((_, index) => index !== itemIndex),
      };
    })
    .filter((invoice) => invoice.items.length > 0);

  await writeInvoices(nextInvoices);
  return nextInvoices;
}

export async function readJson<T>(key: string): Promise<T | null> {
  if (!hasRedisConfigured()) return null;
  return getRedis().get<T>(key);
}

export async function writeJson<T>(key: string, value: T, options?: { expiresInSeconds?: number }) {
  if (options?.expiresInSeconds) {
    await getRedis().set(key, value, { ex: options.expiresInSeconds });
    return;
  }

  await getRedis().set(key, value);
}

export async function deleteKey(key: string) {
  if (!hasRedisConfigured()) return;
  await getRedis().del(key);
}
