#!/usr/bin/env node
/**
 * Mở Chromium (Playwright), bạn đăng nhập BNS trên cửa sổ đó, rồi xuất cookie
 * dạng header `Cookie:` để dán vào tab BNS của wattpad-bns-downloader-v2.2.html.
 *
 * Cài đặt lần đầu (trong thư mục repo):
 *   npm install
 *   npx playwright install chromium
 *
 * Chạy:
 *   node bns-playwright-cookie.mjs
 *   node bns-playwright-cookie.mjs --out my-cookie.txt
 *   node bns-playwright-cookie.mjs --user-data-dir ./.bns-playwright-profile
 *
 * --user-data-dir: giữ profile → lần sau có thể vẫn đăng nhập sẵn (Enter ngay).
 */
import { chromium } from "playwright";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import fs from "node:fs/promises";
import path from "node:path";

const BNS_URLS = ["https://bachngocsach.cc/", "https://www.bachngocsach.cc/"];

function parseArgs() {
  const o = {
    out: "bns-cookie-export.txt",
    userDataDir: null,
    startUrl: "https://bachngocsach.cc/",
    help: false,
  };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") o.help = true;
    else if (a === "--out") o.out = argv[++i] || o.out;
    else if (a === "--user-data-dir") o.userDataDir = argv[++i] || null;
    else if (a === "--url") o.startUrl = argv[++i] || o.startUrl;
  }
  return o;
}

function cookieHeaderString(cookies) {
  const byName = new Map();
  const sorted = [...cookies].sort((a, b) => b.path.length - a.path.length);
  for (const c of sorted) {
    if (!byName.has(c.name)) byName.set(c.name, c.value);
  }
  return [...byName.entries()].map(([n, v]) => `${n}=${v}`).join("; ");
}

function printHelp() {
  console.log(`bns-playwright-cookie.mjs — xuất cookie BNS cho bridge/HTML tool

  node bns-playwright-cookie.mjs [tùy chọn]

  --out <file>           Ghi chuỗi cookie (mặc định: bns-cookie-export.txt)
  --user-data-dir <dir>  Profile Chromium bền (giữ phiên đăng nhập)
  --url <url>            Trang mở đầu (mặc định: https://bachngocsach.cc/)

Lần đầu: npm install && npx playwright install chromium
`);
}

async function waitEnter(message) {
  const rl = createInterface({ input, output });
  try {
    await rl.question(message);
  } finally {
    rl.close();
  }
}

async function main() {
  const args = parseArgs();
  if (args.help) {
    printHelp();
    return;
  }

  let browser;
  let context;
  let closeAll;

  if (args.userDataDir) {
    const dir = path.resolve(args.userDataDir);
    await fs.mkdir(dir, { recursive: true });
    context = await chromium.launchPersistentContext(dir, {
      headless: false,
      viewport: { width: 1280, height: 820 },
      locale: "vi-VN",
    });
    closeAll = async () => {
      await context.close();
    };
  } else {
    const launchOpts = { headless: false };
    if (process.env.PLAYWRIGHT_CHROME_CHANNEL) {
      launchOpts.channel = process.env.PLAYWRIGHT_CHROME_CHANNEL;
    }
    browser = await chromium.launch(launchOpts);
    context = await browser.newContext({
      locale: "vi-VN",
      viewport: { width: 1280, height: 820 },
    });
    closeAll = async () => {
      await context.close();
      await browser.close();
    };
  }

  const page = context.pages()[0] || (await context.newPage());

  console.log("\n→ Đang mở trình duyệt. Hãy đăng nhập bachngocsach.cc (nếu cần).\n");
  await page.goto(args.startUrl, { waitUntil: "domcontentloaded" });

  await waitEnter(
    "Sau khi đã đăng nhập và thấy trang Reader hoạt động bình thường, quay lại terminal và nhấn Enter để xuất cookie…\n"
  );

  const raw = await context.cookies(BNS_URLS);
  const header = cookieHeaderString(raw);

  if (!header) {
    console.error(
      "\nKhông lấy được cookie cho bachngocsach.cc. Thử đăng nhập rồi mở một trang trên cùng domain, sau đó chạy lại.\n"
    );
    await closeAll();
    process.exitCode = 1;
    return;
  }

  const outPath = path.resolve(args.out);
  await fs.writeFile(outPath, header, "utf8");

  console.log(`\nĐã ghi ${raw.length} cookie → ${outPath}`);
  console.log("Dán nội dung file vào ô Cookie trong tab BNS (hoặc mở file copy).\n");
  console.log("— Không commit file cookie lên git; có thể chứa phiên đăng nhập.\n");

  await closeAll();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
