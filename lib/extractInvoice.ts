import { GoogleGenAI, Type } from "@google/genai";

type ExtractInvoiceInput = {
  fileName?: string;
  mimeType?: string;
  data?: string;
  xmlText?: string;
};

type SriXmlItem = {
  barcode: string;
  product: string;
  quantity: number;
  finalUnitCost: number;
  finalTotalCost: number;
  taxCategory: "IVA_15" | "IVA_0" | "UNKNOWN";
};

const extractionPrompt = `
Eres un extractor experto de comprobantes, tickets y facturas de Ecuador. Tu mision es la precision absoluta.

INSTRUCCIONES CRITICAS:
1. DETECCION DE IVA: Mapea cada producto a 'IVA_15' (si es gravado) o 'IVA_0' (si no lo es).
   - Busca indicadores como asteriscos (*), la letra 'G', o columnas marcadas como 'IVA' o '%'.
   - Si un producto es procesado, enlatado o un servicio, usualmente lleva IVA_15.
   - Si es un alimento basico, medicina o libros, usualmente es IVA_0.
2. COSTO FINAL: El 'finalTotalCost' DEBE ser el valor total por esa linea INCLUYENDO IVA y descontando cualquier rebaja.
3. CONCORDANCIA: No inventes ajustes para cuadrar. Si la suma no coincide, deja una nota explicando la diferencia probable.
4. FORMATO: Devuelve exclusivamente el JSON siguiendo el esquema.
5. CODIGOS: Busca codigos numericos de 7, 8 o 13 digitos junto al producto. Si no existe un codigo claro, deja "".
6. SRI: Si el documento es XML autorizado del SRI, extrae tambien supplierRuc, accessKey y authorizationDate.
`;

function decodeXmlEntities(value: string) {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function tagValue(xml: string, tag: string) {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return decodeXmlEntities(match?.[1]?.trim() || "");
}

function tagValues(xml: string, tag: string) {
  return [...xml.matchAll(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi"))].map((match) =>
    decodeXmlEntities(match[1]?.trim() || ""),
  );
}

function numberValue(value: string) {
  const normalized = value.replace(",", ".").replace(/[^\d.-]/g, "");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function roundMoney(value: number) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function normalizeDate(value: string) {
  const trimmed = value.trim();
  const dateMatch = trimmed.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (dateMatch) return `${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}`;
  return trimmed;
}

function innerComprobanteXml(xmlText: string) {
  const comprobante = tagValue(xmlText, "comprobante");
  if (!comprobante) return xmlText;
  return decodeXmlEntities(comprobante.replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "").trim());
}

function extractBlocks(xml: string, tag: string) {
  return [...xml.matchAll(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi"))].map((match) => match[1] || "");
}

function extractSriXmlInvoice(xmlText: string) {
  const rawXml = decodeXmlEntities(xmlText);
  const invoiceXml = innerComprobanteXml(rawXml);
  const detailBlocks = extractBlocks(invoiceXml, "detalle");

  if (!/<factura[\s>]/i.test(invoiceXml) || detailBlocks.length === 0) {
    return null;
  }

  const accessKey = tagValue(invoiceXml, "claveAcceso") || tagValue(rawXml, "numeroAutorizacion");
  const invoiceNumber = [tagValue(invoiceXml, "estab"), tagValue(invoiceXml, "ptoEmi"), tagValue(invoiceXml, "secuencial")]
    .filter(Boolean)
    .join("-");
  const authorizationDate = normalizeDate(tagValue(rawXml, "fechaAutorizacion"));

  const items: SriXmlItem[] = detailBlocks
    .map((detail) => {
      const quantity = Math.max(numberValue(tagValue(detail, "cantidad")), 1);
      const subtotal = numberValue(tagValue(detail, "precioTotalSinImpuesto"));
      const taxTotal = extractBlocks(detail, "impuesto").reduce((acc, tax) => acc + numberValue(tagValue(tax, "valor")), 0);
      const finalTotalCost = roundMoney(subtotal + taxTotal);
      const taxPercentCodes = tagValues(detail, "codigoPorcentaje");
      const barcode = tagValue(detail, "codigoPrincipal") || tagValue(detail, "codigoAuxiliar");
      const product = tagValue(detail, "descripcion");

      if (!product || finalTotalCost < 0) return null;

      return {
        barcode,
        product,
        quantity,
        finalUnitCost: roundMoney(finalTotalCost / quantity),
        finalTotalCost,
        taxCategory: taxPercentCodes.includes("0") && !taxPercentCodes.some((code) => code !== "0") ? "IVA_0" : "IVA_15",
      };
    })
    .filter((item): item is SriXmlItem => item !== null);

  return {
    supplier: tagValue(invoiceXml, "razonSocial") || tagValue(invoiceXml, "nombreComercial") || "Desconocido",
    supplierRuc: tagValue(invoiceXml, "ruc"),
    invoiceNumber,
    invoiceDate: normalizeDate(tagValue(invoiceXml, "fechaEmision")),
    accessKey,
    authorizationDate,
    invoiceTotalPaid: roundMoney(numberValue(tagValue(invoiceXml, "importeTotal"))),
    currency: "USD",
    items,
    notes: ["XML SRI leido directamente sin usar Gemini."],
  };
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTemporaryAiError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /503|UNAVAILABLE|high demand|overloaded|temporar/i.test(message);
}

export async function extractInvoice(input: ExtractInvoiceInput) {
  const isXml =
    Boolean(input.xmlText) ||
    input.fileName?.toLowerCase().endsWith(".xml") ||
    input.mimeType?.includes("xml");

  if (isXml && !input.xmlText) {
    throw new Error("El XML no contiene texto para analizar.");
  }
  if (!isXml && !input.data) {
    throw new Error("El archivo no contiene datos para analizar.");
  }

  if (isXml && input.xmlText) {
    const xmlResult = extractSriXmlInvoice(input.xmlText);
    if (xmlResult) return xmlResult;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("Falta configurar GEMINI_API_KEY en Vercel.");
  }

  const ai = new GoogleGenAI({ apiKey });
  const contents = [
    { text: extractionPrompt },
    isXml
      ? { text: `CONTENIDO XML FACTURA ELECTRONICA ECUADOR:\n\n${input.xmlText}` }
      : {
          inlineData: {
            mimeType: input.mimeType || "image/jpeg",
            data: input.data,
          },
        },
  ];

  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await ai.models.generateContent({
        model: process.env.GEMINI_MODEL || "gemini-3-flash-preview",
        contents,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              supplier: { type: Type.STRING },
              supplierRuc: { type: Type.STRING },
              invoiceNumber: { type: Type.STRING },
              invoiceDate: { type: Type.STRING },
              accessKey: { type: Type.STRING },
              authorizationDate: { type: Type.STRING },
              invoiceTotalPaid: { type: Type.NUMBER },
              currency: { type: Type.STRING },
              items: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    barcode: { type: Type.STRING },
                    product: { type: Type.STRING },
                    quantity: { type: Type.NUMBER },
                    finalUnitCost: { type: Type.NUMBER },
                    finalTotalCost: { type: Type.NUMBER },
                    taxCategory: { type: Type.STRING, enum: ["IVA_15", "IVA_0", "UNKNOWN"] },
                  },
                  required: ["product", "quantity", "finalUnitCost", "finalTotalCost"],
                },
              },
              notes: { type: Type.ARRAY, items: { type: Type.STRING } },
            },
            required: ["invoiceTotalPaid", "items"],
          },
        },
      });

      return JSON.parse(response.text || "{}");
    } catch (error) {
      lastError = error;
      if (!isTemporaryAiError(error) || attempt === 2) break;
      await wait(800 * (attempt + 1));
    }
  }

  if (isTemporaryAiError(lastError)) {
    throw new Error("Gemini esta temporalmente saturado. Intenta otra vez en unos segundos o sube el XML original del SRI.");
  }

  throw lastError;
}
