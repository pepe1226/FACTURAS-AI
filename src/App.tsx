/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useMemo, useRef, useState, useEffect, useCallback } from "react";
import { 
  Upload, 
  FileText, 
  CheckCircle2, 
  AlertCircle, 
  Download, 
  Trash2, 
  Copy,
  Search,
  LayoutDashboard,
  Receipt,
  Info,
  Loader2,
  ChevronDown,
  ChevronUp,
  FilterX,
  Sigma,
  Check,
  MoreVertical,
  KeyRound,
  LogIn,
  LogOut,
  ShieldCheck,
  RefreshCw,
  CalendarDays,
  Archive,
  ClipboardList
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

// =====================================================
// Types & Constants
// =====================================================

type TaxCategory = "IVA_15" | "IVA_0" | "UNKNOWN";
type InvoiceStatus = "OK" | "REVIEW";
type InvoiceSource = "AI_UPLOAD" | "SRI_RECEIVED";
type SriReceptionStatus = "Pendiente mapeo" | "Listo para ingresar" | "Ingresado";
type InvoiceCategory = "SIN_CATEGORIA" | "INVENTARIO" | "GASTO" | "SERVICIO" | "ACTIVO" | "REVISION";

interface InvoiceItem {
  barcode: string;
  product: string;
  quantity: number;
  finalUnitCost: number;
  finalTotalCost: number;
  taxCategory?: TaxCategory;
  confidence?: number;
}

interface InvoiceResult {
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
}

interface ProductPurchaseInfo {
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
}

type SortField = "barcode" | "product" | "quantity" | "finalUnitCost" | "finalTotalCost";
type SortOrder = "asc" | "desc" | null;
type AggregationType = "sum" | "count" | "avg" | "min" | "max";

const DEFAULT_ECUADOR_VAT_RATE = 0.15;
const CATEGORY_OPTIONS: { value: InvoiceCategory; label: string }[] = [
  { value: "SIN_CATEGORIA", label: "Sin categoria" },
  { value: "INVENTARIO", label: "Inventario" },
  { value: "GASTO", label: "Gasto" },
  { value: "SERVICIO", label: "Servicio" },
  { value: "ACTIVO", label: "Activo" },
  { value: "REVISION", label: "Revision" },
];

const EXTRACTION_PROMPT = `
Eres un extractor experto de comprobantes, tickets y facturas de Ecuador. Tu misión es la precisión absoluta.

INSTRUCCIONES CRÍTICAS:
1. DETECCIÓN DE IVA: Mapea cada producto a 'IVA_15' (si es gravado) o 'IVA_0' (si no lo es). 
   - Busca indicadores como asteriscos (*), la letra 'G', o columnas marcadas como 'IVA' o '%'.
   - Si un producto es procesado, enlatado o un servicio, usualmente lleva IVA_15.
   - Si es un alimento básico, medicina o libros, usualmente es IVA_0.
2. COSTO FINAL: El 'finalTotalCost' DEBE ser el valor total por esa línea INCLUYENDO IVA y descontando cualquier rebaja.
3. CONCORDANCIA: La suma de todos los 'finalTotalCost' DEBE ser IGUAL al 'invoiceTotalPaid' del documento.
4. FORMATO: Devuelve exclusivamente el JSON siguiendo el esquema.
5. CÓDIGOS (CÓDIGO DE BARRAS): Busca el código numérico al lado de cada producto o debajo del nombre. 
   - Busca códigos de 7, 8 o 13 dígitos (EAN-8, EAN-13).
   - A veces aparece como 'Código', 'Ref', 'Cod. Art'. 
   - Si no existe un código claro, deja "".
`;

// =====================================================
// Utility Functions
// =====================================================

function roundMoney(value: number): number {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function roundUnitCost(value: number): number {
  return Math.round((Number(value || 0) + Number.EPSILON) * 10000) / 10000;
}

function sumItems(items: InvoiceItem[]): number {
  return roundMoney(items.reduce((acc, item) => acc + Number(item.finalTotalCost || 0), 0));
}

function asFiniteNumber(value: unknown, fallback = 0): number {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : fallback;
}

function normalizeTaxCategory(value: unknown): TaxCategory {
  return value === "IVA_15" || value === "IVA_0" || value === "UNKNOWN" ? value : "UNKNOWN";
}

function sanitizeItems(items: unknown): InvoiceItem[] {
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

function sriReceptionStatus(items: InvoiceItem[], difference: number): SriReceptionStatus {
  return items.length > 0 && Math.abs(difference) <= 0.01 ? "Listo para ingresar" : "Pendiente mapeo";
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      const base64 = result.split(",")[1];
      resolve(base64);
    };
    reader.onerror = () => reject(new Error("No se pudo leer el archivo."));
    reader.readAsDataURL(file);
  });
}

function friendlyProcessingError(error: unknown) {
  const rawMessage = error instanceof Error ? error.message : "Error desconocido";
  let message = rawMessage;

  try {
    const parsed = JSON.parse(rawMessage);
    message = parsed?.error?.message || parsed?.error || parsed?.message || rawMessage;
  } catch {
    // Keep the original text when it is not JSON.
  }

  if (/503|UNAVAILABLE|high demand|saturad|overloaded|temporar/i.test(message)) {
    return "El lector visual esta ocupado por alta demanda. La app ya intento reintentos y modelos alternos; espera unos segundos y pulsa Procesar otra vez.";
  }

  return message;
}

async function optimizeImage(base64: string, maxDimension = 2048): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      let width = img.width;
      let height = img.height;

      if (width > maxDimension || height > maxDimension) {
        if (width > height) {
          height *= maxDimension / width;
          width = maxDimension;
        } else {
          width *= maxDimension / height;
          height = maxDimension;
        }
      }

      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        resolve(base64);
        return;
      }
      ctx.drawImage(img, 0, 0, width, height);
      // Return highly compressed but legible jpeg base64
      resolve(canvas.toDataURL("image/jpeg", 0.8).split(",")[1]);
    };
    img.onerror = () => reject(new Error("Error al optimizar la imagen."));
    img.src = `data:image/jpeg;base64,${base64}`;
  });
}

// =====================================================
// Components
// =====================================================

export default function App() {
  const [results, setResults] = useState<InvoiceResult[]>([]);
  const [products, setProducts] = useState<ProductPurchaseInfo[]>([]);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [selectedInvoiceIds, setSelectedInvoiceIds] = useState<Set<string>>(new Set());
  const [loadedInvoiceIds, setLoadedInvoiceIds] = useState<Set<string>>(new Set());
  const [showOnlySelectedUploads, setShowOnlySelectedUploads] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [loadingPhase, setLoadingPhase] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<InvoiceCategory | "TODAS">("TODAS");
  const [error, setError] = useState<string | null>(null);
  
  // Sorting & Filtering
  const [sortField, setSortField] = useState<SortField | null>(null);
  const [sortOrder, setSortOrder] = useState<SortOrder>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number, y: number, field: SortField } | null>(null);
  const [columnSearch, setColumnSearch] = useState<Partial<Record<SortField, string>>>({});
  const [activeSearchField, setActiveSearchField] = useState<SortField | null>(null);
  const [aggType, setAggType] = useState<AggregationType>("sum");
  const [isAggMenuOpen, setIsAggMenuOpen] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copiedCellId, setCopiedCellId] = useState<string | null>(null);
  const [deleteConfirmation, setDeleteConfirmation] = useState<{ invoiceId: string, itemIndex: number, productName: string } | null>(null);
  
  const [uploadContextMenu, setUploadContextMenu] = useState<{ x: number, y: number } | null>(null);

  const loadInvoices = useCallback(async () => {
    try {
      const response = await fetch("/api/invoices");
      if (!response.ok) throw new Error("No se pudo cargar el historial compartido.");
      setResults(await response.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cargar el historial compartido.");
    }
  }, []);

  const loadProducts = useCallback(async () => {
    try {
      const response = await fetch("/api/products");
      if (!response.ok) throw new Error("No se pudo cargar historial de productos.");
      setProducts(await response.json());
    } catch (err) {
      console.warn(err);
    }
  }, []);

  useEffect(() => {
    void loadInvoices();
    void loadProducts();
  }, [loadInvoices, loadProducts]);

  const handleUploadContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setUploadContextMenu({ x: e.clientX, y: e.clientY });
  };

  const closeUploadContextMenu = () => setUploadContextMenu(null);

  const handlePasteFromClipboard = async () => {
    if (!navigator.clipboard || !navigator.clipboard.read) {
      setError("Tu navegador no permite el acceso directo al portapapeles. Por favor usa Ctrl+V.");
      closeUploadContextMenu();
      return;
    }

    try {
      const clipboardItems = await navigator.clipboard.read();
      let foundImage = false;
      for (const item of clipboardItems) {
        for (const type of item.types) {
          if (type.startsWith("image/")) {
            const blob = await item.getType(type);
            const file = new File([blob], `pasted-image-${Date.now()}.png`, { type });
            setSelectedFiles((prev) => [...prev, file]);
            setError(null);
            foundImage = true;
            break;
          }
        }
        if (foundImage) break;
      }
      
      if (!foundImage) {
        setError("No se encontró ninguna imagen en el portapapeles.");
      }
      closeUploadContextMenu();
    } catch (err) {
      console.error("Clipboard Error:", err);
      if (err instanceof Error && err.name === "NotAllowedError") {
        setError("Permiso denegado para acceder al portapapeles. Habilita el acceso en tu navegador o usa Ctrl+V.");
      } else {
        setError("No se pudo acceder al portapapeles debido a restricciones de seguridad. Por favor usa Ctrl+V.");
      }
      closeUploadContextMenu();
    }
  };

  const handleFileUpload = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setSelectedFiles((prev) => [...prev, ...Array.from(files)]);
    setError(null);
  };

  useEffect(() => {
    const handlePaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;

      for (let i = 0; i < items.length; i++) {
        if (items[i].type.indexOf("image") !== -1) {
          const blob = items[i].getAsFile();
          if (blob) {
            const file = new File([blob], `pasted-image-${Date.now()}.png`, { type: blob.type });
            setSelectedFiles((prev) => [...prev, file]);
            setError(null);
          }
        }
      }
    };

    window.addEventListener("paste", handlePaste);
    return () => window.removeEventListener("paste", handlePaste);
  }, []);

  const processSingleFile = async (file: File, index: number, total: number): Promise<InvoiceResult[]> => {
    const baseProgress = Math.round((index / total) * 100);
    const stepProgress = (step: number) => Math.min(99, baseProgress + Math.round(step / total));

    setProgress(stepProgress(5));
    setLoadingPhase(`Leyendo ${index + 1}/${total}: ${file.name}`);

    const isXml = file.type.includes("xml") || file.name.toLowerCase().endsWith(".xml");
    const isTxt = file.type.includes("text/plain") || file.name.toLowerCase().endsWith(".txt");
    let base64 = "";

    if (!isXml && !isTxt) {
      const initialBase64 = await fileToBase64(file);
      base64 = initialBase64;

      if (file.type.startsWith("image/")) {
        setLoadingPhase(`Optimizando imagen ${index + 1}/${total}...`);
        try {
          base64 = await optimizeImage(initialBase64);
        } catch (e) {
          console.warn("Resizing failed, using original", e);
        }
      } else {
        setLoadingPhase(`Preparando documento ${index + 1}/${total}...`);
      }
    } else {
      setLoadingPhase(isXml ? `Leyendo XML ${index + 1}/${total}...` : `Leyendo reporte TXT ${index + 1}/${total}...`);
    }

    setProgress(stepProgress(25));
    setLoadingPhase(isXml || isTxt ? "Leyendo datos estructurados..." : "Analizando con lector visual...");

    const response = await fetch("/api/extract-invoice", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fileName: file.name,
        mimeType: file.type || (isXml ? "application/xml" : isTxt ? "text/plain" : "image/jpeg"),
        data: isXml || isTxt ? undefined : base64,
        xmlText: isXml ? await file.text() : undefined,
        text: isTxt ? await file.text() : undefined,
      }),
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      throw new Error(payload?.error || "No se pudo analizar la factura.");
    }

    setProgress(stepProgress(70));
    setLoadingPhase("Guardando facturas...");

    const rawData = await response.json();
    if (Array.isArray(rawData.reportInvoices)) {
      const savedInvoices: InvoiceResult[] = [];

      for (const reportInvoice of rawData.reportInvoices as InvoiceResult[]) {
        const saveResponse = await fetch("/api/invoices", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(reportInvoice),
        });

        if (!saveResponse.ok) {
          const payload = await saveResponse.json().catch(() => null);
          throw new Error(payload?.error || "No se pudo guardar una factura del reporte TXT.");
        }

        savedInvoices.push(await saveResponse.json());
      }

      return savedInvoices;
    }

    const sanitizedItems = sanitizeItems(rawData.items || []);
    const invoiceTotalPaid = roundMoney(asFiniteNumber(rawData.invoiceTotalPaid));
    const totalItems = sumItems(sanitizedItems);
    const difference = roundMoney(invoiceTotalPaid - totalItems);
    const notes = Array.isArray(rawData.notes) ? rawData.notes.map(String) : [];

    if (Math.abs(difference) > 0.01) {
      notes.push(`Diferencia por revisar: factura ${invoiceTotalPaid.toFixed(2)} vs items ${totalItems.toFixed(2)}.`);
    }

    const newResult: InvoiceResult = {
      id: crypto.randomUUID(),
      fileName: file.name,
      source: isXml ? "SRI_RECEIVED" : "AI_UPLOAD",
      category: isXml ? "INVENTARIO" : "REVISION",
      supplier: rawData.supplier || "Desconocido",
      supplierRuc: rawData.supplierRuc || "",
      invoiceNumber: rawData.invoiceNumber || "",
      invoiceDate: rawData.invoiceDate || "",
      accessKey: rawData.accessKey || "",
      authorizationDate: rawData.authorizationDate || "",
      sriReceptionStatus: isXml ? sriReceptionStatus(sanitizedItems, difference) : undefined,
      invoiceTotalPaid,
      currency: "USD",
      items: sanitizedItems,
      status: sanitizedItems.length > 0 && Math.abs(difference) <= 0.01 ? "OK" : "REVIEW",
      difference,
      notes,
    };

    const saveResponse = await fetch("/api/invoices", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(newResult),
    });

    if (!saveResponse.ok) {
      const payload = await saveResponse.json().catch(() => null);
      throw new Error(payload?.error || "La factura se extrajo, pero no se pudo guardar.");
    }

    return [await saveResponse.json()];
  };

  const processFiles = async () => {
    if (selectedFiles.length === 0) return;

    setIsLoading(true);
    setProgress(5);
    setError(null);

    const savedInvoices: InvoiceResult[] = [];
    const failedFiles: string[] = [];

    try {
      for (const [index, file] of selectedFiles.entries()) {
        try {
          savedInvoices.push(...await processSingleFile(file, index, selectedFiles.length));
        } catch (err) {
          console.error("Error processing file:", file.name, err);
          failedFiles.push(`${file.name}: ${friendlyProcessingError(err)}`);
        }
      }

      if (savedInvoices.length > 0) {
        setResults((prev) => {
          const savedIds = new Set(savedInvoices.map((invoice) => invoice.id));
          return [...savedInvoices, ...prev.filter((invoice) => !savedIds.has(invoice.id))];
        });
        setSelectedInvoiceIds(new Set(savedInvoices.map((invoice) => invoice.id)));
        await loadProducts();
      }

      setSelectedFiles([]);
      setProgress(100);
      setLoadingPhase("Finalizado");

      if (failedFiles.length > 0) {
        setError(`No se pudieron procesar ${failedFiles.length} archivo(s): ${failedFiles.join(" | ")}`);
      }

      setTimeout(() => {
        setIsLoading(false);
        setProgress(0);
        setLoadingPhase("");
      }, 500);
    } catch (err) {
      console.error("Error processing files:", err);
      setError(`Error al procesar: ${friendlyProcessingError(err)}`);
      setIsLoading(false);
      setProgress(0);
      setLoadingPhase("");
    }
  };

  const normalize = (str: string) => 
    str.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

  const matchesSearch = (text: string, query: string) => {
    if (!query) return true;
    const normalizedText = normalize(text);
    const words = normalize(query).split(/\s+/).filter(Boolean);
    return words.every(word => normalizedText.includes(word));
  };

  const filteredRows = useMemo(() => {
    let visibleInvoices = categoryFilter === "TODAS"
      ? results
      : results.filter((invoice) => (invoice.category || "SIN_CATEGORIA") === categoryFilter);

    if (loadedInvoiceIds.size > 0) {
      visibleInvoices = visibleInvoices.filter((invoice) => loadedInvoiceIds.has(invoice.id));
    }

    let allRows = visibleInvoices.flatMap(invoice => 
      invoice.items.map((item, idx) => ({ 
        ...item, 
        supplier: invoice.supplier, 
        fileName: invoice.fileName, 
        invoiceId: invoice.id,
        itemIndex: idx,
        rowId: `${invoice.id}-${idx}`
      }))
    );
    
    // Search filter (Global)
    if (searchQuery) {
      allRows = allRows.filter(row => 
        matchesSearch(row.product, searchQuery) || 
        matchesSearch(row.barcode, searchQuery)
      );
    }

    // Column specific filters
    (Object.entries(columnSearch) as [SortField, string][]).forEach(([field, value]) => {
      if (!value) return;
      allRows = allRows.filter(row => {
        const rowValue = String(row[field as keyof typeof row] || "");
        return matchesSearch(rowValue, value);
      });
    });

    // Sort order
    if (sortField && sortOrder) {
      allRows.sort((a, b) => {
        const valA = a[sortField];
        const valB = b[sortField];
        
        if (typeof valA === "string" && typeof valB === "string") {
          return sortOrder === "asc" ? valA.localeCompare(valB) : valB.localeCompare(valA);
        }
        
        if (typeof valA === "number" && typeof valB === "number") {
          return sortOrder === "asc" ? valA - valB : valB - valA;
        }
        
        return 0;
      });
    }
    
    return allRows;
  }, [results, searchQuery, sortField, sortOrder, columnSearch, categoryFilter, loadedInvoiceIds]);

  const totalInvoiceSum = useMemo(() => 
    roundMoney(filteredRows.reduce((acc, curr) => acc + curr.finalTotalCost, 0)), 
  [filteredRows]);
  const totalFilteredQuantity = useMemo(
    () => filteredRows.reduce((acc, curr) => acc + Number(curr.quantity || 0), 0),
    [filteredRows],
  );
  const weightedUnitCost = useMemo(
    () => totalFilteredQuantity > 0 ? roundUnitCost(totalInvoiceSum / totalFilteredQuantity) : 0,
    [totalFilteredQuantity, totalInvoiceSum],
  );

  const aggResult = useMemo(() => {
    if (filteredRows.length === 0) return 0;
    
    switch (aggType) {
      case "count": return filteredRows.length;
      case "avg": return weightedUnitCost;
      case "min": return Math.min(...filteredRows.map(r => r.finalTotalCost));
      case "max": return Math.max(...filteredRows.map(r => r.finalTotalCost));
      case "sum":
      default:
        return totalInvoiceSum;
    }
  }, [filteredRows, aggType, totalInvoiceSum, weightedUnitCost]);

  const aggLabel = useMemo(() => {
    switch (aggType) {
      case "count": return "Número de elementos";
      case "avg": return "Costo Unit.";
      case "min": return "Mínimo";
      case "max": return "Máximo";
      case "sum":
      default:
        return "Suma Total";
    }
  }, [aggType]);

  const sriInvoices = useMemo(
    () => {
      const sourceInvoices = results;
      return categoryFilter === "TODAS"
        ? sourceInvoices
        : sourceInvoices.filter((invoice) => (invoice.category || "SIN_CATEGORIA") === categoryFilter);
    },
    [results, categoryFilter],
  );

  const sriReady = sriInvoices.filter((invoice) => invoice.sriReceptionStatus === "Listo para ingresar").length;
  const sriPending = sriInvoices.length - sriReady;
  const sriTotal = roundMoney(sriInvoices.reduce((acc, invoice) => acc + invoice.invoiceTotalPaid, 0));
  const sriUnmappedItems = sriInvoices.reduce(
    (acc, invoice) => acc + invoice.items.filter((item) => !item.barcode).length,
    0,
  );
  const visibleUploadedInvoices = useMemo(() => {
    const filtered = showOnlySelectedUploads
      ? sriInvoices.filter((invoice) => selectedInvoiceIds.has(invoice.id))
      : sriInvoices;
    return filtered;
  }, [sriInvoices, selectedInvoiceIds, showOnlySelectedUploads]);
  const selectedInvoicesTotal = roundMoney(
    results
      .filter((invoice) => selectedInvoiceIds.has(invoice.id))
      .reduce((acc, invoice) => acc + invoice.invoiceTotalPaid, 0),
  );

  const toggleInvoiceSelection = (invoiceId: string) => {
    setSelectedInvoiceIds((prev) => {
      const next = new Set(prev);
      if (next.has(invoiceId)) {
        next.delete(invoiceId);
      } else {
        next.add(invoiceId);
      }
      return next;
    });
  };

  const toggleAllVisibleInvoices = () => {
    setSelectedInvoiceIds((prev) => {
      const next = new Set(prev);
      const allVisibleSelected = visibleUploadedInvoices.length > 0 && visibleUploadedInvoices.every((invoice) => next.has(invoice.id));

      if (allVisibleSelected) {
        visibleUploadedInvoices.forEach((invoice) => next.delete(invoice.id));
      } else {
        visibleUploadedInvoices.forEach((invoice) => next.add(invoice.id));
      }

      return next;
    });
  };

  const loadSelectedInvoicesIntoSystem = async () => {
    if (selectedInvoiceIds.size === 0) {
      setError("Selecciona una o mas facturas para cargarlas al sistema.");
      return;
    }

    const selectedInvoices = results.filter((invoice) => selectedInvoiceIds.has(invoice.id));
    setLoadedInvoiceIds(new Set(selectedInvoices.map((invoice) => invoice.id)));
    setError(null);
  };

  const updateInvoiceCategory = async (invoice: InvoiceResult, category: InvoiceCategory) => {
    const updatedInvoice = { ...invoice, category };
    setResults((prev) => prev.map((item) => (item.id === invoice.id ? updatedInvoice : item)));

    try {
      const response = await fetch("/api/invoices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updatedInvoice),
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.error || "No se pudo guardar la categoria.");
      }
      await loadProducts();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar la categoria.");
      setResults((prev) => prev.map((item) => (item.id === invoice.id ? invoice : item)));
    }
  };

  const exportCSV = () => {
    const headers = ["Fecha", "Proveedor", "RUC", "Factura", "Clave acceso", "Producto", "Codigo", "Cantidad", "Precio Unit", "Total", "IVA", "Archivo"];
    const csvData = filteredRows.map(row => {
      const inv = results.find(r => r.id === row.invoiceId);
      const rowData = [
        inv?.invoiceDate || "",
        row.supplier || "",
        inv?.supplierRuc || "",
        inv?.invoiceNumber || "",
        inv?.accessKey || "",
        row.product || "",
        row.barcode || "",
        row.quantity,
        row.finalUnitCost.toFixed(4),
        row.finalTotalCost.toFixed(2),
        row.taxCategory || "UNKNOWN",
        row.fileName || ""
      ];
      // Escape each field and join with semicolon
      return rowData.map(val => {
        const strVal = String(val).replace(/"/g, '""');
        return `"${strVal}"`;
      }).join(";");
    });

    // Add Byte Order Mark (BOM) for correct UTF-8 encoding in Excel
    const BOM = "\uFEFF";
    const csvContent = BOM + [headers.join(";"), ...csvData].join("\n");
    
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", `reporte_inventario_${new Date().toISOString().split('T')[0]}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const deleteItem = (invoiceId: string, itemIndex: number, productName: string) => {
    setDeleteConfirmation({ invoiceId, itemIndex, productName });
  };

  const confirmDelete = async () => {
    if (!deleteConfirmation) return;
    const { invoiceId, itemIndex } = deleteConfirmation;

    try {
      const response = await fetch(`/api/invoices/${invoiceId}/items/${itemIndex}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.error || "No se pudo eliminar el item.");
      }

      setResults(await response.json());
      setDeleteConfirmation(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo eliminar el item.");
    }
  };

  const clearResults = async () => {
    try {
      const response = await fetch("/api/invoices", { method: "DELETE" });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.error || "No se pudo limpiar el historial.");
      }

      setSelectedFiles([]);
      setSelectedInvoiceIds(new Set());
      setLoadedInvoiceIds(new Set());
      setShowOnlySelectedUploads(false);
      setResults([]);
      setSortField(null);
      setSortOrder(null);
      setSearchQuery("");
      setColumnSearch({});
      setActiveSearchField(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo limpiar el historial.");
    }
  };

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const copyCellText = (text: string, cellId: string) => {
    navigator.clipboard.writeText(text);
    setCopiedCellId(cellId);
    setTimeout(() => setCopiedCellId(null), 1500);
  };

  const handleHeaderContextMenu = (e: React.MouseEvent, field: SortField) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, field });
  };

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
    setUploadContextMenu(null);
  }, []);

  useEffect(() => {
    window.addEventListener("click", closeContextMenu);
    return () => window.removeEventListener("click", closeContextMenu);
  }, [closeContextMenu]);

  const handleSort = (field: SortField, order: SortOrder) => {
    setSortField(field);
    setSortOrder(order);
    closeContextMenu();
  };

  const toggleColumnSearch = (e: React.MouseEvent, field: SortField) => {
    e.stopPropagation();
    setActiveSearchField(activeSearchField === field ? null : field);
  };

  return (
    <div className="min-h-screen bg-[#020617] text-slate-100 font-sans p-4 md:p-8">
      <div className="max-w-7xl mx-auto space-y-6">
        {/* Header */}
        <header className="flex justify-between items-center">
          <div>
            <h1 className="text-2xl font-black tracking-tighter text-white uppercase italic flex items-center gap-2">
              <Receipt className="h-6 w-6 text-cyan-400" />
              Facturas AI
            </h1>
            <p className="text-slate-500 text-[11px] font-bold uppercase tracking-widest mt-1">Costo final por producto • Cuadrado automático</p>
          </div>
          <div className="hidden md:block text-right">
            <div className="text-[10px] text-slate-600 font-bold uppercase">Dashboard Comercial</div>
            <div className="text-xs text-slate-400 font-medium">v1.2.0-stable</div>
          </div>
        </header>

        <div className="grid gap-6 lg:grid-cols-[340px_1fr]">
          {/* Left Column */}
          <aside className="space-y-4">
            {/* Upload Area */}
            <div 
              className="group flex flex-col items-center justify-center rounded-2xl border-2 border-dashed border-slate-800 bg-slate-900/20 p-8 min-h-[200px] transition-all hover:border-cyan-500/30 hover:bg-slate-900/40 cursor-pointer text-center relative overflow-hidden"
              onClick={() => document.getElementById('file-upload')?.click()}
              onContextMenu={handleUploadContextMenu}
            >
              <div className="absolute inset-0 bg-gradient-to-b from-cyan-500/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
              <input 
                id="file-upload" 
                type="file" 
                className="hidden" 
                onChange={(e) => handleFileUpload(e.target.files)}
                multiple
                accept="image/*,.pdf,.xml,.txt,text/plain,text/xml,application/xml"
              />
              <div className="bg-slate-800 p-4 rounded-full mb-4 group-hover:scale-110 transition-transform">
                <Upload className="h-6 w-6 text-cyan-400" />
              </div>
              <p className="font-black text-slate-200 text-sm uppercase tracking-wide">Subir comprobantes</p>
              <p className="text-[10px] text-slate-500 mt-1 uppercase font-bold tracking-tight">
                XML, reporte TXT SRI, fotos, PDF o <span className="text-cyan-500 underline decoration-cyan-500/30 underline-offset-2">pega una imagen</span>
              </p>
              
              {selectedFiles.length > 0 && (
                <div className="mt-6 w-full max-w-[260px] space-y-2">
                  <div className="rounded-lg bg-cyan-500/10 px-3 py-2 text-[10px] text-cyan-400 font-black border border-cyan-500/20 shadow-[0_0_15px_rgba(34,211,238,0.1)]">
                    {selectedFiles.length} archivo(s) listos
                  </div>
                  <div className="max-h-24 overflow-auto custom-scrollbar space-y-1">
                    {selectedFiles.slice(0, 5).map((file, index) => (
                      <div key={`${file.name}-${file.lastModified}-${index}`} className="flex items-center gap-2 rounded bg-slate-950/70 px-2 py-1 text-[9px] text-slate-400">
                        <FileText className="h-3 w-3 text-cyan-500" />
                        <span className="truncate">{file.name}</span>
                      </div>
                    ))}
                    {selectedFiles.length > 5 && (
                      <div className="text-[9px] font-bold text-slate-600">+{selectedFiles.length - 5} mas</div>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* Progress Area */}
            <AnimatePresence>
              {isLoading && (
                <motion.div 
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                  className="space-y-2 mb-4 overflow-hidden"
                >
                  <div className="flex justify-between items-end">
                    <span className="text-[9px] font-black uppercase tracking-widest text-cyan-400 animate-pulse">
                      {loadingPhase}
                    </span>
                    <span className="text-[9px] font-mono text-slate-500">
                      {progress}%
                    </span>
                  </div>
                  <div className="h-1 w-full bg-slate-900 rounded-full overflow-hidden border border-slate-800/50 relative">
                    <motion.div 
                      className="absolute inset-y-0 left-0 bg-linear-to-r from-cyan-600 to-cyan-400"
                      initial={{ width: "0%" }}
                      animate={{ width: `${progress}%` }}
                      transition={{ type: "spring", bounce: 0, duration: 0.5 }}
                    />
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Actions */}
            <div className="grid grid-cols-2 gap-3">
              <button 
                onClick={clearResults}
                className="rounded-xl border border-slate-800 bg-slate-950 py-3.5 text-[10px] font-black uppercase tracking-widest text-slate-500 hover:bg-slate-900 hover:text-slate-300 transition"
              >
                Limpiar
              </button>
              <button 
                onClick={processFiles}
                disabled={selectedFiles.length === 0 || isLoading}
                className="flex items-center justify-center rounded-xl bg-cyan-600 py-3.5 text-[10px] font-black uppercase tracking-widest text-white shadow-[0_0_20px_rgba(8,145,178,0.2)] hover:bg-cyan-500 transition disabled:opacity-30 disabled:grayscale transition-all overflow-hidden"
              >
                {isLoading ? (
                  <span className="animate-pulse">Procesando...</span>
                ) : (
                  "Procesar"
                )}
              </button>
            </div>

            {/* Status Panel */}
            <div className="rounded-2xl border border-slate-800/60 bg-slate-900/30 p-5 space-y-4">
              <div className="flex gap-2">
                <div className="px-3 py-1 rounded bg-green-500/10 border border-green-500/20 flex items-center gap-1.5">
                  <div className="h-1 w-1 rounded-full bg-green-500" />
                  <span className="text-[9px] font-black text-green-500 uppercase">OK: {results.filter(r => r.status === 'OK').length}</span>
                </div>
                <div className="px-3 py-1 rounded bg-amber-500/10 border border-amber-500/20 flex items-center gap-1.5">
                  <div className="h-1 w-1 rounded-full bg-amber-500" />
                  <span className="text-[9px] font-black text-amber-500 uppercase">Rev: {results.filter(r => r.status === 'REVIEW').length}</span>
                </div>
                <div className="px-3 py-1 rounded bg-slate-800 border border-slate-700 flex items-center gap-1.5">
                  <span className="text-[9px] font-black text-slate-400 uppercase">Files: {results.length}</span>
                </div>
              </div>
              
              {error && (
                <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-[10px] text-red-300 italic font-medium">
                  {error}
                </div>
              )}
            </div>
          </aside>

          {/* Table Container */}
          <main className="rounded-2xl border border-slate-800 bg-slate-900/20 flex flex-col min-h-[500px] shadow-2xl relative overflow-hidden backdrop-blur-sm">
            <section className="border-b border-slate-800/60 bg-slate-950/30 p-4 space-y-4">
              <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                <div>
                  <div className="text-[10px] font-black uppercase tracking-[0.3em] text-cyan-500">Archivo</div>
                  <h2 className="text-lg font-black uppercase tracking-tight text-white">Facturas y productos</h2>
                </div>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-[10px] font-black uppercase">
                  <div className="rounded-lg border border-slate-800 bg-slate-950 px-3 py-2">
                    <span className="block text-slate-600">Facturas</span>
                    <strong className="text-slate-200">{sriInvoices.length}</strong>
                  </div>
                  <div className="rounded-lg border border-green-500/20 bg-green-500/10 px-3 py-2">
                    <span className="block text-green-600">Productos</span>
                    <strong className="text-green-400">{products.length}</strong>
                  </div>
                  <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2">
                    <span className="block text-amber-600">Revision</span>
                    <strong className="text-amber-400">{sriPending}</strong>
                  </div>
                  <div className="rounded-lg border border-cyan-500/20 bg-cyan-500/10 px-3 py-2">
                    <span className="block text-cyan-600">Total</span>
                    <strong className="text-cyan-400">${sriTotal.toFixed(2)}</strong>
                  </div>
                </div>
              </div>

              <div className="grid gap-3 rounded-xl border border-slate-800 bg-slate-950/40 p-4">
                <div className="grid gap-3 lg:grid-cols-[1fr_auto_auto] lg:items-center">
                  <div>
                    <div className="flex items-center gap-2 text-[10px] font-black uppercase tracking-[0.25em] text-cyan-500">
                      <ClipboardList className="h-3.5 w-3.5" />
                      Facturas subidas
                    </div>
                    <div className="mt-2 flex flex-wrap gap-2 text-[10px] font-black uppercase">
                      <span className="rounded bg-slate-900 px-2 py-1 text-slate-500">Seleccionadas: {selectedInvoiceIds.size}</span>
                      <span className="rounded bg-cyan-500/10 px-2 py-1 text-cyan-400">Total: ${selectedInvoicesTotal.toFixed(2)}</span>
                      {loadedInvoiceIds.size > 0 && (
                        <span className="rounded bg-green-500/10 px-2 py-1 text-green-400">Cargadas abajo: {loadedInvoiceIds.size}</span>
                      )}
                    </div>
                  </div>

                  <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-slate-800 bg-slate-950 px-3 py-3 text-[10px] font-black uppercase text-slate-300">
                    <input
                      type="checkbox"
                      checked={showOnlySelectedUploads}
                      onChange={(event) => setShowOnlySelectedUploads(event.target.checked)}
                      className="h-4 w-4 accent-cyan-500"
                    />
                    Mostrar seleccionadas
                  </label>

                  <select
                    value={categoryFilter}
                    onChange={(event) => setCategoryFilter(event.target.value as InvoiceCategory | "TODAS")}
                    className="rounded-lg border border-slate-800 bg-slate-950 px-3 py-3 text-[11px] font-black uppercase text-slate-200 outline-none transition focus:border-cyan-500/40"
                  >
                    <option value="TODAS">Todas</option>
                    {CATEGORY_OPTIONS.map((category) => (
                      <option key={category.value} value={category.value}>{category.label}</option>
                    ))}
                  </select>
                </div>

                <div className="flex flex-col gap-2 sm:flex-row">
                  <button
                    type="button"
                    onClick={toggleAllVisibleInvoices}
                    disabled={visibleUploadedInvoices.length === 0}
                    className="flex items-center justify-center gap-2 rounded-lg border border-slate-800 bg-slate-950 px-4 py-2.5 text-[10px] font-black uppercase tracking-widest text-slate-400 transition hover:bg-slate-900 hover:text-white disabled:opacity-30"
                  >
                    <Check className="h-3.5 w-3.5" />
                    Seleccionar visibles
                  </button>
                  <button
                    type="button"
                    onClick={loadSelectedInvoicesIntoSystem}
                    disabled={selectedInvoiceIds.size === 0}
                    className="flex items-center justify-center gap-2 rounded-lg bg-cyan-600 px-4 py-2.5 text-[10px] font-black uppercase tracking-widest text-white transition hover:bg-cyan-500 disabled:opacity-30"
                  >
                    <Archive className="h-3.5 w-3.5" />
                    Cargar seleccionadas al sistema
                  </button>
                  {loadedInvoiceIds.size > 0 && (
                    <button
                      type="button"
                      onClick={() => setLoadedInvoiceIds(new Set())}
                      className="flex items-center justify-center gap-2 rounded-lg border border-slate-800 bg-slate-950 px-4 py-2.5 text-[10px] font-black uppercase tracking-widest text-slate-400 transition hover:bg-slate-900 hover:text-white"
                    >
                      Ver todas abajo
                    </button>
                  )}
                </div>
              </div>

              <div className="rounded-xl border border-slate-800 overflow-hidden">
                <div className="grid grid-cols-[44px_1.2fr_0.8fr_0.8fr_0.7fr] gap-2 bg-slate-950 px-4 py-2 text-[9px] font-black uppercase tracking-widest text-slate-600">
                  <span></span>
                  <span>Factura</span>
                  <span>Categoria</span>
                  <span>Productos</span>
                  <span className="text-right">Total</span>
                </div>
                <div className="max-h-72 overflow-auto custom-scrollbar divide-y divide-slate-800">
                  {visibleUploadedInvoices.length === 0 ? (
                    <div className="px-4 py-8 text-center text-[10px] font-black uppercase tracking-widest text-slate-700">
                      Sube TXT, XML, fotos o PDF para ver facturas guardadas
                    </div>
                  ) : (
                    visibleUploadedInvoices.map((invoice) => (
                      <div
                        key={invoice.id}
                        className={`grid grid-cols-[44px_1.2fr_0.8fr_0.8fr_0.7fr] gap-2 px-4 py-3 text-[11px] ${loadedInvoiceIds.has(invoice.id) ? "bg-cyan-500/5" : ""}`}
                      >
                        <label className="flex items-center">
                          <input
                            type="checkbox"
                            checked={selectedInvoiceIds.has(invoice.id)}
                            onChange={() => toggleInvoiceSelection(invoice.id)}
                            className="h-4 w-4 accent-cyan-500"
                            aria-label={`Seleccionar factura ${invoice.invoiceNumber || invoice.fileName}`}
                          />
                        </label>
                        <div className="min-w-0">
                          <strong className="block truncate text-slate-200 uppercase">{invoice.supplier || "Proveedor"}</strong>
                          <span className="block truncate text-slate-600">{invoice.invoiceNumber || invoice.fileName}</span>
                        </div>
                        <select
                          value={invoice.category || "SIN_CATEGORIA"}
                          onChange={(event) => updateInvoiceCategory(invoice, event.target.value as InvoiceCategory)}
                          className="w-full rounded border border-slate-800 bg-slate-950 px-2 py-1 text-[9px] font-black uppercase text-slate-300 outline-none"
                        >
                          {CATEGORY_OPTIONS.map((category) => (
                            <option key={category.value} value={category.value}>{category.label}</option>
                          ))}
                        </select>
                        <span className="text-slate-400">{invoice.items.length}</span>
                        <strong className="text-right text-cyan-400">${invoice.invoiceTotalPaid.toFixed(2)}</strong>
                      </div>
                    ))
                  )}
                </div>
              </div>

              {sriUnmappedItems > 0 && (
                <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-[10px] font-bold text-amber-300">
                  {sriUnmappedItems} productos recibidos no tienen codigo de barras y requieren mapeo antes de ingresar inventario.
                </div>
              )}

            </section>

            {/* Search and Export */}
            <div className="flex items-center gap-3 p-4 border-b border-slate-800/40 bg-slate-900/20">
              <div className="flex-1 relative">
                <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-600" />
                <input 
                  type="text" 
                  placeholder="BUSCAR PRODUCTO O CÓDIGO..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full bg-slate-950/60 border border-slate-800 rounded-xl pl-10 pr-4 py-2.5 text-xs font-bold uppercase tracking-tight outline-none focus:border-cyan-500/40 transition-all placeholder:text-slate-700"
                />
              </div>
              <button 
                onClick={exportCSV}
                disabled={filteredRows.length === 0}
                className="px-6 py-2.5 rounded-xl border border-slate-800 bg-slate-950 text-[10px] font-black text-slate-400 hover:bg-slate-800 hover:text-white transition disabled:opacity-30 uppercase tracking-widest"
              >
                Exportar
              </button>
            </div>

            {/* Table */}
            <div className="flex-1 overflow-auto custom-scrollbar">
              <table className="w-full text-left text-[11px] border-collapse relative border-slate-800">
                <thead className="sticky top-0 z-10 bg-slate-900 shadow-md">
                  <tr className="border-b border-slate-700 text-slate-500 uppercase font-black tracking-[0.2em] text-[9px]">
                    <th 
                      className="px-6 py-4 cursor-default select-none group/h border-r border-slate-800/50"
                      onContextMenu={(e) => handleHeaderContextMenu(e, "barcode")}
                    >
                      <div className="flex items-center gap-2">
                        <div className="flex items-center gap-1">
                          Código
                          {sortField === "barcode" && (sortOrder === "asc" ? <ChevronUp className="h-3 w-3 text-cyan-400" /> : <ChevronDown className="h-3 w-3 text-cyan-400" />)}
                        </div>
                        <Search 
                          className={`h-3 w-3 cursor-pointer transition-opacity ${activeSearchField === 'barcode' || columnSearch.barcode ? 'opacity-100 text-cyan-400' : 'opacity-0 group-hover/h:opacity-40 hover:opacity-100'}`}
                          onClick={(e) => toggleColumnSearch(e, "barcode")}
                        />
                      </div>
                      <AnimatePresence>
                        {activeSearchField === 'barcode' && (
                          <motion.div 
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: 'auto', opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            className="mt-2"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <input 
                              autoFocus
                              type="text"
                              className="w-full bg-slate-950 border border-slate-800 rounded px-2 py-1 text-[10px] outline-none focus:border-cyan-500/40"
                              placeholder="Filtrar..."
                              value={columnSearch.barcode || ""}
                              onChange={(e) => setColumnSearch(prev => ({ ...prev, barcode: e.target.value }))}
                            />
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </th>
                    <th 
                      className="px-6 py-4 cursor-default select-none group/h text-left border-r border-slate-800/50"
                      onContextMenu={(e) => handleHeaderContextMenu(e, "product")}
                    >
                      <div className="flex items-center gap-2">
                        <div className="flex items-center gap-1">
                          Producto
                          {sortField === "product" && (sortOrder === "asc" ? <ChevronUp className="h-3 w-3 text-cyan-400" /> : <ChevronDown className="h-3 w-3 text-cyan-400" />)}
                        </div>
                        <Search 
                          className={`h-3 w-3 cursor-pointer transition-opacity ${activeSearchField === 'product' || columnSearch.product ? 'opacity-100 text-cyan-400' : 'opacity-0 group-hover/h:opacity-40 hover:opacity-100'}`}
                          onClick={(e) => toggleColumnSearch(e, "product")}
                        />
                      </div>
                      <AnimatePresence>
                        {activeSearchField === 'product' && (
                          <motion.div 
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: 'auto', opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            className="mt-2"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <input 
                              autoFocus
                              type="text"
                              className="w-full bg-slate-950 border border-slate-800 rounded px-2 py-1 text-[10px] outline-none focus:border-cyan-500/40"
                              placeholder="Filtrar..."
                              value={columnSearch.product || ""}
                              onChange={(e) => setColumnSearch(prev => ({ ...prev, product: e.target.value }))}
                            />
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </th>
                    <th 
                      className="px-6 py-4 text-right cursor-default select-none group/h border-r border-slate-800/50"
                      onContextMenu={(e) => handleHeaderContextMenu(e, "quantity")}
                    >
                      <div className="flex items-center justify-end gap-2">
                        <Search 
                          className={`h-3 w-3 cursor-pointer transition-opacity ${activeSearchField === 'quantity' || columnSearch.quantity ? 'opacity-100 text-cyan-400' : 'opacity-0 group-hover/h:opacity-40 hover:opacity-100'}`}
                          onClick={(e) => toggleColumnSearch(e, "quantity")}
                        />
                        <div className="flex items-center gap-1">
                          Cant
                          {sortField === "quantity" && (sortOrder === "asc" ? <ChevronUp className="h-3 w-3 text-cyan-400" /> : <ChevronDown className="h-3 w-3 text-cyan-400" />)}
                        </div>
                      </div>
                      <AnimatePresence>
                        {activeSearchField === 'quantity' && (
                          <motion.div 
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: 'auto', opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            className="mt-2"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <input 
                              autoFocus
                              type="text"
                              className="w-full bg-slate-950 border border-slate-800 rounded px-2 py-1 text-[10px] outline-none focus:border-cyan-500/40 text-right"
                              placeholder="0..."
                              value={columnSearch.quantity || ""}
                              onChange={(e) => setColumnSearch(prev => ({ ...prev, quantity: e.target.value }))}
                            />
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </th>
                    <th 
                      className="px-6 py-4 text-right cursor-default select-none group/h border-r border-slate-800/50"
                      onContextMenu={(e) => handleHeaderContextMenu(e, "finalUnitCost")}
                    >
                      <div className="flex items-center justify-end gap-2">
                        <Search 
                          className={`h-3 w-3 cursor-pointer transition-opacity ${activeSearchField === 'finalUnitCost' || columnSearch.finalUnitCost ? 'opacity-100 text-cyan-400' : 'opacity-0 group-hover/h:opacity-40 hover:opacity-100'}`}
                          onClick={(e) => toggleColumnSearch(e, "finalUnitCost")}
                        />
                        <div className="flex items-center gap-1">
                          Unit
                          {sortField === "finalUnitCost" && (sortOrder === "asc" ? <ChevronUp className="h-3 w-3 text-cyan-400" /> : <ChevronDown className="h-3 w-3 text-cyan-400" />)}
                        </div>
                      </div>
                      <AnimatePresence>
                        {activeSearchField === 'finalUnitCost' && (
                          <motion.div 
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: 'auto', opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            className="mt-2"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <input 
                              autoFocus
                              type="text"
                              className="w-full bg-slate-950 border border-slate-800 rounded px-2 py-1 text-[10px] outline-none focus:border-cyan-500/40 text-right"
                              placeholder="0.00..."
                              value={columnSearch.finalUnitCost || ""}
                              onChange={(e) => setColumnSearch(prev => ({ ...prev, finalUnitCost: e.target.value }))}
                            />
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </th>
                    <th 
                      className="px-6 py-4 text-right cursor-default select-none group/h border-r border-slate-800/50"
                      onContextMenu={(e) => handleHeaderContextMenu(e, "finalTotalCost")}
                    >
                      <div className="flex items-center justify-end gap-2">
                        <Search 
                          className={`h-3 w-3 cursor-pointer transition-opacity ${activeSearchField === 'finalTotalCost' || columnSearch.finalTotalCost ? 'opacity-100 text-cyan-400' : 'opacity-0 group-hover/h:opacity-40 hover:opacity-100'}`}
                          onClick={(e) => toggleColumnSearch(e, "finalTotalCost")}
                        />
                        <div className="flex items-center gap-1">
                          Total
                          {sortField === "finalTotalCost" && (sortOrder === "asc" ? <ChevronUp className="h-3 w-3 text-cyan-400" /> : <ChevronDown className="h-3 w-3 text-cyan-400" />)}
                        </div>
                      </div>
                      <AnimatePresence>
                        {activeSearchField === 'finalTotalCost' && (
                          <motion.div 
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: 'auto', opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            className="mt-2"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <input 
                              autoFocus
                              type="text"
                              className="w-full bg-slate-950 border border-slate-800 rounded px-2 py-1 text-[10px] outline-none focus:border-cyan-500/40 text-right"
                              placeholder="0.00..."
                              value={columnSearch.finalTotalCost || ""}
                              onChange={(e) => setColumnSearch(prev => ({ ...prev, finalTotalCost: e.target.value }))}
                            />
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </th>
                    <th className="px-6 py-4 text-center text-slate-700 uppercase font-black tracking-widest text-[8px]">
                      Acciones
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-700/60 text-slate-400">
                  {filteredRows.map((row, idx) => (
                    <tr key={idx} className="hover:bg-cyan-500/5 transition-all group border-b border-slate-800">
                      <td 
                        className={`px-6 py-3 font-mono text-[10px] italic border-r border-slate-800/50 cursor-pointer hover:bg-white/5 transition-colors relative ${copiedCellId === `${row.rowId}-barcode` ? 'text-cyan-400' : 'text-slate-500 group-hover:text-slate-400'}`}
                        onClick={() => copyCellText(row.barcode || "", `${row.rowId}-barcode`)}
                        title="Clic para copiar"
                      >
                        {row.barcode || "—"}
                        {copiedCellId === `${row.rowId}-barcode` && (
                          <motion.span initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="absolute right-1 top-1">
                            <Check className="h-2 w-2" />
                          </motion.span>
                        )}
                      </td>
                      <td 
                        className={`px-6 py-3 font-black uppercase tracking-tight border-r border-slate-800/50 cursor-pointer hover:bg-white/5 transition-colors relative ${copiedCellId === `${row.rowId}-product` ? 'text-cyan-400' : 'text-slate-200 group-hover:text-white'}`}
                        onClick={() => copyCellText(row.product, `${row.rowId}-product`)}
                        title="Clic para copiar"
                      >
                        <div className="flex items-center gap-2">
                          {row.product}
                          {row.taxCategory === "IVA_15" && (
                            <span className="text-[7px] bg-cyan-500/20 text-cyan-400 px-1 rounded-sm border border-cyan-500/30">IVA</span>
                          )}
                        </div>
                        {copiedCellId === `${row.rowId}-product` && (
                          <motion.span initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="absolute right-1 top-1">
                            <Check className="h-2 w-2" />
                          </motion.span>
                        )}
                      </td>
                      <td 
                        className={`px-6 py-3 text-right font-bold tabular-nums border-r border-slate-800/50 cursor-pointer hover:bg-white/5 transition-colors relative ${copiedCellId === `${row.rowId}-qty` ? 'text-cyan-400' : 'text-slate-400'}`}
                        onClick={() => copyCellText(row.quantity.toString(), `${row.rowId}-qty`)}
                        title="Clic para copiar"
                      >
                        {row.quantity}
                        {copiedCellId === `${row.rowId}-qty` && (
                          <motion.span initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="absolute right-1 top-1">
                            <Check className="h-2 w-2" />
                          </motion.span>
                        )}
                      </td>
                      <td 
                        className={`px-6 py-3 text-right font-black tabular-nums text-xs brightness-125 border-r border-slate-800/50 cursor-pointer hover:bg-white/5 transition-colors relative ${copiedCellId === `${row.rowId}-unit` ? 'text-cyan-400' : 'text-cyan-400/90'}`}
                        onClick={() => copyCellText(row.finalUnitCost.toFixed(4), `${row.rowId}-unit`)}
                        title="Clic para copiar"
                      >
                        <span className="bg-cyan-950/20 px-1.5 py-0.5 rounded border border-cyan-500/10">
                          ${row.finalUnitCost.toFixed(4)}
                        </span>
                        {copiedCellId === `${row.rowId}-unit` && (
                          <motion.span initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="absolute right-1 top-1">
                            <Check className="h-2 w-2" />
                          </motion.span>
                        )}
                      </td>
                      <td 
                        className={`px-6 py-3 text-right font-black tabular-nums text-sm tracking-tighter border-r border-slate-800/50 cursor-pointer hover:bg-white/5 transition-colors relative ${copiedCellId === `${row.rowId}-total` ? 'text-cyan-400' : 'text-slate-100'}`}
                        onClick={() => copyCellText(row.finalTotalCost.toFixed(2), `${row.rowId}-total`)}
                        title="Clic para copiar"
                      >
                        ${row.finalTotalCost.toFixed(2)}
                        {copiedCellId === `${row.rowId}-total` && (
                          <motion.span initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="absolute right-1 top-1">
                            <Check className="h-2 w-2" />
                          </motion.span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className="flex items-center justify-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                          <button 
                            onClick={() => copyToClipboard(`${row.product} | ${row.barcode}`, row.rowId)}
                            className="p-1.5 rounded hover:bg-slate-800 text-slate-500 hover:text-cyan-400 transition-colors"
                            title="Copiar detalles"
                          >
                            {copiedId === row.rowId ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
                          </button>
                          <button 
                            onClick={() => deleteItem(row.invoiceId, row.itemIndex, row.product)}
                            className="p-1.5 rounded hover:bg-red-500/10 text-slate-500 hover:text-red-500 transition-colors"
                            title="Eliminar ítem"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                  
                  {/* Spreadsheet Footer / Summary Row */}
                  {filteredRows.length > 0 && (
                    <tr className="bg-slate-950/80 border-t-2 border-slate-700 font-black text-[10px] sticky bottom-0 z-10 backdrop-blur-md">
                      <td className="px-6 py-4 text-slate-600 uppercase tracking-widest border-r border-slate-800/50 italic">
                        {filteredRows.length} Ítems Det.
                      </td>
                      <td className="px-6 py-4 uppercase tracking-tighter text-slate-600 border-r border-slate-800/50">
                        Resultados de Columnas
                      </td>
                      <td className="px-6 py-4 text-right text-slate-300 border-r border-slate-800/50 tabular-nums">
                        {totalFilteredQuantity}
                      </td>
                      <td className="px-6 py-4 text-right text-cyan-500/60 border-r border-slate-800/50 tabular-nums italic">
                        UNIT: ${weightedUnitCost.toFixed(4)}
                      </td>
                      <td 
                        className="px-6 py-4 text-right text-cyan-400 cursor-pointer bg-cyan-950/10 hover:bg-cyan-900/20 transition-colors border-r border-slate-800/50"
                        onClick={(e) => { e.stopPropagation(); setIsAggMenuOpen(!isAggMenuOpen); }}
                      >
                        <div className="flex items-center justify-end gap-2">
                          <Sigma className="h-3 w-3" />
                          <span className="tabular-nums">${aggType === "avg" ? aggResult.toFixed(4) : aggResult.toFixed(2)}</span>
                        </div>
                      </td>
                      <td className="px-6 py-4"></td>
                    </tr>
                  )}

                  {filteredRows.length === 0 && (
                    <tr>
                      <td colSpan={6} className="px-6 py-32 text-center text-slate-700 italic flex flex-col items-center gap-3">
                        <Receipt className="h-8 w-8 opacity-20" />
                        <span className="text-[10px] font-black uppercase tracking-widest opacity-40">No hay registros</span>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {/* Footer / Total */}
            <div className="p-8 border-t border-slate-800/60 bg-slate-950/40 flex justify-between items-end backdrop-blur-xl relative">
              <div>
                <div className="text-cyan-500 font-black text-[10px] uppercase tracking-[0.3em] mb-1">Inventario AI</div>
                <div className="text-slate-500 font-bold text-xs italic">
                  {filteredRows.length} productos detectados
                </div>
              </div>
              <div className="text-right">
                <div className="relative group/agg">
                  <button 
                    onClick={(e) => { e.stopPropagation(); setIsAggMenuOpen(!isAggMenuOpen); }}
                    className="flex items-center gap-1.5 ml-auto text-[9px] uppercase tracking-[0.3em] text-slate-600 font-black mb-2 opacity-80 hover:text-cyan-400 transition-colors cursor-pointer"
                  >
                    <Sigma className="h-3 w-3" />
                    {aggLabel}
                  </button>
                  
                  <AnimatePresence>
                    {isAggMenuOpen && (
                      <motion.div
                        initial={{ opacity: 0, y: 5, scale: 0.95 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: 5, scale: 0.95 }}
                        className="absolute bottom-full right-0 mb-2 w-56 bg-slate-900 border border-slate-800 rounded-lg shadow-2xl p-1 z-50 text-left"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <div className="px-3 py-2 border-b border-slate-800 mb-1">
                          <span className="text-[9px] font-black uppercase tracking-widest text-slate-500 italic">Cálculo automático</span>
                        </div>
                        {[
                          { id: "sum", label: "Suma" },
                          { id: "count", label: "Número de elementos" },
                          { id: "avg", label: "Costo unitario" },
                          { id: "min", label: "Mínimo" },
                          { id: "max", label: "Máximo" },
                        ].map((opt) => (
                          <button
                            key={opt.id}
                            onClick={() => { setAggType(opt.id as AggregationType); setIsAggMenuOpen(false); }}
                            className={`w-full flex items-center justify-between px-3 py-2 text-xs font-bold rounded transition ${aggType === opt.id ? 'bg-cyan-500/10 text-cyan-400' : 'text-slate-300 hover:bg-slate-800 hover:text-white'}`}
                          >
                            {opt.label}
                            {aggType === opt.id && <Check className="h-3 w-3" />}
                          </button>
                        ))}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
                <div className="text-6xl font-black text-white tabular-nums tracking-tighter glow-text leading-none">
                  {aggType === 'sum' || aggType === 'avg' || aggType === 'min' || aggType === 'max' ? '$' : ''}
                  {aggType === 'count' ? aggResult : aggType === 'avg' ? aggResult.toFixed(4) : aggResult.toFixed(2)}
                </div>
              </div>
            </div>
          </main>
        </div>
      </div>

      <AnimatePresence>
        {contextMenu && (
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: -5 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: -5 }}
            className="fixed z-50 min-w-[160px] bg-slate-900 border border-slate-700/50 rounded-lg shadow-2xl p-1 overflow-hidden"
            style={{ top: contextMenu.y, left: contextMenu.x }}
          >
            <div className="px-3 py-2 border-b border-slate-800 mb-1">
              <span className="text-[9px] font-black uppercase tracking-widest text-slate-500">Filtrar: {contextMenu.field}</span>
            </div>
            <button 
              onClick={() => handleSort(contextMenu.field, "asc")}
              className="w-full flex items-center gap-3 px-3 py-2 text-xs font-bold text-slate-300 hover:bg-slate-800 hover:text-white rounded transition"
            >
              <ChevronUp className="h-3.5 w-3.5 text-cyan-400" />
              Ordenar A-Z / Menor
            </button>
            <button 
              onClick={() => handleSort(contextMenu.field, "desc")}
              className="w-full flex items-center gap-3 px-3 py-2 text-xs font-bold text-slate-300 hover:bg-slate-800 hover:text-white rounded transition"
            >
              <ChevronDown className="h-3.5 w-3.5 text-cyan-400" />
              Ordenar Z-A / Mayor
            </button>
            <div className="h-px bg-slate-800 my-1" />
            <button 
              onClick={() => { setSortField(null); setSortOrder(null); setColumnSearch({}); setActiveSearchField(null); closeContextMenu(); }}
              className="w-full flex items-center gap-3 px-3 py-2 text-xs font-bold text-red-400 hover:bg-red-500/10 rounded transition"
            >
              <FilterX className="h-3.5 w-3.5" />
              Limpiar filtros
            </button>
          </motion.div>
        )}

        {uploadContextMenu && (
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: -5 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: -5 }}
            className="fixed z-50 min-w-[160px] bg-slate-900 border border-slate-700/50 rounded-lg shadow-2xl p-1 overflow-hidden"
            style={{ top: uploadContextMenu.y, left: uploadContextMenu.x }}
          >
            <button 
              onClick={(e) => {
                e.stopPropagation();
                handlePasteFromClipboard();
              }}
              className="w-full flex items-center gap-3 px-3 py-2 text-xs font-bold text-slate-300 hover:bg-slate-800 hover:text-white rounded transition"
            >
              <Copy className="h-3.5 w-3.5 text-cyan-400" />
              Pegar imagen
            </button>
          </motion.div>
        )}

        {deleteConfirmation && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 bg-slate-950/80 backdrop-blur-sm"
              onClick={() => setDeleteConfirmation(null)}
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className="relative w-full max-w-sm bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl overflow-hidden"
            >
              <div className="p-6 text-center">
                <div className="mx-auto w-12 h-12 rounded-full bg-red-500/10 flex items-center justify-center mb-4">
                  <Trash2 className="h-6 w-6 text-red-500" />
                </div>
                <h3 className="text-white font-black text-lg mb-2">¿Confirmar eliminación?</h3>
                <p className="text-slate-400 text-sm mb-6">
                  Estás a punto de eliminar <span className="text-slate-200 font-bold italic">"{deleteConfirmation.productName}"</span>. Esta acción no se puede deshacer.
                </p>
                <div className="flex gap-3">
                  <button 
                    onClick={() => setDeleteConfirmation(null)}
                    className="flex-1 px-4 py-3 rounded-xl bg-slate-800 text-slate-300 text-xs font-black uppercase tracking-widest hover:bg-slate-700 transition"
                  >
                    Cancelar
                  </button>
                  <button 
                    onClick={confirmDelete}
                    className="flex-1 px-4 py-3 rounded-xl bg-red-600 text-white text-xs font-black uppercase tracking-widest hover:bg-red-500 transition shadow-[0_0_20px_rgba(239,68,68,0.2)]"
                  >
                    Eliminar
                  </button>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      <style>{`
        .glow-text {
          text-shadow: 0 0 30px rgba(34, 211, 238, 0.4), 0 0 60px rgba(34, 211, 238, 0.1);
        }
        .custom-scrollbar::-webkit-scrollbar {
          width: 6px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: #1e293b;
          border-radius: 10px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: #334155;
        }
      `}</style>
    </div>
  );
}

