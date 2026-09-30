#!/usr/bin/env bash
# ==============================================================================
# install.sh — Bootstrap cài đặt napp trên một server Ubuntu mới.
#
# napp được viết bằng TypeScript/Node.js và đóng gói thành MỘT file duy nhất
# (napp.cjs), nên trước tiên cần đảm bảo Node.js đã có mặt trên máy — script
# này tự lo việc đó (qua NodeSource) nếu chưa có, rồi tải napp.cjs về và cài
# vào /usr/local/bin/napp. Ngoài ra còn cài sẵn 'bun' (system-wide) để có thể
# tạo app chạy bằng bun — có thể tắt bằng NAPP_INSTALL_BUN=0.
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
#   NAPP_CJS_URL      URL raw của napp.cjs (mặc định: gist chính thức bên dưới)
#   NODE_MAJOR        phiên bản Node.js LTS cài qua NodeSource (mặc định: 24)
#   NAPP_INSTALL_BUN  cài bun runtime system-wide hay không (1=có mặc định, 0=bỏ qua)
#   NAPP_DB           database engine muốn dùng: mariadb (mặc định), mysql, postgresql,
#                     mongodb, nhiều engine cách nhau dấu phẩy, hoặc 'none'. Chỉ GHI NHẬN
#                     lựa chọn — 'napp check --fix' mới cài. Ví dụ:
#                       curl -fsSL .../install.sh | sudo NAPP_DB=postgresql bash
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
# napp cần Node.js >= $NODE_MAJOR cài Ở MỨC HỆ THỐNG (/usr hoặc /opt), KHÔNG
# phải node kiểu nvm/n/asdf nằm trong thư mục home. Lý do:
#   - `sudo napp` chạy dưới secure_path của sudo -> không thấy ~/.nvm
#   - app chạy bằng systemd có ProtectHome=yes -> không truy cập được home
#     -> node trong ~/.nvm là VÔ HÌNH với service.
# Vì vậy ta cố tình bỏ qua node kiểu home và luôn đảm bảo có node system-wide.
install_node() {
  info "Đang cài Node.js ${NODE_MAJOR}.x LTS qua NodeSource (system-wide)..."
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
  ok "Đã cài Node.js $(node --version) tại $(command -v node)"
}

NODE_BIN="$(command -v node || true)"
NODE_REAL="$(readlink -f "$NODE_BIN" 2>/dev/null || echo "$NODE_BIN")"
case "$NODE_REAL" in
  /usr/*|/opt/*|/bin/*)   # node hệ thống — systemd & sudo đều dùng được
    NODE_VER="$("$NODE_BIN" --version)"         # ví dụ: v24.18.0
    NODE_CUR_MAJOR="${NODE_VER#v}"; NODE_CUR_MAJOR="${NODE_CUR_MAJOR%%.*}"
    if [[ "$NODE_CUR_MAJOR" =~ ^[0-9]+$ ]] && [[ "$NODE_CUR_MAJOR" -ge "$NODE_MAJOR" ]]; then
      ok "Node.js hệ thống đã đạt yêu cầu: $NODE_VER ($NODE_BIN)"
    else
      warn "Node.js hệ thống ($NODE_VER) cũ hơn ${NODE_MAJOR}.x — đang nâng cấp..."
      install_node
    fi
    ;;
  "")   # chưa có node nào trên PATH
    info "Node.js chưa được cài (system-wide)."
    install_node
    ;;
  *)    # có node nhưng nằm trong home (nvm/n/asdf) — service KHÔNG dùng được
    warn "Phát hiện Node.js tại '$NODE_BIN' (kiểu nvm/home). napp cần node system-wide"
    warn "nên sẽ cài thêm bản NodeSource — KHÔNG đụng tới nvm của bạn."
    install_node
    ;;
esac

# --- bun (runtime tùy chọn cho app) ------------------------------------------
# Mặc định cài bun để có thể tạo app chạy bằng bun (tắt bằng NAPP_INSTALL_BUN=0).
# GIỐNG Node: bun PHẢI ở mức hệ thống (/usr/local/bin) để systemd service
# (ProtectHome=yes) và sudo thấy được — KHÔNG cài vào ~/.bun như mặc định của
# trình cài chính thức. Cài bun là KHÔNG bắt buộc: lỗi ở đây không chặn cài napp.
INSTALL_BUN="${NAPP_INSTALL_BUN:-1}"
install_bun() {
  info "Đang cài bun (system-wide vào /usr/local/bin)..."
  # Trình cài bun cần 'unzip'.
  if ! command -v unzip >/dev/null 2>&1; then
    apt-get install -y unzip >/dev/null 2>&1 || { apt-get update && apt-get install -y unzip; }
  fi
  # BUN_INSTALL=/usr/local -> nhị phân đặt tại /usr/local/bin/bun (systemd/sudo dùng được).
  export BUN_INSTALL=/usr/local
  curl -fsSL https://bun.sh/install | bash
  command -v bun >/dev/null 2>&1 || return 1
  ok "Đã cài bun $(bun --version) tại $(command -v bun)"
}

if [[ "$INSTALL_BUN" == "1" ]]; then
  BUN_BIN="$(command -v bun || true)"
  BUN_REAL="$(readlink -f "$BUN_BIN" 2>/dev/null || echo "$BUN_BIN")"
  case "$BUN_REAL" in
    /usr/*|/opt/*|/bin/*)   # bun hệ thống — systemd & sudo đều dùng được
      ok "bun hệ thống đã có sẵn: $("$BUN_BIN" --version) ($BUN_BIN)" ;;
    "")   # chưa có bun nào trên PATH
      info "bun chưa được cài (system-wide) — đang cài..."
      install_bun || warn "Cài bun thất bại — bỏ qua (napp vẫn dùng được với Node; tạo app runtime=bun sẽ cần cài bun sau)." ;;
    *)    # có bun nhưng nằm trong home (~/.bun) — service KHÔNG dùng được
      warn "Phát hiện bun tại '$BUN_BIN' (kiểu ~/.bun trong home) — systemd/sudo không dùng được; cài thêm bản system-wide..."
      install_bun || warn "Cài bun thất bại — bỏ qua." ;;
  esac
else
  info "Bỏ qua cài bun (NAPP_INSTALL_BUN=0). Tạo app runtime=bun sẽ cần bun được cài sẵn system-wide."
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

# Database engine: qua 'curl | sudo bash' thì stdin là chính script nên KHÔNG hỏi
# được — lựa chọn đi bằng biến NAPP_DB. Không đặt -> 'napp check --fix' sẽ hỏi
# (hoặc dùng MariaDB nếu chạy với --yes).
if [[ -n "${NAPP_DB:-}" ]]; then
  "$INSTALL_PATH" db engine select "$NAPP_DB" || warn "NAPP_DB='$NAPP_DB' không hợp lệ — bỏ qua (chọn lại sau: sudo napp check --fix --db <engine>)."
fi

echo
ok "Hoàn tất! Chạy lệnh sau để kiểm tra môi trường máy chủ:"
echo
echo "    sudo napp check --fix"
echo
echo "Database mặc định là MariaDB. Muốn PostgreSQL / MySQL / MongoDB (hoặc không dùng DB):"
echo
echo "    sudo napp check --fix --db postgresql      # hoặc: mysql, mongodb, none, mariadb,mongodb"
echo
echo "Sau đó tạo app Node.js/Bun đầu tiên, ví dụ:"
echo
echo "    sudo napp app create api.example.com --repo git@github.com:you/app.git --db --redis"
echo
echo "(--db tạo database trên engine đang cài; máy có nhiều engine thì ghi rõ, vd --db postgresql)"
echo
