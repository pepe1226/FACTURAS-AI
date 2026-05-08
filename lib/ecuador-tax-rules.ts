export type TaxCategory = "IVA_15" | "IVA_0" | "UNKNOWN";

export const DEFAULT_ECUADOR_VAT_RATE = 0.15;

export const ECUADOR_IVA_0_HINTS = [
  "arroz",
  "azucar",
  "azúcar",
  "avena",
  "carne",
  "fruta",
  "harina",
  "huevo",
  "huevos",
  "leche",
  "legumbre",
  "medicina",
  "medicamento",
  "pan",
  "pescado",
  "pollo",
  "sal",
  "verdura",
  "yogurt natural"
];

export function inferEcuadorTaxCategory(productName: string): TaxCategory {
  const name = productName.toLowerCase();
  if (ECUADOR_IVA_0_HINTS.some((word) => name.includes(word))) return "IVA_0";
  return "UNKNOWN";
}
