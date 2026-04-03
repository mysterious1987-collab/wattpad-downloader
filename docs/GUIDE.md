## Wattpad Downloader — GitHub Actions (v1.6)

Mục tiêu: chạy tải **trên GitHub Actions**, rồi bạn tải file về máy qua **artifact**, để máy bạn “offline” khỏi việc crawl Wattpad.

### Files quan trọng

- `.github/workflows/download.yml`: workflow trigger.
- `wattpad.js`: script tải + xuất file.
- `urls.txt`: (tuỳ chọn) list URL mặc định.
- `state.json`: state cache (tự sinh) để resume.
- `output/`: output (tự sinh).

### Step-by-step: chạy trên GitHub Actions

1) Vào repo GitHub → tab **Actions**
2) Chọn workflow **Wattpad Downloader v1.6**
3) Bấm **Run workflow**
   - **format**: `epub` / `txt` / `md` / `json` hoặc combo
   - **urls**: dán URL (mỗi dòng 1). Nếu để trống thì workflow dùng `urls.txt`
   - **throttle_ms**: mặc định `900` (giảm = nhanh hơn nhưng dễ 429)
   - **save_every**: mặc định `5` (tăng = nhanh hơn do giảm IO, nhưng rủi ro mất tối đa N chapters nếu job chết)
4) Chờ run xong → tải artifact trong trang run

### Bạch Ngọc Sách (BNS) — có login

1) Tạo GitHub Secrets (repo → Settings → Secrets and variables → Actions):
   - `BNS_USERNAME`
   - `BNS_PASSWORD`
2) Vào tab **Actions** → workflow **BNS Downloader v1.6**
3) Bấm **Run workflow**
   - **story_url**: ví dụ `https://bachngocsach.cc/reader/quy-bi-chi-chu`
   - **format** / **throttle_ms** / **save_every**: giống logic Wattpad
   - **chapter_from** / **chapter_to** (tuỳ chọn): giới hạn khoảng chương theo số thứ tự mục lục (1-based); để trống = tải cả truyện
4) Chờ run xong → tải artifact

**Giao diện `index.html` (v1.6)**: tab BNS có ô **Từ chương / Đến chương** tương ứng các input trên.

### Step-by-step: chạy local (debug)

```bash
npm install
node wattpad.js --batch urls.txt --format epub --output ./output --state ./state.json
```

