import { createHash } from "crypto";
import { buildSriInvoice } from "./invoiceNormalize.js";
import { consultSriAuthorization } from "./sriAuthorization.js";
import type { InvoiceResult } from "./types.js";

export type SriReceivedPeriodInput = {
  ruc: string;
  username: string;
  password: string;
  year: number;
  month: number;
  day: number;
  voucherType: "1" | "2" | "3" | "4" | "6";
  environment?: "production" | "test";
};

export type SriReceivedPeriodResult = {
  imported: InvoiceResult[];
  failed: { accessKey?: string; error: string }[];
  reportAccessKeys: string[];
};

const receivedPageUrl =
  "https://srienlinea.sri.gob.ec/comprobantes-electronicos-internet/pages/consultas/recibidos/comprobantesRecibidos.jsf";
const tokenUrl = `https://srienlinea.sri.gob.ec/tuportal-internet/GeneraToken.jsp?urlAplicacion=${encodeURIComponent(receivedPageUrl)}`;

type CookieJar = Record<string, string>;

function cookieHeader(jar: CookieJar) {
  return Object.entries(jar)
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

function storeCookies(jar: CookieJar, setCookieHeader: string | null) {
  if (!setCookieHeader) return;

  for (const cookie of setCookieHeader.split(/,(?=\s*[^;,]+=)/)) {
    const [pair] = cookie.trim().split(";");
    const separator = pair.indexOf("=");
    if (separator > 0) {
      jar[pair.slice(0, separator)] = pair.slice(separator + 1);
    }
  }
}

async function sriFetch(url: string, jar: CookieJar, init: RequestInit = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("user-agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36");
  headers.set("accept", headers.get("accept") || "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");
  if (Object.keys(jar).length > 0) headers.set("cookie", cookieHeader(jar));

  const response = await fetch(url, {
    ...init,
    redirect: "manual",
    headers,
  });
  storeCookies(jar, response.headers.get("set-cookie"));
  return response;
}

async function followSriRedirects(url: string, jar: CookieJar, init: RequestInit = {}, limit = 10) {
  let nextUrl = url;
  let response = await sriFetch(nextUrl, jar, init);

  for (let index = 0; index < limit && response.status >= 300 && response.status < 400; index += 1) {
    const location = response.headers.get("location");
    if (!location) break;
    nextUrl = new URL(location, nextUrl).toString();
    response = await sriFetch(nextUrl, jar);
  }

  return response;
}

function decodeHtml(value: string) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function findLoginAction(html: string) {
  const formMatch = html.match(/<form[^>]+id=["']kc-form-login["'][\s\S]*?>/i);
  const actionMatch = formMatch?.[0].match(/action=["']([^"']+)["']/i);
  return actionMatch ? decodeHtml(actionMatch[1]) : "";
}

function hashSriPassword(password: string) {
  const md5 = createHash("md5").update(password, "ascii").digest("hex");
  const sha512 = createHash("sha512").update(password, "ascii").digest("hex");
  return `${md5}${sha512}`;
}

function extractAccessKeys(html: string) {
  return Array.from(new Set(html.match(/\b\d{49}\b/g) || []));
}

function looksLikeLoginFailed(html: string) {
  return /usuario|clave|credenciales|inv[aá]lid|incorrect/i.test(html) && /kc-form-login|login-pf/i.test(html);
}

function looksLikeHumanChallenge(html: string) {
  return /captcha|recaptcha|verificaci[oó]n|c[oó]digo de seguridad/i.test(html);
}

export function validateSriPeriod(input: Partial<SriReceivedPeriodInput>) {
  const year = Number(input.year);
  const month = Number(input.month);
  const day = Number(input.day ?? 0);
  const voucherType = String(input.voucherType || "1") as SriReceivedPeriodInput["voucherType"];
  const currentYear = new Date().getFullYear();

  if (!Number.isInteger(year) || year < 2010 || year > currentYear + 1) {
    throw new Error("Selecciona un anio valido para consultar comprobantes SRI.");
  }

  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error("Selecciona un mes valido para consultar comprobantes SRI.");
  }

  if (!Number.isInteger(day) || day < 0 || day > 31) {
    throw new Error("Selecciona un dia valido o usa Todo el mes.");
  }

  if (!["1", "2", "3", "4", "6"].includes(voucherType)) {
    throw new Error("Selecciona un tipo de comprobante SRI valido.");
  }

  return { year, month, day, voucherType };
}

async function openReceivedPage(input: SriReceivedPeriodInput) {
  const jar: CookieJar = {};
  const loginPageResponse = await followSriRedirects(tokenUrl, jar);
  const loginPageHtml = await loginPageResponse.text();
  const loginAction = findLoginAction(loginPageHtml);

  if (!loginAction) {
    throw new Error("No se pudo abrir el formulario de inicio de sesion del SRI.");
  }

  if (looksLikeHumanChallenge(loginPageHtml)) {
    throw new Error("El SRI solicito una verificacion humana antes de iniciar sesion.");
  }

  const loginBody = new URLSearchParams({
    username: input.username.toUpperCase(),
    usuario: input.ruc.toUpperCase(),
    ciAdicional: input.username !== input.ruc ? input.username : "",
    password: hashSriPassword(input.password),
    login: "Ingresar",
  });

  const loginResponse = await followSriRedirects(loginAction, jar, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: "https://srienlinea.sri.gob.ec",
      referer: tokenUrl,
    },
    body: loginBody,
  });
  const html = await loginResponse.text();

  if (looksLikeHumanChallenge(html)) {
    throw new Error("El SRI solicito captcha o verificacion adicional. No se puede completar automaticamente desde Vercel.");
  }

  if (looksLikeLoginFailed(html)) {
    throw new Error("El SRI no acepto las credenciales ingresadas.");
  }

  return html;
}

export async function importSriReceivedPeriod(
  input: SriReceivedPeriodInput,
): Promise<SriReceivedPeriodResult> {
  validateSriPeriod(input);

  const reportHtml = await openReceivedPage(input);
  const accessKeys = extractAccessKeys(reportHtml);

  if (accessKeys.length === 0) {
    throw new Error(
      "Se inicio sesion en el SRI, pero no se encontraron claves de acceso en la pantalla de comprobantes recibidos. Falta completar el envio del filtro de periodo del formulario JSF del SRI.",
    );
  }

  const imported: InvoiceResult[] = [];
  const failed: { accessKey?: string; error: string }[] = [];

  for (const accessKey of accessKeys) {
    try {
      const rawData = await consultSriAuthorization({
        accessKey,
        environment: input.environment || "production",
      });
      const sriStatus = "sriAuthorizationStatus" in rawData ? rawData.sriAuthorizationStatus : rawData.status;

      if (sriStatus && sriStatus !== "AUTORIZADO") {
        failed.push({
          accessKey,
          error: `SRI: ${sriStatus}. ${(rawData.notes || []).join(" ")}`,
        });
        continue;
      }

      imported.push(buildSriInvoice(rawData as Record<string, unknown>, accessKey));
    } catch (error) {
      failed.push({
        accessKey,
        error: error instanceof Error ? error.message : "No se pudo leer el comprobante.",
      });
    }
  }

  return { imported, failed, reportAccessKeys: accessKeys };
}
