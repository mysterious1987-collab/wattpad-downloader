#!/usr/bin/env node
/**
 * Bạch Ngọc Sách (bachngocsach.cc) Downloader — GitHub Actions edition v1.5
 *
 * - Yêu cầu login (XenForo forum SSO).
 * - Lấy mục lục (page=all) → tải chương → xuất EPUB/TXT/MD/JSON.
 * - Giữ cover (thumbnail) theo lựa chọn.
 *
 * Secrets (Actions): BNS_USERNAME, BNS_PASSWORD
 *
 * Usage:
 *   node bns.js --story-url "https://bachngocsach.cc/reader/quy-bi-chi-chu" --format epub,txt --output ./output --state ./bns-state.json
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

async function fetchWithRetry(url, opts = {}, jar = null) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        redirect: "follow",
        headers: {
          ...HEADERS,
          ...(jar?.header() ? { Cookie: jar.header() } : {}),
          ...(opts.headers || {}),
        },
        signal: AbortSignal.timeout(30000),
        ...opts,
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

async function loginBns({ username, password, jar }) {
  const loginPageUrl = `${BASE}/forum/login?redirect=%2Freader%2Findex`;
  const loginPage = await (await fetchWithRetry(loginPageUrl, {}, jar)).text();

  const token = loginPage.match(/name="_xfToken"\s+value="([^"]+)"/i)?.[1] || "";
  const action = loginPage.match(/<form[^>]+action="([^"]+login\/login[^"]*)"/i)?.[1] || "/forum/login/login";

  if (!token) throw new Error("Không lấy được _xfToken từ trang login.");

  const form = new URLSearchParams();
  form.set("login", username);
  form.set("password", password);
  form.set("remember", "1");
  form.set("_xfRedirect", `${BASE}/reader/index`);
  form.set("_xfToken", token);

  const postUrl = action.startsWith("http") ? action : `${BASE}${action.startsWith("/") ? "" : "/"}${action}`;
  const res = await fetchWithRetry(postUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  }, jar);

  // XenForo thường redirect sau login; kiểm tra bằng cách truy cập reader page
  const check = await (await fetchWithRetry(`${BASE}/reader`, {}, jar)).text();
  if (/Đăng nhập/i.test(check) && /forum\/login/i.test(check)) {
    throw new Error("Login thất bại (vẫn bị yêu cầu đăng nhập). Kiểm tra BNS_USERNAME/BNS_PASSWORD.");
  }
  return true;
}

function normalizeStoryUrl(u) {
  let s = String(u || "").trim();
  if (!s) throw new Error("Thiếu --story-url");
  if (!/^https?:\/\//i.test(s)) s = "https://" + s.replace(/^\/+/, "");
  const url = new URL(s);
  if (url.hostname !== "bachngocsach.cc") throw new Error("story-url phải thuộc bachngocsach.cc");
  return `${BASE}${url.pathname.replace(/\/+$/, "")}`;
}

function parseTocAll(html) {
  // Heuristic: collect /reader/<story>/<chapterSlug> links
  const out = [];
  const seen = new Set();
  const re = /href="(\/reader\/[^"\/]+\/[^"?#]+)"/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const href = m[1];
    if (!href) continue;
    if (/\/muc-luc$/i.test(href)) continue;
    if (/\/index$/i.test(href)) continue;
    const full = `${BASE}${href}`;
    if (seen.has(full)) continue;
    seen.add(full);
    out.push({ url: full, title: "" });
  }

  // Try also to capture title text near links (best effort)
  // This is optional; chapter pages will give titles anyway.
  return out;
}

function extractTitleFromHtml(html) {
  return (
    html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ||
    html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ||
    ""
  ).replace(/<[^>]+>/g, "").trim();
}

function parseChapterParagraphs(html) {
  // BNS reader tends to be straightforward; fallback to grabbing <p> blocks
  const paras = [];
  const re = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const t = stripTags(m[1]).trim();
    if (t && t.length > 1) paras.push(t);
  }
  if (paras.length) return paras;

  // fallback: text from main container
  const main = html.match(/<article[\s\S]*?<\/article>/i)?.[0] || html.match(/<div[^>]+class="[^"]*content[^"]*"[\s\S]*?<\/div>/i)?.[0] || html;
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
BNS Downloader v1.5
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

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--story-url" && args[i + 1]) storyUrl = args[++i];
    else if (a === "--format" && args[i + 1]) formats = args[++i].split(",").map(s => s.trim()).filter(Boolean);
    else if (a === "--output" && args[i + 1]) outputDir = args[++i];
    else if (a === "--state" && args[i + 1]) stateFile = args[++i];
    else if (a === "--throttle-ms" && args[i + 1]) throttleMs = Math.max(0, parseInt(args[++i], 10));
    else if (a === "--save-every" && args[i + 1]) saveEvery = Math.max(1, parseInt(args[++i], 10));
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
  console.log(`BNS Downloader v1.5`);
  console.log(`Story  : ${fullStoryUrl}`);
  console.log(`Format : ${formats.join(", ").toUpperCase()}`);
  console.log(`Output : ${outputDir} | State: ${stateFile}`);
  console.log(`Speed  : throttle=${throttleMs}ms | saveEvery=${saveEvery}`);
  console.log(`${"═".repeat(60)}\n`);

  console.log("🔐 Logging in...");
  await loginBns({ username, password, jar });
  console.log("✅ Login OK");

  console.log("📚 Loading TOC...");
  const tocHtml = await (await fetchWithRetry(tocUrl, {}, jar)).text();
  if (/Đăng nhập để đọc truyện/i.test(tocHtml)) {
    throw new Error("TOC vẫn bị chặn sau login. Có thể redirect khác / cookie chưa đúng.");
  }

  if (!state[storyKey].meta) {
    const storyHtml = await (await fetchWithRetry(fullStoryUrl, {}, jar)).text();
    const title = extractTitleFromHtml(storyHtml) || fullStoryUrl.split("/").pop();
    const coverUrl = parseCoverUrl(storyHtml);
    state[storyKey].meta = { id: sanitizeFilename(fullStoryUrl.split("/").pop()), title, author: "", url: fullStoryUrl, coverUrl };
    await saveState(stateFile, state);
  }

  const meta = state[storyKey].meta;
  const toc = parseTocAll(tocHtml);
  console.log(`🔎 Found chapters: ${toc.length}`);
  if (!toc.length) throw new Error("Không parse được danh sách chương từ TOC.");

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

  for (let i = 0; i < toc.length; i++) {
    const ch = toc[i];
    const cached = state[storyKey].chapters[ch.url];
    if (cached?.status === "done" && cached?.paras?.length) continue;

    console.log(`\n[${i + 1}/${toc.length}] ${ch.url}`);
    try {
      const html = await (await fetchWithRetry(ch.url, {}, jar)).text();
      const title = extractTitleFromHtml(html) || `Chương ${i + 1}`;
      const paras = parseChapterParagraphs(html);
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
    if (i < toc.length - 1) await sleep(throttleMs);
  }

  await saveState(stateFile, state);

  // Build chapters in TOC order
  const chapters = toc.map((c, idx) => {
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

