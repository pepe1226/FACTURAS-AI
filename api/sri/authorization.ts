import { consultSriAuthorization } from "../../lib/sriAuthorization.js";
import type { ApiRequest, ApiResponse } from "../../lib/types.js";

export const config = {
  api: {
    bodyParser: {
      sizeLimit: "2mb",
    },
  },
};

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Metodo no permitido." });
    return;
  }

  try {
    const body = req.body as { accessKey?: string; environment?: "production" | "test" };
    const result = await consultSriAuthorization({
      accessKey: body.accessKey || "",
      environment: body.environment || "production",
    });
    res.status(200).json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "No se pudo consultar el SRI.";
    res.status(500).json({ error: message });
  }
}
