export type TaxCategory = "IVA_15" | "IVA_0" | "UNKNOWN";
export type InvoiceStatus = "OK" | "REVIEW";
export type InvoiceSource = "AI_UPLOAD" | "SRI_RECEIVED";
export type SriReceptionStatus = "Pendiente mapeo" | "Listo para ingresar" | "Ingresado";
export type InvoiceCategory = "SIN_CATEGORIA" | "INVENTARIO" | "GASTO" | "SERVICIO" | "ACTIVO" | "REVISION";

export type InvoiceItem = {
  barcode: string;
  product: string;
  quantity: number;
  finalUnitCost: number;
  finalTotalCost: number;
  taxCategory?: TaxCategory;
  confidence?: number;
};

export type InvoiceResult = {
  id: string;
  fileName: string;
  source?: InvoiceSource;
  category?: InvoiceCategory;
  supplier?: string;
  supplierRuc?: string;
  invoiceNumber?: string;
  invoiceDate?: string;
  accessKey?: string;
  authorizationDate?: string;
  sriReceptionStatus?: SriReceptionStatus;
  invoiceTotalPaid: number;
  currency: "USD";
  items: InvoiceItem[];
  status: InvoiceStatus;
  difference: number;
  notes: string[];
  error?: string;
};

export type ProductPurchaseInfo = {
  id: string;
  barcode: string;
  product: string;
  supplier?: string;
  supplierRuc?: string;
  invoiceId: string;
  invoiceNumber?: string;
  invoiceDate?: string;
  quantity: number;
  lastUnitCost: number;
  lastTotalCost: number;
  taxCategory?: TaxCategory;
  updatedAt: string;
  purchaseCount: number;
};

export type ApiRequest = {
  method?: string;
  body?: unknown;
  query?: Record<string, string | string[]>;
};

export type ApiResponse = {
  status: (code: number) => ApiResponse;
  json: (body: unknown) => void;
  end: () => void;
  setHeader?: (name: string, value: string) => void;
};
