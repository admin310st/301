// src/api/integrations/providers/namecheap.ts
//
// Адаптер Namecheap API для 301
// - проверка валидности ключа
// - список доменов → для UI 301
// - смена NS на NS Cloudflare
// Работает через fetch(), формат Namecheap = XML

import { decrypt } from "../../lib/crypto";
import type { Env } from "../../types/worker";
import type { ProviderKeyData } from "../keys/schema";


// Внутренний helper: XML → JS
async function parseXml(xml: string): Promise<any> {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xml, "application/xml");

  if (doc.querySelector("parsererror")) {
    throw new Error("invalid_xml_response");
  }

  return doc;
}


// 1) Проверка ключа Namecheap
export async function namecheapVerifyKey(
  env: Env,
  encrypted: any
): Promise<boolean> {
  const data = await decrypt<ProviderKeyData>(encrypted, env.MASTER_SECRET);

  const url =
    `https://api.namecheap.com/xml.response?` +
    `ApiUser=${data.username}` +
    `&ApiKey=${data.apiKey}` +
    `&UserName=${data.username}` +
    `&Command=namecheap.users.getBalances` +
    `&ClientIp=127.0.0.1`;

  const res = await fetch(url);
  const text = await res.text();

  const xml = await parseXml(text);

  const status = xml.querySelector("ApiResponse")?.getAttribute("Status");
  return status === "OK";
}


// 2) Получение списка доменов
export async function namecheapListDomains(
  env: Env,
  encrypted: any
): Promise<{ domain: string; expires: string }[]> {
  const data = await decrypt<ProviderKeyData>(encrypted, env.MASTER_SECRET);

  const url =
    `https://api.namecheap.com/xml.response?` +
    `ApiUser=${data.username}` +
    `&ApiKey=${data.apiKey}` +
    `&UserName=${data.username}` +
    `&Command=namecheap.domains.getList` +
    `&ClientIp=127.0.0.1`;

  const res = await fetch(url);
  const text = await res.text();
  const xml = await parseXml(text);

  const resp = [];
  const items = xml.querySelectorAll("Domain");
  items.forEach((item) => {
    resp.push({
      domain: item.getAttribute("Name") || "",
      expires: item.getAttribute("Expires") || "",
    });
  });

  return resp;
}


// 3) Смена NS на Cloudflare
// ns1 = dns1.cloudflare.com
// ns2 = dns2.cloudflare.com
// Worker передаёт клиенту через API 301
export async function namecheapSetNsToCloudflare(
  env: Env,
  encrypted: any,
  fqdn: string
): Promise<boolean> {
  const data = await decrypt<ProviderKeyData>(encrypted, env.MASTER_SECRET);

  const cfNS1 = "dns1.cloudflare.com";
  const cfNS2 = "dns2.cloudflare.com";

  const url =
    `https://api.namecheap.com/xml.response?` +
    `ApiUser=${data.username}` +
    `&ApiKey=${data.apiKey}` +
    `&UserName=${data.username}` +
    `&Command=namecheap.domains.dns.setCustom` +
    `&SLD=${fqdn.split(".")[0]}` +
    `&TLD=${fqdn.split(".")[1]}` +
    `&Nameservers=${cfNS1},${cfNS2}` +
    `&ClientIp=127.0.0.1`;

  const res = await fetch(url);
  const text = await res.text();
  const xml = await parseXml(text);

  const status = xml.querySelector("ApiResponse")?.getAttribute("Status");
  return status === "OK";
}

