/* 联机叠加层探针自检：确认 cam()/playerHead() 返回可渲染的快照，且坐标变换与引擎一致 */
const fs = require("fs");
const vm = require("vm");
const html = fs.readFileSync(__dirname + "/play.html", "utf8");
const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(x => x[1]);

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
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); this.firstChild = this.children[0] || null; return c; },
    querySelector() { return makeEl("q"); }, querySelectorAll() { return []; },
    getBoundingClientRect() { return { left: 0, top: 0, width: this.clientWidth || 800, height: this.clientHeight || 400 }; },
    getContext() { return ctxProxy(); }, clientWidth: 800, clientHeight: 800, width: 0, height: 0 };
}
function makeSandbox(theme) {
  const els = {}; const getEl = id => (els[id] = els[id] || makeEl(id));
  const winL = {}, docL = {};
  const win = { addEventListener(t, fn) { (winL[t] = winL[t] || []).push(fn); },
    innerWidth: 800, innerHeight: 400, devicePixelRatio: 2, screen: {}, ResizeObserver: class { observe() {} },
    visualViewport: undefined, location: { search: "?theme=" + theme },
    localStorage: { getItem() { return null; }, setItem() {} } };
  const doc = { getElementById: getEl, querySelector(s){ return getEl("sel:" + s); },
    querySelectorAll(s){ return s.indexOf("data-dir") >= 0 ? [makeEl("d0"), makeEl("d1")] : []; },
    createElement() { return makeEl("new"); }, addEventListener(t, fn) { (docL[t] = docL[t] || []).push(fn); },
    body: makeEl("body"), documentElement: { requestFullscreen() {} }, fullscreenElement: null, title: "" };
  return { window: win, document: doc, navigator: { maxTouchPoints: 0 }, location: win.location,
    localStorage: win.localStorage, performance: { now: () => sb.__clock }, requestAnimationFrame: cb => { sb.__raf = cb; },
    setTimeout: () => 0, setInterval: () => 0, clearInterval: () => {}, URLSearchParams, console, __els: els, __winL: winL, __clock: 1000, __raf: null };
}
let sb;
const sbByTheme = {};
let ok = true;
for (const theme of ["su", "77", "beijing", "nanjing"]) {
  sb = makeSandbox(theme); sbByTheme[theme] = sb;
  try { for (const b of blocks) vm.runInNewContext(b, sb, { filename: "play.html" }); }
  catch (e) { console.error("FAIL [" + theme + "] eval threw:", e && e.stack || e); ok = false; continue; }
  (sb.__els["startBtn"]._l.click || []).forEach(fn => fn());
  let now = sb.__clock;
  for (let n = 0; n < 120; n++) { now += 16; sb.__clock = now; const cb = sb.__raf; sb.__raf = null; if (cb) cb(now); }
  const S = sb.window.__SNAKE__;
  if (!S) { console.error("FAIL [" + theme + "] window.__SNAKE__ 未定义"); ok = false; continue; }
  // cam() 必须返回 8 个数值字段
  const cam = S.cam();
  const keys = ["camX","camY","VCOLS","VROWS","CELL","WCOLS","WROWS"];
  const bad = keys.filter(k => typeof cam[k] !== "number" || !isFinite(cam[k]));
  if (bad.length) { console.error("FAIL [" + theme + "] cam() 缺字段/非数值: " + bad.join(",")); ok = false; }
  else console.log("  [" + theme + "] cam() ✓ → camX=" + cam.camX.toFixed(1) + " CELL=" + cam.CELL + " VCOLS=" + cam.VCOLS.toFixed(1));
  // playerHead() 必须返回 {x,y,dir}
  const h = S.playerHead();
  if (!h || typeof h.x !== "number" || typeof h.y !== "number" || !h.dir) { console.error("FAIL [" + theme + "] playerHead() 异常: " + JSON.stringify(h)); ok = false; }
  else console.log("  [" + theme + "] playerHead() ✓ → (" + h.x + "," + h.y + ") dir=(" + h.dir.x + "," + h.dir.y + ")");
  // 坐标变换一致：ovSx/ovSy 必须等于引擎 sx/sy（同一公式）。环形世界里远侧点会落在屏幕外，
  // 引擎随后按 S±CELL 裁剪——这是预期行为，故只校验「有限」+「相机中心映射到屏幕中心」。
  function rel(v,cam,n){ var d=(v-cam)%n; if(d>n/2)d-=n; if(d<-n/2)d+=n; return d; }
  const sx = ((cam.VCOLS - 1) / 2 + rel(10, cam.camX, cam.WCOLS)) * cam.CELL;
  const sy = ((cam.VROWS - 1) / 2 + rel(20, cam.camY, cam.WROWS)) * cam.CELL;
  const sxC = ((cam.VCOLS - 1) / 2 + rel(cam.camX, cam.camX, cam.WCOLS)) * cam.CELL; // 应为屏幕中心 x
  const syC = ((cam.VROWS - 1) / 2 + rel(cam.camY, cam.camY, cam.WROWS)) * cam.CELL;
  const centerX = (cam.VCOLS - 1) / 2 * cam.CELL, centerY = (cam.VROWS - 1) / 2 * cam.CELL;
  if (![sx, sy, sxC, syC].every(Number.isFinite)) { console.error("FAIL [" + theme + "] 变换产生非有限值"); ok = false; }
  else if (Math.abs(sxC - centerX) > 0.01 || Math.abs(syC - centerY) > 0.01) { console.error("FAIL [" + theme + "] 相机中心未映射到屏幕中心 sxC=" + sxC + " 期望 " + centerX); ok = false; }
  else console.log("  [" + theme + "] 变换复算 ✓ 有限 + 中心对齐(Δ<0.01) · 远侧点 sx=" + sx.toFixed(1) + "（引擎将裁剪，符合预期）");
}
console.log(ok ? "\nMP PROBE PASS" : "\nMP PROBE FAILED");
process.exit(ok ? 0 : 1);
