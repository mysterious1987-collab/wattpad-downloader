# Wattpad Downloader — GitHub Actions

Tự động tải truyện Wattpad về dạng EPUB/TXT/Markdown/JSON, chạy trên GitHub — không cần mở máy tính.

## Cách dùng

### 1. Thêm URL vào `urls.txt`

```
https://www.wattpad.com/story/123456-ten-truyen
https://www.wattpad.com/story/789012-story-two
```

### 2. Chạy từ GitHub UI

- Vào tab **Actions** → **Wattpad Downloader** → **Run workflow**
- Chọn format (epub/txt/md/json)
- Hoặc nhập URL trực tiếp vào ô input (không cần sửa urls.txt)
- Bấm **Run workflow**

### 3. Tải file về

Sau khi job hoàn thành → kéo xuống phần **Artifacts** → tải file `.zip`

## Tính năng

- ✅ **Auto-resume**: nếu bị ngắt giữa chừng, chạy lại sẽ tiếp tục từ chỗ dở
- ✅ **Multi-format**: chọn `epub,txt` để xuất cả 2 format cùng lúc  
- ✅ **Retry tự động**: thử lại khi gặp lỗi mạng
- ✅ **Batch**: tải nhiều truyện trong 1 lần chạy

## Giới hạn GitHub Actions (free)

| | Repo Public | Repo Private |
|---|---|---|
| Phút/tháng | Không giới hạn | 2,000 phút |
| Thời gian tối đa/job | 6 tiếng | 6 tiếng |
| Artifact giữ | 90 ngày | 90 ngày |

Truyện 200 chapter ≈ 10–15 phút chạy.
