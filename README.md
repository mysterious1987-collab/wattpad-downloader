## Gói v1.5 (Object Github) — đủ file để repo chạy

Thư mục này là **bản đóng gói đầy đủ**: script Node, workflow GitHub Actions, `package.json`, tài liệu và **giao diện điều khiển** `index.html`.

### Cấu trúc

| Mục | Mô tả |
|-----|--------|
| `index.html` | UI mở bằng trình duyệt (PAT + trigger workflow). **Không** bắt buộc trên GitHub nếu bạn chỉ chạy từ tab Actions. |
| `.github/workflows/` | `download.yml` (Wattpad), `bns-download.yml` (BNS) |
| `wattpad.js`, `bns.js` | Script tải |
| `package.json`, `urls.txt` | Dependencies và URL mặc định (Wattpad) |
| `docs/` | Hướng dẫn / lịch sử |

### Đưa lên GitHub (repo gốc)

1. Copy **toàn bộ nội dung** thư mục `v1.5` vào **root** repository GitHub của bạn (hoặc chỉ copy các file cần cho Actions: bỏ `index.html` nếu không muốn commit UI).
2. Đảm bảo nhánh mặc định có tên **`main`** (UI trigger dùng `ref: main`) hoặc sửa trong `index.html` nếu nhánh khác.
3. Thêm Secrets **BNS** nếu dùng workflow BNS: `BNS_USERNAME`, `BNS_PASSWORD`.

### Chạy thử local

```bash
cd "Object Github/v1.5"
npm ci
# hoặc: npm install
node wattpad.js --help
node bns.js --help
```

Có sẵn `package-lock.json` để `npm ci` khớp phiên bản dependency với CI. Thư mục `node_modules/` không nằm trong gói — tạo lại bằng lệnh trên.
