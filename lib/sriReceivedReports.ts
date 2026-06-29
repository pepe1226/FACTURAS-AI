import type { InvoiceResult } from "./types.js";

export type SriReceivedPeriodInput = {
  ruc: string;
  username: string;
  password: string;
  year: number;
  month: number;
  day: number;
  voucherType: "1" | "2" | "3" | "4" | "6";
  environment?: "production" | "test";
};

export type SriReceivedPeriodResult = {
  imported: InvoiceResult[];
  failed: { accessKey?: string; error: string }[];
  reportAccessKeys: string[];
};

export class SriPortalAutomationRequiredError extends Error {
  constructor() {
    super(
      "El SRI no expone un servicio publico estable para listar automaticamente comprobantes recibidos por periodo desde Vercel. Esta pantalla ya esta lista para importar por periodo, pero falta conectar el flujo transaccional real del portal SRI si no exige captcha o verificacion adicional.",
    );
    this.name = "SriPortalAutomationRequiredError";
  }
}

export function validateSriPeriod(input: Partial<SriReceivedPeriodInput>) {
  const year = Number(input.year);
  const month = Number(input.month);
  const day = Number(input.day ?? 0);
  const voucherType = String(input.voucherType || "1") as SriReceivedPeriodInput["voucherType"];
  const currentYear = new Date().getFullYear();

  if (!Number.isInteger(year) || year < 2010 || year > currentYear + 1) {
    throw new Error("Selecciona un anio valido para consultar comprobantes SRI.");
  }

  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error("Selecciona un mes valido para consultar comprobantes SRI.");
  }

  if (!Number.isInteger(day) || day < 0 || day > 31) {
    throw new Error("Selecciona un dia valido o usa Todo el mes.");
  }

  if (!["1", "2", "3", "4", "6"].includes(voucherType)) {
    throw new Error("Selecciona un tipo de comprobante SRI valido.");
  }

  return { year, month, day, voucherType };
}

export async function importSriReceivedPeriod(
  input: SriReceivedPeriodInput,
): Promise<SriReceivedPeriodResult> {
  validateSriPeriod(input);

  // The public SRI authorization SOAP service only accepts access keys. Listing
  // received vouchers by period is behind SRI En Linea's transactional portal.
  // Keep this isolated so we can connect the exact portal flow without touching
  // the UI or invoice storage once captcha/2FA behavior is confirmed.
  throw new SriPortalAutomationRequiredError();
}
