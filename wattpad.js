#!/usr/bin/env node
/**
 * Wattpad Batch Downloader — GitHub Actions edition v2.0
 *
 * Mục tiêu:
 * - Chạy được trong GitHub Actions (offline về phía máy bạn: tải artifact về).
 * - Resume nhờ state.json cache + thư mục song song *-bodies (tránh JSON.stringify toàn truyện → Invalid string length).
 * - Tốc độ tốt hơn v1.2 bằng cách giảm IO (save state theo lô) + tuỳ chọn delay.
 * - v1.9 / v2.0: sau chapter lấy từ cache không chờ throttle; TXT/MD/JSON — gộp hoặc per-chapter; save_every mặc định 1.
 * - v2.0: UI index.html gửi chapters_map khớp DOM (fix chọn subset chapter).
 *
 * Cách dùng:
 *   node wattpad.js --batch urls.txt --format epub --output ./output
 *   node wattpad.js --batch urls.txt --format txt --text-layout per-chapter
 *   node wattpad.js --batch urls.txt --chapters-map '{"123456":"1-5,10","789012":"all"}'
 */

"use strict";

import fetch from "node-fetch";
import fs from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import crypto from "crypto";
import { ZipWriter, BlobWriter, TextReader } from "@zip.js/zip.js";

// ══════════════════════════════════════════════════════════════
// CONFIG (defaults)
// ══════════════════════════════════════════════════════════════
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,*/*;q=0.9",
  "Accept-Language": "en-US,en;q=0.5",
};

// Delay giữa chapters (ms). Có thể giảm để tăng tốc nhưng dễ dính 429.
const DEFAULT_THROTTLE_MS = 900;
const PAGE_DELAY_MS = 300;
const MAX_RETRIES = 4;
const RETRY_DELAYS = [1500, 3500, 8000, 15000];

// Sau mỗi N chapter tải mạng mới ghi state (N=1 = mỗi chapter; tăng để giảm IO)
const DEFAULT_SAVE_EVERY = 1;

/** Khi --max-part-mb > 0: mỗi file txt/md/json không vượt quá ~N MB (UTF-8). Tối thiểu 512 KiB nếu giá trị quá nhỏ. */
const MIN_SPLIT_PART_BYTES = 512 * 1024;

// ══════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════
const sleep = ms => new Promise(r => setTimeout(r, ms));

function sanitizeFilename(s) {
  return s.replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, " ").trim().slice(0, 100);
}

function escXml(s) {
  return (s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function logLine(...args) { console.log(...args); }
function logStep(msg)     { process.stdout.write(`  ${msg}\r`); }

function sha16(s) {
  return crypto.createHash("sha256").update(String(s)).digest("hex").slice(0, 16);
}

/** Thư mục lưu nội dung từng chương (JSON array paras) — cạnh state.json */
function bodiesRoot(stateFile) {
  const base = path.basename(stateFile, path.extname(stateFile)) || "state";
  return path.join(path.dirname(stateFile), `${base}-bodies`);
}

function chapterBodyFilename(storyId, partUrl) {
  return `${String(storyId)}_${sha16(partUrl)}.json`;
}

/**
 * Gom chapters thành các nhóm; tổng (header phần + nội dung chương) ước lượng ≤ maxPartBytes.
 * Một chương vượt ngưỡng vẫn nằm một phần riêng (cảnh báo có thể bổ sung ở caller).
 */
function partitionChaptersByWeight(chapters, maxPartBytes, headBytesFn, chapterWeightFn) {
  if (!chapters.length) return [[]];
  const out = [];
  let i = 0;
  while (i < chapters.length) {
    const partNum = out.length + 1;
    const isFirst = out.length === 0;
    const headCost = headBytesFn(partNum, isFirst);
    let used = headCost;
    const start = i;
    while (i < chapters.length) {
      const w = chapterWeightFn(chapters[i]);
      if (used + w <= maxPartBytes) {
        used += w;
        i++;
        continue;
      }
      if (used === headCost) {
        used += w;
        i++;
      }
      break;
    }
    out.push(chapters.slice(start, i));
  }
  return out;
}

/**
 * Parse chuỗi chapter selection: "1-5,10,12-15" → Set {1,2,3,4,5,10,12,13,14,15}
 * "all" hoặc "" → null (= lấy tất cả)
 */
function parseChapterSelection(str) {
  if (!str || str.trim() === "all" || str.trim() === "") return null;
  const indices = new Set();
  for (const part of str.split(",")) {
    const t = part.trim();
    const range = t.match(/^(\d+)-(\d+)$/);
    if (range) {
      const from = parseInt(range[1]), to = parseInt(range[2]);
      for (let i = from; i <= to; i++) indices.add(i);
    } else if (/^\d+$/.test(t)) {
      indices.add(parseInt(t));
    }
  }
  return indices.size ? indices : null;
}

// ══════════════════════════════════════════════════════════════
// HTTP
// ══════════════════════════════════════════════════════════════
async function fetchWithRetry(url, opts = {}, retries = MAX_RETRIES) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: HEADERS,
        signal: AbortSignal.timeout(30000),
        ...opts,
      });
      if (res.ok) return res;

      if (res.status === 429) {
        const wait = (parseInt(res.headers.get("Retry-After") || "30")) * 1000;
        logLine(`  ⏳ Rate limited (429), đợi ${wait/1000}s...`);
        await sleep(wait);
        continue;
      }

      if (attempt === retries) throw new Error(`HTTP ${res.status}: ${url}`);
    } catch (e) {
      if (attempt === retries) throw e;
      const wait = RETRY_DELAYS[attempt] || 15000;
      logLine(`  ⚠ Lỗi (lần ${attempt + 1}): ${e.message} — thử lại sau ${wait/1000}s`);
      await sleep(wait);
    }
  }
}

async function fetchText(url) { return (await fetchWithRetry(url)).text(); }
async function fetchJson(url) {
  return (await fetchWithRetry(url, { headers: { ...HEADERS, Accept: "application/json" } })).json();
}

// ══════════════════════════════════════════════════════════════
// WATTPAD API
// ══════════════════════════════════════════════════════════════
function extractStoryId(url) {
  url = url.trim();
  if (!url.startsWith("http")) url = "https://" + url;
  const u = new URL(url);
  for (const part of u.pathname.split("/").filter(Boolean)) {
    const m = part.match(/^(\d+)/);
    if (m && m[1].length >= 4) return m[1];
  }
  const m = u.pathname.match(/\/(\d{5,})/);
  if (m) return m[1];
  throw new Error("Không tìm được Story ID từ: " + url);
}

async function fetchStoryMeta(storyId) {
  return fetchJson(
    `https://www.wattpad.com/api/v3/stories/${storyId}?fields=id,title,user,description,cover,tags,completed,parts(id,title,url,wordCount)`
  );
}

function extractTextUrlInfo(html) {
  const searchStr = '.metadata":{"data":';
  const idx = html.indexOf(searchStr);
  if (idx < 0) return null;
  let start = html.indexOf("{", idx + searchStr.length - 1);
  if (start < 0) return null;
  let depth = 0, end = start;
  for (; end < html.length; end++) {
    if (html[end] === "{") depth++;
    else if (html[end] === "}" && --depth === 0) break;
  }
  try {
    const raw = JSON.stringify(JSON.parse(html.slice(start, end + 1)));
    const ti = raw.indexOf('"text_url"');
    if (ti < 0) return null;
    const ts = raw.indexOf("{", ti);
    let d2 = 0, te = ts;
    for (; te < raw.length; te++) {
      if (raw[te] === "{") d2++;
      else if (raw[te] === "}" && --d2 === 0) break;
    }
    const tu = JSON.parse(raw.slice(ts, te + 1));
    const pm = raw.slice(Math.max(0, ti - 100), ti + 300).match(/"pages"\s*:\s*(\d+)/);
    return { textUrl: tu.text, refreshToken: tu.refresh_token, pages: pm ? parseInt(pm[1]) : 1 };
  } catch { return null; }
}

function decodeHtml(s) {
  return String(s)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function parseParagraphs(html) {
  const paras = [], seen = new Set();
  const re = /<p[^>]*data-p-id="([^"]*)"[^>]*>([\s\S]*?)<\/p>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const id = m[1];
    const text = decodeHtml(m[2].replace(/<[^>]+>/g, "")).trim();
    if (text && !seen.has(id)) { seen.add(id); paras.push({ id, text }); }
  }
  if (paras.length === 0) {
    const re2 = /<p[^>]*>([\s\S]*?)<\/p>/gi;
    while ((m = re2.exec(html)) !== null) {
      const text = decodeHtml(m[1].replace(/<[^>]+>/g, "")).trim();
      if (text && text.length > 3) paras.push({ id: null, text });
    }
  }
  return paras;
}

async function fetchChapter(part) {
  const html = await fetchText(part.url);
  const titleMatch = html.match(/<h1[^>]*class="[^"]*h2[^"]*"[^>]*>([\s\S]*?)<\/h1>/i) || html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const title = titleMatch ? decodeHtml(titleMatch[1].replace(/<[^>]+>/g, "")).trim() : part.title;
  const info = extractTextUrlInfo(html);
  if (!info || !info.textUrl) return { title, paras: parseParagraphs(html) };

  const qi = info.textUrl.indexOf("?");
  const base = (qi >= 0 ? info.textUrl.slice(0, qi) : info.textUrl).replace(/-\d+$/, "");
  let query = qi >= 0 ? info.textUrl.slice(qi) : "";
  const allParas = [], seenIds = new Set();

  for (let page = 1; page <= info.pages; page++) {
    const pageUrl = `${base}-${page}${query}`;
    let fetched = false;
    for (let retry = 0; retry < MAX_RETRIES && !fetched; retry++) {
      try {
        const pageHtml = await fetchText(pageUrl);
        for (const p of parseParagraphs(pageHtml)) {
          if (!p.id || !seenIds.has(p.id)) { if (p.id) seenIds.add(p.id); allParas.push(p); }
        }
        fetched = true;
        if (page < info.pages) await sleep(PAGE_DELAY_MS);
      } catch (e) {
        if (info.refreshToken) {
          try { const rt = await fetchJson(info.refreshToken); if (rt.token) query = "?" + rt.token; } catch {}
        }
        if (retry < MAX_RETRIES - 1) await sleep(RETRY_DELAYS[retry]);
        else logLine(`    ⚠ Page ${page} thất bại: ${e.message}`);
      }
    }
  }
  return { title, paras: allParas };
}

// ══════════════════════════════════════════════════════════════
// STATE
// ══════════════════════════════════════════════════════════════
async function loadState(stateFile) {
  try {
    if (!existsSync(stateFile)) return {};
    const data = JSON.parse(await fs.readFile(stateFile, "utf8"));
    const root = bodiesRoot(stateFile);
    for (const ss of Object.values(data)) {
      if (!ss || typeof ss !== "object" || !ss.chapters) continue;
      for (const ch of Object.values(ss.chapters)) {
        if (!ch || ch.paras?.length) continue;
        if (ch.bodyRef) {
          const bf = path.join(root, ch.bodyRef);
          if (existsSync(bf)) {
            try {
              ch.paras = JSON.parse(await fs.readFile(bf, "utf8"));
            } catch {
              ch.paras = [{ text: "[Lỗi đọc file cache chương]" }];
            }
          }
        }
      }
    }
    return data;
  } catch {
    return {};
  }
}

async function saveState(stateFile, state) {
  const root = bodiesRoot(stateFile);
  await fs.mkdir(root, { recursive: true });
  const forDisk = {};
  for (const [storyId, ss] of Object.entries(state)) {
    if (!ss || typeof ss !== "object") {
      forDisk[storyId] = ss;
      continue;
    }
    forDisk[storyId] = { meta: ss.meta, chapters: {} };
    for (const [url, ch] of Object.entries(ss.chapters || {})) {
      if (!ch) continue;
      const row = { status: ch.status, title: ch.title };
      if (Array.isArray(ch.paras) && ch.paras.length) {
        const fn = chapterBodyFilename(storyId, url);
        await fs.writeFile(path.join(root, fn), JSON.stringify(ch.paras), "utf8");
        row.bodyRef = fn;
      } else if (ch.bodyRef) {
        row.bodyRef = ch.bodyRef;
      }
      forDisk[storyId].chapters[url] = row;
    }
  }
  await fs.writeFile(stateFile, JSON.stringify(forDisk, null, 2), "utf8");
}

// ══════════════════════════════════════════════════════════════
// OUTPUT BUILDERS (ghi theo chương hoặc theo part giới hạn MB — tránh chuỗi quá lớn)
// ══════════════════════════════════════════════════════════════
function partFilePath(basePathNoExt, ext, partIndex1, totalParts) {
  if (totalParts <= 1) return `${basePathNoExt}.${ext}`;
  return `${basePathNoExt}_part${String(partIndex1).padStart(2, "0")}.${ext}`;
}

async function writeTxtFile(meta, chapters, basePathNoExt, maxPartBytes) {
  const fullHead = [meta.title, `by ${meta.user?.name || "Unknown"}`, "", meta.description || "", "", "═".repeat(60), ""].join("\n");
  const block = (ch) => `${ch.title}\n${"─".repeat(40)}\n${ch.paras.map(p => p.text).join("\n\n")}\n\n`;
  const shortHead = (pn) => `— ${meta.title} — (phần ${pn})\n\n`;

  if (!maxPartBytes || maxPartBytes <= 0) {
    const f = `${basePathNoExt}.txt`;
    await fs.writeFile(f, fullHead, "utf8");
    for (const ch of chapters) await fs.appendFile(f, block(ch), "utf8");
    return [f];
  }

  const effMax = Math.max(maxPartBytes, MIN_SPLIT_PART_BYTES);
  const groups = partitionChaptersByWeight(
    chapters,
    effMax,
    (pn, isFirst) => Buffer.byteLength(isFirst ? fullHead : shortHead(pn), "utf8"),
    (ch) => Buffer.byteLength(block(ch), "utf8"),
  );
  const total = groups.length;
  const files = [];
  for (let g = 0; g < total; g++) {
    const head = g === 0 ? fullHead : shortHead(g + 1);
    let content = head;
    for (const ch of groups[g]) content += block(ch);
    const fp = partFilePath(basePathNoExt, "txt", g + 1, total);
    await fs.writeFile(fp, content, "utf8");
    files.push(fp);
    if (Buffer.byteLength(content, "utf8") > effMax) {
      logLine(`   ⚠ Phần ${g + 1} TXT ~${Math.round(Buffer.byteLength(content, "utf8") / 1024 / 1024)} MB (> giới hạn — thường do một chương rất dài)`);
    }
  }
  return files;
}

async function writeMarkdownFile(meta, chapters, basePathNoExt, maxPartBytes) {
  const fullHead = [`# ${meta.title}`, `**Tác giả:** ${meta.user?.name || "Unknown"}`, "",
    meta.description ? `> ${meta.description.replace(/\n/g, "\n> ")}` : "", "", ""].join("\n");
  const block = (ch) => `## ${ch.title}\n\n${ch.paras.map(p => p.text).join("\n\n")}\n\n`;
  const shortHead = (pn) => `## ${meta.title} _(phần ${pn})_\n\n`;

  if (!maxPartBytes || maxPartBytes <= 0) {
    const f = `${basePathNoExt}.md`;
    await fs.writeFile(f, fullHead, "utf8");
    for (const ch of chapters) await fs.appendFile(f, block(ch), "utf8");
    return [f];
  }

  const effMax = Math.max(maxPartBytes, MIN_SPLIT_PART_BYTES);
  const groups = partitionChaptersByWeight(
    chapters,
    effMax,
    (pn, isFirst) => Buffer.byteLength(isFirst ? fullHead : shortHead(pn), "utf8"),
    (ch) => Buffer.byteLength(block(ch), "utf8"),
  );
  const total = groups.length;
  const files = [];
  for (let g = 0; g < total; g++) {
    const head = g === 0 ? fullHead : shortHead(g + 1);
    let content = head;
    for (const ch of groups[g]) content += block(ch);
    const fp = partFilePath(basePathNoExt, "md", g + 1, total);
    await fs.writeFile(fp, content, "utf8");
    files.push(fp);
    if (Buffer.byteLength(content, "utf8") > effMax) {
      logLine(`   ⚠ Phần ${g + 1} MD ~${Math.round(Buffer.byteLength(content, "utf8") / 1024 / 1024)} MB (> giới hạn)`);
    }
  }
  return files;
}

async function writeJsonFile(meta, chapters, basePathNoExt, maxPartBytes) {
  const jsonChapterObj = (ch) => ({ title: ch.title, text: ch.paras.map(p => p.text).join("\n\n") });
  const shellBytes = (partNum) =>
    Buffer.byteLength(
      JSON.stringify({
        title: meta.title,
        author: meta.user?.name,
        description: meta.description,
        cover: meta.cover,
        tags: meta.tags,
        completed: meta.completed,
        part: partNum,
        partsTotal: 999,
        chapters: [],
      }),
      "utf8",
    );

  if (!maxPartBytes || maxPartBytes <= 0) {
    const f = `${basePathNoExt}.json`;
    const open =
      `{"title":${JSON.stringify(meta.title)},"author":${JSON.stringify(meta.user?.name)},"description":${JSON.stringify(meta.description)},"cover":${JSON.stringify(meta.cover)},"tags":${JSON.stringify(meta.tags)},"completed":${JSON.stringify(meta.completed)},"chapters":[`;
    await fs.writeFile(f, open, "utf8");
    for (let i = 0; i < chapters.length; i++) {
      const obj = jsonChapterObj(chapters[i]);
      await fs.appendFile(f, (i ? "," : "") + JSON.stringify(obj), "utf8");
    }
    await fs.appendFile(f, "]}\n", "utf8");
    return [f];
  }

  const effMax = Math.max(maxPartBytes, MIN_SPLIT_PART_BYTES);
  const groups = partitionChaptersByWeight(
    chapters,
    effMax,
    (pn) => shellBytes(pn),
    (ch) => Buffer.byteLength(JSON.stringify(jsonChapterObj(ch)), "utf8") + 2,
  );
  const total = groups.length;
  const files = [];
  for (let g = 0; g < total; g++) {
    const body = {
      title: meta.title,
      author: meta.user?.name,
      description: meta.description,
      cover: meta.cover,
      tags: meta.tags,
      completed: meta.completed,
      part: g + 1,
      partsTotal: total,
      chapters: groups[g].map(jsonChapterObj),
    };
    const jsonStr = JSON.stringify(body, null, 2);
    const fp = partFilePath(basePathNoExt, "json", g + 1, total);
    await fs.writeFile(fp, jsonStr, "utf8");
    files.push(fp);
    if (Buffer.byteLength(jsonStr, "utf8") > effMax) {
      logLine(`   ⚠ Phần ${g + 1} JSON ~${Math.round(Buffer.byteLength(jsonStr, "utf8") / 1024 / 1024)} MB (> giới hạn)`);
    }
  }
  return files;
}

/** Một file mỗi chương — không áp dụng max_part_mb (chỉ dùng khi --text-layout per-chapter). */
function chapterFileSlug(ch, index0) {
  const t = sanitizeFilename(ch.title || "").replace(/^_+|_+$/g, "").slice(0, 72);
  return t || `chapter_${index0 + 1}`;
}

async function writePerChapterTxt(meta, chapters, basePathNoExt) {
  const dir = `${basePathNoExt}_txt_chapters`;
  await fs.mkdir(dir, { recursive: true });
  const head = [meta.title, `by ${meta.user?.name || "Unknown"}`, "", "═".repeat(40), ""].join("\n");
  const files = [];
  for (let i = 0; i < chapters.length; i++) {
    const ch = chapters[i];
    const slug = chapterFileSlug(ch, i);
    const fn = path.join(dir, `ch${String(i + 1).padStart(3, "0")}_${slug}.txt`);
    const body = `${ch.title}\n${"─".repeat(40)}\n${ch.paras.map(p => p.text).join("\n\n")}\n`;
    await fs.writeFile(fn, head + body, "utf8");
    files.push(fn);
  }
  return files;
}

async function writePerChapterMd(meta, chapters, basePathNoExt) {
  const dir = `${basePathNoExt}_md_chapters`;
  await fs.mkdir(dir, { recursive: true });
  const head = [`# ${meta.title}`, `**Tác giả:** ${meta.user?.name || "Unknown"}`, "", "---", ""].join("\n");
  const files = [];
  for (let i = 0; i < chapters.length; i++) {
    const ch = chapters[i];
    const slug = chapterFileSlug(ch, i);
    const fn = path.join(dir, `ch${String(i + 1).padStart(3, "0")}_${slug}.md`);
    const body = `## ${ch.title}\n\n${ch.paras.map(p => p.text).join("\n\n")}\n`;
    await fs.writeFile(fn, head + body, "utf8");
    files.push(fn);
  }
  return files;
}

async function writePerChapterJson(meta, chapters, basePathNoExt) {
  const dir = `${basePathNoExt}_json_chapters`;
  await fs.mkdir(dir, { recursive: true });
  const files = [];
  for (let i = 0; i < chapters.length; i++) {
    const ch = chapters[i];
    const slug = chapterFileSlug(ch, i);
    const fn = path.join(dir, `ch${String(i + 1).padStart(3, "0")}_${slug}.json`);
    const obj = {
      storyId: meta.id,
      storyTitle: meta.title,
      author: meta.user?.name,
      chapterIndex: i + 1,
      title: ch.title,
      text: ch.paras.map(p => p.text).join("\n\n"),
    };
    await fs.writeFile(fn, JSON.stringify(obj, null, 2), "utf8");
    files.push(fn);
  }
  return files;
}

async function toEpub(meta, chapters) {
  const bw = new BlobWriter("application/epub+zip");
  const zw = new ZipWriter(bw, { useWebWorkers: false });
  await zw.add("mimetype", new TextReader("application/epub+zip"), { compressionMethod: 0 });
  await zw.add("META-INF/container.xml", new TextReader(`<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`));
  await zw.add("OEBPS/stylesheet.css", new TextReader(`body{font-family:Georgia,serif;line-height:1.75;margin:2em auto;max-width:36em;padding:0 1.2em}h2{margin:1.5em 0 .5em}p{margin:0 0 .9em;text-indent:1.2em}p:first-of-type{text-indent:0}`));
  const files = [];
  for (let i = 0; i < chapters.length; i++) {
    const ch = chapters[i], fn = `ch${String(i+1).padStart(4,"0")}.xhtml`;
    const body = ch.paras.map(p=>`<p>${escXml(p.text)}</p>`).join("");
    await zw.add(`OEBPS/Text/${fn}`, new TextReader(`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd"><html xmlns="http://www.w3.org/1999/xhtml"><head><meta charset="UTF-8"/><title>${escXml(ch.title)}</title><link rel="stylesheet" type="text/css" href="../stylesheet.css"/></head><body><h2>${escXml(ch.title)}</h2>${body}</body></html>`));
    files.push({ fn, title: ch.title, id: `c${i+1}` });
  }
  const items = files.map(f=>`<item id="${f.id}" href="Text/${f.fn}" media-type="application/xhtml+xml"/>`).join("");
  const spine = files.map(f=>`<itemref idref="${f.id}"/>`).join("");
  await zw.add("OEBPS/content.opf", new TextReader(`<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="uid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${escXml(meta.title)}</dc:title><dc:creator>${escXml(meta.user?.name||"")}</dc:creator><dc:language>en</dc:language><dc:identifier id="uid">${meta.id}</dc:identifier></metadata><manifest><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/><item id="css" href="stylesheet.css" media-type="text/css"/>${items}</manifest><spine toc="ncx">${spine}</spine></package>`));
  await zw.add("OEBPS/toc.ncx", new TextReader(`<?xml version="1.0" encoding="UTF-8"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="${meta.id}"/></head><docTitle><text>${escXml(meta.title)}</text></docTitle><navMap>${files.map((f,i)=>`<navPoint id="${f.id}" playOrder="${i+1}"><navLabel><text>${escXml(f.title)}</text></navLabel><content src="Text/${f.fn}"/></navPoint>`).join("")}</navMap></ncx>`));
  return Buffer.from(await (await zw.close()).arrayBuffer());
}

// ══════════════════════════════════════════════════════════════
// CORE DOWNLOAD
// ══════════════════════════════════════════════════════════════
async function downloadStory(url, formats, outputDir, state, stateFile, opts) {
  logLine(`\n${"─".repeat(60)}`);
  logLine(`📖 ${url}`);
  const storyId = extractStoryId(url);
  if (!state[storyId]) state[storyId] = { meta: null, chapters: {} };
  const storyState = state[storyId];

  if (!storyState.meta) {
    logLine(`   Đang lấy metadata...`);
    storyState.meta = await fetchStoryMeta(storyId);
    await saveState(stateFile, state);
  }

  const meta = storyState.meta;
  const parts = meta.parts || [];
  logLine(`   📚 ${meta.title}`);
  logLine(`   ✍  ${meta.user?.name || "Unknown"}`);

  const selectedParts = opts.chapterSelection
    ? parts.filter((_, i) => opts.chapterSelection.has(i + 1))
    : parts;

  logLine(
    opts.chapterSelection
      ? `   📑 ${selectedParts.length}/${parts.length} chapters (theo chapters_map / UI)`
      : `   📑 ${selectedParts.length}/${parts.length} chapters được chọn`,
  );

  const doneCount = selectedParts.filter(p => {
    const c = storyState.chapters[p.url];
    return c?.status === "done" && c?.paras?.length > 0;
  }).length;
  if (doneCount > 0) logLine(`   ✅ Resume: ${doneCount}/${selectedParts.length} chapters đã có trong cache`);

  const saveBatch = Math.max(1, opts.saveEvery);
  let netChaptersSinceSave = 0;

  for (let i = 0; i < selectedParts.length; i++) {
    const part = selectedParts[i];
    const cached = storyState.chapters[part.url];
    let fetchedFromNetwork = false;
    if (cached?.status === "done" && cached?.paras?.length > 0) {
      logStep(`   [${i+1}/${selectedParts.length}] ✓ ${part.title.slice(0,50)} (cache)`);
    } else {
      fetchedFromNetwork = true;
      logLine(`   [${i+1}/${selectedParts.length}] Đang tải: ${part.title.slice(0,50)}...`);
      try {
        const ch = await fetchChapter(part);
        if (ch.paras.length === 0) {
          storyState.chapters[part.url] = { status: "empty", title: part.title, paras: [{ text: "[Chapter trống hoặc bị khoá]" }] };
        } else {
          logLine(`   ✓ ${ch.paras.length} đoạn văn`);
          storyState.chapters[part.url] = { status: "done", title: ch.title || part.title, paras: ch.paras };
        }
      } catch (e) {
        logLine(`   ✗ Lỗi: ${e.message}`);
        storyState.chapters[part.url] = { status: "error", title: part.title, paras: [{ text: `[Lỗi: ${e.message}]` }] };
      }

      netChaptersSinceSave++;
      if (netChaptersSinceSave >= saveBatch) {
        await saveState(stateFile, state);
        netChaptersSinceSave = 0;
      }
    }

    // Chỉ delay sau khi vừa gọi mạng — bỏ qua khi chỉ đọc cache (resume nhanh hơn)
    if (fetchedFromNetwork && i < selectedParts.length - 1) await sleep(opts.throttleMs);
  }

  // flush state
  await saveState(stateFile, state);

  const chapters = selectedParts.map(part => {
    const cached = storyState.chapters[part.url];
    return { title: cached?.title || part.title, paras: cached?.paras || [{ text: "[Chưa tải được]" }] };
  });

  const safe = sanitizeFilename(meta.title);
  const basePathNoExt = path.join(outputDir, safe);
  const results = [];
  for (const fmt of formats) {
    logLine(`   Đang xuất ${fmt.toUpperCase()}...`);
    try {
      if (fmt === "epub") {
        const filename = `${basePathNoExt}.epub`;
        await fs.writeFile(filename, await toEpub(meta, chapters));
        logLine(`   💾 ${filename}`);
        results.push({ ok: true, filename });
      } else {
        const maxB = opts.maxPartBytes || 0;
        const perCh = opts.textLayout === "per-chapter";
        let files;
        if (perCh) {
          if (fmt === "txt") files = await writePerChapterTxt(meta, chapters, basePathNoExt);
          else if (fmt === "md") files = await writePerChapterMd(meta, chapters, basePathNoExt);
          else files = await writePerChapterJson(meta, chapters, basePathNoExt);
          for (const fn of files) logLine(`   💾 ${fn}`);
          logLine(`   📂 ${fmt.toUpperCase()}: ${files.length} file (mỗi chương một file; --max-part-mb chỉ áp dụng khi gộp)`);
        } else {
          if (fmt === "txt") files = await writeTxtFile(meta, chapters, basePathNoExt, maxB);
          else if (fmt === "md") files = await writeMarkdownFile(meta, chapters, basePathNoExt, maxB);
          else files = await writeJsonFile(meta, chapters, basePathNoExt, maxB);
          for (const fn of files) logLine(`   💾 ${fn}`);
          if (files.length > 1 && maxB > 0) {
            logLine(`   📎 ${fmt.toUpperCase()}: ${files.length} file (tối đa ~${opts.maxPartMb} MB UTF-8 mỗi phần)`);
          }
        }
        for (const fn of files) results.push({ ok: true, filename: fn });
      }
    } catch (e) {
      logLine(`   ✗ Xuất ${fmt} thất bại: ${e.message}`);
      results.push({ ok: false, fmt, error: e.message });
    }
  }
  return results;
}

// ══════════════════════════════════════════════════════════════
// CLI
// ══════════════════════════════════════════════════════════════
async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("--help")) {
    console.log(`
Wattpad Downloader v2.0
=======================
node wattpad.js [url...]            Tải trực tiếp
node wattpad.js --batch urls.txt    Tải từ file

Options:
  --format epub,txt,md,json     (mặc định: epub)
  --output <dir>                (mặc định: ./output)
  --state  <file>               (mặc định: ./state.json)
  --batch  <urls.txt>
  --chapters-map <json>         Ví dụ: '{"123456":"1-5,10","789012":"all"}'
  --throttle-ms <ms>            Delay giữa chapters (mặc định: ${DEFAULT_THROTTLE_MS}; chỉ sau request mạng)
  --save-every <n>              Ghi state sau mỗi n chapter tải mạng (mặc định: ${DEFAULT_SAVE_EVERY} = mỗi chapter). N>1 giảm IO
  --max-part-mb <số>            TXT/MD/JSON (chế độ gộp): tối đa MB mỗi phần. 0 = một file. Vd: 20
  --text-layout merged|per-chapter   TXT/MD/JSON: gộp file (mặc định) hoặc mỗi chương một file (bỏ qua max_part khi per-chapter)
`);
    process.exit(0);
  }

  let formats = ["epub"], outputDir = "./output", stateFile = "./state.json";
  let batchFile = null, urls = [], chaptersMap = {};
  let throttleMs = DEFAULT_THROTTLE_MS;
  let saveEvery = DEFAULT_SAVE_EVERY;
  let maxPartMb = 0;
  let textLayout = "merged";

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if      (a === "--format"       && args[i+1]) formats   = args[++i].split(",").map(s=>s.trim()).filter(s=>["epub","txt","md","json"].includes(s));
    else if (a === "--output"       && args[i+1]) outputDir = args[++i];
    else if (a === "--state"        && args[i+1]) stateFile = args[++i];
    else if (a === "--batch"        && args[i+1]) batchFile = args[++i];
    else if (a === "--throttle-ms"  && args[i+1]) throttleMs = Math.max(0, parseInt(args[++i] || String(DEFAULT_THROTTLE_MS), 10));
    else if (a === "--save-every"   && args[i+1]) saveEvery  = Math.max(1, parseInt(args[++i] || String(DEFAULT_SAVE_EVERY), 10));
    else if (a === "--text-layout"  && args[i+1]) {
      const v = String(args[++i]).trim().toLowerCase().replace(/_/g, "-");
      if (v === "per-chapter" || v === "perchapter") textLayout = "per-chapter";
      else textLayout = "merged";
    }
    else if (a === "--max-part-mb"  && args[i+1]) {
      const v = parseFloat(String(args[++i]).replace(",", "."));
      maxPartMb = Number.isFinite(v) && v > 0 ? v : 0;
    }
    else if (a === "--chapters-map" && args[i+1]) {
      try {
        const raw = JSON.parse(args[++i]);
        for (const [sid, sel] of Object.entries(raw)) chaptersMap[sid] = parseChapterSelection(sel);
      } catch (e) { console.error("⚠ --chapters-map không hợp lệ:", e.message); }
    } else if (!a.startsWith("--")) urls.push(a);
  }

  if (!formats.length) { console.error("❌ Format không hợp lệ"); process.exit(1); }

  const maxPartBytes = maxPartMb > 0 ? Math.floor(maxPartMb * 1024 * 1024) : 0;

  if (batchFile) {
    const content = await fs.readFile(batchFile, "utf8");
    urls = [...urls, ...content.split("\n").map(l=>l.trim()).filter(l=>l&&!l.startsWith("#")&&l.includes("wattpad"))];
  }

  if (!urls.length) { console.error("❌ Cần ít nhất 1 URL"); process.exit(1); }

  await fs.mkdir(outputDir, { recursive: true });
  const state = await loadState(stateFile);

  console.log(`\n${"═".repeat(60)}`);
  console.log(`Wattpad Downloader v2.0`);
  console.log(`Format : ${formats.join(", ").toUpperCase()}`);
  console.log(`Output : ${outputDir} | State: ${stateFile}`);
  console.log(`Stories: ${urls.length}`);
  console.log(`Speed  : throttle=${throttleMs}ms (sau tải mạng) | saveEvery=${saveEvery}`);
  if (formats.some(f => ["txt", "md", "json"].includes(f))) {
    console.log(`Layout : ${textLayout === "per-chapter" ? "per-chapter (mỗi chương một file)" : "merged (gộp)"}`);
  }
  if (maxPartMb > 0 && textLayout !== "per-chapter") console.log(`Parts  : TXT/MD/JSON gộp — tối đa ~${maxPartMb} MB/phần (UTF-8)`);
  if (maxPartMb > 0 && textLayout === "per-chapter") console.log(`Parts  : max_part_mb bỏ qua khi per-chapter (mỗi file = một chương)`);
  console.log(`${"═".repeat(60)}`);

  const summary = { ok: [], fail: [] };
  for (const url of urls) {
    try {
      let selection = null;
      if (Object.keys(chaptersMap).length) {
        try { selection = chaptersMap[extractStoryId(url)] ?? null; } catch {}
      }
      const results = await downloadStory(
        url,
        formats,
        outputDir,
        state,
        stateFile,
        { chapterSelection: selection, throttleMs, saveEvery, maxPartBytes, maxPartMb, textLayout },
      );
      summary.ok.push({ url, files: results.filter(r=>r.ok).map(r=>r.filename) });
    } catch (e) {
      console.error(`\n❌ Lỗi story ${url}: ${e.message}`);
      summary.fail.push({ url, error: e.message });
    }
  }

  console.log(`\n${"═".repeat(60)}`);
  console.log(`✅ Thành công: ${summary.ok.length} / ${urls.length} story`);
  summary.ok.forEach(r => console.log(`   ${path.basename(r.files[0]||"")}`));
  if (summary.fail.length) {
    console.log(`❌ Thất bại: ${summary.fail.length}`);
    summary.fail.forEach(r => console.log(`   ${r.url}: ${r.error}`));
  }
  console.log(`${"═".repeat(60)}\n`);
  if (summary.fail.length) process.exit(1);
}

main().catch(e => { console.error("Lỗi:", e); process.exit(1); });

