import { extractInvoice } from "../lib/extractInvoice";
import type { ApiRequest, ApiResponse } from "../lib/types";

export const config = {
  api: {
    bodyParser: {
      sizeLimit: "25mb",
    },
  },
};

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Metodo no permitido." });
    return;
  }

  try {
    const result = await extractInvoice(req.body as Parameters<typeof extractInvoice>[0]);
    res.status(200).json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Error desconocido al extraer la factura.";
    res.status(500).json({ error: message });
  }
}
