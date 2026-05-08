import { NextRequest, NextResponse } from "next/server";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { v4 as uuidv4 } from "uuid";
import { InvoiceResultSchema } from "@/lib/invoice-schema";
import { validateInvoice, sumItems } from "@/lib/invoice-calculator";
import { admin, getAdminBucket, getAdminDb } from "@/lib/firebase-admin";

export const runtime = "nodejs";

function fileToGenerativePart(buffer: Buffer, mimeType: string) {
  return {
    inlineData: {
      data: buffer.toString("base64"),
      mimeType,
    },
  };
}

const EXTRACTION_PROMPT = `
Eres un extractor experto de comprobantes, tickets y facturas de Ecuador.

El usuario subirá fotos, capturas, PDF o XML.
Debes leer todos los productos y devolver SOLO JSON válido, sin markdown.

La tabla final de la app solo mostrará:
- barcode
- product
- quantity
- finalUnitCost
- finalTotalCost

Reglas críticas:
1. finalTotalCost es el valor final realmente pagado por ese producto.
2. finalUnitCost = finalTotalCost / quantity.
3. La suma de todos los finalTotalCost debe ser igual a invoiceTotalPaid.
4. Si hay descuentos, promociones, redondeos o descuentos globales, repártelos proporcionalmente entre líneas.
5. Si hay IVA, úsalo internamente para interpretar el costo final pagado, pero NO crees columnas visibles de IVA.
6. Interpreta si cada producto en Ecuador probablemente lleva IVA 15%, IVA 0% o UNKNOWN.
7. Si el comprobante ya muestra el total final por producto, úsalo como prioridad.
8. Si no aparece código de barras, usa string vacío.
9. No incluyas líneas que no sean productos reales.
10. Montos con 2 decimales.
11. Si el comprobante tiene varias páginas o varias imágenes de una misma factura, consolida productos.
12. Si hay propina, servicio, donación, bolsa, redondeo u otro cargo, inclúyelo solo si fue parte del total pagado y aparece como línea cobrable.

JSON exacto requerido:
{
  "supplier": "",
  "invoiceNumber": "",
  "invoiceDate": "YYYY-MM-DD o vacío",
  "invoiceTotalPaid": 0,
  "currency": "USD",
  "items": [
    {
      "barcode": "",
      "product": "",
      "quantity": 1,
      "finalUnitCost": 0,
      "finalTotalCost": 0,
      "taxCategory": "IVA_15 | IVA_0 | UNKNOWN",
      "confidence": 0.8
    }
  ],
  "status": "OK | REVIEW",
  "difference": 0,
  "notes": []
}
`;

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const files = formData.getAll("files") as File[];

    if (!files.length) {
      return NextResponse.json({ error: "No se recibieron archivos." }, { status: 400 });
    }

    const apiKey = process.env.GOOGLE_GEMINI_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "Falta GOOGLE_GEMINI_API_KEY en .env.local." }, { status: 500 });
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

    const db = getAdminDb();
    const bucket = getAdminBucket();
    const results = [];

    for (const file of files) {
      const arrayBuffer = await file.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const mimeType = file.type || guessMimeType(file.name);
      const invoiceId = uuidv4();
      const safeFileName = sanitizeFileName(file.name);
      const storagePath = `invoice-uploads/${invoiceId}/${safeFileName}`;

      await bucket.file(storagePath).save(buffer, {
        metadata: { contentType: mimeType },
        resumable: false,
      });

      const [fileUrl] = await bucket.file(storagePath).getSignedUrl({
        action: "read",
        expires: Date.now() + 1000 * 60 * 60 * 24 * 7,
      });

      const response = await model.generateContent([
        EXTRACTION_PROMPT,
        `Archivo: ${file.name}. Tipo MIME: ${mimeType}`,
        fileToGenerativePart(buffer, mimeType),
      ]);

      const rawText = response.response.text();
      const jsonText = rawText.replace(/```json/g, "").replace(/```/g, "").trim();

      let parsed: unknown;
      try {
        parsed = JSON.parse(jsonText);
      } catch {
        const reviewRecord = {
          id: invoiceId,
          fileName: file.name,
          fileUrl,
          storagePath,
          status: "REVIEW",
          error: "La IA no devolvió JSON válido.",
          rawText,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        };
        await db.collection("invoices").doc(invoiceId).set(reviewRecord);
        results.push({
          id: invoiceId,
          fileName: file.name,
          fileUrl,
          storagePath,
          status: "REVIEW",
          error: "La IA no devolvió JSON válido.",
          rawText,
        });
        continue;
      }

      const safe = InvoiceResultSchema.safeParse(parsed);
      if (!safe.success) {
        const reviewRecord = {
          id: invoiceId,
          fileName: file.name,
          fileUrl,
          storagePath,
          status: "REVIEW",
          error: "JSON incompleto o inválido.",
          issues: safe.error.issues,
          raw: parsed,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        };
        await db.collection("invoices").doc(invoiceId).set(reviewRecord);
        results.push({
          id: invoiceId,
          fileName: file.name,
          fileUrl,
          storagePath,
          status: "REVIEW",
          error: "JSON incompleto o inválido.",
          issues: safe.error.issues,
          raw: parsed,
        });
        continue;
      }

      const validated = validateInvoice(safe.data);
      const invoiceTotalByItems = sumItems(validated.items);

      const invoiceRecord = {
        id: invoiceId,
        fileName: file.name,
        fileUrl,
        storagePath,
        supplier: validated.supplier,
        invoiceNumber: validated.invoiceNumber,
        invoiceDate: validated.invoiceDate,
        invoiceTotalPaid: validated.invoiceTotalPaid,
        invoiceTotalByItems,
        currency: validated.currency,
        status: validated.status,
        difference: validated.difference,
        notes: validated.notes,
        itemCount: validated.items.length,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };

      const invoiceRef = db.collection("invoices").doc(invoiceId);
      const batch = db.batch();
      batch.set(invoiceRef, invoiceRecord);
      validated.items.forEach((item, index) => {
        batch.set(invoiceRef.collection("items").doc(String(index + 1).padStart(4, "0")), {
          ...item,
          lineIndex: index,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      });
      await batch.commit();

      results.push({ fileName: file.name, fileUrl, id: invoiceId, ...validated });
    }

    return NextResponse.json({ results });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: "Error procesando comprobante." }, { status: 500 });
  }
}

function guessMimeType(fileName: string): string {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".xml")) return "text/xml";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  return "application/octet-stream";
}

function sanitizeFileName(fileName: string): string {
  return fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
}
