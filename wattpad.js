#!/usr/bin/env node
/**
 * Wattpad Batch Downloader — GitHub Actions edition
 * 
 * Cách dùng:
 *   node wattpad.js --batch urls.txt --format epub --output ./output
 *   node wattpad.js https://www.wattpad.com/story/123456-ten-truyen --format txt
 * 
 * Tính năng:
 *   - Lấy đúng toàn bộ nội dung chapter qua text_url API (giống browser)
 *   - Auto-resume: lưu tiến độ vào state.json, chạy lại sẽ bỏ qua chapter đã xong
 *   - Retry tự động khi gặp lỗi mạng
 *   - Xuất EPUB / TXT / Markdown / JSON
 *   - Multi-format: --format epub,txt  (xuất cả 2 cùng lúc)
 */

"use strict";

import fetch from "node-fetch";
import fs from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { ZipWriter, BlobWriter, TextReader } from "@zip.js/zip.js";

// ══════════════════════════════════════════════════════════════
// CONFIG
// ══════════════════════════════════════════════════════════════
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,*/*;q=0.9",
  "Accept-Language": "en-US,en;q=0.5",
};

const THROTTLE_MS   = 1200;  // delay giữa các chapter
const PAGE_DELAY_MS = 400;   // delay giữa các trang trong chapter
const MAX_RETRIES   = 4;     // số lần retry khi lỗi
const RETRY_DELAYS  = [2000, 5000, 10000, 20000]; // delay tăng dần (ms)

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

// ══════════════════════════════════════════════════════════════
// HTTP — fetch with retry
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
      // 429 = rate limited — wait longer
      if (res.status === 429) {
        const wait = (parseInt(res.headers.get("Retry-After") || "30")) * 1000;
        logLine(`  ⏳ Rate limited, đợi ${wait/1000}s...`);
        await sleep(wait);
        continue;
      }
      if (attempt === retries) throw new Error(`HTTP ${res.status}: ${url}`);
    } catch (e) {
      if (attempt === retries) throw e;
      const wait = RETRY_DELAYS[attempt] || 20000;
      logLine(`  ⚠ Lỗi (lần ${attempt + 1}): ${e.message} — thử lại sau ${wait/1000}s`);
      await sleep(wait);
    }
  }
}

async function fetchText(url) {
  const res = await fetchWithRetry(url);
  return res.text();
}

async function fetchJson(url) {
  const res = await fetchWithRetry(url, {
    headers: { ...HEADERS, Accept: "application/json" },
  });
  return res.json();
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
  const url = `https://www.wattpad.com/api/v3/stories/${storyId}?fields=id,title,user,description,cover,tags,completed,parts(id,title,url,wordCount)`;
  return fetchJson(url);
}

// ── Extract text_url info from chapter HTML ──
// Wattpad nhúng JSON vào <script> chứa text_url — đây là nguồn nội dung thật.
// HTML page chỉ có ~1 đoạn preview, toàn bộ nội dung nằm ở text_url.
function extractTextUrlInfo(html) {
  const searchStr = '.metadata":{"data":';
  const idx = html.indexOf(searchStr);
  if (idx < 0) return null;

  // Tìm { mở đầu JSON block
  let start = html.indexOf("{", idx + searchStr.length - 1);
  if (start < 0) return null;

  // Bracket-count để tìm cuối JSON block
  let depth = 0, end = start;
  for (; end < html.length; end++) {
    if (html[end] === "{") depth++;
    else if (html[end] === "}" && --depth === 0) break;
  }

  try {
    const raw = JSON.stringify(JSON.parse(html.slice(start, end + 1)));

    // Tìm text_url object trong JSON
    const ti = raw.indexOf('"text_url"');
    if (ti < 0) return null;

    const ts = raw.indexOf("{", ti);
    let d2 = 0, te = ts;
    for (; te < raw.length; te++) {
      if (raw[te] === "{") d2++;
      else if (raw[te] === "}" && --d2 === 0) break;
    }
    const tu = JSON.parse(raw.slice(ts, te + 1));

    // Lấy số trang
    const pm = raw.slice(Math.max(0, ti - 100), ti + 300).match(/"pages"\s*:\s*(\d+)/);

    return {
      textUrl:      tu.text,
      refreshToken: tu.refresh_token,
      pages:        pm ? parseInt(pm[1]) : 1,
    };
  } catch {
    return null;
  }
}

// ── Parse paragraphs từ HTML thuần (kết quả text_url API) ──
function parseParagraphs(html) {
  // Không dùng JSDOM — parse thủ công bằng regex để nhẹ hơn
  const paras = [];
  const seen  = new Set();

  // Match <p data-p-id="...">...</p>
  const re = /<p[^>]*data-p-id="([^"]*)"[^>]*>([\s\S]*?)<\/p>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const id   = m[1];
    const text = m[2].replace(/<[^>]+>/g, "").replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&nbsp;/g," ").trim();
    if (text && !seen.has(id)) {
      seen.add(id);
      paras.push({ id, text });
    }
  }

  // Fallback: nếu không có data-p-id, lấy tất cả <p>
  if (paras.length === 0) {
    const re2 = /<p[^>]*>([\s\S]*?)<\/p>/gi;
    while ((m = re2.exec(html)) !== null) {
      const text = m[1].replace(/<[^>]+>/g, "").trim();
      if (text && text.length > 3) paras.push({ id: null, text });
    }
  }

  return paras;
}

// ── Fetch toàn bộ nội dung 1 chapter ──
async function fetchChapter(part) {
  // Bước 1: lấy HTML trang chapter để tìm text_url
  const html = await fetchText(part.url);

  // Lấy title từ HTML nếu cần
  const titleMatch = html.match(/<h1[^>]*class="[^"]*h2[^"]*"[^>]*>([\s\S]*?)<\/h1>/i)
    || html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const title = titleMatch
    ? titleMatch[1].replace(/<[^>]+>/g, "").trim()
    : part.title;

  // Bước 2: extract text_url từ <script> tags
  const info = extractTextUrlInfo(html);

  if (!info || !info.textUrl) {
    // Fallback: parse paragraphs trực tiếp từ HTML trang
    return { title, paras: parseParagraphs(html) };
  }

  // Bước 3: fetch từng trang qua text_url API
  const qi      = info.textUrl.indexOf("?");
  const base    = (qi >= 0 ? info.textUrl.slice(0, qi) : info.textUrl).replace(/-\d+$/, "");
  let   query   = qi >= 0 ? info.textUrl.slice(qi) : "";

  const allParas = [];
  const seenIds  = new Set();

  for (let page = 1; page <= info.pages; page++) {
    const pageUrl = `${base}-${page}${query}`;
    let fetched   = false;

    for (let retry = 0; retry < MAX_RETRIES && !fetched; retry++) {
      try {
        const pageHtml = await fetchText(pageUrl);
        for (const p of parseParagraphs(pageHtml)) {
          if (!p.id || !seenIds.has(p.id)) {
            if (p.id) seenIds.add(p.id);
            allParas.push(p);
          }
        }
        fetched = true;
        if (page < info.pages) await sleep(PAGE_DELAY_MS);
      } catch (e) {
        // Thử refresh token
        if (info.refreshToken) {
          try {
            const rt = await fetchJson(info.refreshToken);
            if (rt.token) query = "?" + rt.token;
          } catch { /* bỏ qua */ }
        }
        if (retry < MAX_RETRIES - 1) await sleep(RETRY_DELAYS[retry]);
        else logLine(`    ⚠ Page ${page} thất bại: ${e.message}`);
      }
    }
  }

  return { title, paras: allParas };
}

// ══════════════════════════════════════════════════════════════
// STATE / RESUME
// ══════════════════════════════════════════════════════════════
// state.json lưu tiến độ download, cho phép resume khi chạy lại
// {
//   storyId: {
//     meta: {...},
//     chapters: {
//       "url": { status: "done"|"error", title, paras: [...] }
//     }
//   }
// }

async function loadState(stateFile) {
  try {
    if (!existsSync(stateFile)) return {};
    const raw = await fs.readFile(stateFile, "utf8");
    return JSON.parse(raw);
  } catch { return {}; }
}

async function saveState(stateFile, state) {
  await fs.writeFile(stateFile, JSON.stringify(state, null, 2), "utf8");
}

// ══════════════════════════════════════════════════════════════
// OUTPUT BUILDERS
// ══════════════════════════════════════════════════════════════
function toTxt(meta, chapters) {
  return [
    meta.title,
    `by ${meta.user?.name || "Unknown"}`,
    "",
    meta.description || "",
    "",
    "═".repeat(60),
    "",
    ...chapters.flatMap(ch => [
      ch.title,
      "─".repeat(40),
      ch.paras.map(p => p.text).join("\n\n"),
      "",
    ]),
  ].join("\n");
}

function toMarkdown(meta, chapters) {
  return [
    `# ${meta.title}`,
    `**Tác giả:** ${meta.user?.name || "Unknown"}`,
    "",
    meta.description ? `> ${meta.description.replace(/\n/g, "\n> ")}` : "",
    "",
    ...chapters.flatMap(ch => [
      `## ${ch.title}`,
      "",
      ch.paras.map(p => p.text).join("\n\n"),
      "",
    ]),
  ].join("\n");
}

function toJsonOutput(meta, chapters) {
  return JSON.stringify({
    title:       meta.title,
    author:      meta.user?.name,
    description: meta.description,
    cover:       meta.cover,
    tags:        meta.tags,
    completed:   meta.completed,
    chapters:    chapters.map(ch => ({
      title: ch.title,
      text:  ch.paras.map(p => p.text).join("\n\n"),
    })),
  }, null, 2);
}

async function toEpub(meta, chapters) {
  const bw = new BlobWriter("application/epub+zip");
  const zw = new ZipWriter(bw, { useWebWorkers: false });

  await zw.add("mimetype", new TextReader("application/epub+zip"), { compressionMethod: 0 });
  await zw.add("META-INF/container.xml", new TextReader(
    `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`
  ));
  await zw.add("OEBPS/stylesheet.css", new TextReader(
    `body{font-family:Georgia,serif;line-height:1.75;margin:2em auto;max-width:36em;padding:0 1.2em}h2{margin:1.5em 0 .5em}p{margin:0 0 .9em;text-indent:1.2em}p:first-of-type{text-indent:0}`
  ));

  const files = [];
  for (let i = 0; i < chapters.length; i++) {
    const ch = chapters[i];
    const fn = `ch${String(i + 1).padStart(4, "0")}.xhtml`;
    const body = ch.paras.map(p => `<p>${escXml(p.text)}</p>`).join("");
    await zw.add(`OEBPS/Text/${fn}`, new TextReader(
      `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd"><html xmlns="http://www.w3.org/1999/xhtml"><head><meta charset="UTF-8"/><title>${escXml(ch.title)}</title><link rel="stylesheet" type="text/css" href="../stylesheet.css"/></head><body><h2>${escXml(ch.title)}</h2>${body}</body></html>`
    ));
    files.push({ fn, title: ch.title, id: `c${i + 1}` });
  }

  const items = files.map(f => `<item id="${f.id}" href="Text/${f.fn}" media-type="application/xhtml+xml"/>`).join("");
  const spine = files.map(f => `<itemref idref="${f.id}"/>`).join("");
  await zw.add("OEBPS/content.opf", new TextReader(
    `<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="uid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${escXml(meta.title)}</dc:title><dc:creator>${escXml(meta.user?.name || "")}</dc:creator><dc:language>en</dc:language><dc:identifier id="uid">${meta.id}</dc:identifier></metadata><manifest><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/><item id="css" href="stylesheet.css" media-type="text/css"/>${items}</manifest><spine toc="ncx">${spine}</spine></package>`
  ));
  await zw.add("OEBPS/toc.ncx", new TextReader(
    `<?xml version="1.0" encoding="UTF-8"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="${meta.id}"/></head><docTitle><text>${escXml(meta.title)}</text></docTitle><navMap>${files.map((f, i) => `<navPoint id="${f.id}" playOrder="${i + 1}"><navLabel><text>${escXml(f.title)}</text></navLabel><content src="Text/${f.fn}"/></navPoint>`).join("")}</navMap></ncx>`
  ));

  const blob = await zw.close();
  return Buffer.from(await blob.arrayBuffer());
}

// ══════════════════════════════════════════════════════════════
// CORE DOWNLOAD
// ══════════════════════════════════════════════════════════════
async function downloadStory(url, formats, outputDir, state, stateFile) {
  logLine(`\n${"─".repeat(60)}`);
  logLine(`📖 ${url}`);

  const storyId = extractStoryId(url);

  // Load hoặc fetch metadata
  if (!state[storyId]) state[storyId] = { meta: null, chapters: {} };
  const storyState = state[storyId];

  if (!storyState.meta) {
    logLine(`   Đang lấy metadata...`);
    storyState.meta = await fetchStoryMeta(storyId);
    await saveState(stateFile, state);
  }

  const meta  = storyState.meta;
  const parts = meta.parts || [];
  logLine(`   📚 ${meta.title}`);
  logLine(`   ✍  ${meta.user?.name || "Unknown"}`);
  logLine(`   📑 ${parts.length} chapters`);

  // Đếm đã xong
  const doneCount = Object.values(storyState.chapters)
    .filter(c => c.status === "done" && c.paras?.length > 0).length;
  if (doneCount > 0) logLine(`   ✅ Resume: ${doneCount}/${parts.length} chapters đã có trong cache`);

  // ── Fetch từng chapter ──
  for (let i = 0; i < parts.length; i++) {
    const part    = parts[i];
    const cached  = storyState.chapters[part.url];
    const isDone  = cached?.status === "done" && cached?.paras?.length > 0;

    if (isDone) {
      logStep(`   [${i + 1}/${parts.length}] ✓ ${part.title.slice(0, 50)} (cache)`);
      continue;
    }

    logLine(`   [${i + 1}/${parts.length}] Đang tải: ${part.title.slice(0, 50)}...`);

    try {
      const ch = await fetchChapter(part);

      if (ch.paras.length === 0) {
        logLine(`   ⚠ Không có nội dung`);
        storyState.chapters[part.url] = {
          status: "empty", title: part.title, paras: [{ text: "[Chapter trống hoặc bị khoá]" }],
        };
      } else {
        logLine(`   ✓ ${ch.paras.length} đoạn văn`);
        storyState.chapters[part.url] = {
          status: "done", title: ch.title || part.title, paras: ch.paras,
        };
      }
    } catch (e) {
      logLine(`   ✗ Lỗi: ${e.message}`);
      storyState.chapters[part.url] = {
        status: "error", title: part.title, paras: [{ text: `[Lỗi: ${e.message}]` }],
      };
    }

    // Lưu state sau mỗi chapter
    await saveState(stateFile, state);

    if (i < parts.length - 1) await sleep(THROTTLE_MS);
  }

  // ── Assemble chapters theo thứ tự gốc ──
  const chapters = parts.map(part => {
    const cached = storyState.chapters[part.url];
    return {
      title: cached?.title || part.title,
      paras: cached?.paras || [{ text: "[Chưa tải được]" }],
    };
  });

  // ── Xuất file ──
  const safe = sanitizeFilename(meta.title);
  const results = [];

  for (const fmt of formats) {
    logLine(`   Đang xuất ${fmt.toUpperCase()}...`);
    const filename = path.join(outputDir, `${safe}.${fmt}`);
    try {
      if (fmt === "epub") {
        await fs.writeFile(filename, await toEpub(meta, chapters));
      } else {
        const text = fmt === "txt" ? toTxt(meta, chapters)
                   : fmt === "md"  ? toMarkdown(meta, chapters)
                   :                 toJsonOutput(meta, chapters);
        await fs.writeFile(filename, text, "utf8");
      }
      logLine(`   💾 ${filename}`);
      results.push({ ok: true, filename });
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
Wattpad Downloader — GitHub Actions edition
===========================================
node wattpad.js [url...]            Tải 1 hoặc nhiều URL trực tiếp
node wattpad.js --batch urls.txt    Tải từ file danh sách

Tùy chọn:
  --format epub,txt,md,json   Format xuất (mặc định: epub)
                              Có thể chỉ định nhiều: --format epub,txt
  --output <thư mục>          Thư mục lưu (mặc định: ./output)
  --state <file>              File lưu tiến độ (mặc định: ./state.json)
  --batch <urls.txt>          File danh sách URLs
`);
    process.exit(0);
  }

  // ── Parse args ──
  let formats   = ["epub"];
  let outputDir = "./output";
  let stateFile = "./state.json";
  let batchFile = null;
  let urls      = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--format" && args[i + 1]) {
      formats = args[++i].split(",").map(s => s.trim()).filter(s => ["epub","txt","md","json"].includes(s));
    } else if (a === "--output" && args[i + 1]) outputDir = args[++i];
    else if (a === "--state"  && args[i + 1]) stateFile = args[++i];
    else if (a === "--batch"  && args[i + 1]) batchFile = args[++i];
    else if (!a.startsWith("--")) urls.push(a);
  }

  if (!formats.length) { console.error("❌ Format không hợp lệ"); process.exit(1); }

  // ── Đọc batch file ──
  if (batchFile) {
    const content = await fs.readFile(batchFile, "utf8");
    const batchUrls = content.split("\n")
      .map(l => l.trim())
      .filter(l => l && !l.startsWith("#") && l.includes("wattpad"));
    urls = [...urls, ...batchUrls];
  }

  if (!urls.length) { console.error("❌ Cần ít nhất 1 URL"); process.exit(1); }

  // ── Setup ──
  await fs.mkdir(outputDir, { recursive: true });
  const state = await loadState(stateFile);

  console.log(`\n${"═".repeat(60)}`);
  console.log(`Wattpad Downloader`);
  console.log(`Format : ${formats.join(", ").toUpperCase()}`);
  console.log(`Output : ${outputDir}`);
  console.log(`State  : ${stateFile}`);
  console.log(`Stories: ${urls.length}`);
  console.log(`${"═".repeat(60)}`);

  // ── Download ──
  const summary = { ok: [], fail: [] };

  for (const url of urls) {
    try {
      const results = await downloadStory(url, formats, outputDir, state, stateFile);
      summary.ok.push({ url, files: results.filter(r => r.ok).map(r => r.filename) });
    } catch (e) {
      console.error(`\n❌ Lỗi story ${url}: ${e.message}`);
      summary.fail.push({ url, error: e.message });
    }
  }

  // ── Summary ──
  console.log(`\n${"═".repeat(60)}`);
  console.log(`✅ Thành công: ${summary.ok.length} / ${urls.length} story`);
  summary.ok.forEach(r => console.log(`   ${path.basename(r.files[0] || "")}`));
  if (summary.fail.length) {
    console.log(`❌ Thất bại  : ${summary.fail.length} story`);
    summary.fail.forEach(r => console.log(`   ${r.url}: ${r.error}`));
  }
  console.log(`${"═".repeat(60)}\n`);

  // Exit code 1 nếu có story thất bại (để Actions đánh dấu warning)
  if (summary.fail.length) process.exit(1);
}

main().catch(e => { console.error("Lỗi:", e); process.exit(1); });
