/* 量一下「真正落到地图上的换乘站比例」——不信权重，信实测。
   pickLastKind==="transfer" 只是「显式换乘类」，真正让玩家弹面板的是
   「抽到的站名本身是不是枢纽」，所以两者都要量。 */
const fs = require("fs");
const vm = require("vm");
const html = fs.readFileSync(__dirname + "/play.html", "utf8");
const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(x => x[1]);
const tm = html.match(/const THEMES = (\{[\s\S]*?\n\});[\s\S]*?function pickTheme/);
const THEMES = vm.runInNewContext("(" + tm[1] + ")", {});

function ctxProxy() {
  const grad = { addColorStop() {} };
  return new Proxy({}, { get(_, p) {
    if (p === "createRadialGradient" || p === "createLinearGradient") return () => grad;
    if (p === "measureText") return () => ({ width: 10 });
    return () => {};
  }, set() { return true; } });
}
function makeEl(id) {
  return { id, style: {}, _l: {}, textContent: "", innerHTML: "", children: [], firstChild: null,
    classList: { add(){}, remove(){}, toggle(){}, contains(){ return false; } },
    addEventListener(t, fn) { (this._l[t] = this._l[t] || []).push(fn); },
    removeEventListener() {}, setAttribute() {}, getAttribute() { return null; },
    appendChild(c) { this.children.push(c); this.firstChild = this.children[0]; return c; },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c; },
    querySelector() { return makeEl("q"); }, querySelectorAll() { return []; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 400 }; },
    getContext() { return ctxProxy(); }, clientWidth: 800, clientHeight: 800, width: 0, height: 0 };
}
function makeSandbox(theme) {
  const sb = {};
  const els = {};
  const getEl = (id) => (els[id] = els[id] || makeEl(id));
  const win = { addEventListener(){}, innerWidth: 800, innerHeight: 400, devicePixelRatio: 2,
    screen: {}, ResizeObserver: class { observe() {} }, visualViewport: undefined,
    location: { search: "?theme=" + theme }, localStorage: { getItem(){return null;}, setItem(){} } };
  const doc = { getElementById: getEl, querySelector(s){ return getEl("sel:"+s); },
    querySelectorAll(s){ if (s.indexOf("data-dir")>=0) return [makeEl("d0"),makeEl("d1"),makeEl("d2"),makeEl("d3")]; return []; },
    createElement() { return makeEl("new"); }, addEventListener(){}, body: makeEl("body"),
    documentElement: { requestFullscreen(){} }, fullscreenElement: null, title: "" };
  Object.assign(sb, { window: win, document: doc, navigator: { maxTouchPoints: 0 }, location: win.location,
    localStorage: win.localStorage, performance: { now: () => sb.__clock },
    requestAnimationFrame: (cb) => { sb.__raf = cb; }, setTimeout: () => 0, setInterval: () => 0,
    clearInterval: () => {}, URLSearchParams, console, __els: els, __clock: 1000, __raf: null });
  return sb;
}

for (const theme of ["beijing", "nanjing"]) {
  const sb = makeSandbox(theme);
  for (const b of blocks) vm.runInNewContext(b, sb, { filename: "play.html" });
  (sb.__els["startBtn"]._l.click || []).forEach(fn => fn());
  // 跑几百拍，让地图铺满、状态稳定
  let now = sb.__clock;
  for (let n = 0; n < 300; n++) { now += 16; sb.__clock = now; const cb = sb.__raf; sb.__raf = null; if (cb) cb(now); }

  const S = sb.__SNAKE__ || sb.window.__SNAKE__;

  // ① pickStation 抽样：kind 分布 + 「抽到的站本身是不是枢纽」
  const N = 3000;
  const hs = S.pickHubSample(N);
  const kind = {}, hubByKind = {};
  let tot = 0;
  for (const k of Object.keys(hs.byKind)) { kind[k] = hs.byKind[k].n; hubByKind[k] = hs.byKind[k].hub; tot += hs.byKind[k].n; }

  // ② 场上现有豆子里，枢纽占多少（玩家眼睛看到的密度）
  const fr = S.foodHubRatio();

  // ③ 天然基准：枢纽占全部车站
  const idx = S.pickIndex();

  console.log("===== " + theme + " =====");
  console.log("  天然基准：全部车站 " + idx.all + " 个，其中枢纽 " + idx.tr + " = " + (idx.tr / idx.all * 100).toFixed(1) + "%");
  console.log("  pickStation 抽样 " + N + " 次（kind 分布 / 该 kind 里是枢纽的比例）：");
  for (const k of Object.keys(kind).sort((a, b) => kind[b] - kind[a])) {
    const r = kind[k] / tot * 100, hr = kind[k] ? hubByKind[k] / kind[k] * 100 : 0;
    console.log("    " + k.padEnd(10) + " 占 " + r.toFixed(1).padStart(5) + "%   其中是枢纽 " + hr.toFixed(1) + "%");
  }
  console.log("  >> 真正会弹面板的枢纽站占比 = " + (hs.hub / (hs.hub + hs.nonhub) * 100).toFixed(1) + "%");
  console.log("  场上豆子 " + fr.total + " 个，其中枢纽 " + fr.hub + " = " + (fr.total ? (fr.hub / fr.total * 100).toFixed(1) : "0") + "%");
}
