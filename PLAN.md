## PLAN — v1.6

### Goal

- Trigger qua GitHub Actions (`workflow_dispatch`)
- Download + build ebook server-side
- Upload artifact để bạn tải về máy
- Resume được khi fail/timeout nhờ cache `state.json`

### Constraints

- Không dùng browser automation
- Tránh rate-limit (429)
- Ưu tiên ổn định hơn là “nhanh tối đa”

### v1.6 changes

- **BNS**: giải mã nội dung qua API `decrypt-content` (payload `#encrypted-content`); chọn phạm vi chương `--chapter-from` / `--chapter-to` + UI `index.html`
- Đồng bộ nhãn release **v1.6** (workflows, scripts, docs)

### v1.5 changes

- Thêm `package.json` để workflow `npm install` chạy được
- Nâng `wattpad.js` lên `v1.5`
  - Giảm IO bằng `--save-every` (mặc định 5 chapters mới save 1 lần)
  - Cho phép chỉnh `--throttle-ms` từ workflow inputs
  - Giữ retry/backoff + xử lý 429

### Next improvements (tuỳ chọn)

- Thêm concurrency giới hạn (ví dụ 2 chapters song song) kèm giới hạn tốc độ để không bắn request dồn
- Thêm tuỳ chọn “zip all outputs” trước khi upload artifact (1 file duy nhất)

