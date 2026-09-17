/**
 * 组织闸（Space Gate）—— "这次请求算在哪个组织名下，以及你到底是不是这个组织的人"。
 *
 * 起因（09-15 苏白）：他在「中际旭创」里建的四个应用，换到「二元AI」也看得见。
 * 根因很硬：`apps` / `cards` 每一条查询都只有 `WHERE owner_uid=?` ——
 * 数据在库里只认人，不认组织，所以"人到哪，应用跟到哪"。
 *
 * 苏白批准的口径（09-15）：
 *   · 身份归 AI —— 全局唯一，不按组织复制
 *   · 成员资格按组织 —— 要被"拉进去"才算数
 *   · 工作数据按组织隔死 —— 应用 / 卡片 / 数据 / 用量账单
 *
 * ── 谁说了算：用访问者自己的凭据证明，服务端不持特权 token ──────────
 * 判定走宿主 `GET /v1/space/my`（实测返回数组，元素带 `space_id`）——
 * 用的是访问者请求里那把 token，和 `app-shares.mjs` 判"你在哪些群"同一条路子：
 *   · 服务端不持有、也不需要任何特权 token —— 泄露面没有扩大
 *   · 他能证明的只有他自己的组织，冒充不了别人
 *   · 宿主不可达 ⇒ 拒（fail closed，不是"宿主挂了就先信着"）
 *
 * ── 为什么允许"没有组织"这一档 ──────────────────────────────
 * `OCTO_SPACE_ID` 没配、请求也没带 `x-space-id` 时，算在空组织 `''` 名下。
 * 这不是后门，是**这台服务器上压根没有声明过任何组织**的老实表达（本地开发、
 * 单测都跑在这一档）。**只要请求带了 `x-space-id`，就一定验成员资格，没有例外。**
 */

/** 组织成员关系会变（有人被移出组织），缓存必须短。 */
const SPACES_TTL_MS = 30_000;

export function createSpaceGate({
  hostSpacesUrl,
  defaultSpaceId = "",
  fetchImpl,
  now = Date.now,
  ttlMs = SPACES_TTL_MS,
}) {
  const doFetch = fetchImpl || fetch;
  const cache = new Map(); // token -> { spaces:Map<spaceId, role>, at }

  /**
   * 拿访问者自己的 token 去问宿主"你加入了哪些组织"。
   * 🔴 任何异常一律返回 null＝不可判定，调用方必须当作"不放行"。
   */
  async function spacesOfViewer(token) {
    if (!token) return null;
    const hit = cache.get(token);
    if (hit && now() - hit.at < ttlMs) return hit.spaces;

    let res;
    try {
      res = await doFetch(hostSpacesUrl, {
        headers: { token, Authorization: token },
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      return null; // 宿主不可达 ⇒ fail closed
    }
    if (!res.ok) return null;

    let body;
    try {
      body = await res.json();
    } catch {
      return null;
    }
    // 宿主直接返数组；也兼容 {data:[...]} 这种包一层的写法。
    const arr = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : null;
    if (!arr) return null;

    /* 🔴 存 Map 而不是 Set：宿主这份返回里**带 role**（0 成员 / 1 管理员 / 2 所有者，
       见 octo-server `pkg/space/member_role.go`）。写口要判"你是不是管理员"，
       而这是唯一一处拿访问者自己的凭据、由宿主给出的可核验角色 —— 丢掉它，
       写闸就只能退化成"是成员就能写"。Map 同样有 `.has`，调用方无需改。 */
    const spaces = new Map();
    for (const sp of arr) {
      const id = sp?.space_id;
      if (!id) continue;
      spaces.set(id, Number.isFinite(sp?.role) ? sp.role : 0);
    }
    cache.set(token, { spaces, at: now() });
    return spaces;
  }

  /**
   * 访问者在某个组织里的角色。0 成员 / 1 管理员 / 2 所有者。
   * 🔴 判不了（宿主不可达、不是成员）一律返回 null＝不放行，绝不返回 0 蒙混过去 ——
   *    0 是"我确实是成员、只是没权限"，null 是"我不知道你是谁"，两件事不能混。
   */
  async function roleOfViewer(token, spaceId) {
    const spaces = await spacesOfViewer(token);
    if (!spaces) return null;
    if (!spaces.has(spaceId)) return null;
    return spaces.get(spaceId);
  }

  /**
   * 这次请求算在哪个组织名下。
   * @returns {Promise<{spaceId:string}|{error:string,status:number}>}
   */
  async function resolve({ token, headerSpaceId }) {
    const asked = String(
      (Array.isArray(headerSpaceId) ? headerSpaceId[0] : headerSpaceId) || ""
    ).trim();

    // 没点名组织：退回这台服务器声明的那一个（没声明就是空组织档）。
    if (!asked) return { spaceId: defaultSpaceId };

    // 点名了就必须验 —— 这一条没有例外，默认组织也要验。
    const spaces = await spacesOfViewer(token);
    if (!spaces) return { error: "space unverifiable", status: 503 };
    if (!spaces.has(asked)) return { error: "space forbidden", status: 403 };
    return { spaceId: asked };
  }

  return { resolve, spacesOfViewer, roleOfViewer };
}
