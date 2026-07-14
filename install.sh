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
#   NODE_MAJOR     phiên bản Node.js LTS cài qua NodeSource (mặc định: 24)
# ==============================================================================
set -euo pipefail
NAPP_CJS_URL_DEFAULT="https://gist.githubusercontent.com/anhtuank7c/ef7ac27df205d70cf1f789bb420ec013/raw/napp.cjs"
NAPP_CJS_URL="${NAPP_CJS_URL:-$NAPP_CJS_URL_DEFAULT}"
NODE_MAJOR="${NODE_MAJOR:-24}"
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
# napp yêu cầu Node.js >= $NODE_MAJOR. Nếu máy chưa có node, hoặc đang chạy bản
# CŨ HƠN, ta cài/nâng cấp lên Node ${NODE_MAJOR}.x LTS qua NodeSource.
install_node() {
  info "Đang cài Node.js ${NODE_MAJOR}.x LTS qua NodeSource..."
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
  ok "Đã cài Node.js $(node --version)"
}

if command -v node >/dev/null 2>&1; then
  NODE_VER="$(node --version)"                 # ví dụ: v22.23.1
  NODE_CUR_MAJOR="${NODE_VER#v}"; NODE_CUR_MAJOR="${NODE_CUR_MAJOR%%.*}"
  if [[ "$NODE_CUR_MAJOR" =~ ^[0-9]+$ ]] && [[ "$NODE_CUR_MAJOR" -ge "$NODE_MAJOR" ]]; then
    ok "Node.js đã đạt yêu cầu: $NODE_VER (>= ${NODE_MAJOR}.x)"
  else
    warn "Node.js hiện tại ($NODE_VER) cũ hơn ${NODE_MAJOR}.x — đang nâng cấp..."
    install_node
  fi
else
  info "Node.js chưa được cài."
  install_node
fi

# --- napp.cjs ------------------------------------------------------------------
info "Đang tải napp từ: $NAPP_CJS_URL"
# QUAN TRỌNG: file tạm PHẢI có đuôi .cjs. Node >= 20 dựa vào đuôi file để xác
# định CommonJS/ESM; `node --check` trên file không đuôi (như mktemp mặc định)
# sẽ ném ERR_UNKNOWN_FILE_EXTENSION và fail dù nội dung hoàn toàn hợp lệ.
TMP_DIR="$(mktemp -d)"
TMP_FILE="$TMP_DIR/napp.cjs"
trap 'rm -rf "$TMP_DIR"' EXIT

# Vẫn thử lại vài lần để phòng lỗi mạng tạm thời / gist cache chưa đồng bộ.
ATTEMPTS="${NAPP_DL_ATTEMPTS:-3}"
attempt=1
while :; do
  reason=""
  # --retry: tự thử lại khi lỗi mạng tạm thời; header no-cache: hạn chế nhận bản cache cũ.
  if ! curl --proto '=https' --tlsv1.2 -fsSL \
            --retry 3 --retry-delay 2 --retry-all-errors \
            -H 'Cache-Control: no-cache' \
            "$NAPP_CJS_URL" -o "$TMP_FILE"; then
    reason="curl tải thất bại — kiểm tra URL hoặc kết nối mạng"
  elif ! check_err="$(node --check "$TMP_FILE" 2>&1)"; then
    reason="node --check báo lỗi (file tải dở/hỏng?): ${check_err##*$'\n'}"
  elif ! grep -q '__NAPP_MARKER__' "$TMP_FILE"; then
    reason="thiếu marker __NAPP_MARKER__ — không giống napp.cjs hợp lệ (trang lỗi HTML?)"
  else
    break   # tải + kiểm tra đều OK
  fi

  # Thất bại: in lý do THẬT + chẩn đoán để không phải đoán mò.
  warn "Lần $attempt/$ATTEMPTS thất bại: $reason"
  warn "  File tải về: $(wc -c < "$TMP_FILE" 2>/dev/null || echo 0) byte, dòng đầu: $(head -1 "$TMP_FILE" 2>/dev/null | cut -c1-60)"
  if [[ $attempt -ge $ATTEMPTS ]]; then
    die "Không cài được napp sau $ATTEMPTS lần. Lý do gần nhất: $reason"
  fi
  attempt=$((attempt + 1))
  sleep 2
done

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
