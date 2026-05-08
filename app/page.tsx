"use client";

import { useEffect, useMemo, useState } from "react";
import { UploadBox } from "@/components/UploadBox";
import { CompactInvoiceTable } from "@/components/CompactInvoiceTable";
import { InvoiceHistory } from "@/components/InvoiceHistory";
import type { InvoiceItem } from "@/lib/invoice-schema";

type Row = InvoiceItem & { sourceFile?: string };

type InvoiceSummary = {
  id: string;
  fileName: string;
  supplier?: string;
  invoiceNumber?: string;
  invoiceTotalPaid?: number;
  itemCount?: number;
  status?: string;
  createdAt?: string | null;
};

export default function HomePage() {
  const [response, setResponse] = useState<any>(null);
  const [history, setHistory] = useState<InvoiceSummary[]>([]);
  const [selectedTitle, setSelectedTitle] = useState("Productos detectados");

  async function loadHistory() {
    const res = await fetch("/api/invoices", { cache: "no-store" });
    const data = await res.json();
    setHistory(data.invoices || []);
  }

  async function openInvoice(invoiceId: string) {
    const res = await fetch(`/api/invoices/${invoiceId}`, { cache: "no-store" });
    const data = await res.json();
    if (!data.invoice) return;
    setSelectedTitle(data.invoice.supplier || data.invoice.fileName || "Comprobante");
    setResponse({ results: [data.invoice] });
  }

  useEffect(() => {
    loadHistory().catch(console.error);
  }, []);

  const rows: Row[] = useMemo(() => {
    if (!response?.results) return [];
    return response.results.flatMap((invoice: any) =>
      Array.isArray(invoice.items)
        ? invoice.items.map((item: InvoiceItem) => ({ ...item, sourceFile: invoice.fileName }))
        : []
    );
  }, [response]);

  return (
    <main className="min-h-screen bg-slate-50 p-4 text-slate-900 md:p-6">
      <div className="mx-auto max-w-7xl space-y-4">
        <header className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold tracking-tight">Facturas AI</h1>
            <p className="text-sm text-slate-500">Costo final por producto, guardado en Firebase</p>
          </div>
        </header>

        <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
          <div className="space-y-4">
            <UploadBox
              onProcessed={(data) => {
                setSelectedTitle("Productos detectados");
                setResponse(data);
                loadHistory().catch(console.error);
              }}
            />
            <InvoiceHistory invoices={history} onOpen={openInvoice} />
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between px-1">
              <h2 className="text-sm font-bold text-slate-800">{selectedTitle}</h2>
            </div>
            <CompactInvoiceTable rows={rows} />
          </div>
        </div>

        {response?.results?.some((r: any) => r.status === "REVIEW" || r.error) && (
          <div className="rounded-2xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            Hay comprobantes que requieren revisión manual. Revisa totales, productos y códigos detectados.
          </div>
        )}
      </div>
    </main>
  );
}
