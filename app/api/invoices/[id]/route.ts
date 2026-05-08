import { NextRequest, NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase-admin";

export const runtime = "nodejs";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const db = getAdminDb();
    const invoiceDoc = await db.collection("invoices").doc(id).get();

    if (!invoiceDoc.exists) {
      return NextResponse.json({ error: "Factura no encontrada." }, { status: 404 });
    }

    const itemsSnapshot = await db
      .collection("invoices")
      .doc(id)
      .collection("items")
      .orderBy("lineIndex", "asc")
      .get();

    const invoiceData = invoiceDoc.data() || {};
    return NextResponse.json({
      invoice: {
        id: invoiceDoc.id,
        ...invoiceData,
        createdAt: invoiceData.createdAt?.toDate?.()?.toISOString?.() || null,
        items: itemsSnapshot.docs.map((doc) => {
          const item = doc.data();
          return {
            id: doc.id,
            barcode: item.barcode || "",
            product: item.product || "",
            quantity: item.quantity || 0,
            finalUnitCost: item.finalUnitCost || 0,
            finalTotalCost: item.finalTotalCost || 0,
            taxCategory: item.taxCategory || "UNKNOWN",
            confidence: item.confidence || 0,
            lineIndex: item.lineIndex || 0,
          };
        }),
      },
    });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: "No se pudo cargar la factura." }, { status: 500 });
  }
}
