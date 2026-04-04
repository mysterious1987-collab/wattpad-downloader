#!/usr/bin/env node
/**
 * Cầu cục bộ cho tool HTML tải Bạch Ngọc Sách.
 *
 * Vì sao cần: trang HTML (file:// hoặc localhost khác) không thể gửi header Cookie
 * tới bachngocsach.cc (CORS + header bị cấm). Bridge chạy trên máy bạn, nhận
 * cookie do bạn dán từ DevTools và gắn vào request tới BNS.
 *
 * Chạy: node bns-browser-bridge.mjs
 * Mặc định: http://127.0.0.1:8799
 */
import http from "node:http";

const PORT = Number(process.env.BNS_BRIDGE_PORT || 8799);
const HOST = process.env.BNS_BRIDGE_HOST || "127.0.0.1";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, X-BNS-Cookie",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Content-Length": Buffer.byteLength(body, "utf8"),
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, X-BNS-Cookie",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    });
    res.end();
    return;
  }

  if (req.method === "GET" && req.url === "/ping") {
    return json(res, 200, { ok: true, service: "bns-browser-bridge", port: PORT });
  }

  if (req.method !== "POST" || req.url !== "/proxy") {
    return json(res, 404, { error: "not_found", hint: "POST /proxy or GET /ping" });
  }

  let raw = "";
  for await (const ch of req) raw += ch;

  let j;
  try {
    j = JSON.parse(raw);
  } catch {
    return json(res, 400, { error: "invalid_json" });
  }

  const url = j.url;
  if (!url || typeof url !== "string" || !/^https:\/\/(www\.)?bachngocsach\.cc\//i.test(url)) {
    return json(res, 400, {
      error: "bad_url",
      hint: "Chỉ cho phép https://bachngocsach.cc/...",
    });
  }

  const method = j.method === "POST" ? "POST" : "GET";
  const cookie = String(req.headers["x-bns-cookie"] || j.cookie || "").trim();

  const headers = {
    "User-Agent": UA,
    "Accept-Language": "vi-VN,vi;q=0.9,en-US;q=0.7,en;q=0.5",
    Accept:
      j.accept ||
      (method === "POST"
        ? "application/json, text/plain, */*"
        : "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"),
  };
  if (j.referer) headers.Referer = j.referer;
  if (j.origin !== false) headers.Origin = "https://bachngocsach.cc";
  if (cookie) headers.Cookie = cookie;

  if (method === "POST" && j.contentType) {
    headers["Content-Type"] = j.contentType;
  }

  let body;
  if (method === "POST" && j.body != null) {
    body = typeof j.body === "string" ? j.body : JSON.stringify(j.body);
  }

  try {
    const r = await fetch(url, { method, headers, body });
    const text = await r.text();
    return json(res, 200, { ok: r.ok, status: r.status, body: text });
  } catch (e) {
    return json(res, 502, { error: "fetch_failed", message: String(e.message || e) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`bns-browser-bridge → http://${HOST}:${PORT}`);
  console.log(`  GET  /ping`);
  console.log(`  POST /proxy  (JSON body + header X-BNS-Cookie)`);
});
