"use client";

import { useRef, useState } from "react";

export function UploadBox({ onProcessed }: { onProcessed: (data: any) => void }) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  function addFiles(list: FileList | null) {
    if (!list) return;
    setError("");
    setFiles((prev) => [...prev, ...Array.from(list)]);
  }

  function clearFiles() {
    setFiles([]);
    setError("");
  }

  async function processFiles() {
    if (!files.length) return;
    setLoading(true);
    setError("");

    try {
      const formData = new FormData();
      files.forEach((file) => formData.append("files", file));

      const res = await fetch("/api/process-invoice", {
        method: "POST",
        body: formData
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Error al procesar archivos.");
      onProcessed(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error inesperado.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div
        onClick={() => inputRef.current?.click()}
        onDrop={(e) => {
          e.preventDefault();
          addFiles(e.dataTransfer.files);
        }}
        onDragOver={(e) => e.preventDefault()}
        className="cursor-pointer rounded-xl border border-dashed border-slate-300 bg-slate-50 p-6 text-center hover:bg-slate-100"
      >
        <input
          ref={inputRef}
          type="file"
          multiple
          accept="image/*,.pdf,.xml,text/xml,application/pdf"
          className="hidden"
          onChange={(e) => addFiles(e.target.files)}
        />
        <p className="text-sm font-semibold text-slate-900">Subir comprobantes</p>
        <p className="mt-1 text-xs text-slate-500">Fotos, capturas, PDF o XML</p>
      </div>

      {files.length > 0 && (
        <div className="mt-3 space-y-1 text-xs text-slate-600">
          {files.map((file, index) => (
            <div key={`${file.name}-${index}`} className="flex justify-between gap-3 rounded-lg bg-slate-50 px-3 py-2">
              <span className="truncate">{file.name}</span>
              <span className="shrink-0">{(file.size / 1024).toFixed(0)} KB</span>
            </div>
          ))}
        </div>
      )}

      {error && <p className="mt-3 rounded-lg bg-red-50 p-2 text-xs text-red-700">{error}</p>}

      <div className="mt-4 grid grid-cols-2 gap-2">
        <button
          onClick={clearFiles}
          disabled={loading || !files.length}
          className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Limpiar
        </button>
        <button
          onClick={processFiles}
          disabled={!files.length || loading}
          className="rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-300"
        >
          {loading ? "Procesando" : `Procesar ${files.length || ""}`}
        </button>
      </div>
    </div>
  );
}
