import { hasRedisConfigured, readProducts, rebuildProducts, readInvoices } from "../lib/store.js";
import type { ApiRequest, ApiResponse } from "../lib/types.js";

export default async function handler(req: ApiRequest, res: ApiResponse) {
  try {
    if (req.method === "GET") {
      res.status(200).json(await readProducts());
      return;
    }

    if (req.method === "POST") {
      if (!hasRedisConfigured()) {
        res.status(503).json({ error: "Configura Redis/Upstash en Vercel para guardar productos compartidos." });
        return;
      }

      res.status(200).json(await rebuildProducts(await readInvoices()));
      return;
    }

    res.status(405).json({ error: "Metodo no permitido." });
  } catch (error) {
    const message = error instanceof Error ? error.message : "No se pudo cargar productos.";
    res.status(500).json({ error: message });
  }
}
