import { z } from "zod";

export const InvoiceItemSchema = z.object({
  barcode: z.string().optional().default(""),
  product: z.string().min(1),
  quantity: z.number().positive(),
  finalUnitCost: z.number().nonnegative(),
  finalTotalCost: z.number().nonnegative(),
  taxCategory: z.enum(["IVA_15", "IVA_0", "UNKNOWN"]).default("UNKNOWN"),
  confidence: z.number().min(0).max(1).default(0.7)
});

export const InvoiceResultSchema = z.object({
  supplier: z.string().optional().default(""),
  invoiceNumber: z.string().optional().default(""),
  invoiceDate: z.string().optional().default(""),
  invoiceTotalPaid: z.number().nonnegative(),
  currency: z.string().default("USD"),
  items: z.array(InvoiceItemSchema),
  status: z.enum(["OK", "REVIEW"]).default("REVIEW"),
  difference: z.number().default(0),
  notes: z.array(z.string()).default([])
});

export type InvoiceItem = z.infer<typeof InvoiceItemSchema>;
export type InvoiceResult = z.infer<typeof InvoiceResultSchema>;
