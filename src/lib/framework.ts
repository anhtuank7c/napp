import { existsSync, statSync } from "node:fs";

/**
 * Nhận diện BỐ CỤC ASSET TĨNH của một app Node đã build, để nginx trả thẳng
 * asset thay vì đẩy từng file .js/.css/.woff2 qua tiến trình Node.
 *
 * NGUỒN SỰ THẬT LÀ THƯ MỤC BUILD TRÊN ĐĨA, không phải dependencies trong
 * package.json. Lý do rất thực tế:
 *
 *  - Monorepo: package.json ở gốc repo có thể không nhắc gì tới framework mà
 *    app con đang dùng, và ngược lại — gốc repo liệt kê cả next lẫn @sveltejs/kit
 *    vì workspace có nhiều app. Đọc deps ở đây là đoán.
 *  - Adapter mới là thứ quyết định: cùng một app SvelteKit, adapter-node sinh
 *    'build/client' còn adapter-static sinh 'build'. Deps giống hệt nhau.
 *  - Thư mục build CÓ THẬT thì suy luận không thể sai về sự tồn tại — cùng lắm
 *    là bố cục lạ không khớp luật nào, và khi đó ta trả null thay vì đoán bừa.
 *
 * HỆ QUẢ: chỉ nhận diện được SAU khi build xong. Gọi trước bước build luôn trả
 * null, và đó là hành vi đúng — không có gì trên đĩa để phục vụ cả.
 */
export interface StaticSuggestion {
  /** Nhãn để in cho người dùng, vd "SvelteKit (adapter-node)". */
  framework: string;
  /** Thư mục đã thấy trên đĩa khiến luật này khớp (đường dẫn TUYỆT ĐỐI). */
  evidence: string;
  /** Tương ứng --static-root. Có thể bỏ trống nếu framework chỉ dùng alias. */
  staticRoot?: string;
  /** Tương ứng --static-prefix (phục vụ qua `root` + try_files). */
  staticPrefixes: string[];
  /** Tương ứng --static-alias (phục vụ qua `alias`). Xem chú thích ở dưới. */
  staticAliases: StaticAlias[];
  /**
   * Tiền tố CÓ THỂ ĐỤNG ROUTE CỦA APP nên KHÔNG BAO GIỜ được tự áp.
   *
   * '/_app/', '/_next/', '/_nuxt/', '/_astro/' là namespace riêng của framework:
   * không app nào đặt route ở đó, nên chiếm chúng bằng `^~` là an toàn tuyệt đối.
   * '/assets/' thì KHÁC — nó là một đoạn URL bình thường mà app hoàn toàn có thể
   * dùng cho route động (`/assets/:id` trong một trang quản lý tài sản chẳng
   * hạn). Mà `location ^~` thắng mọi location regex VÀ thắng cả proxy_pass, nên
   * áp nhầm là route đó chết vĩnh viễn với 404 — không log, không lỗi, chỉ là
   * trang trắng. Với nhóm này ta CHỈ IN GỢI Ý và để người biết app quyết định.
   */
  risky: boolean;
  /** Cảnh báo phải in kèm khi áp cấu hình này (bẫy riêng của framework). */
  note?: string;
}

export interface StaticAlias {
  /** Tiền tố URL, luôn bắt đầu và kết thúc bằng '/'. */
  prefix: string;
  /** Thư mục trên đĩa (tuyệt đối) chứa nội dung của tiền tố đó. */
  dir: string;
}

interface Rule {
  framework: string;
  /** Thư mục PHẢI tồn tại (tương đối gốc app) để luật khớp. */
  probe: string;
  /** --static-root, tương đối gốc app. */
  root?: string;
  prefixes?: string[];
  /** dir tương đối gốc app. */
  aliases?: StaticAlias[];
  risky?: boolean;
  note?: string;
}

/**
 * Bảng luật, XÉT THEO THỨ TỰ — luật đầu tiên khớp là kết quả.
 *
 * Thứ tự quan trọng ở hai chỗ:
 *  1. SvelteKit ('build/client/_app') phải đứng TRƯỚC Remix ('build/client/assets'):
 *     cả hai cùng đổ vào 'build/client', và một app SvelteKit cũng có thể có
 *     'build/client/assets' do thư mục static/ của nó chứa. Khớp '_app' trước
 *     thì ra tiền tố an toàn; khớp 'assets' trước thì ra tiền tố risky và ta
 *     mất luôn cấu hình đúng.
 *  2. Mọi luật có namespace riêng ('_nuxt', '_astro', '_build') đứng trước các
 *     luật '/assets/' chung chung.
 */
const RULES: Rule[] = [
  {
    framework: "SvelteKit (adapter-node)",
    probe: "build/client/_app",
    root: "build/client",
    prefixes: ["/_app/"],
  },
  {
    // Next.js là trường hợp DUY NHẤT trong bảng này không dùng được `root`.
    //
    // Trên đĩa asset nằm ở '.next/static/…' nhưng URL lại là '/_next/static/…' —
    // tên thư mục và đoạn URL KHÁC NHAU. nginx `root` chỉ nối thẳng URI vào sau
    // root, nên 'root .next;' + '/_next/static/x.js' đi tìm '.next/_next/static/x.js',
    // một đường dẫn không bao giờ tồn tại -> toàn bộ JS/CSS trả 404 và trang
    // trắng. Phải dùng `alias`, nó THAY THẾ phần tiền tố đã khớp bằng thư mục.
    framework: "Next.js",
    probe: ".next/static",
    aliases: [{ prefix: "/_next/static/", dir: ".next/static" }],
    // Bẫy đắt nhất của Next.js: KHÔNG được lấy '/_next/' làm tiền tố.
    note:
      "CHỈ chiếm '/_next/static/'. Phần còn lại của '/_next/' PHẢI đi qua Node: " +
      "'/_next/image' là bộ tối ưu ảnh chạy lúc request, và '/_next/data' là payload " +
      "của navigation phía client. Chặn chúng bằng nginx là mất tối ưu ảnh và hỏng điều hướng.",
  },
  {
    framework: "Nuxt 3 / Nitro",
    probe: ".output/public/_nuxt",
    root: ".output/public",
    prefixes: ["/_nuxt/"],
  },
  {
    framework: "SolidStart / Vinxi (Nitro)",
    probe: ".output/public/_build",
    root: ".output/public",
    prefixes: ["/_build/"],
  },
  {
    framework: "Astro (SSR)",
    probe: "dist/client/_astro",
    root: "dist/client",
    prefixes: ["/_astro/"],
  },
  {
    framework: "Astro (static)",
    probe: "dist/_astro",
    root: "dist",
    prefixes: ["/_astro/"],
  },
  {
    framework: "Remix / React Router v7",
    probe: "build/client/assets",
    root: "build/client",
    prefixes: ["/assets/"],
    risky: true,
    note:
      "'/assets/' KHÔNG phải namespace riêng của framework — app hoàn toàn có thể có " +
      "route thật ở đó. Kiểm tra app không dùng '/assets/...' làm route rồi hãy áp.",
  },
  {
    framework: "Vite (SPA)",
    probe: "dist/assets",
    root: "dist",
    prefixes: ["/assets/"],
    risky: true,
    note:
      "'/assets/' KHÔNG phải namespace riêng của framework — app hoàn toàn có thể có " +
      "route thật ở đó. Kiểm tra app không dùng '/assets/...' làm route rồi hãy áp.",
  },
];

function isDir(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    // Thư mục có thật nhưng không stat được (quyền, symlink gãy) thì coi như
    // không nhận diện được — thà không gợi ý còn hơn gợi ý một đường dẫn nginx
    // sẽ không đọc nổi.
    return false;
  }
}

function join(root: string, rel: string): string {
  return `${root.replace(/\/+$/, "")}/${rel}`;
}

/**
 * `appRoot` là thư mục app THỰC SỰ CHẠY (đã tính --app-dir của monorepo), vì
 * đó cũng là chỗ lệnh build chạy và đổ output ra.
 */
export function detectStaticLayout(appRoot: string): StaticSuggestion | null {
  if (!isDir(appRoot)) return null;
  for (const rule of RULES) {
    const probe = join(appRoot, rule.probe);
    if (!isDir(probe)) continue;
    return {
      framework: rule.framework,
      evidence: probe,
      staticRoot: rule.root ? join(appRoot, rule.root) : undefined,
      staticPrefixes: rule.prefixes ?? [],
      staticAliases: (rule.aliases ?? []).map((a) => ({ prefix: a.prefix, dir: join(appRoot, a.dir) })),
      risky: rule.risky ?? false,
      note: rule.note,
    };
  }
  return null;
}

/** Các cờ CLI tương ứng một gợi ý — dùng chung cho cả lúc áp lẫn lúc in ra. */
export function staticFlags(s: StaticSuggestion): string[] {
  const out: string[] = [];
  if (s.staticRoot) out.push("--static-root", s.staticRoot);
  for (const p of s.staticPrefixes) out.push("--static-prefix", p);
  for (const a of s.staticAliases) out.push("--static-alias", `${a.prefix}=${a.dir}`);
  return out;
}

/** Dòng lệnh sẵn sàng dán vào terminal để áp gợi ý cho một app ĐÃ TẠO. */
export function staticSetCommand(domain: string, s: StaticSuggestion): string {
  return `sudo napp app set ${domain} ${staticFlags(s).join(" ")}`;
}

/**
 * Parse '--static-alias <prefix>=<dir>'. Trả về lỗi dạng chuỗi (caller tự
 * quyết định die hay warn) thay vì tự thoát, để dùng được cả trong lệnh kiểm tra.
 */
export function parseStaticAlias(item: string): { value?: StaticAlias; error?: string } {
  const eq = item.indexOf("=");
  if (eq === -1) return { error: `--static-alias phải theo dạng <tiền-tố-URL>=<thư-mục>, nhận được: '${item}'` };
  const prefix = item.slice(0, eq).trim();
  const dir = item.slice(eq + 1).trim();
  if (!prefix.startsWith("/")) return { error: `--static-alias: tiền tố URL phải bắt đầu bằng '/', nhận được: '${prefix}'` };
  // Bắt buộc kết thúc bằng '/' vì `alias` của nginx nối phần URI CÒN LẠI sau
  // tiền tố vào sau thư mục. Tiền tố '/_next/static' (thiếu '/') khớp cả
  // '/_next/statically-wrong.js' và ghép ra đường dẫn rác.
  if (!prefix.endsWith("/")) return { error: `--static-alias: tiền tố URL phải kết thúc bằng '/', nhận được: '${prefix}'` };
  if (prefix.includes("..") || dir.includes("..")) return { error: `--static-alias: không cho phép '..' trong '${item}'` };
  if (!dir.startsWith("/")) return { error: `--static-alias: thư mục phải là đường dẫn TUYỆT ĐỐI, nhận được: '${dir}'` };
  return { value: { prefix, dir: dir.replace(/\/+$/, "") } };
}
