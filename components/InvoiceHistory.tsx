"use client";

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

export function InvoiceHistory({
  invoices,
  onOpen,
}: {
  invoices: InvoiceSummary[];
  onOpen: (invoiceId: string) => void;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-bold text-slate-900">Historial</h2>
        <span className="text-xs text-slate-500">{invoices.length}</span>
      </div>

      <div className="max-h-[48vh] space-y-2 overflow-auto">
        {invoices.length === 0 && (
          <p className="rounded-xl bg-slate-50 p-3 text-xs text-slate-500">
            Todavía no hay comprobantes guardados.
          </p>
        )}

        {invoices.map((invoice) => (
          <button
            key={invoice.id}
            onClick={() => onOpen(invoice.id)}
            className="w-full rounded-xl border border-slate-100 p-3 text-left hover:bg-slate-50"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate text-xs font-semibold text-slate-900">
                  {invoice.supplier || invoice.fileName || "Comprobante"}
                </p>
                <p className="truncate text-[11px] text-slate-500">
                  {invoice.invoiceNumber || invoice.fileName}
                </p>
              </div>
              <span
                className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                  invoice.status === "OK"
                    ? "bg-emerald-50 text-emerald-700"
                    : "bg-amber-50 text-amber-700"
                }`}
              >
                {invoice.status || "REVIEW"}
              </span>
            </div>
            <div className="mt-2 flex items-center justify-between text-xs">
              <span className="text-slate-500">{invoice.itemCount || 0} productos</span>
              <span className="font-bold text-blue-700">
                ${(invoice.invoiceTotalPaid || 0).toFixed(2)}
              </span>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
