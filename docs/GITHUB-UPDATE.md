# Đưa gói v2.5 lên GitHub

Hướng dẫn copy snapshot `Object Github/v2.5` vào **root** repository GitHub rồi push. Không đẩy cả cây `Object Github/` (các bản v1.x–v2.4 chỉ lưu local).

## Chạy BAT (cách nhanh)

Double-click một trong hai file (cùng logic):

- `push-v2.5-github.bat` — ở **root** workspace (`wattpad.js` cạnh `Object Github/`)
- `Object Github/v2.5/push-github.bat` — chạy từ snapshot

BAT sẽ:

1. Đợi 3 giây (`Ctrl+C` để hủy)
2. Nếu ROOT chưa có `.git`: `git init -b main`, gắn origin `https://github.com/mysterious1987-collab/wattpad-downloader.git`, `fetch` rồi `reset --hard origin/main` (giữ lịch sử **v2.4**; thư mục `Object Github/` local không bị xóa)
3. Copy file lõi **v2.5** đè lên
4. `git add` đúng danh sách REPO-CORE (không add `Object Github/`, `node_modules/`, `output/`, `state`)
5. `git commit` nếu có thay đổi
6. `git push -u origin main` (**không** `--force`)

Cần Git đã cài (BAT tự tìm `git.exe` ở `Program Files` nếu PATH thiếu) và đã đăng nhập GitHub (Credential Manager / PAT). Token **không** nằm trong BAT. ROOT chưa clone vẫn chạy được.

Nếu không dùng BAT, làm tay từ mục 1 trở xuống.

## 1. Chuẩn bị

- Repo GitHub đã clone (nhánh mặc định **`main`** — `index.html` dispatch `ref: 'main'`).
- Thư mục gói: `Object Github/v2.5/`
- **Không** sửa `Object Github/v2.4/` (snapshot đóng băng).

## 2. Copy file lõi vào root repo

Copy **nội dung** `Object Github/v2.5/` (không copy chính thư mục `v2.5`) vào root repo:

| Copy | Ghi chú |
|------|---------|
| `wattpad.js`, `bns.js` | Script tải |
| `index.html` | UI (PAT + trigger Actions) |
| `package.json`, `package-lock.json`, `.gitignore` | |
| `urls.txt` | URL mặc định (tuỳ chọn) |
| `.github/workflows/download.yml` | Wattpad Downloader **v2.5** |
| `.github/workflows/bns-download.yml` | BNS Downloader **v2.5** |
| `bns-browser-bridge.mjs`, `bns-playwright-cookie.mjs` | BNS helper |
| `docs/` | GUIDE, HISTORY, PLAN, **GITHUB-UPDATE.md** |
| `README.md` | |
| `REPO-CORE-V2.5.txt` | (tuỳ chọn, tham chiếu) |

**Không push:** `node_modules/`, `output/`, `state.json`, `state-bodies/`, `bns-state.json`, cookie/profile BNS.

PowerShell (đang đứng ở workspace `Wattpad downloader Github`, repo GitHub là thư mục khác — sửa `DEST`):

```powershell
$SRC = "Object Github\v2.5"
$DEST = "D:\path\to\your-github-repo"   # root clone, không phải Object Github

Copy-Item "$SRC\wattpad.js","$SRC\bns.js","$SRC\index.html","$SRC\package.json","$SRC\package-lock.json","$SRC\.gitignore","$SRC\urls.txt","$SRC\README.md" -Destination $DEST -Force
Copy-Item "$SRC\bns-browser-bridge.mjs","$SRC\bns-playwright-cookie.mjs" -Destination $DEST -Force
Copy-Item "$SRC\.github" -Destination $DEST -Recurse -Force
Copy-Item "$SRC\docs" -Destination $DEST -Recurse -Force
Copy-Item "$SRC\REPO-CORE-V2.5.txt" -Destination $DEST -Force
```

Nếu repo GitHub **chính là** root workspace này (file `wattpad.js` nằm cạnh `Object Github/`), copy như trên với `$DEST` = thư mục gốc workspace.

## 3. Commit và push

```bash
cd /path/to/your-github-repo
git status
git add wattpad.js bns.js index.html package.json package-lock.json .gitignore urls.txt README.md
git add .github/workflows/download.yml .github/workflows/bns-download.yml
git add bns-browser-bridge.mjs bns-playwright-cookie.mjs
git add docs README.md REPO-CORE-V2.5.txt
git commit -m "v2.5: giữ xuống dòng khi xuất TXT/MD/JSON (br → đoạn văn)"
git push origin main
```

## 4. Kiểm tra trên GitHub

1. Tab **Actions** — workflow hiện **Wattpad Downloader v2.5** và **BNS Downloader v2.5**.
2. Run Wattpad, format **txt** (cùng truyện từng bị dính một dòng). Artifact TXT phải có **dòng trống giữa các đoạn**, giống EPUB.
3. Lần chạy đầu sau update **tải lại chương** (cache key `wattpad-state-v2.5-…` không dùng body v2.4).

## 5. Secrets / UI — không đổi

- Secrets BNS (`BNS_USERNAME`, `BNS_PASSWORD`) giữ nguyên.
- PAT trên `index.html` vẫn gọi `download.yml` / `bns-download.yml`.
- Nhánh phải là `main` (hoặc sửa `ref` trong `index.html`).

## 6. Chạy local (tuỳ chọn)

```bash
cd "Object Github/v2.5"
npm install
node wattpad.js --help
node wattpad.js --batch urls.txt --format txt,epub --output ./output --state ./state.json
```
