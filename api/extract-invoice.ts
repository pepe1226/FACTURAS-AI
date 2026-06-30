import { extractInvoice } from "../lib/extractInvoice.js";
import type { ApiRequest, ApiResponse } from "../lib/types.js";

export const config = {
  api: {
    bodyParser: {
      sizeLimit: "25mb",
    },
  },
};

function cleanErrorMessage(error: unknown) {
  const rawMessage = error instanceof Error ? error.message : "Error desconocido al extraer la factura.";

  try {
    const parsed = JSON.parse(rawMessage);
    return parsed?.error?.message || parsed?.error || parsed?.message || rawMessage;
  } catch {
    return rawMessage;
  }
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Metodo no permitido." });
    return;
  }

  try {
    const result = await extractInvoice(req.body as Parameters<typeof extractInvoice>[0]);
    res.status(200).json(result);
  } catch (error) {
    const message = cleanErrorMessage(error);
    res.status(500).json({ error: message });
  }
}
