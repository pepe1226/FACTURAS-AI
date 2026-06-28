import { GoogleGenAI, Type } from "@google/genai";

type ExtractInvoiceInput = {
  fileName?: string;
  mimeType?: string;
  data?: string;
  xmlText?: string;
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

export async function extractInvoice(input: ExtractInvoiceInput) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("Falta configurar GEMINI_API_KEY en Vercel.");
  }

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
}
