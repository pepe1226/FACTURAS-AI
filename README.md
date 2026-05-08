# Facturas AI + Firebase

App Next.js para subir fotos, capturas, PDF o XML de comprobantes, procesarlos con IA y guardar el resultado en Firebase.

## Qué hace

- Carga múltiple de comprobantes.
- Procesamiento con Gemini.
- Interpretación de productos, cantidad, código, costo unitario final y costo total final.
- Cuadre automático contra el total pagado de la factura.
- Guarda archivo original en Firebase Storage.
- Guarda factura y productos en Firestore.
- Historial visible desde cualquier computadora.
- Exportación CSV.

## Instalación local

```bash
npm install
cp .env.example .env.local
npm run dev
```

Abrir:

```text
http://localhost:3000
```

## Variables necesarias

```env
GOOGLE_GEMINI_API_KEY=TU_API_KEY_DE_GEMINI
FIREBASE_PROJECT_ID=tu-project-id
FIREBASE_CLIENT_EMAIL=firebase-adminsdk-xxxxx@tu-project-id.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nTU_PRIVATE_KEY\n-----END PRIVATE KEY-----\n"
FIREBASE_STORAGE_BUCKET=tu-project-id.appspot.com
NEXT_PUBLIC_APP_NAME=Facturas AI
```

## Firebase

Crear en Firebase:

1. Firestore Database.
2. Storage.
3. Service Account desde Project Settings > Service accounts > Generate new private key.

Usa los datos del JSON de la service account para llenar las variables de entorno.

## Vercel

1. Subir el proyecto a GitHub.
2. Importar el repositorio en Vercel.
3. Agregar las variables de entorno.
4. Deploy.

## Colecciones Firestore

```text
invoices/{invoiceId}
invoices/{invoiceId}/items/{itemId}
```

## Importante

La IA puede equivocarse con fotos borrosas o comprobantes mal impresos. Por eso cada factura queda con estado OK o REVIEW.
