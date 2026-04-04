## History — Wattpad Downloader (GitHub Actions)

### v2.0 (2026-04-04)

- **Fix UI → Actions**: `chapters_map` sinh từ **DOM** (đúng checkbox đang hiển thị), không chỉ dựa `S.stories` dễ lệch sau `renderAllBlocks`. Re-render block chương đọc `selectedChapters` từ `S.stories` để giữ UI.
- Log Wattpad: khi có `chapters_map`, dòng `📑 … chapters (theo chapters_map / UI)`.
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

