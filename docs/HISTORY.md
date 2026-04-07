## History — Wattpad Downloader (GitHub Actions)

### v2.1 (2026-04-07)

- **Wattpad — phạm vi chương (từ/đến)**: giống tab BNS; áp dụng **riêng từng URL** trong batch (chỉ số 1-based theo mục lục API). Workflow `download.yml` inputs `chapter_from` / `chapter_to`; `wattpad.js` `--chapter-from` / `--chapter-to`. Nếu vừa có `chapters_map` vừa có range → **giao** hai điều kiện; rỗng → lỗi rõ ràng trên log.
- **Wattpad — «Xem chapters» / fetch**: `fetchViaProxy` retry khi 408/429/502/503, timeout direct/proxy dài hơn, fallback proxy phụ (`corsproxy.io`) nếu AllOrigins lỗi; `classifyHttpError` có nhánh 408.
- **Wattpad — Actions / CLI**: `fetchWithRetry` backoff rõ hơn cho **408** và **503** (timeout / tạm thời).
- **BNS — «Xem mục lục»**: nút trên UI tải `…/muc-luc?page=all` (best-effort; truyện cần đăng nhập có thể không đầy đủ trong trình duyệt).
- Gói **`Object Github/v2.1`**: snapshot repo đầy đủ; `REPO-CORE-V2.1.txt`.

### v2.0 (2026-04-04)

- **Hai nút Wattpad**: «Tải toàn bộ các chapter» (không gửi `chapters_map`) và «Tải từ các chapter được chọn» (gửi map từ DOM).
- **Fix JSON trên Actions**: `CHAPTERS_MAP` qua biến môi trường + `printf` → file + `--chapters-map-file` (tránh bash `CHAPTERS_MAP="{...}"` vỡ vì dấu `"` trong JSON → `JSON … position 1`).
- **Fix UI → Actions**: `chapters_map` từ DOM; re-render đọc `S.stories.selectedChapters`.
- Log Wattpad: có map → `📑 … (theo chapters_map / UI)`; startup log `Map : chapters_map`.
- Gói **`Object Github/v2.0`**: snapshot repo đầy đủ.

### v1.9 (2026-04-03)

- **Save state sau mỗi chapter tải mạng (mặc định)**: `DEFAULT_SAVE_EVERY = 1` + workflow/UI default `save_every: 1` — tránh mất tiến độ khi job Actions dừng trước lần ghi lô cũ (trước đây mặc định 5). Vẫn có `--save-every N` / input workflow để gộp N chapter giảm IO.
- **Resume nhanh hơn**: `throttle_ms` chỉ áp dụng **sau** khi vừa tải chapter qua mạng; chuỗi chapter chỉ đọc cache không chờ delay giữa các chapter.
- **TXT / MD / JSON**: `--text-layout merged` (mặc định, giữ `--max-part-mb` chia phần như v1.8) hoặc `per-chapter` — mỗi chương một file trong thư mục `*_txt_chapters`, `*_md_chapters`, `*_json_chapters`.
- Workflow `download.yml` + `index.html`: input / UI `text_layout` (`merged` | `per_chapter`).
- Gói **`Object Github/v1.9`**: snapshot repo đầy đủ.

### v1.8

- Cache `state.json` + `state-bodies`; `--max-part-mb` cho file gộp; UI Wattpad: throttle, save_every, max_part_mb.

### v1.6 (2026-04-03)

- **BNS**: tải chương có `#encrypted-content` — gọi `POST /reader/api/decrypt-content.php` (cùng cookie đăng nhập) rồi parse HTML đã giải mã
- **BNS**: phạm vi chương — CLI `--chapter-from` / `--chapter-to`, workflow inputs `chapter_from` / `chapter_to`, UI **Từ chương / Đến chương** trên tab Bạch Ngọc Sách trong `index.html`
- Gói **`Object Github/v1.6`**: snapshot repo đầy đủ (scripts, workflows, docs, UI) nhãn v1.6

### v1.5 (2026-04-03)

- **Fix build**: thêm `package.json` (workflow trước đó có `npm install` nhưng thiếu manifest)
- **Speed (an toàn)**:
  - **Giảm IO**: `state.json` không còn ghi sau *mỗi chapter*; mặc định ghi mỗi **5 chapters tải mới** (`--save-every 5`)
  - Cho phép chỉnh tốc độ qua inputs: `throttle_ms`, `save_every`
- **Workflow**: thêm inputs tốc độ và wire vào CLI
- **BNS**: thêm `bns.js` + workflow `bns-download.yml` (login bằng GitHub Secrets `BNS_USERNAME/BNS_PASSWORD`, giữ cover, xuất EPUB/TXT/MD/JSON)

### v1.2 (legacy)

- Resume bằng `state.json` trong cache
- Download tuần tự, save state sau mỗi chapter (ổn định nhưng chậm hơn)

