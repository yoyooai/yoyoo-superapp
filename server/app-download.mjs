// App 安装包下载口 —— 登录页那两个「Android / iOS」按钮的落点。
//
// 为什么在我们自己的服务里（2026-09-13 苏白："把安卓和 iOS 的下载给做好，
// 用户直接在这里下载不就可以了"）：
//   · 宿主前端目录是**烤进镜像**的，容器一重建就还原 ⇒ 安装包放那里会无声消失。
//   · 改上游的 nginx/compose 去挂一个静态目录，等于给跟随上游又加一处税。
//   · 我们自己的 superapp 已经挂在 /eryuan/ 下、有一个 rw 的 /data —— 放这里
//     既不碰上游，也不怕重建（data 是宿主机目录挂进来的）。
//
// 客户端怎么用（别改协议，这是上游定的）：
//   登录页调 `GET /v1/common/updater/<os>/<当前版本>`，宿主从 `app_version` 表取最新一条；
//   没有记录就回 204（按钮什么都不做，正是现在的症状）。返回 JSON 里的 `url`
//   就是下载地址 —— 前端会校验它是 http(s) 才用。所以让按钮活过来是两件事：
//   ① 有个能下的地址（本文件）② 表里有一行指向它（见 docs/app-download.md）。
//
// 🔴 必须支持 Range：安装包 ~57MB，手机网络断了要能续传；不支持 Range 时
//    很多下载器会从头再来，弱网下基本下不完。
import { createReadStream, statSync } from "node:fs";
import { join, basename } from "node:path";

const DEFAULT_DIR = process.env.DOWNLOAD_DIR || "./data/downloads";

// 固定文件名：版本号走 `app_version` 表，不写进 URL——
// 否则每发一版就要同时改前端/表/nginx 三处，迟早对不上。
// 🔴 download 名必须是纯 ASCII：HTTP 头是 latin-1，塞中文会让 writeHead 直接抛
//    ERR_INVALID_CHAR（2026-09-13 线上实测 500）。中文名走 RFC 5987 的 filename*，
//    ASCII 名留作老客户端的兜底。
const FILES = {
  android: { name: "android-latest.apk", type: "application/vnd.android.package-archive",
             download: "eryuan-space.apk", downloadUtf8: "二元空间.apk" },
};

/** 生成 RFC 6266 / 5987 的 Content-Disposition：ASCII 兜底 + UTF-8 真名。 */
function contentDisposition(meta) {
  const ascii = meta.download.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const utf8 = encodeURIComponent(meta.downloadUtf8 || meta.download);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

export function createAppDownload({ dir = DEFAULT_DIR } = {}) {
  function resolve(os) {
    const f = FILES[os];
    if (!f) return null;
    const path = join(dir, f.name);
    let st;
    try {
      st = statSync(path);
    } catch {
      return { missing: true, os, path };
    }
    if (!st.isFile()) return { missing: true, os, path };
    return { os, path, size: st.size, mtime: st.mtimeMs, meta: f };
  }

  /** 解析单段 Range；无/不合法返回 null，越界返回 {invalid:true}。 */
  function parseRange(header, size) {
    if (!header) return null;
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
    if (!m) return null;
    const [, a, b] = m;
    if (a === "" && b === "") return null;
    let start, end;
    if (a === "") {                        // bytes=-N ⇒ 末尾 N 字节
      const n = Number(b);
      if (!Number.isFinite(n) || n <= 0) return { invalid: true };
      start = Math.max(0, size - n); end = size - 1;
    } else {
      start = Number(a);
      end = b === "" ? size - 1 : Number(b);
    }
    if (!Number.isFinite(start) || !Number.isFinite(end)) return { invalid: true };
    if (start > end || start >= size) return { invalid: true };
    return { start, end: Math.min(end, size - 1) };
  }

  async function handle(req, res, { os }) {
    const info = resolve(os);
    if (!info) {
      res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: `unknown platform: ${os}` }));
      return true;
    }
    if (info.missing) {
      // 说清楚是"还没放包"，不是路由坏了 —— iOS 现在就是这一支。
      res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: `no build published for ${os}`, expected: basename(info.path) }));
      return true;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "method not allowed" }));
      return true;
    }

    const base = {
      "Content-Type": info.meta.type,
      "Content-Disposition": contentDisposition(info.meta),
      "Accept-Ranges": "bytes",
      "Last-Modified": new Date(info.mtime).toUTCString(),
      // 安装包按内容变，不按时间变；给个弱缓存让 CDN/浏览器少回源，但每次问一句。
      "Cache-Control": "public, max-age=0, must-revalidate",
    };

    const range = parseRange(req.headers?.range, info.size);
    if (range?.invalid) {
      res.writeHead(416, { ...base, "Content-Range": `bytes */${info.size}` });
      res.end();
      return true;
    }
    if (range) {
      const len = range.end - range.start + 1;
      res.writeHead(206, { ...base, "Content-Length": len,
                           "Content-Range": `bytes ${range.start}-${range.end}/${info.size}` });
      if (req.method === "HEAD") { res.end(); return true; }
      createReadStream(info.path, { start: range.start, end: range.end }).pipe(res);
      return true;
    }

    res.writeHead(200, { ...base, "Content-Length": info.size });
    if (req.method === "HEAD") { res.end(); return true; }
    createReadStream(info.path).pipe(res);
    return true;
  }

  return { handle, resolve, parseRange, platforms: Object.keys(FILES) };
}
