import { Redis } from "@upstash/redis";
import type { InvoiceResult, ProductPurchaseInfo } from "./types.js";

const invoicesKey = "facturas-ai:invoices";
const productsKey = "facturas-ai:products";

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
  await rebuildProducts(invoices);
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

function productKey(barcode: string, product: string) {
  const cleanBarcode = barcode.trim();
  if (cleanBarcode) return `barcode:${cleanBarcode}`;
  return `name:${product.trim().toLowerCase().replace(/\s+/g, " ")}`;
}

export async function rebuildProducts(invoices = [] as InvoiceResult[]) {
  const products = new Map<string, ProductPurchaseInfo>();

  for (const invoice of [...invoices].reverse()) {
    for (const item of invoice.items || []) {
      const product = String(item.product || "").trim();
      if (!product) continue;

      const key = productKey(String(item.barcode || ""), product);
      const previous = products.get(key);
      products.set(key, {
        id: key,
        barcode: String(item.barcode || ""),
        product,
        supplier: invoice.supplier,
        supplierRuc: invoice.supplierRuc,
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        invoiceDate: invoice.invoiceDate,
        quantity: Number(item.quantity || 0),
        lastUnitCost: Number(item.finalUnitCost || 0),
        lastTotalCost: Number(item.finalTotalCost || 0),
        taxCategory: item.taxCategory,
        updatedAt: new Date().toISOString(),
        purchaseCount: (previous?.purchaseCount || 0) + 1,
      });
    }
  }

  const sortedProducts = Array.from(products.values()).sort((left, right) => left.product.localeCompare(right.product));
  await getRedis().set(productsKey, sortedProducts);
  return sortedProducts;
}

export async function readProducts(): Promise<ProductPurchaseInfo[]> {
  if (!hasRedisConfigured()) return [];

  const products = await getRedis().get<ProductPurchaseInfo[]>(productsKey);
  if (Array.isArray(products)) return products;

  return rebuildProducts(await readInvoices());
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
