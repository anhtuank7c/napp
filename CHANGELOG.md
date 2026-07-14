# Changelog

Tất cả thay đổi đáng chú ý của `napp` được ghi lại ở đây.

## 1.0.0 — Phát hành đầu tiên

- Quản lý app Node.js/Bun đa người dùng: `napp app create/deploy/remove/list/restart/stop/start/logs/env-set`
- Domain phụ (alias): `napp domain add/remove/list`
- SSL miễn phí qua certbot: `napp cert issue/renew/revoke/list/status`
- Database MariaDB độc lập + tự động cho app: `napp db create/drop/list/backup`, cờ `--db` khi tạo app
- Redis dùng chung, cấp DB index riêng (0-15) cho từng app: `napp redis info/allocations/flush`, cờ `--redis`
- systemd service riêng cho từng app (hardened: NoNewPrivileges, ProtectSystem=strict, ...)
- nginx reverse-proxy tự sinh + tích hợp Cloudflare real-IP (`napp cloudflare sync`)
- UFW: `napp firewall sync` — mặc định deny, chỉ mở SSH + 80/443 (giới hạn theo dải IP Cloudflare, tự phát hiện IPv6 khả dụng hay không)
- fail2ban: `napp fail2ban setup` — sshd + nginx + jail chống spam lỗi 502/504/429
- Backup định kỳ qua systemd timer: `napp backup run/schedule/unschedule/list`
- Tối ưu theo phần cứng thực tế: `napp tune show/apply` (nginx/MariaDB/Redis/sysctl, tự phát hiện CPU/RAM)
- Kiểm tra & tự cài môi trường: `napp check [--fix]` (Node.js, sudo, git, nginx, certbot, MariaDB, Redis, fail2ban, UFW)
- Tự cập nhật OTA qua gist công khai: `napp update`
- Menu tương tác tiếng Việt dạng số
- Hỗ trợ `--dry-run` và `--verbose` toàn cục
