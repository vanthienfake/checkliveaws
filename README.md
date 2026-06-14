# checkliveaws

AWS Account Checker - Kiểm tra email tồn tại trong hệ thống AWS.

## Tính năng

- ✅ Kiểm tra email AWS: Live (có mật khẩu) / Dead (không tồn tại)
- 🔄 TMProxy tích hợp: mỗi API key = 1 thread riêng
- 🔑 OMOCaptcha: tự động giải captcha AWS
- 🛡️ Proxy health check: verify proxy trước khi check
- ⏸ Pre-rotation pause: tạm dừng trước khi đổi IP
- 🔁 Auto-retry: retry tự động khi lỗi (tối đa 5 lần)
- 📊 UI realtime: theo dõi tiến độ và kết quả

## Cài đặt

```bash
npm install
```

## Chạy

```bash
node server.js
```

Truy cập: http://localhost:3000

## Cấu hình

- **TMProxy API Keys**: Mỗi key = 1 thread, proxy riêng
- **Đổi IP**: Mặc định 240s (4 phút)
- **OMOCaptcha**: Giải captcha AWS tự động
- **Delay**: Thời gian chờ giữa các lần check
