/**
 * 最小化的构建期类型声明。
 *
 * 为什么手写而不是 `types: ["vite/client"]`：我们只用到 `import.meta.hot`
 * 这一个东西，没必要把整个 vite 拉进依赖 —— 这个包要能被别的宿主（不一定用 vite）
 * 直接引用，依赖越少越搬得动。
 */
interface ImportMetaHot {
  dispose(cb: () => void): void;
}
interface ImportMeta {
  readonly hot?: ImportMetaHot;
}
