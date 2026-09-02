/**
 * 私货扫描器单测 —— SPEC-market §6「敏感扫描器单测」。
 *
 * 这里的判据刻意偏严：**误报可以，漏报不行**。
 * 漏报的代价是不可逆的公开，误报的代价是作者多点一次确认。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { scanForSecrets, SECRET_RULE_COUNT } from "./secrets.mjs";

const bp = (text) => ({ type: "page", children: [{ type: "text", value: text }] });

test("干净的蓝图不报", () => {
  const r = scanForSecrets(bp("本周订单 128 单，环比 +12%"));
  assert.equal(r.clean, true, JSON.stringify(r.hits));
});

test("命中 sk- 开头的密钥", () => {
  const r = scanForSecrets(bp("apiKey 是 sk-abcdefghijklmnopqrstuvwxyz012345"));
  assert.equal(r.clean, false);
  assert.ok(r.hits.some((h) => h.id === "openai_key"));
});

test("命中 GitHub 令牌", () => {
  const r = scanForSecrets(bp("ghp_ABCdefGHIjklMNOpqrSTUvwxYZ012345"));
  assert.ok(r.hits.some((h) => h.id === "github_token"));
});

test("命中 Bearer 令牌与 JWT", () => {
  assert.ok(scanForSecrets(bp("Authorization: Bearer abcdefghijklmnopqrstuvwx"))
    .hits.some((h) => h.id === "bearer"));
  // 正常长度的 JWT
  assert.ok(scanForSecrets(bp("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r"))
    .hits.some((h) => h.id === "jwt"));
  // 头部很短的也要命中（漏报的代价是不可逆的公开）
  assert.ok(scanForSecrets(bp("eyJhbGciOi.eyJzdWIiOjEyMw.SflKxwRJSMeKKF2QT4"))
    .hits.some((h) => h.id === "jwt"));
});

test("命中 password=xxx 这类写法", () => {
  const r = scanForSecrets(bp("db password = hunter2hunter2"));
  assert.ok(r.hits.some((h) => h.id === "assigned_secret"), JSON.stringify(r.hits));
});

test("命中手机号", () => {
  const r = scanForSecrets(bp("有事打 13800138000"));
  assert.ok(r.hits.some((h) => h.id === "cn_mobile"));
});

test("11 位但不是手机号段的不报（避免把订单号全当手机号）", () => {
  const r = scanForSecrets(bp("订单号 12345678901"));
  assert.equal(r.hits.some((h) => h.id === "cn_mobile"), false);
});

test("命中内网地址", () => {
  for (const s of ["http://10.0.0.5:8090", "192.168.1.7", "127.0.0.1", "http://localhost:3000"]) {
    assert.ok(scanForSecrets(bp(s)).hits.some((h) => h.id === "private_ip"), s);
  }
});

test("命中私钥文件内容", () => {
  const r = scanForSecrets(bp("-----BEGIN RSA PRIVATE KEY-----\nMIIE..."));
  assert.ok(r.hits.some((h) => h.id === "private_key"));
});

test("报告里不回显完整值（遮盖后才输出）", () => {
  const secret = "sk-abcdefghijklmnopqrstuvwxyz012345";
  const r = scanForSecrets(bp(secret));
  const all = JSON.stringify(r);
  assert.equal(all.includes(secret), false, "扫描结果里出现了密钥原文 —— 自己又泄了一遍");
  assert.ok(r.hits[0].samples[0].includes("*"), "样本没有打码");
});

test("一份蓝图里多种私货都要报齐（不是命中一条就收工）", () => {
  const r = scanForSecrets(bp("联系 13800138000，内网 10.1.2.3，key=sk-aaaaaaaaaaaaaaaaaaaa"));
  const ids = new Set(r.hits.map((h) => h.id));
  assert.ok(ids.has("cn_mobile") && ids.has("private_ip") && ids.has("openai_key"),
    `只报了 ${[...ids].join(",")}`);
});

test("规则表没被削空", () => {
  assert.ok(SECRET_RULE_COUNT >= 8);
});
