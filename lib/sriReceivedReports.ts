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
  voucherType: "0" | "1" | "2" | "3" | "4" | "6";
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

function extractReceivedTableRows(html: string) {
  const rowIds = [...html.matchAll(/tablaCompRecibidos:(\d+):lnkXml/g)].map((match) => Number(match[1]));
  return Array.from(new Set(rowIds)).filter((index) => Number.isInteger(index) && index >= 0);
}

function htmlAttr(tag: string, name: string) {
  const match = tag.match(new RegExp(`${name}=["']([^"']*)["']`, "i"));
  return match ? decodeHtml(match[1]) : "";
}

function normalizeName(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function parseReceivedForm(html: string) {
  const forms = [...html.matchAll(/<form\b[\s\S]*?<\/form>/gi)].map((match) => match[0]);
  const formHtml =
    forms.find((form) => /frm|principal|formulario|consulta/i.test(form) && /javax\.faces\.ViewState/i.test(form)) ||
    forms.find((form) => /javax\.faces\.ViewState/i.test(form)) ||
    forms[0] ||
    "";
  const formTag = formHtml.match(/<form\b[^>]*>/i)?.[0] || "";
  const id = htmlAttr(formTag, "id") || htmlAttr(formTag, "name") || "frmPrincipal";
  const action = htmlAttr(formTag, "action") || receivedPageUrl;
  const params = new URLSearchParams();

  for (const input of formHtml.matchAll(/<input\b[^>]*>/gi)) {
    const tag = input[0];
    const name = htmlAttr(tag, "name");
    if (!name) continue;
    const type = normalizeName(htmlAttr(tag, "type"));
    if (["button", "submit", "image"].includes(type)) continue;
    params.set(name, htmlAttr(tag, "value"));
  }

  for (const select of formHtml.matchAll(/<select\b[^>]*>[\s\S]*?<\/select>/gi)) {
    const selectHtml = select[0];
    const selectTag = selectHtml.match(/<select\b[^>]*>/i)?.[0] || "";
    const name = htmlAttr(selectTag, "name");
    if (!name) continue;
    const selectedOption = [...selectHtml.matchAll(/<option\b[^>]*>[\s\S]*?<\/option>/gi)].find((option) =>
      /\sselected\b/i.test(option[0]),
    );
    const firstOption = selectHtml.match(/<option\b[^>]*>[\s\S]*?<\/option>/i)?.[0] || "";
    params.set(name, htmlAttr(selectedOption?.[0] || firstOption, "value"));
  }

  for (const textarea of formHtml.matchAll(/<textarea\b[^>]*>([\s\S]*?)<\/textarea>/gi)) {
    const textareaTag = textarea[0].match(/<textarea\b[^>]*>/i)?.[0] || "";
    const name = htmlAttr(textareaTag, "name");
    if (name) params.set(name, decodeHtml(textarea[1] || ""));
  }

  return { id, action, html: formHtml, params };
}

function setMatchingField(params: URLSearchParams, candidates: string[], value: string) {
  const normalizedCandidates = candidates.map(normalizeName);

  for (const key of Array.from(params.keys())) {
    const normalizedKey = normalizeName(key);
    if (normalizedCandidates.some((candidate) => normalizedKey.includes(candidate))) {
      params.set(key, value);
    }
  }
}

function firstSubmitControl(formHtml: string) {
  const controls = [
    ...formHtml.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/gi),
    ...formHtml.matchAll(/<input\b[^>]*>/gi),
  ]
    .map((match) => match[0])
    .filter((control) => {
      const type = normalizeName(htmlAttr(control, "type") || "submit");
      return ["button", "submit", "image"].includes(type) || /consult|buscar|filtrar|aceptar/i.test(control);
    });

  return controls.find((control) => /consult|buscar|filtrar|aceptar/i.test(control)) || controls[0] || "";
}

function hasReceivedForm(html: string) {
  const form = parseReceivedForm(html);
  return Boolean(form.html && /javax\.faces\.ViewState/i.test(form.html));
}

async function submitReceivedPeriodFilter(html: string, jar: CookieJar, input: SriReceivedPeriodInput) {
  const form = parseReceivedForm(html);
  if (!form.html) {
    throw new Error("El SRI inicio sesion, pero no devolvio el formulario de comprobantes recibidos.");
  }

  const params = new URLSearchParams(form.params);
  params.set(form.id, form.id);
  params.set(`${form.id}:opciones`, "ruc");
  setMatchingField(params, ["anio", "ano", "year"], String(input.year));
  setMatchingField(params, ["mes", "month"], String(input.month));
  setMatchingField(params, ["dia", "day"], String(input.day));
  setMatchingField(params, ["tipoComprobante", "tipo_comprobante", "comprobante", "cmbTipo"], input.voucherType);

  const formPrefix = form.id.includes(":") ? form.id.split(":")[0] : form.id;
  const guessedFields: Record<string, string> = {
    [`${formPrefix}:ano`]: String(input.year),
    [`${formPrefix}:anio`]: String(input.year),
    [`${formPrefix}:cmbAnio`]: String(input.year),
    [`${formPrefix}:cmbAno`]: String(input.year),
    [`${formPrefix}:mes`]: String(input.month),
    [`${formPrefix}:cmbMes`]: String(input.month),
    [`${formPrefix}:dia`]: String(input.day),
    [`${formPrefix}:cmbDia`]: String(input.day),
    [`${formPrefix}:cmbTipoComprobante`]: input.voucherType,
    [`${formPrefix}:tipoComprobante`]: input.voucherType,
    [`${formPrefix}:opciones`]: "ruc",
    [`${formPrefix}:captcha`]: "",
  };

  for (const [key, value] of Object.entries(guessedFields)) {
    if (!params.has(key)) params.set(key, value);
  }

  const submitControl = firstSubmitControl(form.html);
  const submitName =
    htmlAttr(submitControl, "name") ||
    htmlAttr(submitControl, "id") ||
    (params.has(`${formPrefix}:btnConsultar`) ? `${formPrefix}:btnConsultar` : `${formPrefix}:j_idtConsultar`);
  params.set(submitName, htmlAttr(submitControl, "value") || "Consultar");
  params.set(`${formPrefix}:btnConsultar`, params.get(`${formPrefix}:btnConsultar`) || "Consultar");

  const actionUrl = new URL(form.action, receivedPageUrl).toString();
  const response = await followSriRedirects(actionUrl, jar, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: "https://srienlinea.sri.gob.ec",
      referer: receivedPageUrl,
    },
    body: params,
  });

  const regularHtml = await response.text();
  if (extractAccessKeys(regularHtml).length > 0) return regularHtml;

  const ajaxParams = new URLSearchParams(params);
  ajaxParams.set("javax.faces.partial.ajax", "true");
  ajaxParams.set("javax.faces.source", submitName);
  ajaxParams.set("javax.faces.partial.execute", "@all");
  ajaxParams.set("javax.faces.partial.render", "@all");
  ajaxParams.set(submitName, submitName);

  const ajaxResponse = await followSriRedirects(actionUrl, jar, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
      "faces-request": "partial/ajax",
      "x-requested-with": "XMLHttpRequest",
      accept: "application/xml, text/xml, */*; q=0.01",
      origin: "https://srienlinea.sri.gob.ec",
      referer: receivedPageUrl,
    },
    body: ajaxParams,
  });
  const ajaxHtml = await ajaxResponse.text();

  return extractAccessKeys(ajaxHtml).length > 0 ? ajaxHtml : regularHtml;
}

async function downloadReceivedXmls(html: string, jar: CookieJar) {
  const form = parseReceivedForm(html);
  const rows = extractReceivedTableRows(html);
  const formPrefix = form.id.includes(":") ? form.id.split(":")[0] : form.id;
  const actionUrl = new URL(form.action, receivedPageUrl).toString();
  const xmlBodies: string[] = [];

  for (const rowIndex of rows.slice(0, 100)) {
    const params = new URLSearchParams(form.params);
    params.set(form.id, form.id);
    params.set(`${formPrefix}:tablaCompRecibidos:${rowIndex}:lnkXml`, `${formPrefix}:tablaCompRecibidos:${rowIndex}:lnkXml`);

    const response = await followSriRedirects(actionUrl, jar, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://srienlinea.sri.gob.ec",
        referer: receivedPageUrl,
      },
      body: params,
    });
    xmlBodies.push(await response.text());
  }

  return xmlBodies;
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

  if (!["0", "1", "2", "3", "4", "6"].includes(voucherType)) {
    throw new Error("Selecciona un tipo de comprobante SRI valido.");
  }

  return { year, month, day, voucherType };
}

async function openReceivedPage(input: SriReceivedPeriodInput) {
  const jar: CookieJar = {};
  const loginPageResponse = await followSriRedirects(receivedPageUrl, jar);
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

  if (hasReceivedForm(html)) {
    return { html: await submitReceivedPeriodFilter(html, jar, input), jar };
  }

  const receivedResponse = await followSriRedirects(receivedPageUrl, jar, {
    headers: {
      referer: tokenUrl,
    },
  });
  const receivedHtml = await receivedResponse.text();

  if (looksLikeHumanChallenge(receivedHtml)) {
    throw new Error("El SRI solicito captcha o verificacion adicional al abrir comprobantes recibidos.");
  }

  return { html: await submitReceivedPeriodFilter(receivedHtml, jar, input), jar };
}

export async function importSriReceivedPeriod(
  input: SriReceivedPeriodInput,
): Promise<SriReceivedPeriodResult> {
  validateSriPeriod(input);

  const report = await openReceivedPage(input);
  const xmlBodies = await downloadReceivedXmls(report.html, report.jar);
  const accessKeys = Array.from(
    new Set([...extractAccessKeys(report.html), ...xmlBodies.flatMap((xml) => extractAccessKeys(xml))]),
  );

  if (accessKeys.length === 0) {
    throw new Error(
      "Se inicio sesion en el SRI, pero no se encontraron comprobantes XML para el periodo seleccionado. Revisa que existan facturas recibidas en ese mes o que el SRI no haya cambiado la tabla de resultados.",
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
