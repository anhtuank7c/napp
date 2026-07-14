// Tiện ích in log có màu — cùng triết lý với lara.sh: info/ok/warn/die.
// %b cho phần màu, nội dung người dùng luôn qua %s (ở đây là template string
// thuần, không có rủi ro ANSI injection vì Node không có printf %b tự động,
// nhưng vẫn escape ký tự điều khiển trong giá trị người dùng khi in domain/path).

const isTTY = process.stdout.isTTY === true;

const COLORS = {
  red: "\x1b[0;31m",
  green: "\x1b[0;32m",
  yellow: "\x1b[0;33m",
  blue: "\x1b[0;34m",
  dim: "\x1b[2m",
  reset: "\x1b[0m",
};

function paint(color: keyof typeof COLORS, text: string): string {
  if (!isTTY) return text;
  return `${COLORS[color]}${text}${COLORS.reset}`;
}

// Loại bỏ ký tự điều khiển để chặn giả mạo dòng log qua input người dùng
// (domain, path, v.v.) khi in ra terminal.
function sanitize(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

export function info(msg: string): void {
  console.log(`${paint("blue", "[INFO]")} ${sanitize(msg)}`);
}

export function ok(msg: string): void {
  console.log(`${paint("green", "[ OK ]")} ${sanitize(msg)}`);
}

export function warn(msg: string): void {
  console.log(`${paint("yellow", "[CẢNH BÁO]")} ${sanitize(msg)}`);
}

export function step(msg: string): void {
  console.log(`${paint("dim", "  ->")} ${sanitize(msg)}`);
}

export class NappError extends Error {}

// Tương đương die() trong lara.sh: in lỗi ra stderr rồi ném lỗi để dừng chương
// trình. index.ts sẽ bắt NappError ở top-level, in gọn gàng và exit(1) mà
// không in stack trace (trừ khi bật DEBUG=1).
export function die(msg: string): never {
  throw new NappError(msg);
}

export function printDie(msg: string): void {
  console.error(`${paint("red", "[LỖI]")} ${sanitize(msg)}`);
}

export function dryRunNotice(msg: string): void {
  console.log(`${paint("yellow", "[DRY-RUN]")} ${sanitize(msg)}`);
}

export function section(title: string): void {
  console.log();
  console.log(paint("green", `=== ${title} ===`));
}
