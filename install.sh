#!/usr/bin/env bash
# ==============================================================================
# install.sh — Bootstrap cài đặt napp trên một server Ubuntu mới.
#
# napp được viết bằng TypeScript/Node.js và đóng gói thành MỘT file duy nhất
# (napp.cjs), nên trước tiên cần đảm bảo Node.js đã có mặt trên máy — script
# này tự lo việc đó (qua NodeSource) nếu chưa có, rồi tải napp.cjs về và cài
# vào /usr/local/bin/napp.
#
# Cách dùng (chạy trên server, cần quyền root/sudo):
#   curl -fsSL "https://gist.githubusercontent.com/anhtuank7c/REPLACE_WITH_GIST_ID/raw/install.sh" | sudo bash
#
# Hoặc tải về xem trước rồi chạy (khuyến nghị cho lần đầu):
#   curl -fsSL "https://gist.githubusercontent.com/anhtuank7c/REPLACE_WITH_GIST_ID/raw/install.sh" -o install.sh
#   less install.sh   # đọc qua trước khi chạy bất kỳ script nào tải từ Internet
#   sudo bash install.sh
#
# Biến môi trường tuỳ chỉnh:
#   NAPP_CJS_URL   URL raw của napp.cjs (mặc định: gist chính thức bên dưới)
#   NODE_MAJOR     phiên bản Node.js LTS cài qua NodeSource (mặc định: 22)
# ==============================================================================
set -euo pipefail

NAPP_CJS_URL_DEFAULT="https://gist.githubusercontent.com/anhtuank7c/REPLACE_WITH_GIST_ID/raw/napp.cjs"
NAPP_CJS_URL="${NAPP_CJS_URL:-$NAPP_CJS_URL_DEFAULT}"
NODE_MAJOR="${NODE_MAJOR:-22}"
INSTALL_PATH="/usr/local/bin/napp"

C_RED='\033[0;31m'; C_GRN='\033[0;32m'; C_YLW='\033[0;33m'; C_BLU='\033[0;34m'; C_RST='\033[0m'
info() { printf '%b %s\n' "${C_BLU}[INFO]${C_RST}" "$*"; }
ok()   { printf '%b %s\n' "${C_GRN}[ OK ]${C_RST}" "$*"; }
warn() { printf '%b %s\n' "${C_YLW}[CẢNH BÁO]${C_RST}" "$*"; }
die()  { printf '%b %s\n' "${C_RED}[LỖI]${C_RST}" "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Script này cần quyền root. Hãy chạy lại với sudo."
command -v curl >/dev/null 2>&1 || die "Cần 'curl'. Cài bằng: apt update && apt install -y curl"

case "$NAPP_CJS_URL" in
  *REPLACE_WITH_GIST_ID*)
    die "Chưa cấu hình URL napp.cjs thật. Sửa NAPP_CJS_URL_DEFAULT trong install.sh (sau khi đã đăng napp.cjs lên gist công khai), hoặc chạy: sudo NAPP_CJS_URL=\"https://...\" bash install.sh" ;;
esac

# --- Node.js -----------------------------------------------------------------
if command -v node >/dev/null 2>&1; then
  NODE_VER="$(node --version)"
  ok "Node.js đã có sẵn: $NODE_VER"
else
  info "Node.js chưa được cài — đang cài Node.js ${NODE_MAJOR}.x LTS qua NodeSource..."
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
  ok "Đã cài Node.js $(node --version)"
fi

# --- napp.cjs ------------------------------------------------------------------
info "Đang tải napp từ: $NAPP_CJS_URL"
TMP_FILE="$(mktemp)"
trap 'rm -f "$TMP_FILE"' EXIT
curl --proto '=https' --tlsv1.2 -fsSL "$NAPP_CJS_URL" -o "$TMP_FILE" \
  || die "Tải thất bại — kiểm tra URL hoặc kết nối mạng."

node --check "$TMP_FILE" 2>/dev/null || die "File tải về lỗi cú pháp — có thể tải dở/hỏng. Hãy thử lại."
grep -q '__NAPP_MARKER__' "$TMP_FILE" || die "File tải về không giống napp.cjs hợp lệ — huỷ cài đặt."

install -m 0755 "$TMP_FILE" "$INSTALL_PATH"
ok "Đã cài napp vào $INSTALL_PATH"

# napp install: thêm banner chào mừng SSH (không bắt buộc, bỏ qua nếu lỗi)
"$INSTALL_PATH" install || true

echo
ok "Hoàn tất! Chạy lệnh sau để kiểm tra môi trường máy chủ:"
echo
echo "    sudo napp check --fix"
echo
echo "Sau đó tạo app Node.js/Bun đầu tiên, ví dụ:"
echo
echo "    sudo napp app create api.example.com --repo git@github.com:you/app.git --db --redis"
echo
