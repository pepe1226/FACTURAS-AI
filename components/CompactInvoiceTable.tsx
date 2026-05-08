"use client";

import { useMemo, useState } from "react";
import type { InvoiceItem } from "@/lib/invoice-schema";
import { roundMoney, sumItems } from "@/lib/invoice-calculator";

type Row = InvoiceItem & { sourceFile?: string };

export function CompactInvoiceTable({ rows }: { rows: Row[] }) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim();
    if (!q) return rows;
    return rows.filter((row) =>
      [row.barcode, row.product, row.sourceFile]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(q))
    );
  }, [rows, query]);

  const total = sumItems(filtered);

  function exportCsv() {
    const header = ["Codigo", "Producto", "Cantidad", "Unitario", "Total"];
    const body = filtered.map((r) => [
      r.barcode || "",
      r.product,
      r.quantity,
      r.finalUnitCost.toFixed(2),
      r.finalTotalCost.toFixed(2)
    ]);

    const csv = [header, ...body]
      .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
      .join("\n");

    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "productos_factura.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="flex items-center gap-3 border-b border-slate-200 p-3">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Buscar producto o código"
          className="h-9 flex-1 rounded-lg border border-slate-200 px-3 text-sm outline-none focus:border-blue-500"
        />
        <button
          onClick={exportCsv}
          disabled={!filtered.length}
          className="h-9 rounded-lg border border-slate-200 px-3 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-40"
        >
          Exportar
        </button>
      </div>

      <div className="max-h-[68vh] overflow-auto">
        <table className="w-full border-collapse text-sm">
          <thead className="sticky top-0 bg-slate-50 text-xs uppercase text-slate-500">
            <tr>
              <th className="px-3 py-2 text-left font-semibold">Código</th>
              <th className="px-3 py-2 text-left font-semibold">Producto</th>
              <th className="px-3 py-2 text-right font-semibold">Cant</th>
              <th className="px-3 py-2 text-right font-semibold">Unit</th>
              <th className="px-3 py-2 text-right font-semibold">Total</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-16 text-center text-sm text-slate-400">
                  Sube comprobantes para ver productos.
                </td>
              </tr>
            )}

            {filtered.map((item, index) => (
              <tr key={`${item.barcode}-${item.product}-${index}`} className="border-t border-slate-100 hover:bg-slate-50">
                <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-slate-600">
                  {item.barcode || "—"}
                </td>
                <td className="max-w-[420px] truncate px-3 py-2 font-medium text-slate-900" title={item.product}>
                  {item.product}
                </td>
                <td className="px-3 py-2 text-right text-slate-700">{item.quantity}</td>
                <td className="px-3 py-2 text-right text-slate-700">${roundMoney(item.finalUnitCost).toFixed(2)}</td>
                <td className="px-3 py-2 text-right font-semibold text-slate-900">${roundMoney(item.finalTotalCost).toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between border-t border-slate-200 bg-white p-3">
        <span className="text-sm text-blue-600">{filtered.length} productos</span>
        <div className="text-right">
          <span className="mr-3 text-xs font-bold uppercase text-slate-500">Total factura pagada</span>
          <span className="text-2xl font-bold text-blue-700">${total.toFixed(2)}</span>
        </div>
      </div>
    </div>
  );
}
