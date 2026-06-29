import { buildSriInvoice } from "../../lib/invoiceNormalize.js";
import { consultSriAuthorization } from "../../lib/sriAuthorization.js";
import { readSriSession } from "../../lib/sriSession.js";
import { hasRedisConfigured, upsertInvoice } from "../../lib/store.js";
import type { ApiRequest, ApiResponse, InvoiceResult } from "../../lib/types.js";

export const config = {
  api: {
    bodyParser: {
      sizeLimit: "3mb",
    },
  },
};

type BulkBody = {
  sessionId?: string;
  accessKeys?: string[];
  environment?: "production" | "test";
};

function uniqueAccessKeys(values: unknown) {
  if (!Array.isArray(values)) return [];
  return Array.from(
    new Set(
      values
        .map((value) => String(value || "").replace(/\D/g, ""))
        .filter((value) => value.length === 49),
    ),
  );
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Metodo no permitido." });
    return;
  }

  try {
    if (!hasRedisConfigured()) {
      res.status(503).json({ error: "Configura Redis/Upstash en Vercel para recibir facturas SRI." });
      return;
    }

    const body = req.body as BulkBody;
    if (!body.sessionId) {
      res.status(401).json({ error: "Inicia sesion con tu usuario SRI antes de recibir comprobantes." });
      return;
    }

    const session = await readSriSession(body.sessionId);
    const accessKeys = uniqueAccessKeys(body.accessKeys);

    if (accessKeys.length === 0) {
      res.status(400).json({
        error: "Ingresa al menos una clave de acceso valida de 49 digitos.",
        sessionRuc: session.ruc,
      });
      return;
    }

    if (accessKeys.length > 60) {
      res.status(400).json({ error: "Procesa maximo 60 comprobantes por lote para evitar bloqueos del SRI." });
      return;
    }

    const imported: InvoiceResult[] = [];
    const failed: { accessKey: string; error: string }[] = [];

    for (const accessKey of accessKeys) {
      try {
        const rawData = await consultSriAuthorization({
          accessKey,
          environment: body.environment || "production",
        });

        const sriStatus = "sriAuthorizationStatus" in rawData ? rawData.sriAuthorizationStatus : rawData.status;
        if (sriStatus && sriStatus !== "AUTORIZADO") {
          failed.push({
            accessKey,
            error: `SRI: ${sriStatus}. ${(rawData.notes || []).join(" ")}`,
          });
          continue;
        }

        const invoice = buildSriInvoice(rawData as Record<string, unknown>, accessKey);
        imported.push(await upsertInvoice(invoice));
      } catch (error) {
        failed.push({
          accessKey,
          error: error instanceof Error ? error.message : "No se pudo recibir el comprobante.",
        });
      }
    }

    res.status(200).json({
      sessionRuc: session.ruc,
      imported,
      failed,
      summary: {
        requested: accessKeys.length,
        imported: imported.length,
        failed: failed.length,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "No se pudo recibir comprobantes SRI.";
    res.status(500).json({ error: message });
  }
}
