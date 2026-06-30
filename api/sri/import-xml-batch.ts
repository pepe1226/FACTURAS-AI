import { buildSriInvoice } from "../../lib/invoiceNormalize.js";
import { consultSriAuthorization } from "../../lib/sriAuthorization.js";
import { hasRedisConfigured, upsertInvoice } from "../../lib/store.js";
import type { ApiRequest, ApiResponse, InvoiceResult } from "../../lib/types.js";

export const config = {
  api: {
    bodyParser: {
      sizeLimit: "20mb",
    },
  },
};

function setCors(res: ApiResponse) {
  res.setHeader?.("Access-Control-Allow-Origin", "*");
  res.setHeader?.("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader?.("Access-Control-Allow-Headers", "Content-Type");
}

function extractAccessKeys(xmlTexts: unknown) {
  if (!Array.isArray(xmlTexts)) return [];
  return Array.from(
    new Set(
      xmlTexts
        .flatMap((xml) => String(xml || "").match(/\b\d{49}\b/g) || [])
        .filter(Boolean),
    ),
  );
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  setCors(res);

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "Metodo no permitido." });
    return;
  }

  try {
    if (!hasRedisConfigured()) {
      res.status(503).json({ error: "Configura Redis/Upstash en Vercel para importar comprobantes SRI." });
      return;
    }

    const body = req.body as { xmlTexts?: string[] };
    const accessKeys = extractAccessKeys(body.xmlTexts);
    if (accessKeys.length === 0) {
      res.status(400).json({ error: "No se encontraron claves de acceso en los XML enviados." });
      return;
    }

    const imported: InvoiceResult[] = [];
    const failed: { accessKey: string; error: string }[] = [];

    for (const accessKey of accessKeys.slice(0, 150)) {
      try {
        const rawData = await consultSriAuthorization({ accessKey, environment: "production" });
        const sriStatus = "sriAuthorizationStatus" in rawData ? rawData.sriAuthorizationStatus : rawData.status;
        if (sriStatus && sriStatus !== "AUTORIZADO") {
          failed.push({ accessKey, error: `SRI: ${sriStatus}. ${(rawData.notes || []).join(" ")}` });
          continue;
        }

        imported.push(await upsertInvoice(buildSriInvoice(rawData as Record<string, unknown>, accessKey)));
      } catch (error) {
        failed.push({
          accessKey,
          error: error instanceof Error ? error.message : "No se pudo importar el comprobante.",
        });
      }
    }

    res.status(200).json({
      imported,
      failed,
      summary: {
        requested: accessKeys.length,
        imported: imported.length,
        failed: failed.length,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "No se pudo importar XML SRI.";
    res.status(500).json({ error: message });
  }
}
