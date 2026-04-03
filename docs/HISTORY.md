## History — Wattpad Downloader (GitHub Actions)

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

