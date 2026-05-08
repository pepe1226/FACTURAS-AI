import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase-admin";

export const runtime = "nodejs";

export async function GET() {
  try {
    const db = getAdminDb();
    const snapshot = await db
      .collection("invoices")
      .orderBy("createdAt", "desc")
      .limit(50)
      .get();

    const invoices = snapshot.docs.map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        ...data,
        createdAt: data.createdAt?.toDate?.()?.toISOString?.() || null,
      };
    });

    return NextResponse.json({ invoices });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: "No se pudo cargar el historial." }, { status: 500 });
  }
}
