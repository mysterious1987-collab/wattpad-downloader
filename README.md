## Wattpad Downloader — GitHub Actions (v1.6)

Chạy tải truyện Wattpad về **EPUB/TXT/Markdown/JSON** trên GitHub Actions, rồi tải file về máy qua **Artifacts** (máy bạn không cần crawl Wattpad).

### Cách dùng nhanh

1) Vào tab **Actions** → workflow **Wattpad Downloader v1.6**
2) Bấm **Run workflow**
   - **urls**: dán URL (mỗi dòng 1) hoặc để trống để dùng `urls.txt`
   - **format**: chọn định dạng xuất
   - **throttle_ms**: mặc định `900` (nhanh hơn → giảm số này, nhưng dễ 429)
   - **save_every**: mặc định `5` (tăng để nhanh hơn do giảm IO)
3) Chờ run xong → tải artifact trong trang run

### Bạch Ngọc Sách (BNS) — có login

- Workflow: **BNS Downloader v1.6**
- Cần tạo GitHub Secrets:
  - `BNS_USERNAME`
  - `BNS_PASSWORD`
- Khi chạy workflow, nhập `story_url` dạng: `https://bachngocsach.cc/reader/<slug>`
- Tuỳ chọn: **chapter_from** / **chapter_to** (số thứ tự theo mục lục) để chỉ tải một đoạn; trên UI mở `index.html` tab BNS có ô **Từ chương / Đến chương**

### Tài liệu

- `docs/GUIDE.md`
- `docs/PLAN.md`
- `docs/HISTORY.md`

