import {
  importSriReceivedPeriod,
  SriPortalAutomationRequiredError,
  validateSriPeriod,
} from "../../lib/sriReceivedReports.js";
import { readSriSession } from "../../lib/sriSession.js";
import { hasRedisConfigured, upsertInvoice } from "../../lib/store.js";
import type { ApiRequest, ApiResponse, InvoiceResult } from "../../lib/types.js";

export const config = {
  api: {
    bodyParser: {
      sizeLimit: "2mb",
    },
  },
};

type PeriodBody = {
  sessionId?: string;
  year?: number;
  month?: number;
  day?: number;
  voucherType?: "1" | "2" | "3" | "4" | "6";
  environment?: "production" | "test";
};

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Metodo no permitido." });
    return;
  }

  try {
    if (!hasRedisConfigured()) {
      res.status(503).json({ error: "Configura Redis/Upstash en Vercel para importar reportes SRI." });
      return;
    }

    const body = req.body as PeriodBody;
    if (!body.sessionId) {
      res.status(401).json({ error: "Inicia sesion con tu usuario SRI antes de importar por periodo." });
      return;
    }

    const period = validateSriPeriod(body);
    const session = await readSriSession(body.sessionId);
    const result = await importSriReceivedPeriod({
      ruc: session.ruc,
      username: session.username,
      password: session.password,
      year: period.year,
      month: period.month,
      day: period.day,
      voucherType: period.voucherType,
      environment: body.environment || "production",
    });

    const imported: InvoiceResult[] = [];
    for (const invoice of result.imported) {
      imported.push(await upsertInvoice(invoice));
    }

    res.status(200).json({
      sessionRuc: session.ruc,
      imported,
      failed: result.failed,
      reportAccessKeys: result.reportAccessKeys,
      summary: {
        requested: result.reportAccessKeys.length,
        imported: imported.length,
        failed: result.failed.length,
      },
    });
  } catch (error) {
    if (error instanceof SriPortalAutomationRequiredError) {
      res.status(501).json({
        error: error.message,
        code: "SRI_PORTAL_CONNECTOR_REQUIRED",
      });
      return;
    }

    const message = error instanceof Error ? error.message : "No se pudo importar reportes SRI.";
    res.status(500).json({ error: message });
  }
}
