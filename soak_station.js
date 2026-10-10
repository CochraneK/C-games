/* soak_station.js —— 验证「站点卡片 / 换乘」后期不会断供
 *
 * 背景：用户反馈「换线路、现实卡片为什么只有初期有，后期就没了」。
 * 根因是数学问题：全网 676 站均匀随机时，同一站要凑满 CARD_AT(3) 次几乎不可能。
 * 本脚本定量验证加权后的生成分布，并模拟「后期局面」（本线已建完、一堆站差一次出卡）。
 */
const fs = require("fs"), vm = require("vm");
const html = fs.readFileSync("play.html", "utf8");

function run(theme) {
  const s = html.replace(/const THEME = pickTheme\(\);/, `const THEME = THEMES["${theme}"];`);
  // 复用 smoke-test 的 DOM 桩思路（精简版）
  const created = [], els = {};
  function mk(tag) {
    const o = { tagName: tag, style: {}, children: [], attrs: {}, _t: "", _h: "", _c: "", value: "", checked: true,
      width: 800, height: 800, clientWidth: 800, clientHeight: 800,
      classList: { _s: new Set(), add(c){this._s.add(c);}, remove(c){this._s.delete(c);},
                   contains(c){return this._s.has(c);}, toggle(c,f){ if(f===undefined) f=!this._s.has(c);
                     f?this._s.add(c):this._s.delete(c); return f; } },
      __h: {}, appendChild(c){ this.children.push(c); return c; },
      insertBefore(c){ this.children.push(c); return c; },
      removeChild(){}, setAttribute(k,v){this.attrs[k]=v;}, getAttribute(k){return this.attrs[k];},
      addEventListener(t,fn){ (this.__h=this.__h||{})[t]=(this.__h[t]||[]).concat(fn); },
      removeEventListener(){}, querySelectorAll(){return [];}, querySelector(){return null;},
      closest(){return null;}, getContext(){ return CTX; },
      getBoundingClientRect(){ return {left:0,top:0,width:800,height:800}; },
      focus(){}, blur(){}, click(){}, remove(){}, insertAdjacentHTML(){} };
    Object.defineProperty(o, "textContent", { get(){return this._t;}, set(v){this._t=v;} });
    Object.defineProperty(o, "innerHTML",   { get(){return this._h;}, set(v){this._h=v;} });
    Object.defineProperty(o, "className",   { get(){return this._c;}, set(v){this._c=v;} });
    created.push(o); return o;
  }
  const CTX = new Proxy({}, { get(t, k) {
    if (k === "canvas") return { width: 800, height: 800 };
    if (k === "measureText") return () => ({ width: 40 });
    if (k === "createLinearGradient" || k === "createRadialGradient") return () => ({ addColorStop(){} });
    return () => {};
  }, set(){ return true; } });

  function gid(id) { if (!els[id]) { const e = mk("div"); e.id = id; els[id] = e; } return els[id]; }
  const ctx = {
    console, Math, Date, JSON, Object, Array, String, Number, Boolean, Set, Map, isNaN, parseInt, parseFloat,
    setTimeout: () => 0, clearTimeout(){}, setInterval: () => 0, clearInterval(){},
    requestAnimationFrame(cb){ ctx.__raf = cb; return 0; },   // 存起来手动驱动，同步递归会爆栈
    cancelAnimationFrame(){}, __raf: null, __clock: 1000,
    performance: { now: () => ctx.__clock }, localStorage: { getItem: () => null, setItem(){}, removeItem(){} },
    location: { search: "?theme=" + theme }, navigator: { maxTouchPoints: 0 },
    URLSearchParams, Image: function(){ return {}; },
    document: { getElementById: gid, createElement: mk, createElementNS: (n,t)=>mk(t),
      querySelectorAll: () => [], querySelector: () => null, addEventListener(){}, body: mk("body"),
      head: mk("head"), documentElement: mk("html") },
  };
  ctx.window = ctx; ctx.globalThis = ctx; ctx.self = ctx;
  ctx.addEventListener = function(){}; ctx.removeEventListener = function(){};
  ctx.matchMedia = function(){ return { matches:false, addListener(){}, addEventListener(){} }; };
  ctx.innerWidth = 1280; ctx.innerHeight = 800; ctx.devicePixelRatio = 1;
  vm.createContext(ctx);
  const main = s.match(/<script>([\s\S]*?)<\/script>/g).pop().replace(/^<script>|<\/script>$/g, "");
  try { vm.runInContext(main, ctx); } catch (e) { console.log("  [" + theme + "] 运行异常:", e.message); return null; }
  // 手动驱动若干帧（否则 player / homeLine 还没建起来）
  for (let n = 0; n < 120; n++) {
    ctx.__clock += 16;
    const cb = ctx.__raf; ctx.__raf = null;
    if (cb) { try { cb(ctx.__clock); } catch (e) { break; } }
  }
  return ctx;
}

const W = { next:26, nearCard:22, homeLine:18, transfer:14, unlit:8, other:6 };
const WTOT = Object.values(W).reduce((a,b)=>a+b,0);

for (const theme of ["beijing", "nanjing"]) {
  const c = run(theme);
  if (!c) continue;
  const S = c.__SNAKE__ || (c.window && c.window.__SNAKE__);
  if (!S) { console.log("=== " + theme + " · 拿不到探针 __SNAKE__"); continue; }
  const idx = S.pickIndex();
  console.log("=== " + theme + " · 站点索引 " + JSON.stringify(idx));

  // ① 开局分布
  let d = S.pickSample(3000);
  console.log("  【开局】生成分布:");
  Object.keys(W).forEach(k => {
    const p = ((d[k]||0)/3000*100).toFixed(1);
    console.log("    " + k.padEnd(9) + (d[k]||0) + "  " + p + "%  (目标 " + (W[k]/WTOT*100).toFixed(1) + "%)");
  });

  // ② 模拟「后期」：造 40 个差一次出卡的站（真实站名，取索引里的前 40 个）
  const seeded = S.seedNearCard(40);
  console.log("\n  【后期局面】造 " + seeded + " 个「差一次出卡」的站后:");
  console.log("    " + JSON.stringify(S.cardStats()));
  d = S.pickSample(3000);
  const nearPct = ((d.nearCard||0)/3000*100).toFixed(1);
  const trPct = ((d.transfer||0)/3000*100).toFixed(1);
  console.log("    nearCard 占比 " + nearPct + "%  → 卡片仍有供给 " + (nearPct > 8 ? "✓" : "✗ 会断供"));
  console.log("    transfer 占比 " + trPct + "%  → 换乘仍有供给 " + (trPct > 8 ? "✓" : "✗ 会断供"));
  console.log("");
}
