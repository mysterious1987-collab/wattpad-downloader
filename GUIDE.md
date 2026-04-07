## Wattpad Downloader — GitHub Actions (v2.1)

Mục tiêu: chạy tải **trên GitHub Actions**, rồi bạn tải file về máy qua **artifact**, để máy bạn “offline” khỏi việc crawl Wattpad.

### Files quan trọng

- `.github/workflows/download.yml`: workflow trigger.
- `wattpad.js`: script tải + xuất file.
- `urls.txt`: (tuỳ chọn) list URL mặc định.
- `state.json`: state cache (tự sinh) để resume.
- `output/`: output (tự sinh).

### Step-by-step: chạy trên GitHub Actions

1) Vào repo GitHub → tab **Actions**
2) Chọn workflow **Wattpad Downloader v2.1**
3) Bấm **Run workflow**
   - **format**: `epub` / `txt` / `md` / `json` hoặc combo
   - **urls**: dán URL (mỗi dòng 1). Nếu để trống thì workflow dùng `urls.txt`
   - **chapter_from** / **chapter_to** (tuỳ chọn, v2.1): giới hạn chương theo thứ tự mục lục (1-based) **cho mỗi truyện** trong danh sách URL; để trống = không cắt; kết hợp với `chapters_map` từ UI thì lấy **giao** hai điều kiện
   - **text_layout**: `merged` (mặc định) hoặc `per_chapter` — chỉ ảnh hưởng txt/md/json; gộp thì dùng **max_part_mb** như v1.8
   - **throttle_ms**: mặc định `900` (áp dụng sau khi tải chapter qua mạng, không chờ giữa các chapter chỉ đọc cache)
   - **save_every**: mặc định `1` (mỗi chapter tải mạng ghi state — resume ổn định trên Actions). Tăng (vd. `5`) để giảm IO, rủi ro mất tối đa N−1 chapter nếu job chết giữa chừng
4) Chờ run xong → tải artifact trong trang run

### Bạch Ngọc Sách (BNS) — có login

1) Tạo GitHub Secrets (repo → Settings → Secrets and variables → Actions):
   - `BNS_USERNAME`
   - `BNS_PASSWORD`
2) Vào tab **Actions** → workflow **BNS Downloader v2.1**
3) Bấm **Run workflow**
   - **story_url**: ví dụ `https://bachngocsach.cc/reader/quy-bi-chi-chu`
   - **format** / **throttle_ms** / **save_every**: giống logic Wattpad
   - **chapter_from** / **chapter_to** (tuỳ chọn): giới hạn khoảng chương theo số thứ tự mục lục (1-based); để trống = tải cả truyện
4) Chờ run xong → tải artifact

**Giao diện `index.html` (v2.1)**: tab Wattpad **Từ/Đến chương** + `chapters_map` từ lưới; **bố cục TXT/MD/JSON**; tab BNS **Từ/Đến chương** và **Xem mục lục** (xem trước best-effort, có thể cần đăng nhập trên site).

### Step-by-step: chạy local (debug)

```bash
npm install
node wattpad.js --batch urls.txt --format epub --output ./output --state ./state.json
node wattpad.js --batch urls.txt --format txt --text-layout per-chapter --output ./output
```

