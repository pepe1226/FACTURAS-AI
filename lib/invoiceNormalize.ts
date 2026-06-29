import type { InvoiceItem, InvoiceResult, SriReceptionStatus, TaxCategory } from "./types.js";

function roundMoney(value: number): number {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function asFiniteNumber(value: unknown, fallback = 0): number {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : fallback;
}

function normalizeTaxCategory(value: unknown): TaxCategory {
  return value === "IVA_15" || value === "IVA_0" || value === "UNKNOWN" ? value : "UNKNOWN";
}

export function sanitizeInvoiceItems(items: unknown): InvoiceItem[] {
  if (!Array.isArray(items)) return [];

  return items
    .map((item): InvoiceItem | null => {
      if (!item || typeof item !== "object") return null;
      const source = item as Partial<InvoiceItem>;
      const product = String(source.product || "").trim();
      const quantity = Math.max(asFiniteNumber(source.quantity, 1), 1);
      const finalTotalCost = roundMoney(asFiniteNumber(source.finalTotalCost));
      const finalUnitCost = roundMoney(
        Number.isFinite(Number(source.finalUnitCost))
          ? asFiniteNumber(source.finalUnitCost)
          : finalTotalCost / quantity,
      );

      if (!product || finalTotalCost < 0) return null;

      return {
        barcode: String(source.barcode || "").trim(),
        product,
        quantity,
        finalUnitCost,
        finalTotalCost,
        taxCategory: normalizeTaxCategory(source.taxCategory),
      };
    })
    .filter((item): item is InvoiceItem => item !== null);
}

export function sriReceptionStatus(items: InvoiceItem[], difference: number): SriReceptionStatus {
  return items.length > 0 && Math.abs(difference) <= 0.01 ? "Listo para ingresar" : "Pendiente mapeo";
}

export function buildSriInvoice(rawData: Record<string, unknown>, accessKey: string): InvoiceResult {
  const sanitizedItems = sanitizeInvoiceItems(rawData.items);
  const invoiceTotalPaid = roundMoney(asFiniteNumber(rawData.invoiceTotalPaid));
  const totalItems = roundMoney(sanitizedItems.reduce((acc, item) => acc + Number(item.finalTotalCost || 0), 0));
  const difference = roundMoney(invoiceTotalPaid - totalItems);
  const notes = Array.isArray(rawData.notes) ? rawData.notes.map(String) : [];

  if (Math.abs(difference) > 0.01) {
    notes.push(`Diferencia por revisar: factura ${invoiceTotalPaid.toFixed(2)} vs items ${totalItems.toFixed(2)}.`);
  }

  return {
    id: accessKey,
    fileName: `${accessKey}.xml`,
    source: "SRI_RECEIVED",
    supplier: String(rawData.supplier || "Desconocido"),
    supplierRuc: String(rawData.supplierRuc || ""),
    invoiceNumber: String(rawData.invoiceNumber || ""),
    invoiceDate: String(rawData.invoiceDate || ""),
    accessKey,
    authorizationDate: String(rawData.authorizationDate || ""),
    sriReceptionStatus: sriReceptionStatus(sanitizedItems, difference),
    invoiceTotalPaid,
    currency: "USD",
    items: sanitizedItems,
    status: sanitizedItems.length > 0 && Math.abs(difference) <= 0.01 ? "OK" : "REVIEW",
    difference,
    notes,
  };
}
