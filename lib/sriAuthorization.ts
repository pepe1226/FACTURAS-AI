import { extractInvoice } from "./extractInvoice";

type SriEnvironment = "production" | "test";

type SriAuthorizationInput = {
  accessKey: string;
  environment?: SriEnvironment;
};

function escapeXml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function decodeXmlEntities(value: string) {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function matchTag(xml: string, tag: string) {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match?.[1]?.trim() || "";
}

function extractComprobanteXml(soapXml: string) {
  const rawComprobante = matchTag(soapXml, "comprobante");
  if (!rawComprobante) return "";

  return decodeXmlEntities(rawComprobante.replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "").trim());
}

function authorizationEndpoint(environment: SriEnvironment) {
  return environment === "test"
    ? "https://celcer.sri.gob.ec/comprobantes-electronicos-ws/AutorizacionComprobantesOffline"
    : "https://cel.sri.gob.ec/comprobantes-electronicos-ws/AutorizacionComprobantesOffline";
}

export async function consultSriAuthorization(input: SriAuthorizationInput) {
  const accessKey = input.accessKey.replace(/\D/g, "");
  if (accessKey.length !== 49) {
    throw new Error("La clave de acceso debe tener 49 digitos.");
  }

  const envelope = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ec="http://ec.gob.sri.ws.autorizacion">
  <soapenv:Header/>
  <soapenv:Body>
    <ec:autorizacionComprobante>
      <claveAccesoComprobante>${escapeXml(accessKey)}</claveAccesoComprobante>
    </ec:autorizacionComprobante>
  </soapenv:Body>
</soapenv:Envelope>`;

  const response = await fetch(authorizationEndpoint(input.environment || "production"), {
    method: "POST",
    headers: {
      "Content-Type": "text/xml;charset=UTF-8",
      SOAPAction: "",
    },
    body: envelope,
  });

  if (!response.ok) {
    throw new Error(`SRI respondio HTTP ${response.status}.`);
  }

  const soapXml = await response.text();
  const status = matchTag(soapXml, "estado") || "SIN_RESPUESTA";
  const authorizationDate = matchTag(soapXml, "fechaAutorizacion");
  const comprobanteXml = extractComprobanteXml(soapXml);

  if (status !== "AUTORIZADO" || !comprobanteXml) {
    return {
      accessKey,
      status,
      authorizationDate,
      notes: [matchTag(soapXml, "mensaje") || "El comprobante no consta como autorizado."],
    };
  }

  const extracted = await extractInvoice({
    fileName: `${accessKey}.xml`,
    mimeType: "application/xml",
    xmlText: comprobanteXml,
  });

  return {
    ...extracted,
    accessKey,
    authorizationDate,
    sriAuthorizationStatus: status,
    xmlText: comprobanteXml,
  };
}
