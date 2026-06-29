import { createSriSession, deleteSriSession } from "../../lib/sriSession.js";
import { hasRedisConfigured } from "../../lib/store.js";
import type { ApiRequest, ApiResponse } from "../../lib/types.js";

export const config = {
  api: {
    bodyParser: {
      sizeLimit: "1mb",
    },
  },
};

export default async function handler(req: ApiRequest, res: ApiResponse) {
  try {
    if (!hasRedisConfigured()) {
      res.status(503).json({ error: "Configura Redis/Upstash en Vercel para crear sesiones SRI." });
      return;
    }

    if (req.method === "POST") {
      const body = req.body as { ruc?: string; username?: string; password?: string };
      res.status(201).json(await createSriSession(body));
      return;
    }

    if (req.method === "DELETE") {
      const body = req.body as { sessionId?: string };
      if (body.sessionId) await deleteSriSession(body.sessionId);
      res.status(204).end();
      return;
    }

    res.status(405).json({ error: "Metodo no permitido." });
  } catch (error) {
    const message = error instanceof Error ? error.message : "No se pudo iniciar sesion SRI.";
    res.status(500).json({ error: message });
  }
}
