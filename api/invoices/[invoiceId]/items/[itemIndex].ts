import { deleteInvoiceItem } from "../../../../lib/store.js";
import type { ApiRequest, ApiResponse } from "../../../../lib/types.js";

function firstQueryValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== "DELETE") {
    res.status(405).json({ error: "Metodo no permitido." });
    return;
  }

  try {
    const invoiceId = firstQueryValue(req.query?.invoiceId);
    const itemIndex = Number(firstQueryValue(req.query?.itemIndex));

    if (!invoiceId || !Number.isInteger(itemIndex) || itemIndex < 0) {
      res.status(400).json({ error: "Parametros invalidos." });
      return;
    }

    res.status(200).json(await deleteInvoiceItem(invoiceId, itemIndex));
  } catch (error) {
    const message = error instanceof Error ? error.message : "No se pudo eliminar el item.";
    res.status(500).json({ error: message });
  }
}
