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
  CalendarDays
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

// =====================================================
// Types & Constants
// =====================================================

type TaxCategory = "IVA_15" | "IVA_0" | "UNKNOWN";
type InvoiceStatus = "OK" | "REVIEW";
type InvoiceSource = "AI_UPLOAD" | "SRI_RECEIVED";
type SriReceptionStatus = "Pendiente mapeo" | "Listo para ingresar" | "Ingresado";

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

type SortField = "barcode" | "product" | "quantity" | "finalUnitCost" | "finalTotalCost";
type SortOrder = "asc" | "desc" | null;
type AggregationType = "sum" | "count" | "avg" | "min" | "max";

type SriSessionState = {
  id: string;
  ruc: string;
  username: string;
  expiresAt: string;
};

type SriBulkSummary = {
  requested: number;
  imported: number;
  failed: number;
};

type SriVoucherType = "0" | "1" | "2" | "3" | "4" | "6";

const DEFAULT_ECUADOR_VAT_RATE = 0.15;

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
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [loadingPhase, setLoadingPhase] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sriAccessKey, setSriAccessKey] = useState("");
  const [isSriSyncing, setIsSriSyncing] = useState(false);
  const [sriRuc, setSriRuc] = useState("");
  const [sriUsername, setSriUsername] = useState("");
  const [sriPassword, setSriPassword] = useState("");
  const [sriSession, setSriSession] = useState<SriSessionState | null>(null);
  const [sriBulkSummary, setSriBulkSummary] = useState<SriBulkSummary | null>(null);
  const [isSriLoggingIn, setIsSriLoggingIn] = useState(false);
  const [sriPeriodYear, setSriPeriodYear] = useState(String(new Date().getFullYear()));
  const [sriPeriodMonth, setSriPeriodMonth] = useState(String(new Date().getMonth() + 1).padStart(2, "0"));
  const [sriPeriodDay, setSriPeriodDay] = useState("0");
  const [sriVoucherType, setSriVoucherType] = useState<SriVoucherType>("0");
  const [isSriPeriodImporting, setIsSriPeriodImporting] = useState(false);
  
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

  useEffect(() => {
    void loadInvoices();
  }, [loadInvoices]);

  useEffect(() => {
    const savedSession = window.sessionStorage.getItem("facturas-ai:sri-session");
    if (!savedSession) return;

    try {
      const parsed = JSON.parse(savedSession) as SriSessionState;
      if (parsed.expiresAt && new Date(parsed.expiresAt).getTime() > Date.now()) {
        setSriSession(parsed);
        setSriRuc(parsed.ruc);
        setSriUsername(parsed.username);
      } else {
        window.sessionStorage.removeItem("facturas-ai:sri-session");
      }
    } catch {
      window.sessionStorage.removeItem("facturas-ai:sri-session");
    }
  }, []);

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
            setSelectedFile(file);
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
    setSelectedFile(files[0]);
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
            setSelectedFile(file);
            setError(null);
          }
        }
      }
    };

    window.addEventListener("paste", handlePaste);
    return () => window.removeEventListener("paste", handlePaste);
  }, []);

  const processFile = async () => {
    if (!selectedFile) return;
    
    setIsLoading(true);
    setProgress(5);
    setLoadingPhase("Leyendo archivo...");
    setError(null);

    try {
      const initialBase64 = await fileToBase64(selectedFile);
      setProgress(15);
      
      let base64 = initialBase64;
      const isXml = selectedFile.type.includes("xml") || selectedFile.name.toLowerCase().endsWith(".xml");
      
      if (selectedFile.type.startsWith("image/")) {
        setLoadingPhase("Optimizando imagen...");
        try {
          base64 = await optimizeImage(initialBase64);
        } catch (e) {
          console.warn("Resizing failed, using original", e);
        }
      } else if (isXml) {
        setLoadingPhase("Leyendo XML...");
      } else {
        setLoadingPhase("Preparando documento...");
      }

      setProgress(25);
      setLoadingPhase(isXml ? "Leyendo datos del XML..." : "Analizando con lector visual...");
      
      const response = await fetch("/api/extract-invoice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fileName: selectedFile.name,
          mimeType: selectedFile.type || (isXml ? "application/xml" : "image/jpeg"),
          data: isXml ? undefined : base64,
          xmlText: isXml ? await selectedFile.text() : undefined,
        }),
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.error || "No se pudo analizar la factura.");
      }

      setProgress(70);
      setLoadingPhase("Procesando respuesta...");

      const rawData = await response.json();
      
      setProgress(85);
      setLoadingPhase("Validando datos...");

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
        fileName: selectedFile.name,
        source: isXml ? "SRI_RECEIVED" : "AI_UPLOAD",
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

      setProgress(95);
      setLoadingPhase("Finalizando...");

      const saveResponse = await fetch("/api/invoices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(newResult),
      });

      if (!saveResponse.ok) {
        const payload = await saveResponse.json().catch(() => null);
        throw new Error(payload?.error || "La factura se extrajo, pero no se pudo guardar.");
      }

      const savedResult = await saveResponse.json();
      setResults(prev => [savedResult, ...prev.filter(r => r.id !== savedResult.id)]);
      setSelectedFile(null);
      setProgress(100);
      
      setTimeout(() => {
        setIsLoading(false);
        setProgress(0);
        setLoadingPhase("");
      }, 500);
    } catch (err) {
      console.error("Error processing file:", err);
      setError(`Error al procesar: ${friendlyProcessingError(err)}`);
      setIsLoading(false);
      setProgress(0);
      setLoadingPhase("");
    }
  };

  const loginSri = async () => {
    setIsSriLoggingIn(true);
    setError(null);
    setSriBulkSummary(null);

    try {
      const response = await fetch("/api/sri/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ruc: sriRuc,
          username: sriUsername || sriRuc,
          password: sriPassword,
        }),
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.error || "No se pudo iniciar sesion SRI.");
      }

      const session = await response.json();
      setSriSession(session);
      setSriRuc(session.ruc);
      setSriUsername(session.username);
      setSriPassword("");
      window.sessionStorage.setItem("facturas-ai:sri-session", JSON.stringify(session));
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo iniciar sesion SRI.");
    } finally {
      setIsSriLoggingIn(false);
    }
  };

  const logoutSri = async () => {
    const sessionId = sriSession?.id;
    setSriSession(null);
    setSriPassword("");
    setSriBulkSummary(null);
    window.sessionStorage.removeItem("facturas-ai:sri-session");

    if (!sessionId) return;

    await fetch("/api/sri/session", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
    }).catch(() => null);
  };

  const importSriPeriod = async () => {
    if (!sriSession) {
      setError("Inicia sesion SRI antes de importar por periodo.");
      return;
    }

    setIsSriPeriodImporting(true);
    setError(null);
    setSriBulkSummary(null);

    try {
      const response = await fetch("/api/sri/received-period", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: sriSession.id,
          year: Number(sriPeriodYear),
          month: Number(sriPeriodMonth),
          day: Number(sriPeriodDay),
          voucherType: sriVoucherType,
          environment: "production",
        }),
      });

      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.error || "No se pudo importar el periodo SRI.");
      }

      const imported = Array.isArray(payload.imported) ? payload.imported as InvoiceResult[] : [];
      setResults((prev) => {
        const importedIds = new Set(imported.map((invoice) => invoice.id));
        return [...imported, ...prev.filter((invoice) => !importedIds.has(invoice.id))];
      });
      setSriBulkSummary(payload.summary || null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo importar el periodo SRI.");
    } finally {
      setIsSriPeriodImporting(false);
    }
  };

  const copySriBrowserConnector = async () => {
    const endpoint = `${window.location.origin}/api/sri/import-xml-batch`;
    const connector = `javascript:(async()=>{const endpoint=${JSON.stringify(endpoint)};const form=document.querySelector('form');if(!form){alert('No se encontro formulario del SRI. Abre Comprobantes recibidos y consulta un periodo.');return;}const links=[...document.querySelectorAll('[id*=\"tablaCompRecibidos\"][id$=\"lnkXml\"],[name*=\"tablaCompRecibidos\"][name$=\"lnkXml\"]')];if(!links.length){alert('No se encontraron enlaces XML. Primero consulta el periodo en Comprobantes recibidos.');return;}const xmlTexts=[];for(const link of links.slice(0,150)){const id=link.id||link.name;const body=new URLSearchParams(new FormData(form));body.set(form.id||form.name,form.id||form.name);body.set(id,id);const response=await fetch(form.action||location.href,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},credentials:'include',body});xmlTexts.push(await response.text());}const result=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({xmlTexts})});const payload=await result.json();if(!result.ok){alert(payload.error||'No se pudo enviar a Facturas AI');return;}alert('Facturas AI: '+(payload.summary?.imported||0)+' importadas, '+(payload.summary?.failed||0)+' con error.');})();`;

    try {
      await navigator.clipboard.writeText(connector);
      setError("Conector copiado. Pegalo como URL en un marcador del navegador y ejecutalo dentro de la pantalla Comprobantes recibidos del SRI.");
    } catch {
      setError("No se pudo copiar el conector. Permite acceso al portapapeles e intenta otra vez.");
    }
  };

  const consultSriByAccessKey = async () => {
    const cleanAccessKey = sriAccessKey.replace(/\D/g, "");
    if (cleanAccessKey.length !== 49) {
      setError("La clave de acceso SRI debe tener 49 digitos.");
      return;
    }

    setIsSriSyncing(true);
    setError(null);

    try {
      const response = await fetch("/api/sri/authorization", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accessKey: cleanAccessKey, environment: "production" }),
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.error || "No se pudo consultar el SRI.");
      }

      const rawData = await response.json();
      if (rawData.sriAuthorizationStatus && rawData.sriAuthorizationStatus !== "AUTORIZADO") {
        throw new Error(`SRI: ${rawData.sriAuthorizationStatus}. ${(rawData.notes || []).join(" ")}`);
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
        fileName: `${cleanAccessKey}.xml`,
        source: "SRI_RECEIVED",
        supplier: rawData.supplier || "Desconocido",
        supplierRuc: rawData.supplierRuc || "",
        invoiceNumber: rawData.invoiceNumber || "",
        invoiceDate: rawData.invoiceDate || "",
        accessKey: cleanAccessKey,
        authorizationDate: rawData.authorizationDate || "",
        sriReceptionStatus: sriReceptionStatus(sanitizedItems, difference),
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
        throw new Error(payload?.error || "La factura se consulto, pero no se pudo guardar.");
      }

      const savedResult = await saveResponse.json();
      setResults((prev) => [savedResult, ...prev.filter((invoice) => invoice.id !== savedResult.id)]);
      setSriAccessKey("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo consultar el SRI.");
    } finally {
      setIsSriSyncing(false);
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
    let allRows = results.flatMap(invoice => 
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
  }, [results, searchQuery, sortField, sortOrder, columnSearch]);

  const totalInvoiceSum = useMemo(() => 
    roundMoney(filteredRows.reduce((acc, curr) => acc + curr.finalTotalCost, 0)), 
  [filteredRows]);

  const aggResult = useMemo(() => {
    if (filteredRows.length === 0) return 0;
    
    switch (aggType) {
      case "count": return filteredRows.length;
      case "avg": return roundMoney(filteredRows.reduce((acc, curr) => acc + curr.finalTotalCost, 0) / filteredRows.length);
      case "min": return Math.min(...filteredRows.map(r => r.finalTotalCost));
      case "max": return Math.max(...filteredRows.map(r => r.finalTotalCost));
      case "sum":
      default:
        return roundMoney(filteredRows.reduce((acc, curr) => acc + curr.finalTotalCost, 0));
    }
  }, [filteredRows, aggType]);

  const aggLabel = useMemo(() => {
    switch (aggType) {
      case "count": return "Número de elementos";
      case "avg": return "Promedio";
      case "min": return "Mínimo";
      case "max": return "Máximo";
      case "sum":
      default:
        return "Suma Total";
    }
  }, [aggType]);

  const sriInvoices = useMemo(
    () => results.filter((invoice) => invoice.source === "SRI_RECEIVED" || invoice.fileName.toLowerCase().endsWith(".xml")),
    [results],
  );

  const sriReady = sriInvoices.filter((invoice) => invoice.sriReceptionStatus === "Listo para ingresar").length;
  const sriPending = sriInvoices.length - sriReady;
  const sriTotal = roundMoney(sriInvoices.reduce((acc, invoice) => acc + invoice.invoiceTotalPaid, 0));
  const sriUnmappedItems = sriInvoices.reduce(
    (acc, invoice) => acc + invoice.items.filter((item) => !item.barcode).length,
    0,
  );

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

      setSelectedFile(null);
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
                accept="image/*,.pdf,.xml,text/xml,application/xml"
              />
              <div className="bg-slate-800 p-4 rounded-full mb-4 group-hover:scale-110 transition-transform">
                <Upload className="h-6 w-6 text-cyan-400" />
              </div>
              <p className="font-black text-slate-200 text-sm uppercase tracking-wide">Subir comprobantes</p>
              <p className="text-[10px] text-slate-500 mt-1 uppercase font-bold tracking-tight">
                Fotos, capturas, PDF o <span className="text-cyan-500 underline decoration-cyan-500/30 underline-offset-2">Pega una imagen (Ctrl+V o Click derecho)</span>
              </p>
              
              {selectedFile && (
                <div className="mt-6 flex items-center gap-2 rounded-lg bg-cyan-500/10 px-3 py-2 text-[10px] text-cyan-400 font-black border border-cyan-500/20 shadow-[0_0_15px_rgba(34,211,238,0.1)]">
                  <FileText className="h-3.5 w-3.5" />
                  <span className="truncate max-w-[150px]">{selectedFile.name}</span>
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
                onClick={processFile}
                disabled={!selectedFile || isLoading}
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
                  <div className="text-[10px] font-black uppercase tracking-[0.3em] text-cyan-500">Recepcion SRI</div>
                  <h2 className="text-lg font-black uppercase tracking-tight text-white">Facturas recibidas</h2>
                </div>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-[10px] font-black uppercase">
                  <div className="rounded-lg border border-slate-800 bg-slate-950 px-3 py-2">
                    <span className="block text-slate-600">XML</span>
                    <strong className="text-slate-200">{sriInvoices.length}</strong>
                  </div>
                  <div className="rounded-lg border border-green-500/20 bg-green-500/10 px-3 py-2">
                    <span className="block text-green-600">Listas</span>
                    <strong className="text-green-400">{sriReady}</strong>
                  </div>
                  <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2">
                    <span className="block text-amber-600">Mapeo</span>
                    <strong className="text-amber-400">{sriPending}</strong>
                  </div>
                  <div className="rounded-lg border border-cyan-500/20 bg-cyan-500/10 px-3 py-2">
                    <span className="block text-cyan-600">Total</span>
                    <strong className="text-cyan-400">${sriTotal.toFixed(2)}</strong>
                  </div>
                </div>
              </div>

              <div className="grid gap-2 md:grid-cols-4">
                {["Consultar SRI", "Validar XML", "Mapear productos", "Ingresar compra"].map((step, index) => (
                  <div key={step} className="flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-900/50 px-3 py-2">
                    <div className={`flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-black ${index < 2 ? "bg-cyan-500/20 text-cyan-400" : "bg-slate-800 text-slate-500"}`}>
                      {index + 1}
                    </div>
                    <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">{step}</span>
                  </div>
                ))}
              </div>

              <div className="grid gap-3 rounded-xl border border-slate-800 bg-slate-950/40 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-2">
                    <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border ${sriSession ? "border-green-500/30 bg-green-500/10 text-green-400" : "border-slate-800 bg-slate-900 text-slate-500"}`}>
                      {sriSession ? <ShieldCheck className="h-4 w-4" /> : <KeyRound className="h-4 w-4" />}
                    </div>
                    <div className="min-w-0">
                      <div className="text-[10px] font-black uppercase tracking-[0.25em] text-slate-500">Sesion SRI</div>
                      <div className="truncate text-xs font-black uppercase text-slate-200">
                        {sriSession ? `${sriSession.ruc} conectado` : "Conecta tu usuario SRI"}
                      </div>
                    </div>
                  </div>
                  {sriSession && (
                    <button
                      onClick={logoutSri}
                      className="flex h-9 w-9 items-center justify-center rounded-lg border border-slate-800 bg-slate-900 text-slate-500 transition hover:text-red-300"
                      title="Cerrar sesion SRI"
                    >
                      <LogOut className="h-4 w-4" />
                    </button>
                  )}
                </div>

                {!sriSession ? (
                  <div className="grid gap-2 md:grid-cols-[1fr_1fr_1fr_auto]">
                    <input
                      value={sriRuc}
                      onChange={(event) => {
                        const value = event.target.value.replace(/\D/g, "").slice(0, 13);
                        setSriRuc(value);
                        if (!sriUsername || sriUsername === sriRuc) setSriUsername(value);
                      }}
                      inputMode="numeric"
                      maxLength={13}
                      placeholder="RUC"
                      className="rounded-lg border border-slate-800 bg-slate-950 px-3 py-3 font-mono text-[11px] font-bold text-slate-200 outline-none transition focus:border-cyan-500/40 placeholder:text-slate-700"
                    />
                    <input
                      value={sriUsername}
                      onChange={(event) => setSriUsername(event.target.value.replace(/\D/g, "").slice(0, 13))}
                      inputMode="numeric"
                      maxLength={13}
                      placeholder="USUARIO SRI"
                      className="rounded-lg border border-slate-800 bg-slate-950 px-3 py-3 font-mono text-[11px] font-bold text-slate-200 outline-none transition focus:border-cyan-500/40 placeholder:text-slate-700"
                    />
                    <input
                      value={sriPassword}
                      onChange={(event) => setSriPassword(event.target.value)}
                      type="password"
                      placeholder="CLAVE SRI"
                      className="rounded-lg border border-slate-800 bg-slate-950 px-3 py-3 text-[11px] font-bold text-slate-200 outline-none transition focus:border-cyan-500/40 placeholder:text-slate-700"
                    />
                    <button
                      onClick={loginSri}
                      disabled={isSriLoggingIn}
                      className="flex items-center justify-center gap-2 rounded-lg bg-green-600 px-4 py-3 text-[10px] font-black uppercase tracking-widest text-white transition hover:bg-green-500 disabled:opacity-40"
                    >
                      {isSriLoggingIn ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <LogIn className="h-3.5 w-3.5" />}
                      Conectar
                    </button>
                  </div>
                ) : (
                  <div className="grid gap-3">
                    <div className="grid gap-2 md:grid-cols-[0.8fr_0.9fr_0.9fr_1.4fr_auto]">
                      <select
                        value={sriPeriodYear}
                        onChange={(event) => setSriPeriodYear(event.target.value)}
                        className="rounded-lg border border-slate-800 bg-slate-950 px-3 py-3 text-[11px] font-black uppercase text-slate-200 outline-none transition focus:border-cyan-500/40"
                      >
                        {Array.from({ length: 8 }, (_, index) => new Date().getFullYear() - index).map((year) => (
                          <option key={year} value={year}>{year}</option>
                        ))}
                      </select>
                      <select
                        value={sriPeriodMonth}
                        onChange={(event) => setSriPeriodMonth(event.target.value)}
                        className="rounded-lg border border-slate-800 bg-slate-950 px-3 py-3 text-[11px] font-black uppercase text-slate-200 outline-none transition focus:border-cyan-500/40"
                      >
                        {[
                          ["01", "Enero"], ["02", "Febrero"], ["03", "Marzo"], ["04", "Abril"],
                          ["05", "Mayo"], ["06", "Junio"], ["07", "Julio"], ["08", "Agosto"],
                          ["09", "Septiembre"], ["10", "Octubre"], ["11", "Noviembre"], ["12", "Diciembre"],
                        ].map(([value, label]) => (
                          <option key={value} value={value}>{label}</option>
                        ))}
                      </select>
                      <select
                        value={sriPeriodDay}
                        onChange={(event) => setSriPeriodDay(event.target.value)}
                        className="rounded-lg border border-slate-800 bg-slate-950 px-3 py-3 text-[11px] font-black uppercase text-slate-200 outline-none transition focus:border-cyan-500/40"
                      >
                        <option value="0">Todo el mes</option>
                        {Array.from({ length: 31 }, (_, index) => String(index + 1)).map((day) => (
                          <option key={day} value={day}>{`Dia ${day}`}</option>
                        ))}
                      </select>
                      <select
                        value={sriVoucherType}
                        onChange={(event) => setSriVoucherType(event.target.value as SriVoucherType)}
                        className="rounded-lg border border-slate-800 bg-slate-950 px-3 py-3 text-[11px] font-black uppercase text-slate-200 outline-none transition focus:border-cyan-500/40"
                      >
                        <option value="0">Factura</option>
                        <option value="1">Todos</option>
                        <option value="2">Liquidacion compra</option>
                        <option value="3">Nota credito</option>
                        <option value="4">Nota debito</option>
                        <option value="6">Retencion</option>
                      </select>
                      <button
                        onClick={importSriPeriod}
                        disabled={isSriPeriodImporting}
                        className="flex items-center justify-center gap-2 rounded-lg bg-cyan-600 px-4 py-3 text-[10px] font-black uppercase tracking-widest text-white transition hover:bg-cyan-500 disabled:opacity-40"
                      >
                        {isSriPeriodImporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CalendarDays className="h-3.5 w-3.5" />}
                        {isSriPeriodImporting ? "Importando..." : "Importar periodo"}
                      </button>
                    </div>
                    <div className="flex items-center justify-between gap-3 rounded-lg border border-slate-800 bg-slate-950/70 px-3 py-2">
                      <span className="text-[10px] font-bold uppercase tracking-widest text-slate-600">
                        {sriBulkSummary
                          ? `${sriBulkSummary.imported}/${sriBulkSummary.requested} importados, ${sriBulkSummary.failed} con error`
                          : "Importacion directa de comprobantes recibidos por periodo SRI"}
                      </span>
                      <RefreshCw className="h-3.5 w-3.5 shrink-0 text-slate-600" />
                    </div>
                    <button
                      onClick={copySriBrowserConnector}
                      className="flex items-center justify-center gap-2 rounded-lg border border-slate-700 bg-slate-900 px-4 py-3 text-[10px] font-black uppercase tracking-widest text-slate-300 transition hover:border-cyan-500/40 hover:text-cyan-300"
                    >
                      <Copy className="h-3.5 w-3.5" />
                      Copiar conector navegador SRI
                    </button>
                  </div>
                )}
              </div>

              <div className="grid gap-2 md:grid-cols-[1fr_auto]">
                <input
                  value={sriAccessKey}
                  onChange={(event) => setSriAccessKey(event.target.value)}
                  inputMode="numeric"
                  maxLength={60}
                  placeholder="CLAVE DE ACCESO SRI (49 DIGITOS)"
                  className="rounded-xl border border-slate-800 bg-slate-950/70 px-4 py-3 font-mono text-[11px] font-bold tracking-wider text-slate-200 outline-none transition focus:border-cyan-500/40 placeholder:text-slate-700"
                />
                <button
                  onClick={consultSriByAccessKey}
                  disabled={isSriSyncing}
                  className="rounded-xl bg-cyan-600 px-5 py-3 text-[10px] font-black uppercase tracking-widest text-white transition hover:bg-cyan-500 disabled:opacity-40"
                >
                  {isSriSyncing ? "Consultando..." : "Consultar SRI"}
                </button>
              </div>

              <div className="rounded-xl border border-slate-800 overflow-hidden">
                <div className="grid grid-cols-[1.2fr_1fr_0.8fr_0.8fr] gap-2 bg-slate-950 px-4 py-2 text-[9px] font-black uppercase tracking-widest text-slate-600">
                  <span>Proveedor</span>
                  <span>Clave acceso</span>
                  <span>Estado</span>
                  <span className="text-right">Total</span>
                </div>
                <div className="max-h-52 overflow-auto custom-scrollbar divide-y divide-slate-800">
                  {sriInvoices.length === 0 ? (
                    <div className="px-4 py-8 text-center text-[10px] font-black uppercase tracking-widest text-slate-700">
                      Sube XML autorizados del SRI para alimentar este modulo
                    </div>
                  ) : (
                    sriInvoices.slice(0, 6).map((invoice) => (
                      <div key={invoice.id} className="grid grid-cols-[1.2fr_1fr_0.8fr_0.8fr] gap-2 px-4 py-3 text-[11px]">
                        <div>
                          <strong className="block text-slate-200 uppercase">{invoice.supplier || "Proveedor"}</strong>
                          <span className="text-slate-600">{invoice.supplierRuc || invoice.invoiceNumber || "Sin RUC"}</span>
                        </div>
                        <span className="truncate font-mono text-[9px] text-slate-500" title={invoice.accessKey || ""}>
                          {invoice.accessKey || "Pendiente"}
                        </span>
                        <span className={`w-fit rounded-full px-2 py-1 text-[9px] font-black uppercase ${invoice.sriReceptionStatus === "Listo para ingresar" ? "bg-green-500/10 text-green-400" : "bg-amber-500/10 text-amber-400"}`}>
                          {invoice.sriReceptionStatus || "Pendiente mapeo"}
                        </span>
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
                        {filteredRows.reduce((a, b) => a + b.quantity, 0)}
                      </td>
                      <td className="px-6 py-4 text-right text-cyan-500/60 border-r border-slate-800/50 tabular-nums italic">
                        AVG: ${(filteredRows.reduce((a, b) => a + b.finalUnitCost, 0) / filteredRows.length).toFixed(4)}
                      </td>
                      <td 
                        className="px-6 py-4 text-right text-cyan-400 cursor-pointer bg-cyan-950/10 hover:bg-cyan-900/20 transition-colors border-r border-slate-800/50"
                        onClick={(e) => { e.stopPropagation(); setIsAggMenuOpen(!isAggMenuOpen); }}
                      >
                        <div className="flex items-center justify-end gap-2">
                          <Sigma className="h-3 w-3" />
                          <span className="tabular-nums">${aggResult.toFixed(2)}</span>
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
                          { id: "avg", label: "Promedio" },
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
                  {aggType === 'count' ? aggResult : aggResult.toFixed(2)}
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

