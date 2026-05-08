import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Facturas AI",
  description: "Extrae productos de comprobantes y calcula costo final por producto"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
