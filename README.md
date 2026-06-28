# Facturas AI

App Vite/React desplegable en Vercel para leer facturas con Gemini y compartir el historial entre diferentes PCs.

## Vercel

Configura estas variables en Vercel Project Settings > Environment Variables:

- `GEMINI_API_KEY`
- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`
- `GEMINI_MODEL` opcional

El historial compartido se guarda en Redis/Upstash desde las funciones serverless de `api/`. No se guarda en el navegador ni en archivos locales.

## Recepcion SRI

El modulo SRI permite:

- Subir XML autorizados del SRI.
- Consultar un comprobante autorizado por clave de acceso de 49 digitos.
- Guardar proveedor, RUC, clave de acceso, fecha de autorizacion, productos y estado de mapeo.

La consulta usa el servicio oficial de autorizacion por clave de acceso. No automatiza el portal web del SRI ni intenta saltar captcha.

## Desarrollo

```bash
npm install
npm run dev
```

`npm run dev` usa `npx vercel dev` para probar las rutas serverless igual que en Vercel.

## Build

```bash
npm run build
```
