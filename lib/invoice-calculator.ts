import type { InvoiceItem, InvoiceResult } from "./invoice-schema";

export function roundMoney(value: number): number {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

export function sumItems(items: InvoiceItem[]): number {
  return roundMoney(items.reduce((acc, item) => acc + Number(item.finalTotalCost || 0), 0));
}

export function normalizeItemsToInvoiceTotal(items: InvoiceItem[], invoiceTotalPaid: number): InvoiceItem[] {
  const currentSum = sumItems(items);
  const target = roundMoney(invoiceTotalPaid);
  const diff = roundMoney(target - currentSum);

  if (Math.abs(diff) <= 0.01 || items.length === 0) return items;

  const maxIndex = items.reduce((best, item, index, array) => {
    return item.finalTotalCost > array[best].finalTotalCost ? index : best;
  }, 0);

  return items.map((item, index) => {
    if (index !== maxIndex) return item;
    const newTotal = roundMoney(item.finalTotalCost + diff);
    const quantity = Math.max(Number(item.quantity || 1), 1);
    return {
      ...item,
      finalTotalCost: newTotal,
      finalUnitCost: roundMoney(newTotal / quantity)
    };
  });
}

export function validateInvoice(result: InvoiceResult): InvoiceResult {
  const normalizedItems = normalizeItemsToInvoiceTotal(result.items, result.invoiceTotalPaid);
  const totalItems = sumItems(normalizedItems);
  const difference = roundMoney(result.invoiceTotalPaid - totalItems);

  return {
    ...result,
    items: normalizedItems,
    difference,
    status: Math.abs(difference) <= 0.01 ? "OK" : "REVIEW",
    notes: [
      ...(result.notes || []),
      Math.abs(difference) <= 0.01
        ? "La suma de productos cuadra con el total pagado."
        : `Diferencia pendiente: ${difference}`
    ]
  };
}
