#!/usr/bin/env node
/**
 * Bạch Ngọc Sách (bachngocsach.cc) Downloader — GitHub Actions edition v1.6
 *
 * - Yêu cầu login (XenForo forum SSO).
 * - Lấy mục lục (page=all) → tải chương → xuất EPUB/TXT/MD/JSON.
 * - Giữ cover (thumbnail) theo lựa chọn.
 *
 * Secrets (Actions): BNS_USERNAME, BNS_PASSWORD
 *
 * Usage:
 *   node bns.js --story-url "https://bachngocsach.cc/reader/quy-bi-chi-chu" --format epub,txt --output ./output --state ./bns-state.json
 *   node bns.js ... --chapter-from 10 --chapter-to 50   # tuỳ chọn: chỉ tải & xuất chương 10–50 (theo mục lục)
 */

"use strict";

import fetch from "node-fetch";
import fs from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { ZipWriter, BlobWriter, TextReader, BlobReader } from "@zip.js/zip.js";

const BASE = "https://bachngocsach.cc";
const DEFAULT_THROTTLE_MS = 900;
const DEFAULT_SAVE_EVERY = 5;
const MAX_RETRIES = 4;
const RETRY_DELAYS = [1500, 3500, 8000, 15000];

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept-Language": "vi-VN,vi;q=0.9,en-US;q=0.7,en;q=0.5",
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

function sanitizeFilename(s) {
  return String(s || "story").replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, " ").trim().slice(0, 120);
}
function escXml(s) {
  return (s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function decodeHtml(s) {
  return String(s || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}
function stripTags(html) {
  return decodeHtml(String(html || "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n\n").replace(/<[^>]+>/g, ""));
}

// ── Cookie jar (very small, good enough for single domain) ──
class CookieJar {
  constructor() { this.map = new Map(); }
  setFromSetCookie(setCookieHeader) {
    if (!setCookieHeader) return;
    const parts = String(setCookieHeader).split(";").map(s => s.trim());
    const kv = parts[0];
    const eq = kv.indexOf("=");
    if (eq <= 0) return;
    const k = kv.slice(0, eq);
    const v = kv.slice(eq + 1);
    if (!k) return;
    this.map.set(k, v);
  }
  setFromResponse(res) {
    const raw = res?.headers?.raw?.();
    const arr = raw?.["set-cookie"] || [];
    for (const sc of arr) this.setFromSetCookie(sc);
  }
  header() {
    if (!this.map.size) return "";
    return [...this.map.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

/** Trang reader / mục lục trả về khi chưa được coi là đã đăng nhập đọc */
function readerPaywallHtml(html) {
  const h = String(html || "");
  return (
    /Đăng nhập để đọc truyện/i.test(h) ||
    /log\s*in\s*to\s*read/i.test(h)
  );
}

async function fetchWithRetry(url, opts = {}, jar = null) {
  const { headers: optHeaders, signal: userSignal, ...restOpts } = opts;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const headers = {
        ...HEADERS,
        ...(jar?.header() ? { Cookie: jar.header() } : {}),
        ...(optHeaders || {}),
      };
      const signal = userSignal ?? AbortSignal.timeout(30000);
      const res = await fetch(url, {
        redirect: "follow",
        headers,
        signal,
        ...restOpts,
      });
      if (jar) jar.setFromResponse(res);
      if (res.ok) return res;
      if (res.status === 429) {
        const wait = (parseInt(res.headers.get("Retry-After") || "30", 10)) * 1000;
        console.log(`⏳ Rate limited (429), đợi ${wait / 1000}s...`);
        await sleep(wait);
        continue;
      }
      if (attempt === MAX_RETRIES) throw new Error(`HTTP ${res.status}: ${url}`);
    } catch (e) {
      if (attempt === MAX_RETRIES) throw e;
      const wait = RETRY_DELAYS[attempt] || 15000;
      console.log(`⚠ Lỗi (lần ${attempt + 1}): ${e.message} — thử lại sau ${wait / 1000}s`);
      await sleep(wait);
    }
  }
}

async function loginBns({ username, password, jar, afterLoginUrl }) {
  let redirectPath = "/reader/index";
  let xfRedirectFull = `${BASE}/reader/index`;
  if (afterLoginUrl) {
    try {
      const u = new URL(String(afterLoginUrl));
      if (u.hostname.replace(/^www\./i, "") === "bachngocsach.cc") {
        const p = `${u.pathname}${u.search || ""}`.replace(/\/{2,}/g, "/") || "/reader/index";
        redirectPath = p.startsWith("/") ? p : `/${p}`;
        xfRedirectFull = `${BASE}${u.pathname.replace(/\/+$/, "")}${u.search || ""}`;
      }
    } catch {
      /* giữ mặc định */
    }
  }
  const loginPageUrl = `${BASE}/forum/login?redirect=${encodeURIComponent(redirectPath)}`;
  const acceptHtml = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

  try {
    await fetchWithRetry(BASE + "/", { headers: { Accept: acceptHtml } }, jar);
  } catch {
    /* một số host vẫn cho phép login nếu bỏ qua warmup */
  }

  const loginRes = await fetchWithRetry(loginPageUrl, { headers: { Accept: acceptHtml } }, jar);
  const pageUrlForForm = loginRes.url || loginPageUrl;
  const loginPage = await loginRes.text();

  // Trang "You are already logged in" (XenForo) thường không còn form — thử đọc reader trước khi báo lỗi token
  const hasToken = /name="_xfToken"/i.test(loginPage);
  if (!hasToken) {
    const alreadyMsg =
      /already logged in|You are already logged in|B\u1ea1n \u0111ã \u0111\u0103ng nh\u1eadp/i.test(loginPage) ||
      /class="isLoggedIn"/i.test(loginPage);
    if (alreadyMsg) {
      const probe = await (await fetchWithRetry(`${BASE}/reader`, { headers: { Accept: acceptHtml } }, jar)).text();
      if (!(/Đăng nhập/i.test(probe) && /forum\/login/i.test(probe))) return true;
    }
  }

  const token =
    loginPage.match(/name="_xfToken"\s+value="([^"]+)"/i)?.[1] ||
    loginPage.match(/value="([^"]+)"\s+name="_xfToken"/i)?.[1] ||
    "";
  const actionRaw =
    loginPage.match(/<form[^>]+action="([^"]+)"[^>]*method\s*=\s*"post"/i)?.[1] ||
    loginPage.match(/<form[^>]+method\s*=\s*"post"[^>]*action="([^"]+)"/i)?.[1] ||
    loginPage.match(/action="(\/forum\/login\/login[^"]*)"/i)?.[1] ||
    "/forum/login/login";

  let postUrl;
  try {
    postUrl = new URL(actionRaw.trim(), pageUrlForForm).href;
  } catch {
    postUrl = actionRaw.startsWith("http")
      ? actionRaw
      : `${BASE}${actionRaw.startsWith("/") ? "" : "/"}${actionRaw}`;
  }

  if (!token) throw new Error("Không lấy được _xfToken từ trang login.");

  const form = new URLSearchParams();
  form.set("login", username);
  form.set("password", password);
  form.set("remember", "1");
  form.set("_xfRedirect", xfRedirectFull);
  form.set("_xfToken", token);

  /**
   * POST login + theo redirect tay: mỗi bước đều jar.setFromResponse.
   * fetch(..., redirect:'follow') thường chỉ áp Set-Cookie từ response *cuối* → mất session giữa đường (Reader hay paywall).
   */
  const postLoginFollowRedirects = async startUrl => {
    let url = startUrl;
    let method = "POST";
    let body = form.toString();
    let referer = pageUrlForForm;
    for (let hop = 0; hop < 16; hop++) {
      const h = {
        ...HEADERS,
        ...(jar.header() ? { Cookie: jar.header() } : {}),
        Accept: acceptHtml,
        Referer: referer,
        Origin: BASE,
      };
      if (method === "POST") h["Content-Type"] = "application/x-www-form-urlencoded";

      const res = await fetch(url, {
        method,
        redirect: "manual",
        headers: h,
        body: method === "POST" ? body : undefined,
        signal: AbortSignal.timeout(60000),
      });
      jar.setFromResponse(res);

      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const loc = res.headers.get("location");
        await res.text().catch(() => {});
        if (!loc) throw new Error(`HTTP ${res.status} redirect không có Location`);
        referer = url;
        url = new URL(loc, url).href;
        method = "GET";
        body = undefined;
        continue;
      }

      const text = await res.text();
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}: ${url}`);
        err.status = res.status;
        throw err;
      }
      if (
        /blockMessage[^>]*error|formButtonWrapper[\s\S]*error/i.test(text) &&
        /(provided password|incorrect password|mật khẩu không đúng|không hợp lệ)/i.test(text)
      ) {
        throw new Error("Đăng nhập forum bị từ chối (sai mật khẩu / lỗi form). Kiểm tra BNS_USERNAME/BNS_PASSWORD.");
      }
      return;
    }
    throw new Error("Quá nhiều redirect sau POST login");
  };

  try {
    await postLoginFollowRedirects(postUrl);
  } catch (e) {
    const st = e?.status;
    const is404 = st === 404 || /HTTP 404:/.test(String(e.message));
    const fallback = `${BASE}/forum/login/login`;
    if (is404 && postUrl !== fallback) {
      await postLoginFollowRedirects(fallback);
    } else {
      throw e;
    }
  }

  try {
    await fetchWithRetry(`${BASE}/forum/`, { headers: { Accept: acceptHtml, Referer: pageUrlForForm } }, jar);
    await fetchWithRetry(`${BASE}/reader`, { headers: { Accept: acceptHtml, Referer: `${BASE}/forum/` } }, jar);
  } catch {
    /* bridge SSO tùy site */
  }

  const verifyUrl =
    afterLoginUrl && /^https:\/\//i.test(String(afterLoginUrl).trim()) && /\/reader\//i.test(String(afterLoginUrl))
      ? String(afterLoginUrl).trim().replace(/#.*$/, "")
      : `${BASE}/reader`;
  const check = await (
    await fetchWithRetry(verifyUrl, {
      headers: {
        Accept: acceptHtml,
        Referer: `${BASE}/reader/index`,
      },
    }, jar)
  ).text();
  if (readerPaywallHtml(check)) {
    console.error("Verify snippet:", check.replace(/\s+/g, " ").slice(0, 900));
    throw new Error(
      "Sau login vẫn không đọc được trang truyện (paywall). Kiểm tra Secrets đúng tài khoản forum có quyền Reader; xem snippet log phía trên."
    );
  }
  if (verifyUrl === `${BASE}/reader` && /Đăng nhập/i.test(check) && /forum\/login/i.test(check)) {
    throw new Error("Login thất bại (vẫn bị yêu cầu đăng nhập). Kiểm tra BNS_USERNAME/BNS_PASSWORD.");
  }
  return true;
}

function normalizeStoryUrl(u) {
  let s = String(u || "").trim();
  if (!s) throw new Error("Thiếu --story-url");
  if (!/^https?:\/\//i.test(s)) s = "https://" + s.replace(/^\/+/, "");
  const url = new URL(s);
  const host = url.hostname.replace(/^www\./i, "");
  if (host !== "bachngocsach.cc") throw new Error("story-url phải thuộc bachngocsach.cc");
  let p = url.pathname.replace(/\/+$/, "");
  p = p.replace(/\/muc-luc$/i, "");
  const m = p.match(/^\/reader\/([^/]+)$/i);
  if (!m) {
    throw new Error(
      "story-url cần dạng .../reader/<slug> (có thể dán thêm /muc-luc hoặc ?page=all — script tự bỏ; danh sách chương luôn lấy từ muc-luc?page=all)."
    );
  }
  return `${BASE}/reader/${m[1]}`;
}

/**
 * Lấy inner HTML của thẻ <div id="..."> cân bằng độ sâu (cho #noidung lồng div).
 */
function extractDivInnerById(html, id) {
  const esc = String(id).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const openRe = new RegExp(`<div\\b[^>]*\\bid\\s*=\\s*["']${esc}["'][^>]*>`, "i");
  const m = openRe.exec(html);
  if (!m) return "";
  const lc = html.toLowerCase();
  let pos = m.index + m[0].length;
  let depth = 1;
  while (pos < html.length && depth > 0) {
    const nextDiv = lc.indexOf("<div", pos);
    const nextClose = lc.indexOf("</div>", pos);
    if (nextClose < 0) break;
    if (nextDiv >= 0 && nextDiv < nextClose) {
      depth++;
      pos = nextDiv + 4;
    } else {
      depth--;
      if (depth === 0) return html.slice(m.index + m[0].length, nextClose);
      pos = nextClose + 6;
    }
  }
  return "";
}

/**
 * Giới hạn danh sách chương theo số thứ tự 1-based (theo mục lục).
 * Để trống from/to → từ đầu / đến cuối.
 */
function resolveChapterRange(toc, fromRaw, toRaw) {
  const total = toc.length;
  let from = 1;
  let to = total;
  const fs = fromRaw != null && String(fromRaw).trim() !== "" ? String(fromRaw).trim() : "";
  const ts = toRaw != null && String(toRaw).trim() !== "" ? String(toRaw).trim() : "";
  if (fs) {
    const n = parseInt(fs, 10);
    if (!Number.isNaN(n)) from = n;
  }
  if (ts) {
    const n = parseInt(ts, 10);
    if (!Number.isNaN(n)) to = n;
  }
  from = Math.max(1, Math.min(from, total));
  to = Math.max(1, Math.min(to, total));
  if (from > to) {
    throw new Error(`Phạm vi chương không hợp lệ: từ ${from} đến ${to} (mục lục có ${total} chương).`);
  }
  return { from, to, slice: toc.slice(from - 1, to) };
}

/** Chỉ link chương: /reader/{storySlug}/{chapterKey} — loại manifest, /user, /sites/, … */
function parseTocAll(html, storySlug) {
  const slug = String(storySlug || "").trim();
  const out = [];
  const seen = new Set();

  function addHref(raw) {
    if (!raw || !slug) return;
    let path = raw.trim();
    if (/^https?:\/\//i.test(path)) {
      try {
        const u = new URL(path);
        const h = u.hostname.replace(/^www\./i, "");
        if (h !== "bachngocsach.cc") return;
        path = u.pathname;
      } catch {
        return;
      }
    }
    path = path.replace(/\/+$/, "");
    const parts = path.split("/").filter(Boolean);
    if (parts.length !== 3 || parts[0] !== "reader") return;
    if (parts[1] !== slug) return;
    const chapterKey = parts[2];
    if (!chapterKey || /^(muc-luc|index)$/i.test(chapterKey)) return;
    if (/\.(json|xml|png|jpe?g|gif|webp|svg|ico)$/i.test(chapterKey)) return;

    const full = `${BASE}${path}`;
    if (seen.has(full)) return;
    seen.add(full);
    out.push({ url: full, title: "" });
  }

  const patterns = [
    /href="(\/reader\/[^"\/]+\/[^"?#]+)"/gi,
    /href='(\/reader\/[^'\/]+\/[^'?#]+)'/gi,
    /href="(https?:\/\/(?:www\.)?bachngocsach\.cc\/reader\/[^"\/]+\/[^"?#]+)"/gi,
    /href='(https?:\/\/(?:www\.)?bachngocsach\.cc\/reader\/[^'\/]+\/[^'?#]+)'/gi,
  ];
  for (const re of patterns) {
    for (const m of html.matchAll(re)) addHref(m[1]);
  }

  return out;
}

function extractTitleFromHtml(html) {
  const chuong = html.match(
    /<(?:div|h1|h2|h3|span)\b[^>]*\bid\s*=\s*["']chuong-title["'][^>]*>([\s\S]*?)<\/(?:div|h1|h2|h3|span)>/i
  )?.[1];
  if (chuong) return stripTags(chuong).trim();
  return (
    html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ||
    html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ||
    ""
  )
    .replace(/<[^>]+>/g, "")
    .trim();
}

/** Payload base64 trong #encrypted-content (BNS mã hóa thân chương, browser gọi API giải mã). */
function extractEncryptedContentPayload(html) {
  const m = html.match(/<div\b[^>]*\bid\s*=\s*["']encrypted-content["'][^>]*>([\s\S]*?)<\/div>/i);
  if (!m) return "";
  return m[1].replace(/<[^>]+>/g, "").replace(/\s+/g, "").trim();
}

async function decryptBnsChapterBody(payload, jar, chapterPageUrl) {
  if (!payload || payload.length < 20) return "";
  const api = `${BASE}/reader/api/decrypt-content.php`;
  const referer = /^https?:\/\//i.test(chapterPageUrl) ? chapterPageUrl : `${BASE}${chapterPageUrl.startsWith("/") ? "" : "/"}${chapterPageUrl}`;
  const res = await fetchWithRetry(
    api,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/plain, */*",
        Referer: referer,
        Origin: BASE,
      },
      body: JSON.stringify({ encryptedData: payload }),
    },
    jar
  );
  const text = await res.text();
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    throw new Error(`API decrypt không trả JSON (${text.slice(0, 100)}…)`);
  }
  if (j.error || j.message) {
    const msg = String(j.error || j.message || "");
    if (msg) throw new Error(`Decrypt: ${msg.slice(0, 200)}`);
  }
  const content = j.content ?? j.data?.content;
  return typeof content === "string" ? content : "";
}

function parseChapterParagraphs(html) {
  const noidung = extractDivInnerById(html, "noidung");
  const scope = noidung || "";

  if (scope) {
    const paras = [];
    let m;
    const reP = /<p[^>]*>([\s\S]*?)<\/p>/gi;
    while ((m = reP.exec(scope)) !== null) {
      const t = stripTags(m[1]).trim();
      if (t.length > 1) paras.push(t);
    }
    if (paras.length > 0) return paras;

    const brChunks = stripTags(scope.replace(/<br\s*\/?>/gi, "\n\n"))
      .split(/\n{2,}/)
      .map(s => s.trim())
      .filter(s => s.length > 15);
    if (brChunks.length > 1) return brChunks;

    const divParas = [];
    const reDiv = /<div\b[^>]*>([\s\S]*?)<\/div>/gi;
    while ((m = reDiv.exec(scope)) !== null) {
      const inner = m[1];
      if (/<div\b/i.test(inner)) continue;
      const t = stripTags(inner).trim();
      if (t.length > 40) divParas.push(t);
    }
    if (divParas.length > 0) return divParas;
  }

  const paras = [];
  const re = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const t = stripTags(m[1]).trim();
    if (t.length > 1) paras.push(t);
  }
  if (paras.length) return paras;

  const main =
    html.match(/<article[\s\S]*?<\/article>/i)?.[0] ||
    html.match(/<div[^>]+class="[^"]*content[^"]*"[\s\S]*?<\/div>/i)?.[0] ||
    html;
  const t = stripTags(main).trim();
  return t ? t.split(/\n{2,}/).map(s => s.trim()).filter(Boolean) : [];
}

function parseCoverUrl(html) {
  const og = html.match(/property="og:image"\s+content="([^"]+)"/i)?.[1];
  if (og) return og;
  const meta = html.match(/name="twitter:image"\s+content="([^"]+)"/i)?.[1];
  if (meta) return meta;
  const img = html.match(/<img[^>]+src="([^"]+)"[^>]*>/i)?.[1];
  if (!img) return "";
  return img.startsWith("http") ? img : `${BASE}${img}`;
}

async function loadState(stateFile) {
  try {
    if (!existsSync(stateFile)) return {};
    return JSON.parse(await fs.readFile(stateFile, "utf8"));
  } catch { return {}; }
}
async function saveState(stateFile, state) {
  await fs.writeFile(stateFile, JSON.stringify(state, null, 2), "utf8");
}

function toTxt(meta, chapters) {
  const lines = [];
  lines.push(meta.title || "Untitled");
  if (meta.author) lines.push(`by ${meta.author}`);
  if (meta.url) lines.push(meta.url);
  if (meta.coverUrl) lines.push(`cover: ${meta.coverUrl}`);
  lines.push("");
  for (const ch of chapters) {
    lines.push(ch.title);
    lines.push("─".repeat(40));
    lines.push(ch.paras.join("\n\n"));
    lines.push("");
  }
  return lines.join("\n");
}

function toMarkdown(meta, chapters) {
  const lines = [];
  lines.push(`# ${meta.title || "Untitled"}`);
  if (meta.author) lines.push(`**Tác giả:** ${meta.author}`);
  if (meta.url) lines.push(`**URL:** ${meta.url}`);
  if (meta.coverUrl) lines.push(`**Cover:** ${meta.coverUrl}`);
  lines.push("");
  for (const ch of chapters) {
    lines.push(`## ${ch.title}`);
    lines.push("");
    lines.push(ch.paras.join("\n\n"));
    lines.push("");
  }
  return lines.join("\n");
}

function toJson(meta, chapters) {
  return JSON.stringify({ meta, chapters }, null, 2);
}

async function toEpub(meta, chapters, cover) {
  const bw = new BlobWriter("application/epub+zip");
  const zw = new ZipWriter(bw, { useWebWorkers: false });
  await zw.add("mimetype", new TextReader("application/epub+zip"), { compressionMethod: 0 });
  await zw.add(
    "META-INF/container.xml",
    new TextReader(`<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`)
  );
  await zw.add(
    "OEBPS/stylesheet.css",
    new TextReader(`body{font-family:Georgia,serif;line-height:1.75;margin:2em auto;max-width:36em;padding:0 1.2em}h1,h2{margin:1.2em 0 .5em}p{margin:0 0 .9em;text-indent:1.2em}p:first-of-type{text-indent:0}img{max-width:100%;height:auto}`)
  );

  const files = [];
  for (let i = 0; i < chapters.length; i++) {
    const ch = chapters[i];
    const fn = `ch${String(i + 1).padStart(4, "0")}.xhtml`;
    const body = ch.paras.map(p => `<p>${escXml(p)}</p>`).join("");
    await zw.add(
      `OEBPS/Text/${fn}`,
      new TextReader(`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd"><html xmlns="http://www.w3.org/1999/xhtml"><head><meta charset="UTF-8"/><title>${escXml(ch.title)}</title><link rel="stylesheet" type="text/css" href="../stylesheet.css"/></head><body><h2>${escXml(ch.title)}</h2>${body}</body></html>`)
    );
    files.push({ fn, title: ch.title, id: `c${i + 1}` });
  }

  let coverItems = "";
  let coverSpine = "";
  if (cover?.bytes && cover?.mime) {
    const ext = cover.mime.includes("png") ? "png" : "jpg";
    await zw.add(`OEBPS/Images/cover.${ext}`, new BlobReader(new Blob([cover.bytes], { type: cover.mime })));
    await zw.add(
      `OEBPS/Text/cover.xhtml`,
      new TextReader(`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd"><html xmlns="http://www.w3.org/1999/xhtml"><head><meta charset="UTF-8"/><title>Cover</title><link rel="stylesheet" type="text/css" href="../stylesheet.css"/></head><body><h1>${escXml(meta.title || "")}</h1><img src="../Images/cover.${ext}" alt="cover"/></body></html>`)
    );
    coverItems = `<item id="coverimg" href="Images/cover.${ext}" media-type="${cover.mime}"/><item id="cover" href="Text/cover.xhtml" media-type="application/xhtml+xml"/>`;
    coverSpine = `<itemref idref="cover"/>`;
  }

  const items = files.map(f => `<item id="${f.id}" href="Text/${f.fn}" media-type="application/xhtml+xml"/>`).join("");
  const spine = files.map(f => `<itemref idref="${f.id}"/>`).join("");

  await zw.add(
    "OEBPS/content.opf",
    new TextReader(`<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="uid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${escXml(meta.title || "Untitled")}</dc:title><dc:creator>${escXml(meta.author || "")}</dc:creator><dc:language>vi</dc:language><dc:identifier id="uid">${escXml(meta.id || "bns")}</dc:identifier></metadata><manifest><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/><item id="css" href="stylesheet.css" media-type="text/css"/>${coverItems}${items}</manifest><spine toc="ncx">${coverSpine}${spine}</spine></package>`)
  );

  await zw.add(
    "OEBPS/toc.ncx",
    new TextReader(`<?xml version="1.0" encoding="UTF-8"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="${escXml(meta.id || "bns")}"/></head><docTitle><text>${escXml(meta.title || "")}</text></docTitle><navMap>${files.map((f, i) => `<navPoint id="${f.id}" playOrder="${i + 1}"><navLabel><text>${escXml(f.title)}</text></navLabel><content src="Text/${f.fn}"/></navPoint>`).join("")}</navMap></ncx>`)
  );

  return Buffer.from(await (await zw.close()).arrayBuffer());
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("--help")) {
    console.log(`
BNS Downloader v1.6
===================
node bns.js --story-url <url> --format epub,txt,md,json --output ./output --state ./bns-state.json

Options:
  --story-url <url>         (required) URL truyện, ví dụ: https://bachngocsach.cc/reader/quy-bi-chi-chu
  --format <list>           epub,txt,md,json (mặc định: epub)
  --output <dir>            (mặc định: ./output)
  --state <file>            (mặc định: ./bns-state.json)
  --throttle-ms <ms>        delay giữa chapters (mặc định: ${DEFAULT_THROTTLE_MS})
  --save-every <n>          save state mỗi n chapters tải mới (mặc định: ${DEFAULT_SAVE_EVERY})
`);
    process.exit(0);
  }

  let storyUrl = "";
  let formats = ["epub"];
  let outputDir = "./output";
  let stateFile = "./bns-state.json";
  let throttleMs = DEFAULT_THROTTLE_MS;
  let saveEvery = DEFAULT_SAVE_EVERY;
  /** @type {string|null} */
  let chapterFromArg = null;
  /** @type {string|null} */
  let chapterToArg = null;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--story-url" && args[i + 1]) storyUrl = args[++i];
    else if (a === "--format" && args[i + 1]) formats = args[++i].split(",").map(s => s.trim()).filter(Boolean);
    else if (a === "--output" && args[i + 1]) outputDir = args[++i];
    else if (a === "--state" && args[i + 1]) stateFile = args[++i];
    else if (a === "--throttle-ms" && args[i + 1]) throttleMs = Math.max(0, parseInt(args[++i], 10));
    else if (a === "--save-every" && args[i + 1]) saveEvery = Math.max(1, parseInt(args[++i], 10));
    else if (a === "--chapter-from" && args[i + 1]) chapterFromArg = String(args[++i]).trim();
    else if (a === "--chapter-to" && args[i + 1]) chapterToArg = String(args[++i]).trim();
  }

  formats = formats.filter(f => ["epub", "txt", "md", "json"].includes(f));
  if (!formats.length) formats = ["epub"];

  const username = process.env.BNS_USERNAME || "";
  const password = process.env.BNS_PASSWORD || "";
  if (!username || !password) {
    throw new Error("Thiếu env BNS_USERNAME/BNS_PASSWORD (đặt trong GitHub Secrets hoặc env local).");
  }

  const jar = new CookieJar();
  const fullStoryUrl = normalizeStoryUrl(storyUrl);
  const tocUrl = `${fullStoryUrl}/muc-luc?page=all`;

  await fs.mkdir(outputDir, { recursive: true });
  const state = await loadState(stateFile);
  const storyKey = fullStoryUrl;
  if (!state[storyKey]) state[storyKey] = { meta: null, chapters: {} };

  console.log(`\n${"═".repeat(60)}`);
  console.log(`BNS Downloader v1.6`);
  console.log(`Story  : ${fullStoryUrl}`);
  console.log(`Format : ${formats.join(", ").toUpperCase()}`);
  console.log(`Output : ${outputDir} | State: ${stateFile}`);
  console.log(`Speed  : throttle=${throttleMs}ms | saveEvery=${saveEvery}`);
  console.log(`${"═".repeat(60)}\n`);

  console.log("🔐 Logging in...");
  await loginBns({ username, password, jar, afterLoginUrl: fullStoryUrl });
  console.log("✅ Login OK");

  console.log("📖 Mở trang truyện (bridge cookie Reader → mục lục)...");
  await (
    await fetchWithRetry(fullStoryUrl, {
      headers: {
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        Referer: `${BASE}/reader/index`,
      },
    }, jar)
  ).text();

  console.log("📚 Loading TOC...");
  const tocHtml = await (
    await fetchWithRetry(tocUrl, {
      headers: {
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        Referer: fullStoryUrl,
      },
    }, jar)
  ).text();
  if (readerPaywallHtml(tocHtml)) {
    throw new Error("TOC vẫn bị paywall sau login. Nếu đã pull bns.js mới: kiểm tra quyền Reader / tài khoản.");
  }

  if (!state[storyKey].meta) {
    const storyHtml = await (await fetchWithRetry(fullStoryUrl, {}, jar)).text();
    const title = extractTitleFromHtml(storyHtml) || fullStoryUrl.split("/").pop();
    const coverUrl = parseCoverUrl(storyHtml);
    state[storyKey].meta = { id: sanitizeFilename(fullStoryUrl.split("/").pop()), title, author: "", url: fullStoryUrl, coverUrl };
    await saveState(stateFile, state);
  }

  const meta = state[storyKey].meta;
  const storySlug = fullStoryUrl.split("/").pop();
  const toc = parseTocAll(tocHtml, storySlug);
  console.log(`🔎 Found chapters: ${toc.length}`);
  if (!toc.length) {
    const snip = tocHtml.replace(/\s+/g, " ").slice(0, 500);
    console.error(`TOC preview (${tocHtml.length} chars): ${snip}${tocHtml.length > 500 ? "…" : ""}`);
    throw new Error("Không parse được danh sách chương từ TOC (xem log preview phía trên).");
  }

  const { slice: tocWork, from: rangeFrom, to: rangeTo } = resolveChapterRange(
    toc,
    chapterFromArg,
    chapterToArg
  );
  if (tocWork.length < toc.length) {
    console.log(`📌 Phạm vi: chương ${rangeFrom}–${rangeTo} (${tocWork.length} chương, bỏ qua phần còn lại của mục lục)`);
  }

  let cover = null;
  if (meta.coverUrl) {
    try {
      const res = await fetchWithRetry(meta.coverUrl, {}, jar);
      const buf = Buffer.from(await res.arrayBuffer());
      const mime = res.headers.get("content-type") || "image/jpeg";
      cover = { bytes: buf, mime };
      console.log("🖼️ Cover: OK");
    } catch (e) {
      console.log(`🖼️ Cover: skip (${e.message})`);
    }
  }

  let saveCountdown = saveEvery;
  let downloaded = 0;

  for (let i = 0; i < tocWork.length; i++) {
    const ch = tocWork[i];
    const cached = state[storyKey].chapters[ch.url];
    if (cached?.status === "done" && cached?.paras?.length) continue;

    console.log(`\n[${i + 1}/${tocWork.length}] ${ch.url}`);
    try {
      const html = await (
        await fetchWithRetry(ch.url, {
          headers: {
            Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            Referer: fullStoryUrl,
          },
        }, jar)
      ).text();
      const title = extractTitleFromHtml(html) || `Chương ${i + 1}`;
      let parseHtml = html;
      const enc = extractEncryptedContentPayload(html);
      if (enc.length > 40) {
        const dec = await decryptBnsChapterBody(enc, jar, ch.url);
        if (dec) {
          parseHtml = dec;
          console.log("  🔓 Giải mã nội dung (encrypted-content → API)");
        }
      }
      const paras = parseChapterParagraphs(parseHtml);
      state[storyKey].chapters[ch.url] = { status: "done", title, paras };
      console.log(`✓ ${title} (${paras.length} đoạn)`);
    } catch (e) {
      state[storyKey].chapters[ch.url] = { status: "error", title: ch.title || "", paras: [`[Lỗi: ${e.message}]`] };
      console.log(`✗ ${e.message}`);
    }

    downloaded++;
    saveCountdown--;
    if (saveCountdown <= 0) {
      await saveState(stateFile, state);
      saveCountdown = saveEvery;
    }
    if (i < tocWork.length - 1) await sleep(throttleMs);
  }

  await saveState(stateFile, state);

  // Build chapters in TOC order (chỉ phạm vi đã chọn)
  const chapters = tocWork.map((c, idx) => {
    const x = state[storyKey].chapters[c.url];
    return {
      index: idx + 1,
      url: c.url,
      title: x?.title || c.title || `Chương ${idx + 1}`,
      paras: x?.paras?.length ? x.paras : ["[Chưa tải được]"],
    };
  });

  const safe = sanitizeFilename(meta.title || "bns_story");
  for (const fmt of formats) {
    const filename = path.join(outputDir, `${safe}.${fmt}`);
    console.log(`\n📦 Export ${fmt.toUpperCase()}...`);
    if (fmt === "epub") {
      await fs.writeFile(filename, await toEpub(meta, chapters, cover));
    } else if (fmt === "txt") {
      await fs.writeFile(filename, toTxt(meta, chapters), "utf8");
    } else if (fmt === "md") {
      await fs.writeFile(filename, toMarkdown(meta, chapters), "utf8");
    } else {
      await fs.writeFile(filename, toJson(meta, chapters), "utf8");
    }
    console.log(`✅ ${filename}`);
  }

  console.log(`\nDone. Downloaded new chapters this run: ${downloaded}`);
}

main().catch(e => {
  console.error("Fatal:", e.message);
  process.exit(1);
});

