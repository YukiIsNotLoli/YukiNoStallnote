/* =============================================================
   手机版业务逻辑测试（用 Node 跑，不需要浏览器）

   思路：从 出摊计算器.html 里把 <script> 整段抠出来，在一个带
   document / localStorage 桩的沙箱里执行，然后直接测 M / Pricing / Biz /
   Store / Images 这些模块。

   跑法：  node tests/test_phone.js
   ============================================================= */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const HTML = path.join(__dirname, "..", "出摊计算器.html");
const source = fs.readFileSync(HTML, "utf8");

/* ---------------------------------------------------------------- 抠出脚本 */
const match = source.match(/<script>\n([\s\S]*?)\n<\/script>/);
if (!match) {
  console.error("没能在 HTML 里找到 <script> 段，测试无法进行");
  process.exit(1);
}
let code = match[1];

/* 不要让它自动启动界面（就删掉那一条监听，后面的导出代码必须留着） */
code = code.replace(
  /document\.addEventListener\("DOMContentLoaded", function \(\) \{ UI\.boot\(\); \}\);/,
  "/* 测试环境下不自动启动界面 */"
);

/* ---------------------------------------------------------------- DOM 桩 */
/* 记下每个 id 对应的元素，测试可以回头检查它的子节点结构——
   这样「弹窗有没有底栏」这种问题就能被真实验证，而不只是扫源码。 */
const domNodes = new Map();

/* 浏览器里的 Node/Element 基类，沙箱里得补齐——脚本用 `instanceof Node`
   来判断传进来的是节点还是 HTML 字符串，没有它会直接报错。 */
function FakeNode() {}
FakeNode.prototype.nodeType = 1;

function makeEl(id) {
  const el = Object.create(FakeNode.prototype);
  Object.assign(el, {
    id: id, _html: "", textContent: "", value: "", disabled: false, checked: false,
    dataset: {}, style: {}, className: "", children: [], files: null,
    addEventListener() {}, removeEventListener() {},
    appendChild(child) { this.children.push(child); return child; },
    insertBefore(child) { this.children.push(child); return child; },
    remove() {}, focus() {}, click() {},
    querySelector() { return makeEl("q"); }, querySelectorAll() { return []; },
    setAttribute() {}, getAttribute() { return null; },
  });
  /* 真实 DOM 里给 innerHTML 赋值会「换掉全部子节点」。
     桩如果只存字符串，就会漏掉这个语义——之前那条「关闭后应该清空」的测试
     就是因为这个假阳性失败。所以这里如实模拟：赋值即清空 children。 */
  Object.defineProperty(el, "innerHTML", {
    get() { return this._html; },
    set(v) {
      this._html = String(v);
      this.children.length = 0;
    },
  });
  /* 加类名时按空格拆开记下来，测试要能看出有没有 hidden 之类 */
  el.classList = {
    _set: new Set(),
    add(...names) { names.forEach((n) => this._set.add(n)); },
    remove(...names) { names.forEach((n) => this._set.delete(n)); },
    toggle(name, force) {
      const on = force === undefined ? !this._set.has(name) : !!force;
      if (on) this._set.add(name); else this._set.delete(name);
      return on;
    },
    contains(name) { return this._set.has(name); },
  };
  return el;
}

function getNode(id) {
  if (!domNodes.has(id)) domNodes.set(id, makeEl(id));
  return domNodes.get(id);
}

const store = new Map();
const localStorageStub = {
  getItem(k) { return store.has(k) ? store.get(k) : null; },
  setItem(k, v) { store.set(k, String(v)); },
  removeItem(k) { store.delete(k); },
  get length() { return store.size; },
};

const sandbox = {
  console: console,
  setTimeout: setTimeout, clearTimeout: clearTimeout,
  Blob: function () {}, URL: { createObjectURL() { return "blob:x"; }, revokeObjectURL() {} },
  FileReader: function () {}, Image: function () {},
  Node: FakeNode, Element: FakeNode, HTMLElement: FakeNode,
  /* ?demo= 自检入口会读 location.search，这里给个空查询，让它自然跳过 */
  location: { search: "", href: "http://localhost/", hash: "" },
  URLSearchParams: URLSearchParams,
  localStorage: localStorageStub,
  document: {
    readyState: "complete",
    getElementById: (id) => getNode(id),
    querySelector: () => makeEl("q"),
    querySelectorAll: () => [],
    createElement: (tag) => makeEl(tag),
    addEventListener() {},
    body: makeEl("body"),
  },
  window: { scrollTo() {}, print() {} },
};
sandbox.globalThis = sandbox;

vm.createContext(sandbox);
try {
  vm.runInContext(code, sandbox, { filename: "出摊计算器.html" });
} catch (err) {
  console.error("脚本执行崩了：", err && err.stack || err);
  process.exit(1);
}

const exported = sandbox.__stallcalc || {};
const M = exported.M;
const Pricing = exported.Pricing;
const Biz = exported.Biz;
const Store = exported.Store;
const Images = exported.Images;
if (!M || !Pricing || !Biz || !Store) {
  console.error("模块没暴露出来，检查一下 HTML 末尾的 __stallcalc 导出");
  process.exit(1);
}

/* ---------------------------------------------------------------- 测试框架 */
let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log("  \u2714 " + name);
  } catch (err) {
    failures.push({ name, message: err && err.message });
    console.log("  \u2718 " + name + "\n      " + (err && err.message));
  }
}
function eq(actual, expected, label) {
  if (actual !== expected) {
    throw new Error((label || "") + " 期望 " + JSON.stringify(expected) +
                    "，实际 " + JSON.stringify(actual));
  }
}
function ok(cond, label) { if (!cond) throw new Error(label || "断言失败"); }
function near(actual, expected, tol, label) {
  if (Math.abs(actual - expected) > (tol == null ? 1 : tol)) {
    throw new Error((label || "") + " 期望≈" + expected + "，实际 " + actual);
  }
}
function reset() {
  Biz.resetAll();
  Biz.ensureSession();
}

/* ================================================================ 金额工具 */
console.log("\n== 金额工具 ==");
test("分转元字符串", () => {
  eq(M.money(0), "0.00");
  eq(M.money(5), "0.05");
  eq(M.money(1250), "12.50");
  eq(M.money(100000), "1000.00");
  eq(M.money(-350), "-3.50");
});
test("元转分（四舍五入到分）", () => {
  eq(M.toCents("12.5"), 1250);
  eq(M.toCents("0.1"), 10);
  eq(M.toCents("19.995"), 2000);
  eq(M.toCents(""), null);
  eq(M.toCents("abc"), null);
  eq(M.toCents("-5"), null);
});
test("折扣率说法", () => {
  eq(M.rate(10000, 8500), "8.5折");
  eq(M.rate(10000, 10000), "10折");
  eq(M.rate(0, 0), "—");
});
test("尾数取整", () => {
  eq(M.round(333, "cent"), 333);
  eq(M.round(333, "jiao"), 330);
  eq(M.round(333, "yuan_down"), 300);
  eq(M.round(333, "yuan_up"), 400);
  eq(M.round(0, "yuan_up"), 0);
});

/* ================================================================ 计价 */
console.log("\n== 计价引擎 ==");
const line = (id, price, qty, kind) => ({
  product_id: id, name: "P" + id, unit_price_cents: price, qty: qty,
  discount_kind: kind || "none", discount_nth: 2, discount_percent: 5,
});

test("无折扣", () => {
  const q = Pricing.quote([line(1, 5000, 2)], {});
  eq(q.gross_cents, 10000);
  eq(q.final_cents, 10000);
  eq(q.discount_cents, 0);
});
test("比例折扣 8.5 折", () => {
  const q = Pricing.quote([line(1, 5000, 2)], { percent_enabled: true, percent_value: 8.5 });
  eq(q.percent_cut_cents, 1500);
  eq(q.final_cents, 8500);
});
test("满减取最有利的一档（250 元 → 减 30，不是减 40）", () => {
  const q = Pricing.quote([line(1, 10000, 2)], {
    threshold_enabled: true,
    tiers: [{ threshold_cents: 10000, cut_cents: 1000 },
            { threshold_cents: 20000, cut_cents: 3000 }],
  });
  eq(q.threshold_cut_cents, 3000);
  eq(q.final_cents, 17000);
});
test("叠加顺序：先打折再满减（125 → 106.25 → 96.25）", () => {
  const q = Pricing.quote([line(1, 5000, 2), line(2, 2500, 1)], {
    percent_enabled: true, percent_value: 8.5, threshold_enabled: true,
    tiers: [{ threshold_cents: 10000, cut_cents: 1000 }],
  });
  eq(q.percent_cut_cents, 1875);
  eq(q.threshold_cut_cents, 1000);
  eq(q.final_cents, 9625);
  ok(q.stacked, "叠加标记应该为真");
  ok(q.confirm_required, "叠加必须要求确认");
});
test("恒等式：原价 − 优惠 = 实收（所有取整模式）", () => {
  ["cent", "jiao", "yuan_up", "yuan_down"].forEach((mode) => {
    const q = Pricing.quote([line(1, 333, 3)], {
      percent_enabled: true, percent_value: 9.3, rounding_mode: mode,
    });
    eq(q.gross_cents - q.discount_cents, q.final_cents, "模式 " + mode + "：");
  });
});
test("折扣不会把实收算成负数", () => {
  const q = Pricing.quote([line(1, 100, 1)], {
    threshold_enabled: true, tiers: [{ threshold_cents: 100, cut_cents: 99999 }],
  });
  eq(q.final_cents, 0);
  ok(q.discount_cents >= 0, "优惠额不能是负的");
});
test("第二件半价（4 件 33 元 → 省 33）", () => {
  const q = Pricing.quote([line(1, 3300, 4, "second_half")], {});
  eq(q.item_discount_cents, 3300);
  eq(q.final_cents, 9900);
  eq(q.item_breakdown[0].label, "第二件半价");
});
test("第 N 件 X 折用的是「折」口径（第 3 件 5 折）", () => {
  const l = line(1, 3300, 3, "nth_percent");
  l.discount_nth = 3; l.discount_percent = 5;
  const q = Pricing.quote([l], {});
  eq(q.item_discount_cents, 1650);
  eq(q.item_breakdown[0].label, "第 3 件 5 折");
});
test("套装：必须跨商品凑件数（2×A + 1×B = 3 件）", () => {
  const q = Pricing.quote([line(1, 800, 2, "bundle"), line(2, 800, 1, "bundle")], {
    bundles: [{ name: "任意 3 件 20 元", product_ids: [1, 2], qty: 3, price_cents: 2000 }],
  });
  eq(q.item_discount_cents, 400);
  eq(q.final_cents, 2000);
});
test("套装比单买贵时不生效", () => {
  const q = Pricing.quote([line(1, 800, 3, "bundle")], {
    bundles: [{ name: "贵的套装", product_ids: [1], qty: 3, price_cents: 9900 }],
  });
  eq(q.item_discount_cents, 0);
  eq(q.final_cents, 2400);
});
test("套装凑不满的部分按原价（7 件 → 2 组 + 1 散）", () => {
  const q = Pricing.quote([line(1, 800, 7, "bundle")], {
    bundles: [{ name: "任意 3 件 20 元", product_ids: [1], qty: 3, price_cents: 2000 }],
  });
  eq(q.item_discount_cents, 800);
  eq(q.final_cents, 4800);
});
test("套装优先挑贵的进套装（省最多）", () => {
  const q = Pricing.quote([line(1, 5000, 1, "bundle"), line(2, 500, 1, "bundle"),
                           line(3, 2000, 1, "bundle")], {
    bundles: [{ name: "3 件 30 元", product_ids: [1, 2, 3], qty: 3, price_cents: 3000 }],
  });
  eq(q.item_discount_cents, 4500);
  eq(q.final_cents, 3000);
});
test("套装优惠分摊到各行后，加起来正好等于总额", () => {
  const lines = [700, 1300, 1100, 900, 1700, 300].map((p, i) => line(i + 1, p, 1, "bundle"));
  const q = Pricing.quote(lines, {
    bundles: [{ name: "任意 3 件 20 元", product_ids: [1, 2, 3, 4, 5, 6], qty: 3,
                price_cents: 2000 }],
  });
  const allocated = q.item_breakdown.reduce((a, r) => a + r.cut_cents, 0);
  eq(allocated, q.item_discount_cents, "分项合计：");
  ok(q.item_discount_cents > 0, "应该真的优惠了");
  eq(q.gross_cents - q.discount_cents, q.final_cents, "恒等式：");
});
test("空购物车算出 0，不报错", () => {
  const q = Pricing.quote([], {});
  eq(q.final_cents, 0);
  eq(q.item_count, 0);
});
test("满减档位：重复门槛取优惠大的、非法档位被丢掉", () => {
  const tiers = Pricing.normalizeTiers([
    { threshold_cents: 10000, cut_cents: 500 },
    { threshold_cents: 10000, cut_cents: 1500 },
    { threshold_cents: 0, cut_cents: 9999 },
  ]);
  eq(tiers.length, 1);
  eq(tiers[0].cut_cents, 1500);
});

/* ================================================================ 商品与库存 */
console.log("\n== 商品与库存 ==");
test("新增商品并记初始库存流水", () => {
  reset();
  const res = Biz.saveProduct({ name: "色纸", price_cents: 5000, stock_initial: 10 });
  ok(res.ok, res.error);
  eq(Biz.listProducts(false)[0].stock_current, 10);
  eq(Biz.state().ledger.length, 1);
  eq(Biz.state().ledger[0].reason, "initial");
});
test("商品名不能空、单价不能为负", () => {
  reset();
  ok(!Biz.saveProduct({ name: "  ", price_cents: 100 }).ok, "空名字应该被拒");
  ok(!Biz.saveProduct({ name: "X", price_cents: -1 }).ok, "负单价应该被拒");
});
test("折扣值校验（必须是 0~10 的「折」）", () => {
  reset();
  ok(!Biz.saveProduct({ name: "X", price_cents: 100, discount_kind: "nth_percent",
                        discount_percent: 10 }).ok, "10 折等于没优惠，应该被拒");
  ok(Biz.saveProduct({ name: "Y", price_cents: 100, discount_kind: "nth_percent",
                       discount_percent: 5 }).ok, "5 折应该可以");
});
test("改初始库存会平移剩余，已售数量不受影响", () => {
  reset();
  const p = Biz.saveProduct({ name: "色纸", price_cents: 5000, stock_initial: 10 }).product;
  Biz.addToCart(p.id, 10);
  Biz.setCartQty(p.id, 4);
  Biz.commitTransaction({});
  eq(Biz.productStock(p.id), 6, "卖 4 件后：");
  eq(Biz.productSold(p.id), 4);
  Biz.saveProduct({ id: p.id, name: "色纸", price_cents: 5000, stock_initial: 20 });
  eq(Biz.productStock(p.id), 16, "改成带 20 件后：");
  eq(Biz.productSold(p.id), 4, "已售不该被改初始库存搅乱：");
});
test("补货、盘点、负数修正", () => {
  reset();
  const p = Biz.saveProduct({ name: "吧唧", price_cents: 1500, stock_initial: 5 }).product;
  Biz.restock(p.id, 10);
  eq(Biz.productStock(p.id), 15);
  Biz.restock(p.id, -3);
  eq(Biz.productStock(p.id), 12);
  ok(!Biz.restock(p.id, -999).ok, "减到负库存应该被拒");
  ok(!Biz.restock(p.id, 0).ok, "补 0 件应该被拒");
});
test("库存流水能追溯到每一笔", () => {
  reset();
  const p = Biz.saveProduct({ name: "色纸", price_cents: 1000, stock_initial: 10 }).product;
  Biz.addToCart(p.id, 10); Biz.setCartQty(p.id, 2); Biz.commitTransaction({});
  Biz.restock(p.id, 5);
  const reasons = Biz.productLedger(p.id).map((e) => e.reason);
  ok(reasons.indexOf("initial") >= 0, "应有上架流水");
  ok(reasons.indexOf("sale") >= 0, "应有销售流水");
  ok(reasons.indexOf("restock") >= 0, "应有补货流水");
});
test("库存恒等式：初始 + 补货 + 销售净额 = 当前库存", () => {
  reset();
  const p = Biz.saveProduct({ name: "色纸", price_cents: 1000, stock_initial: 30 }).product;
  Biz.restock(p.id, 10);
  Biz.addToCart(p.id, 30); Biz.setCartQty(p.id, 7); Biz.commitTransaction({});
  const restock = Biz.state().ledger.filter((e) => e.product_id === p.id &&
    e.reason === "restock").reduce((a, e) => a + e.change_qty, 0);
  const net = Biz.state().ledger.filter((e) => e.product_id === p.id &&
    (e.reason === "sale" || e.reason === "void_return")).reduce((a, e) => a + e.change_qty, 0);
  eq(30 + restock + net, Biz.productStock(p.id), "恒等式：");
  eq(Biz.productStock(p.id), 33);
});

/* ================================================================ 收银与撤销 */
console.log("\n== 收银与撤销 ==");
test("结算扣库存、金额正确、单价走快照", () => {
  reset();
  const a = Biz.saveProduct({ name: "色纸", price_cents: 5000, stock_initial: 10 }).product;
  const b = Biz.saveProduct({ name: "钥匙扣", price_cents: 2500, stock_initial: 10 }).product;
  Biz.addToCart(a.id, 10); Biz.setCartQty(a.id, 2);
  Biz.addToCart(b.id, 10); Biz.setCartQty(b.id, 1);
  const res = Biz.commitTransaction({ paidCents: 20000 });
  ok(res.ok, res.error);
  eq(res.transaction.gross_cents, 12500);
  eq(res.transaction.final_cents, 12500);
  eq(res.transaction.change_cents, 7500);
  eq(Biz.productStock(a.id), 8);
  eq(Biz.productStock(b.id), 9);
  eq(Biz.state().cart.length, 0, "结算后购物车应该清空");

  // 之后改价，历史单必须还是原价
  Biz.saveProduct({ id: a.id, name: "色纸", price_cents: 9900 });
  eq(Biz.listTransactions(10)[0].items[0].unit_price_cents, 5000, "历史单单价：");
});
test("超卖被拦住（一次报全所有缺货的）", () => {
  reset();
  const a = Biz.saveProduct({ name: "稀有A", price_cents: 3000, stock_initial: 2 }).product;
  const b = Biz.saveProduct({ name: "稀有B", price_cents: 3000, stock_initial: 1 }).product;
  Biz.addToCartForce(a.id); Biz.addToCartForce(a.id); Biz.addToCartForce(a.id);
  Biz.addToCartForce(b.id); Biz.addToCartForce(b.id);
  const res = Biz.commitTransaction({});
  ok(!res.ok, "应该被拦");
  ok(res.error.indexOf("库存不足") >= 0, "错误消息该说库存不足");
  ok(res.error.indexOf("稀有A") >= 0 && res.error.indexOf("稀有B") >= 0,
     "应该一次把两款都报出来");
  eq(Biz.productStock(a.id), 2, "失败后库存不能动：");
  eq(Biz.state().transactions.length, 0, "失败后不能留下单据");
  eq(Biz.state().cart.length, 2, "失败后购物车要保留");
});
test("允许超卖时能记账，库存变负", () => {
  reset();
  const p = Biz.saveProduct({ name: "色纸", price_cents: 1000, stock_initial: 1 }).product;
  Biz.addToCartForce(p.id); Biz.addToCartForce(p.id); Biz.addToCartForce(p.id);
  const res = Biz.commitTransaction({ allowNegative: true });
  ok(res.ok, res.error);
  eq(Biz.productStock(p.id), -2);
});
test("收到的钱比应收少要被拦", () => {
  reset();
  const p = Biz.saveProduct({ name: "色纸", price_cents: 5000, stock_initial: 5 }).product;
  Biz.addToCart(p.id, 5);
  const res = Biz.commitTransaction({ paidCents: 100 });
  ok(!res.ok, "应该被拦");
  ok(res.error.indexOf("还少") >= 0, "错误消息该提示钱不够");
  eq(Biz.state().transactions.length, 0);
});
test("叠加折扣必须显式确认", () => {
  reset();
  const p = Biz.saveProduct({ name: "色纸", price_cents: 10000, stock_initial: 5 }).product;
  Biz.setDiscount({ percent_enabled: true, percent_value: 9, threshold_enabled: true,
                    tiers: [{ threshold_cents: 15000, cut_cents: 1000 }] });
  Biz.addToCart(p.id, 5); Biz.setCartQty(p.id, 2);
  const bad = Biz.commitTransaction({});
  ok(!bad.ok, "没确认应该被拦");
  ok(bad.error.indexOf("确认") >= 0, "错误消息该要求确认");
  const good = Biz.commitTransaction({ confirmDiscount: true });
  ok(good.ok, good.error);
  eq(good.transaction.final_cents, 17000);
});
test("撤销：软撤销 + 库存回补 + 不计入统计", () => {
  reset();
  const p = Biz.saveProduct({ name: "色纸", price_cents: 5000, stock_initial: 10 }).product;
  Biz.addToCart(p.id, 10); Biz.setCartQty(p.id, 4);
  const res = Biz.commitTransaction({ paidCents: 20000 });
  eq(Biz.productStock(p.id), 6);

  const voided = Biz.voidTransaction(res.transaction.id, "手滑点错了");
  ok(voided.ok, voided.error);
  eq(Biz.productStock(p.id), 10, "撤销后库存：");
  eq(Biz.productSold(p.id), 0, "撤销后已售：");
  eq(Biz.stats(null).summary.orders, 0, "撤销单不该计入订单数");
  eq(Biz.stats(null).summary.revenue_cents, 0, "撤销单不该计入销售额");
  eq(Biz.state().transactions.length, 1, "单据要留档，不能删掉");
  eq(Biz.state().transactions[0].status, "voided");

  ok(!Biz.voidTransaction(res.transaction.id).ok, "撤两次应该报错");
});
test("撤销后库存流水自动抵消（不会翻倍）", () => {
  reset();
  const p = Biz.saveProduct({ name: "色纸", price_cents: 1000, stock_initial: 8 }).product;
  Biz.addToCart(p.id, 8); Biz.setCartQty(p.id, 3);
  const res = Biz.commitTransaction({});
  Biz.voidTransaction(res.transaction.id, "测试");
  // 卖掉又撤回，净额应该是 0；查历史的时候最怕这里算成 -3 和 +3 各算一次
  const net = Biz.state().ledger.filter((e) => e.product_id === p.id &&
    (e.reason === "sale" || e.reason === "void_return"))
    .reduce((a, e) => a + e.change_qty, 0);
  eq(net, 0, "销售净额：");
  eq(Biz.productStock(p.id), 8);
});

/* ================================================================ 场次 */
console.log("\n== 场次分账 ==");
test("自动开场，不用手动建", () => {
  reset();
  const s = Biz.activeSession();
  ok(s, "应该自动有一场");
  eq(s.is_active, true);
  eq(Biz.listSessions().length, 1);
});
test("开场边界用流水号，而不是时间戳", () => {
  reset();
  const p = Biz.saveProduct({ name: "先有货", price_cents: 1000, stock_initial: 10 }).product;
  const first = Biz.activeSession();
  // 同一秒内就开新场 + 加商品，时间戳会分不开，流水号能分开
  Biz.startSession("第二场");
  const fresh = Biz.saveProduct({ name: "开场后上架", price_cents: 2000, stock_initial: 5 }).product;
  const second = Biz.activeSession();
  ok(second.opening_ledger_id >= first.opening_ledger_id, "边界应该递增");

  const lines = Biz.sessionLines(second.id);
  const freshLine = lines.find((l) => l.product_id === fresh.id);
  eq(freshLine.opening, 0, "开场后才上架的商品，开场库存应该是 0：");
  eq(freshLine.brought, 5, "但它的初始库存算这一场带出来的货：");
  const oldLine = lines.find((l) => l.product_id === p.id);
  eq(oldLine.opening, 10, "开场前就有的货，应该算开场库存：");
});
test("两场账完全分开", () => {
  reset();
  const a = Biz.saveProduct({ name: "色纸", price_cents: 5000, stock_initial: 20 }).product;
  const b = Biz.saveProduct({ name: "吧唧", price_cents: 1500, stock_initial: 30 }).product;

  Biz.startSession("第一场");
  const s1 = Biz.activeSession();
  Biz.addToCart(a.id, 20); Biz.setCartQty(a.id, 3);
  Biz.commitTransaction({});

  Biz.startSession("第二场");
  const s2 = Biz.activeSession();
  Biz.addToCart(b.id, 30); Biz.setCartQty(b.id, 10);
  Biz.commitTransaction({});

  const sum1 = Biz.sessionSummary(s1.id);
  eq(sum1.orders, 1);
  eq(sum1.revenue_cents, 15000);
  eq(sum1.total_sold, 3);

  const sum2 = Biz.sessionSummary(s2.id);
  eq(sum2.orders, 1);
  eq(sum2.total_sold, 10);
  eq(sum2.total_brought, 47, "第二场开场时：色纸剩 17 + 吧唧 30 = 47");
});
test("新单子自动归到当前这场", () => {
  reset();
  const p = Biz.saveProduct({ name: "色纸", price_cents: 1000, stock_initial: 10 }).product;
  Biz.startSession("A场");
  const a = Biz.activeSession();
  Biz.addToCart(p.id, 10);
  const tx1 = Biz.commitTransaction({}).transaction;
  eq(tx1.session_id, a.id);
  Biz.startSession("B场");
  const b = Biz.activeSession();
  Biz.addToCart(p.id, 10);
  const tx2 = Biz.commitTransaction({}).transaction;
  eq(tx2.session_id, b.id);
  eq(Biz.listTransactions(50, a.id).length, 1, "A场的单子数：");
  eq(Biz.listTransactions(50, b.id).length, 1, "B场的单子数：");
});
test("收摊后结果固定，不能再收一次", () => {
  reset();
  const p = Biz.saveProduct({ name: "色纸", price_cents: 1000, stock_initial: 10 }).product;
  Biz.startSession("今日场");
  const s = Biz.activeSession();
  Biz.addToCart(p.id, 10); Biz.setCartQty(p.id, 2);
  Biz.commitTransaction({});
  eq(Biz.sessionSummary(s.id).total_sold, 2);
  eq(Biz.sessionSummary(s.id).total_remaining, 8);

  const closed = Biz.closeSession(s.id);
  ok(closed.ok, closed.error);
  ok(!Biz.closeSession(s.id).ok, "收两次应该报错");

  // 收摊后再卖，不能改写已经封存的这一场
  Biz.addToCart(p.id, 10);
  Biz.commitTransaction({});
  eq(Biz.sessionSummary(s.id).total_sold, 2, "封存后的场次不该被后来的单子改写：");
  eq(Biz.sessionSummary(s.id).total_remaining, 8);
});
test("开新场时自动收尾上一场（同时只有一场在进行）", () => {
  reset();
  Biz.startSession("第一场");
  const first = Biz.activeSession();
  Biz.startSession("第二场");
  const all = Biz.listSessions();
  eq(all.filter((s) => s.is_active).length, 1, "进行中的场次只能有一个：");
  const firstAgain = all.find((s) => s.id === first.id);
  eq(firstAgain.is_active, false);
  ok(firstAgain.ended_at, "上一场应该被写上收摊时间");
});
test("场次里撤销，库存和场次账都回到原样", () => {
  reset();
  const p = Biz.saveProduct({ name: "色纸", price_cents: 1000, stock_initial: 10 }).product;
  Biz.startSession("撤销测试场");
  const s = Biz.activeSession();
  Biz.addToCart(p.id, 10); Biz.setCartQty(p.id, 4);
  const tx = Biz.commitTransaction({}).transaction;

  eq(Biz.sessionSummary(s.id).total_sold, 4);
  eq(Biz.sessionSummary(s.id).total_remaining, 6);

  Biz.voidTransaction(tx.id, "测试");
  const after = Biz.sessionSummary(s.id);
  eq(after.total_sold, 0, "撤销后这一场售出：");
  eq(after.total_remaining, 10, "撤销后这一场剩余：");
  eq(after.voided, 1);
});

/* ================================================================ 设置与备份 */
console.log("\n== 设置与备份 ==");
test("设置校验：折扣值必须在 0~10", () => {
  reset();
  ok(!Biz.saveSettings({ percent_value: 12 }).ok, "12 折应该被拒");
  ok(!Biz.saveSettings({ percent_value: 0 }).ok, "0 折应该被拒");
  ok(Biz.saveSettings({ percent_value: 8.5 }).ok, "8.5 折应该可以");
});
test("摊位名称不能空", () => {
  reset();
  Biz.saveSettings({ stall_name: "   " });
  eq(Biz.settings().stall_name, "我的小摊");
});
test("套装配置会被规范化（件数至少 2、丢掉空商品列表）", () => {
  reset();
  const res = Biz.saveSettings({ bundle_rules: [
    { name: "坏套装", product_ids: [], qty: 3, price_cents: 1000 },
    { name: "好套装", product_ids: [1, 2], qty: 1, price_cents: 2000 },
  ] });
  ok(res.ok, res.error);
  eq(res.settings.bundle_rules.length, 1, "空的套装应该被丢掉：");
  eq(res.settings.bundle_rules[0].qty, 2, "件数至少是 2：");
});
test("导出再导入，账目一模一样", () => {
  reset();
  const p = Biz.saveProduct({ name: "色纸", price_cents: 5000, stock_initial: 10,
                              discount_kind: "second_half" }).product;
  Biz.addToCart(p.id, 10); Biz.setCartQty(p.id, 3);
  Biz.commitTransaction({ paidCents: 10000 });
  const before = JSON.stringify({
    products: Biz.state().products, transactions: Biz.state().transactions,
    ledger: Biz.state().ledger, sessions: Biz.state().sessions,
  });
  const archive = JSON.parse(JSON.stringify(Biz.exportArchive()));

  Biz.resetAll();
  const res = Biz.importArchive(archive, "replace");
  ok(res.ok, res.error);
  const after = JSON.stringify({
    products: Biz.state().products, transactions: Biz.state().transactions,
    ledger: Biz.state().ledger, sessions: Biz.state().sessions,
  });
  eq(after, before, "导入导出后应该完全一致：");
});
test("导入无效文件要给人话错误", () => {
  reset();
  const bad = Biz.importArchive("{不是 json", "replace");
  ok(!bad.ok);
  ok(bad.error.indexOf("JSON") >= 0, "该提示不是有效 JSON");

  const wrong = Biz.importArchive(JSON.stringify({ hello: "world" }), "replace");
  ok(!wrong.ok);
  ok(wrong.error.indexOf("出摊计算器") >= 0, "该提示不是本程序的备份");
});
test("合并导入：同名同价的商品不会变成两份", () => {
  reset();
  const p = Biz.saveProduct({ name: "色纸", price_cents: 5000, stock_initial: 10 }).product;
  const archive = JSON.parse(JSON.stringify(Biz.exportArchive()));
  const res = Biz.importArchive(archive, "merge");
  ok(res.ok, res.error);
  eq(Biz.state().products.length, 1, "商品应该被识别为同一个，不该重复：");
  eq(res.counts.transactions, 0, "没有单据时不该凭空加单据");
});
test("导入外部档案（字段略有不同也能吃下）", () => {
  reset();
  const desktopArchive = {
    format: "stallcalc-phone-archive", version: 1,
    exported_at: "2026-10-06 20:00:00", source: "外部导出",
    stall_name: "深海小摊",
    settings: { percent_value: 9, rounding_mode: "jiao", threshold_tiers: [],
                bundle_rules: [], low_stock_alert: 3, allow_negative_stock: false },
    products: [{ id: 1, name: "色纸 A3", category: "色纸", price_cents: 5000,
                 stock_initial: 40, low_stock_alert: 5, sort_order: 0, is_active: 1,
                 discount_kind: "none", discount_nth: 2, discount_percent: 5,
                 created_at: "2026-10-01 10:00:00", updated_at: "2026-10-01 10:00:00",
                 image: "data:image/png;base64,iVBORw0KGgo=" }],
    sessions: [{ id: 1, name: "国庆场", started_at: "2026-10-01 10:00:00",
                 ended_at: null, note: null, is_active: true, opening_ledger_id: 0 }],
    transactions: [{ id: 1, created_at: "2026-10-01 11:00:00", session_id: 1,
                     gross_cents: 15000, discount_cents: 0, final_cents: 15000,
                     paid_cents: 20000, change_cents: 5000, item_count: 3,
                     note: null, status: "completed", voided_at: null, void_reason: null,
                     percent_enabled: false, percent_value: 10, threshold_enabled: false,
                     item_discount_kind: "none", threshold_cut_cents: 0, rounding_mode: "cent",
                     items: [{ product_id: 1, name: "色纸 A3", unit_price_cents: 5000, qty: 3 }] }],
    ledger: [{ id: 1, product_id: 1, change_qty: 40, reason: "initial",
               transaction_id: null, stock_after: 40, created_at: "2026-10-01 10:00:00" },
             { id: 2, product_id: 1, change_qty: -3, reason: "sale",
               transaction_id: 1, stock_after: 37, created_at: "2026-10-01 11:00:00" }],
    stats: { product_count: 1, transaction_count: 1 },
  };
  const res = Biz.importArchive(desktopArchive, "replace");
  ok(res.ok, res.error);
  eq(Biz.state().products.length, 1);
  eq(Biz.state().transactions.length, 1);
  eq(Biz.state().sessions.length, 1);
  eq(Biz.productStock(1), 37, "导入后库存应该是 40 - 3：");
  eq(Biz.settings().stall_name, "深海小摊");
  ok(Biz.state().products[0].image, "图片（data URL）应该一起带过来");
  eq(Biz.sessionSummary(1).total_sold, 3, "导入的场次账要能算出来：");
});
test("存储层：存得下、读得回", () => {
  reset();
  Biz.saveProduct({ name: "持久化测试", price_cents: 100, stock_initial: 1 });
  const raw = sandbox.localStorage.getItem("stallcalc.phone.v1");
  ok(raw && raw.length > 0, "应该写进 localStorage 了");
  const parsed = JSON.parse(raw);
  eq(parsed.products.length, 1);
  eq(parsed.products[0].name, "持久化测试");
});
test("存储用量统计能报出来", () => {
  reset();
  Biz.saveProduct({ name: "X", price_cents: 100, stock_initial: 1 });
  const u = Store.usage();
  ok(u.bytes > 0, "应该有用量");
  ok(u.limit > 0, "应该有上限");
});

/* ================================================================ 弹窗结构 */
/* 这一组用于防回归：移动端打开「新增商品」时，底部确认按钮曾被挤出屏幕，
   弹窗只剩一个关闭叉。根因是弹窗允许「没有底栏」的状态存在。
   现改为强制有底栏，此测试守住这一约束。 */
console.log("\n== 弹窗结构（底栏不许消失）==");

const fs2 = require("fs");
const htmlSource = fs2.readFileSync(HTML, "utf8");

test("弹窗调用方必须自己塞按钮（源码级检查）", () => {
  const scriptBody = htmlSource.match(/<script>\n([\s\S]*?)\n<\/script>/)[1];
  const withoutAuto = scriptBody.replace(/UI\.boot\(\);/, "");
  const opens = withoutAuto.match(/modal\(\s*\{/g) || [];
  const calls = withoutAuto.match(/handle\.footer\.(innerHTML|appendChild)/g) || [];
  ok(opens.length > 0, "应该至少有一处弹窗调用");
  ok(calls.length >= opens.length,
     `弹窗调用 ${opens.length} 处，但往底栏塞按钮只有 ${calls.length} 处——` +
     "有弹窗可能没有确定键");
});

test("底栏样式：不允许被压缩，且躲开系统手势条", () => {
  const css = htmlSource.match(/<style>([\s\S]*?)<\/style>/)[1];
  const footRule = css.match(/\.modal__foot\{[^}]*\}/);
  ok(footRule, "找不到 .modal__foot 样式");
  ok(/flex:0 0 auto/.test(footRule[0]), "底栏必须不可压缩（flex:0 0 auto）");
  ok(/env\(safe-area-inset-bottom\)/.test(footRule[0]), "底栏要按安全区收边距");
  ok(/box-shadow/.test(footRule[0]), "底栏要有上浮阴影，和内容区分开");
});

test("正文区可以滚动，且允许被压缩（min-height:0）", () => {
  const css = htmlSource.match(/<style>([\s\S]*?)<\/style>/)[1];
  const bodyRule = css.match(/\.modal__body\{[^}]*\}/);
  ok(bodyRule, "找不到 .modal__body 样式");
  ok(/overflow-y:auto/.test(bodyRule[0]), "正文区要能滚动");
  ok(/min-height:0/.test(bodyRule[0]), "min-height:0 是 flex 子项能收缩的关键");
});

test("弹窗高度用 dvh，兼顾手机地址栏伸缩", () => {
  const css = htmlSource.match(/<style>([\s\S]*?)<\/style>/)[1];
  const boxRule = css.match(/\.modal__box\{[\s\S]*?\}/);
  ok(boxRule, "找不到 .modal__box 样式");
  ok(/100dvh/.test(boxRule[0]), "要用 100dvh：手机上地址栏出现/消失时 vh 会算错");
  ok(/max-height:88vh/.test(boxRule[0]), "老浏览器要有个 88vh 兜底");
});

test("弹窗根节点不滚动，避免双重滚动条把内容推歪", () => {
  const css = htmlSource.match(/<style>([\s\S]*?)<\/style>/)[1];
  const modalRule = css.match(/\.modal\{[^}]*\}/);
  ok(/overflow:hidden/.test(modalRule[0]), "弹窗外壳应该 overflow:hidden");
});

test("真开一个弹窗：结构里必须有底栏", () => {
  const box = getNode("modal-box");
  box.children.length = 0;

  const handle = exported.UI.modal({ title: "新增商品", body: "<p>表单内容</p>" });
  const classes = box.children.map((c) => c.className);
  ok(box.children.length > 0, "弹窗内容没有塞进 modal-box");
  ok(classes.indexOf("modal__head") >= 0, "缺少标题栏，实际：" + classes.join(" / "));
  ok(classes.indexOf("modal__body") >= 0, "缺少正文区，实际：" + classes.join(" / "));
  ok(classes.indexOf("modal__foot") >= 0,
     "缺少底部按钮栏——即用户实际遇到的「没有确定键」问题。实际：" + classes.join(" / "));

  const foot = box.children[classes.indexOf("modal__foot")];
  ok(foot.children.length > 0, "底栏里一个按钮都没有");
  handle.close();
});

test("调用方不给按钮时，自动补一个「关闭」兜底", () => {
  const box = getNode("modal-box");
  box.children.length = 0;
  // 故意不传 footer（模拟调用方忘了加按钮）
  const handle = exported.UI.modal({ title: "忘了加按钮的弹窗", body: "<p>x</p>" });
  const foot = box.children.find((c) => c.className === "modal__foot");
  ok(foot, "底栏应该被无条件创建");
  eq(foot.children.length, 1, "应该自动补 1 个兜底按钮：");
  eq(foot.children[0].textContent, "关闭", "兜底按钮文案：");
  handle.close();
});

test("关闭弹窗后清理干净（不会残留旧内容）", () => {
  const box = getNode("modal-box");
  box.children.length = 0;
  const handle = exported.UI.modal({ title: "临时弹窗", body: "<p>x</p>" });
  ok(box.children.length > 0, "打开时应该有内容");
  handle.close();
  eq(box.children.length, 0, "关闭后 modal-box 应该是空的：");
  eq(box._html, "", "innerHTML 也该被清空：");
});

/* ================================================================ 汇总 */
console.log("\n" + "=".repeat(52));
if (failures.length === 0) {
  console.log("全部通过：" + passed + " 项测试");
  process.exit(0);
} else {
  console.log("失败 " + failures.length + " 项（通过 " + passed + " 项）：");
  failures.forEach((f) => console.log("  · " + f.name + " —— " + f.message));
  process.exit(1);
}
