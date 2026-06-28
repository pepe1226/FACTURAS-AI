import { hasRedisConfigured, readInvoices, upsertInvoice, writeInvoices } from "../lib/store.js";
import type { ApiRequest, ApiResponse, InvoiceResult } from "../lib/types.js";

export const config = {
  api: {
    bodyParser: {
      sizeLimit: "10mb",
    },
  },
};

function isInvoice(value: unknown): value is InvoiceResult {
  return Boolean(
    value &&
      typeof value === "object" &&
      "id" in value &&
      typeof value.id === "string" &&
      "items" in value &&
      Array.isArray(value.items),
  );
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  try {
    if (req.method === "GET") {
      res.status(200).json(await readInvoices());
      return;
    }

    if (req.method === "POST") {
      if (!hasRedisConfigured()) {
        res.status(503).json({ error: "Configura Redis/Upstash en Vercel para guardar facturas compartidas." });
        return;
      }

      if (!isInvoice(req.body)) {
        res.status(400).json({ error: "Factura invalida." });
        return;
      }

      res.status(201).json(await upsertInvoice(req.body));
      return;
    }

    if (req.method === "DELETE") {
      if (!hasRedisConfigured()) {
        res.status(503).json({ error: "Configura Redis/Upstash en Vercel para limpiar el historial compartido." });
        return;
      }

      await writeInvoices([]);
      res.status(204).end();
      return;
    }

    res.status(405).json({ error: "Metodo no permitido." });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Error desconocido al guardar facturas.";
    res.status(500).json({ error: message });
  }
}
