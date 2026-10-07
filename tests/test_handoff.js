/* =============================================================
   数据导入验收测试

   用 tests/_handoff/phone-archive.json 这份样例档案灌进应用，
   逐项核对：库存、单据、场次、优惠配置是否都正确还原。

   档案不存在则跳过（这样只跑 test_phone.js 也不会失败）。

   跑法：  node tests/test_handoff.js
   ============================================================= */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ARCHIVE = path.join(__dirname, "_handoff", "phone-archive.json");
const HTML = path.join(__dirname, "..", "出摊计算器.html");

if (!fs.existsSync(ARCHIVE)) {
  console.log("跳过：未找到样例档案（tests/_handoff/phone-archive.json）");
  process.exit(0);
}

/* ---------------------------------------------------------------- 装载手机版 */
function loadPhoneApp() {
  const source = fs.readFileSync(HTML, "utf8");
  const m = source.match(/<script>\n([\s\S]*?)\n<\/script>/);
  if (!m) throw new Error("找不到 <script> 段");
  let code = m[1].replace(
    /document\.addEventListener\("DOMContentLoaded", function \(\) \{ UI\.boot\(\); \}\);/,
    "/* 测试环境不自动启动界面 */"
  );
  function makeEl(id) {
    const el = {
      id, _html: "", textContent: "", value: "", disabled: false, checked: false,
      dataset: {}, style: {}, className: "", children: [], files: null,
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      addEventListener() {}, removeEventListener() {}, appendChild() {}, insertBefore() {},
      remove() {}, focus() {}, click() {},
      querySelector() { return makeEl("q"); }, querySelectorAll() { return []; },
      setAttribute() {}, getAttribute() { return null; },
    };
    /* innerHTML 赋值在真实 DOM 里会清空子节点，桩要如实模拟 */
    Object.defineProperty(el, "innerHTML", {
      get() { return this._html; },
      set(v) { this._html = String(v); this.children.length = 0; },
    });
    return el;
  }
  const store = new Map();
  const sandbox = {
    console, setTimeout, clearTimeout,
    Blob: function () {}, URL: { createObjectURL: () => "blob:x", revokeObjectURL() {} },
    FileReader: function () {}, Image: function () {},
    Node: function () {}, Element: function () {}, HTMLElement: function () {},
    /* ?demo= 自检入口会读 location.search，给个空查询让它跳过 */
    location: { search: "", href: "http://localhost/", hash: "" },
    URLSearchParams: URLSearchParams,
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    document: {
      readyState: "complete",
      getElementById: (id) => makeEl(id),
      querySelector: () => makeEl("q"),
      querySelectorAll: () => [],
      createElement: (t) => makeEl(t),
      addEventListener() {},
      body: makeEl("body"),
    },
    window: { scrollTo() {}, print() {} },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: "出摊计算器.html" });
  return sandbox.__stallcalc;
}

const app = loadPhoneApp();
const { M, Biz, Pricing, Store } = app;

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log("  \u2714 " + name); }
  catch (e) { failures.push([name, e.message]); console.log("  \u2718 " + name + "\n      " + e.message); }
}
function eq(a, b, label) {
  if (a !== b) throw new Error((label || "") + " 期望 " + JSON.stringify(b) + "，实际 " + JSON.stringify(a));
}
function ok(c, label) { if (!c) throw new Error(label || "断言失败"); }

/* ---------------------------------------------------------------- 导入 */
const archive = JSON.parse(fs.readFileSync(ARCHIVE, "utf8"));

console.log("== 样例档案内容 ==");
console.log("  导出时间：" + archive.exported_at + "  来源：" + archive.source);
console.log("  商品 " + archive.products.length + " 款，单据 " + archive.transactions.length +
            " 笔，场次 " + archive.sessions.length + " 个，流水 " + archive.ledger.length + " 条");

console.log("\n== 导入手机版 ==");
test("导入成功", () => {
  const res = Biz.importArchive(archive, "replace");
  ok(res.ok, res.error || "导入失败");
  eq(res.replaced, true, "应该是替换模式：");
});
test("商品数量一致", () => {
  eq(Biz.state().products.length, archive.products.length);
});
test("摊位名和优惠配置搬过来了", () => {
  const s = Biz.settings();
  eq(s.stall_name, archive.stall_name);
  eq(Number(s.percent_value), Number(archive.settings.percent_value));
  eq(s.rounding_mode, archive.settings.rounding_mode);
  eq(s.low_stock_alert, Number(archive.settings.low_stock_alert));
});
test("单件商品的优惠规则搬过来了（第二件半价）", () => {
  const fromDesktop = archive.products.find((p) => p.discount_kind === "second_half");
  ok(fromDesktop, "档案里本来就没有半价商品，测试前提不成立");
  const inPhone = Biz.state().products.find((p) => p.name === fromDesktop.name);
  eq(inPhone.discount_kind, "second_half", inPhone.name + " 的优惠：");
  eq(inPhone.discount_nth, fromDesktop.discount_nth);
});
test("单据数量与状态一致", () => {
  const txs = Biz.state().transactions;
  eq(txs.length, archive.transactions.length);
  const want = archive.transactions.map((t) => t.status).sort().join(",");
  const got = txs.map((t) => t.status).sort().join(",");
  eq(got, want, "单据状态：");
});
test("单据明细原样带过来（单价快照不能变）", () => {
  archive.transactions.forEach((src) => {
    const dst = Biz.state().transactions.find((t) => t.id === src.id);
    ok(dst, "找不到单号 #" + src.id);
    eq(dst.items.length, src.items.length, "#" + src.id + " 明细条数：");
    src.items.forEach((it, i) => {
      eq(dst.items[i].name, it.name, "#" + src.id + " 第 " + i + " 项名称：");
      eq(dst.items[i].unit_price_cents, it.unit_price_cents, "#" + src.id + " 第 " + i + " 项单价：");
      eq(dst.items[i].qty, it.qty, "#" + src.id + " 第 " + i + " 项数量：");
    });
  });
});
test("场次带过来，且只有一个进行中", () => {
  const sessions = Biz.listSessions();
  eq(sessions.length, archive.sessions.length);
  eq(sessions.filter((s) => s.is_active).length, 1, "进行中的场次数量：");
  ok(Biz.activeSession(), "应该能取到当前场次");
});

/* ---------------------------------------------------------------- 账目核对 */
console.log("\n== 账目核对（应用内算出来必须与档案一致）==");

/* 基准值直接由档案的流水和单据推导，不经过应用自身的代码，
   这样才能真正验证应用算法是否正确，而不是自己验自己。 */
function archiveStock(productId) {
  const p = archive.products.find((x) => x.id === productId);
  let stock = p.stock_initial || 0;
  archive.ledger.forEach((e) => {
    if (e.product_id !== productId) return;
    if (e.reason === "restock" || e.reason === "adjust") stock += e.change_qty;
    else if (e.reason === "sale" || e.reason === "void_return") stock += e.change_qty;
  });
  return stock;
}
function archiveSold(productId) {
  return archive.transactions
    .filter((t) => t.status === "completed")
    .reduce((sum, t) => sum + (t.items || [])
      .filter((i) => i.product_id === productId)
      .reduce((s, i) => s + i.qty, 0), 0);
}

test("每个商品的库存都与档案一致", () => {
  archive.products.forEach((p) => {
    const expected = archiveStock(p.id);
    const actual = Biz.productStock(p.id);
    eq(actual, expected, p.name + " 的库存：");
  });
});
test("每个商品的已售数量都与档案一致", () => {
  archive.products.forEach((p) => {
    const expected = archiveSold(p.id);
    eq(Biz.productSold(p.id), expected, p.name + " 的已售：");
  });
});
test("销售额/优惠/订单数都与档案一致", () => {
  const done = archive.transactions.filter((t) => t.status === "completed");
  const wantRevenue = done.reduce((a, t) => a + t.final_cents, 0);
  const wantGross = done.reduce((a, t) => a + t.gross_cents, 0);
  const wantDiscount = done.reduce((a, t) => a + t.discount_cents, 0);
  const got = Biz.stats(null).summary;
  eq(got.orders, done.length, "订单数：");
  eq(got.revenue_cents, wantRevenue, "实收：");
  eq(got.gross_cents, wantGross, "原价：");
  eq(got.discount_cents, wantDiscount, "优惠：");
});
test("撤销过的单子不计入销售额", () => {
  const voided = archive.transactions.filter((t) => t.status === "voided");
  ok(voided.length > 0, "档案里应该有一笔已撤销的单子，测试前提不成立");
  const got = Biz.stats(null).summary;
  const allTotal = archive.transactions.reduce((a, t) => a + t.final_cents, 0);
  eq(got.revenue_cents, allTotal - voided.reduce((a, t) => a + t.final_cents, 0),
     "实收应该是「全部单据 − 已撤销」：");
});
test("库存恒等式在导入后依然成立", () => {
  archive.products.forEach((p) => {
    const inPhone = Biz.state().products.find((x) => x.id === p.id);
    const restock = Biz.state().ledger
      .filter((e) => e.product_id === p.id && e.reason === "restock")
      .reduce((a, e) => a + e.change_qty, 0);
    const net = Biz.state().ledger
      .filter((e) => e.product_id === p.id &&
                     (e.reason === "sale" || e.reason === "void_return"))
      .reduce((a, e) => a + e.change_qty, 0);
    eq(inPhone.stock_initial + restock + net, Biz.productStock(p.id), p.name + " 恒等式：");
  });
});
test("场次结算表能算出来且数字自洽", () => {
  const active = Biz.activeSession();
  const sum = Biz.sessionSummary(active.id);
  const lines = Biz.sessionLines(active.id);
  eq(sum.total_brought, lines.reduce((a, l) => a + l.brought, 0), "带出：");
  eq(sum.total_sold, lines.reduce((a, l) => a + l.sold, 0), "售出：");
  eq(sum.total_remaining, lines.reduce((a, l) => a + l.remaining, 0), "剩余：");
  lines.forEach((l) => {
    eq(l.remaining, Biz.productStock(l.product_id), l.name + " 场次剩余 vs 当前库存：");
  });
});
test("手机上还能继续记账（导入后不是只读的）", () => {
  const before = Biz.state().transactions.length;
  const target = Biz.listProducts(true)[0];
  const stockBefore = target.stock_current;
  Biz.addToCartForce(target.id);
  const res = Biz.commitTransaction({});
  ok(res.ok, res.error || "记账失败");
  eq(Biz.state().transactions.length, before + 1, "单据数应该 +1：");
  eq(Biz.productStock(target.id), stockBefore - 1, "库存应该 -1：");
  const tx = Biz.state().transactions[Biz.state().transactions.length - 1];
  ok(tx.session_id, "新单子应该归属到某个场次：");
  // 收尾：撤销这一笔，别把测试数据留给后面的用例
  Biz.voidTransaction(tx.id, "验收测试回滚");
  eq(Biz.productStock(target.id), stockBefore, "撤销后库存应回到原值：");
});
test("导出再导入依然一致（手机端自己的备份链路）", () => {
  const snapshot = JSON.stringify(Biz.state().products) + "|" +
                   JSON.stringify(Biz.state().transactions) + "|" +
                   JSON.stringify(Biz.state().ledger);
  const out = JSON.parse(JSON.stringify(Biz.exportArchive()));
  Biz.resetAll();
  const res = Biz.importArchive(out, "replace");
  ok(res.ok, res.error);
  const after = JSON.stringify(Biz.state().products) + "|" +
                JSON.stringify(Biz.state().transactions) + "|" +
                JSON.stringify(Biz.state().ledger);
  eq(after, snapshot, "往返后应该完全一致：");
});

/* ---------------------------------------------------------------- 图片链路 */
/* 说明：这张测试环境里没有真正的图片解码器（没有 canvas），所以用 SVG 来验证
   「图片编码成 data URL → 存进档案 → 导入 → 商品仍然带着图」这整条链路。
   真正的压缩（canvas 缩放 + 转 JPEG）只能在手机浏览器里跑，那部分逻辑在
   UI 层的文件选择处理里，依赖浏览器的 Image/canvas。 */
console.log("\n== 图片链路 ==");

function makeSvgDataUrl(label) {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40">' +
    '<rect width="40" height="40" fill="#3f7cac"/>' +
    '<text x="20" y="26" font-size="18" text-anchor="middle" fill="#fff">' +
    (label || "A") + "</text></svg>";
  return "data:image/svg+xml;base64," + Buffer.from(svg, "utf8").toString("base64");
}

test("商品图片能存下来并写进备份", () => {
  Biz.resetAll();
  Biz.ensureSession();
  const image = makeSvgDataUrl("A");
  const res = Biz.saveProduct({ name: "带图商品", price_cents: 1000, stock_initial: 3,
                                image: image });
  ok(res.ok, res.error);
  eq(Biz.state().products[0].image, image, "商品里的图片：");
  const archive2 = Biz.exportArchive();
  eq(archive2.products[0].image, image, "备份里的图片：");
});
test("带图的备份能导入，图片不丢", () => {
  const image = makeSvgDataUrl("B");
  Biz.saveProduct({ name: "另一件带图", price_cents: 2000, stock_initial: 1, image: image });
  const archive2 = JSON.parse(JSON.stringify(Biz.exportArchive()));
  Biz.resetAll();
  Biz.ensureSession();
  const res = Biz.importArchive(archive2, "replace");
  ok(res.ok, res.error);
  const withImage = Biz.state().products.filter((p) => p.image);
  eq(withImage.length, archive2.products.filter((p) => p.image).length, "带图商品数量：");
  ok(withImage.every((p) => String(p.image).startsWith("data:image/")), "图片格式：");
});
test("图片会让存储用量变大（能算出这个信号）", () => {
  const before = Store.usage().bytes;
  Biz.saveProduct({ name: "大图商品", price_cents: 100, stock_initial: 1,
                    image: makeSvgDataUrl("C") });
  Biz.touch();
  ok(Store.usage().bytes > before, "存了图之后用量应该变大");
});

/* ---------------------------------------------------------------- 汇总 */
console.log("\n" + "=".repeat(52));
if (failures.length === 0) {
  console.log("导入验收全部通过：" + passed + " 项");
  process.exit(0);
} else {
  console.log("失败 " + failures.length + " 项（通过 " + passed + " 项）：");
  failures.forEach(([n, m]) => console.log("  · " + n + " —— " + m));
  process.exit(1);
}
