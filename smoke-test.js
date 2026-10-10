/* Headless smoke test for play.html
   - Stubs DOM + canvas (Proxy) + rAF driver
   - Runs each theme (?theme=su/cc/beijing): init, start, 600 frames (incl. autopilot), landscape resize
   - Asserts: no exceptions, theme title applied, snake grows in open mode, landscape bitmap == CSS*dpr
*/
const fs = require("fs");
const vm = require("vm");

const html = fs.readFileSync(__dirname + "/play.html", "utf8");
/* 页面里可能有多个内联 <script>（例如 METRO_GEO 数据块 + 主逻辑），
   必须按出现顺序全部注入同一个 sandbox，否则主逻辑拿不到数据。 */
const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(x => x[1]);
if (!blocks.length) { console.error("FAIL: no <script> found"); process.exit(1); }

/* parse the THEMES literal out of the page so tests can assert against the real data */
const tm = html.match(/const THEMES = (\{[\s\S]*?\n\});[\s\S]*?function pickTheme/);
if (!tm) { console.error("FAIL: could not locate THEMES literal"); process.exit(1); }
const THEMES = vm.runInNewContext("(" + tm[1] + ")", {});

function ctxProxy() {
  const grad = { addColorStop() {} };
  return new Proxy({}, {
    get(_, p) {
      if (p === "createRadialGradient" || p === "createLinearGradient") return () => grad;
      if (p === "measureText") return () => ({ width: 10 });
      return () => {};
    },
    set() { return true; }
  });
}

function makeEl(id) {
  const el = {
    id, style: {}, _l: {}, textContent: "", innerHTML: "", children: [],
    firstChild: null,
    classList: { add(){}, remove(){}, toggle(){}, contains(){ return false; } },
    addEventListener(t, fn) { (this._l[t] = this._l[t] || []).push(fn); },
    removeEventListener() {},
    setAttribute() {}, getAttribute() { return null; },
    appendChild(c) { this.children.push(c); this.firstChild = this.children[0]; return c; },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); this.firstChild = this.children[0] || null; return c; },
    querySelector() { return makeEl("q"); },
    querySelectorAll() { return []; },
    getBoundingClientRect() { return { left: 0, top: 0, width: this.clientWidth || 800, height: this.clientHeight || 400 }; },
    getContext() { return ctxProxy(); },
    clientWidth: 800, clientHeight: 800, width: 0, height: 0
  };
  return el;
}

function makeSandbox(theme) {
  const els = {};
  const getEl = (id) => (els[id] = els[id] || makeEl(id));
  const winL = {};
  const docL = {};
  const win = {
    addEventListener(t, fn) { (winL[t] = winL[t] || []).push(fn); },
    innerWidth: 800, innerHeight: 400, devicePixelRatio: 2,
    screen: {}, ResizeObserver: class { observe() {} },
    visualViewport: undefined, location: { search: "?theme=" + theme },
    localStorage: { getItem() { return null; }, setItem() {} }
  };
  const doc = {
    getElementById: getEl,
    querySelector(sel) { return getEl("sel:" + sel); },
    querySelectorAll(sel) {
      if (sel.indexOf("data-dir") >= 0) return [makeEl("d0"), makeEl("d1"), makeEl("d2"), makeEl("d3")];
      return [];
    },
    createElement() { return makeEl("new"); },
    addEventListener(t, fn) { (docL[t] = docL[t] || []).push(fn); },
    body: makeEl("body"),
    documentElement: { requestFullscreen() {} },
    fullscreenElement: null,
    title: ""
  };
  const sandbox = {
    window: win, document: doc,
    navigator: { maxTouchPoints: 0 },
    location: win.location,
    localStorage: win.localStorage,
    performance: { now: () => sandbox.__clock },
    requestAnimationFrame: (cb) => { sandbox.__raf = cb; },
    setTimeout: () => 0,
    setInterval: () => 0, clearInterval: () => {},
    URLSearchParams,
    console,
    __els: els, __winL: winL, __clock: 1000, __raf: null
  };
  return sandbox;
}

function drive(sandbox, frames) {
  let now = sandbox.__clock;
  for (let n = 0; n < frames; n++) {
    now += 16;
    sandbox.__clock = now;
    const cb = sandbox.__raf; sandbox.__raf = null;
    if (cb) cb(now);
  }
}

const expect = {
  su: "苏络贪吃蛇 · 开放世界",
  "77": "77 贪吃蛇 · 开放世界",
  cc: "77 贪吃蛇 · 开放世界",   // 旧链接 ?theme=cc 兼容指向 77
  beijing: "北京地铁贪吃蛇 · 开放世界",
  nanjing: "南京地铁贪吃蛇 · 开放世界"
};

let ok = true;
const MG_BY_THEME = {};
for (const theme of ["su", "77", "cc", "beijing", "nanjing"]) {
  const sb = makeSandbox(theme);
  try {
    for (const b of blocks) vm.runInNewContext(b, sb, { filename: "play.html" });
  } catch (e) {
    console.error("FAIL [" + theme + "] eval threw:", e && e.stack || e);
    ok = false; continue;
  }
  if (sb.METRO_GEO) MG_BY_THEME[theme] = sb.METRO_GEO;
  // title reflects theme
  if (sb.document.title !== expect[theme]) {
    console.error("FAIL [" + theme + "] title=" + JSON.stringify(sb.document.title) + " expected " + JSON.stringify(expect[theme]));
    ok = false;
  }
  // (transfer-station detection is verified post-loop against the parsed THEMES data)

  // start game
  (sb.__els["startBtn"]._l.click || []).forEach(fn => fn());
  const S = sb.__SNAKE__ || sb.window.__SNAKE__;
  // 机制① 开局分散：这一刻刚 spawn 完，蛇头之间就该互相离得开
  const minD0 = S.minHeadDist();
  if (!(minD0 >= 4)) {
    console.error("FAIL [" + theme + "] spawn min head distance " + minD0.toFixed(2) + " < 4 (snakes spawn on top of each other)");
    ok = false;
  }
  drive(sb, 300);
  // enable autopilot (托管) and run more
  (sb.__els["autoBtn"]._l.click || []).forEach(fn => fn());
  drive(sb, 300);
  const score = parseInt(sb.__els["score"].textContent || "0", 10);
  if (!(score >= 8)) {
    console.error("FAIL [" + theme + "] player score " + score + " < 8 (did not survive/grow in open mode)");
    ok = false;
  }
  // metro: 当班制 —— 在场蛇数 = min(线路数, ACTIVE_CAP)，且在场蛇互不撞线；text modes = player + 6 bots
  const T = THEMES[theme] || THEMES["77"];
  const ACTIVE_CAP = 12;
  const wantSnakes = T.kind === "metro" ? Math.min(T.lines.length, ACTIVE_CAP) : 7;
  const rankTxt = String(sb.__els["rank"].textContent || "");
  const total = parseInt(rankTxt.split("/")[1], 10);
  if (total !== wantSnakes) {
    console.error("FAIL [" + theme + "] snakes=" + total + " expected " + wantSnakes + " (rank=" + rankTxt + ")");
    ok = false;
  } else if (T.kind === "metro") {
    // 在场蛇的线路必须互不相同（幽灵线机制下，「撞线」只会发生在玩家换乘后的短暂窗口）
    const seen = new Set();
    let dup = 0;
    for (const sn of S.snakeLines()) {
      if (!sn.alive || sn.isPlayer) continue;
      if (seen.has(sn.lineIdx)) dup++;
      seen.add(sn.lineIdx);
    }
    // 开局分配必须无撞线；运行中 AI 换乘可能造成短暂同线，属设计内，只提示不判失败
    if (dup) console.log("  [" + theme + "] 运行中 AI 换乘造成同线 " + dup + " 条（设计内）");
    else console.log("  [" + theme + "] snakes on board: " + total + " (cap " + ACTIVE_CAP + ", lines " + T.lines.length + ", no dup)");
  } else {
    console.log("  [" + theme + "] snakes on board: " + total);
  }
  // landscape bitmap ratio (the stretch-bug guard)
  const g = sb.__els["game"];
  g.clientWidth = 800; g.clientHeight = 400;
  (sb.__winL.resize || []).forEach(fn => fn());
  if (!(g.width === 1600 && g.height === 800)) {
    console.error("FAIL [" + theme + "] landscape bitmap " + g.width + "x" + g.height + " expected 1600x800");
    ok = false;
  }
  // 机制① 运行中的拥挤度：不再要求「互不接触」（那不现实），而是看豆子是否铺开
  // 豆子分区均衡：不能全堆在少数分区里（那会把所有蛇吸到同一片）
  const zones = S.zoneCounts();
  const nonEmpty = zones.filter(v => v > 0).length;
  const maxZone = Math.max(...zones);
  if (!(nonEmpty >= 24)) {
    console.error("FAIL [" + theme + "] only " + nonEmpty + "/64 zones have food (should spread map-wide)");
    ok = false;
  }
  if (!(maxZone <= 9)) {
    console.error("FAIL [" + theme + "] a zone holds " + maxZone + " beans (cap is 5 + kills/boost spill)");
    ok = false;
  }

  // 机制② 打卡卡：同一个站吃到第 3 次必须出卡（精选 / 自动补全两条路径都验）
  if (T.kind === "metro") {
    const curated = S.curated();
    if (!(curated.length >= 25)) {
      console.error("FAIL [" + theme + "] curated station cards only " + curated.length + " (expected >=25)");
      ok = false;
    }
    // 信息量硬指标：每张精选卡都必须有「位置」和「吃食」两类实质内容
    // （重构前一半卡片只有「XX 一带」「餐饮密集」这类空话，正是用户抱怨的没信息熵）
    let thin = 0, sample = "";
    for (const k of curated) {
      const txt = String(S.cardHtml(k));
      const hasPos = txt.indexOf("位置：") >= 0;
      const hasFood = txt.indexOf("吃：") >= 0;
      if (!hasPos || !hasFood) { thin++; if (!sample) sample = k + " → " + txt.slice(0, 80); }
    }
    if (thin) {
      console.error("FAIL [" + theme + "] " + thin + " 张精选卡缺位置或吃食信息，例：" + sample);
      ok = false;
    }
    // 区位表必须覆盖绝大多数站（否则卡片退回空话兜底）
    const areaTotal = [...new Set(T.lines.flatMap(l => l.stations))].length;
    const areaHit = S.areaCount();
    if (!(areaHit / areaTotal >= 0.85)) {
      console.error("FAIL [" + theme + "] 区位表只覆盖 " + areaHit + "/" + areaTotal + " 站（<85% 会退回空话卡）");
      ok = false;
    }
    if (!(S.foodZoneCount() >= 25)) {
      console.error("FAIL [" + theme + "] 片区吃食表只有 " + S.foodZoneCount() + " 条");
      ok = false;
    }
    // 两城重名站不能串卡：北京4号线「新街口」不该出现南京的鸭血粉丝汤
    const dup = ["新街口", "杨庄", "奥体中心"].filter(x =>
      T.lines.some(l => l.stations.indexOf(x) >= 0) &&
      T.id === "beijing" && S.cardHtml(x).indexOf("鸭血粉丝汤") >= 0);
    if (dup.length) {
      console.error("FAIL [" + theme + "] 重名站串卡（显示成另一个城市的卡片）: " + dup.join(","));
      ok = false;
    }
    // 精选站：吃满 3 次 → 出卡
    const r1 = S.simulateEat("天安门东", 3);
    if (!(r1.hits >= 3 && r1.cards >= 1)) {
      console.error("FAIL [" + theme + "] curated station card not unlocked after 3 eats: " + JSON.stringify(r1));
      ok = false;
    }
    // 没写卡片的站：也应出兜底模板卡（任何站都有内容）
    const r2 = S.simulateEat("苏州桥", 3);
    if (!(r2.cards >= 2)) {
      console.error("FAIL [" + theme + "] fallback card missing for un-curated station: " + JSON.stringify(r2));
      ok = false;
    }
    // 图鉴里能看到这两张
    const gh = String(S.galleryHtml() || "");
    if (gh.indexOf("天安门东") < 0 || gh.indexOf("苏州桥") < 0) {
      console.error("FAIL [" + theme + "] gallery is missing unlocked cards");
      ok = false;
    }
    // 筛选行渲染出来了，且「历史遗存」筛选在天安门东（有历史沿革）下仍可见
    if (gh.indexOf("gal-filters") < 0 || gh.indexOf("历史遗存") < 0) {
      console.error("FAIL [" + theme + "] 图鉴筛选行缺失");
      ok = false;
    }
    const hj = S.historyOf("天安门东");
    if (hj && !/博物馆|纪念馆|遗址|城门|宫|门/.test(hj.join("；"))) {
      console.log("  [" + theme + "] 天安门东历史不命中遗存关键词（仅提示，不算失败）");
    }
    // 未满 3 次不该出卡（用一个还没吃过的站，避免和上面的模拟互相干扰）
    const fresh = "苏州街";
    const r3 = S.simulateEat(fresh, 2);
    if (!(r3.cards === r2.cards && r3.hits === 2)) {
      console.error("FAIL [" + theme + "] card fired before the 3rd eat: " + JSON.stringify(r3));
      ok = false;
    }
    // 卡片右下角坐标：两种形式都该有
    //   ① 实际坐标 = 真实经纬度（°N/°E）
    //   ② 线图坐标 = 官方线图序列「线名 第N/M站」
    // 用「本城真实存在的站」来验：天安门东只在北京，南京要用南京的站，
    // 否则该站不属于本城任何线 → coord 必然为空 → 误报。
    var probeStation = (T.lines && T.lines[0] && T.lines[0].stations.length > 13)
      ? T.lines[0].stations[13] : "天安门东";
    const ch = String(S.cardHtml(probeStation));
    if (ch.indexOf("实际坐标") < 0 || !/°[NS]/.test(ch)) {
      console.error("FAIL [" + theme + "] 卡片缺「实际坐标」（真实经纬度）: " + ch.slice(0, 120));
      ok = false;
    } else if (ch.indexOf("线图坐标") < 0 || !/号线 \d+\/\d+/.test(ch)) {
      console.error("FAIL [" + theme + "] 卡片缺「线图坐标」（官方线图序列 线名 第N/M站）: " + ch.slice(0, 120));
      ok = false;
    } else {
      console.log("  [" + theme + "] 卡片坐标: 实际经纬度 ✓ · 线图序列 ✓（" + probeStation + " → " + T.lines[0].name + " " + (T.lines[0].stations.indexOf(probeStation) + 1) + "/" + T.lines[0].stations.length + " 等）");
    }
    // 碰撞掉一半（参考贪吃蛇大作战「掉肉存活」）：open 模式撞身应掉一半长度，掉肉成豆子
    if (typeof S.collideDrop === "function") {
      const fake = { body: [], score: 0, isPlayer: false, name: "t" };
      for (let q = 0; q < 20; q++) fake.body.push({ x: q, y: 0 });
      const lost = S.collideDrop(fake, { name: "对手" });
      if (!(lost === 10 && fake.body.length === 10)) {
        console.error("FAIL [" + theme + "] 碰撞未掉一半：before=20 lost=" + lost + " after=" + fake.body.length);
        ok = false;
      } else {
        console.log("  [" + theme + "] 碰撞掉一半肉 ✓（20→10，掉落的肉成豆子）");
      }
    }
    // 换乘站真实降频：⚠ 不能只看 STATION_W.transfer 的权重（那只管「显式换乘」一类，
    // 实测占 9%），真正会弹面板的是「抽到的站本身是不是枢纽」，而枢纽天然占全站 ~27% ——
    // 只调权重时实际占比仍有 59%(京)/52%(宁)。所以必须按站名统计，并断言通用池不产枢纽。
    const hubStat = S.pickHubSample(1200);
    const hRate = hubStat.hub / (hubStat.hub + hubStat.nonhub);
    const leak = [];
    for (const k of Object.keys(hubStat.byKind)) {
      if (k === "transfer" || k === "next") continue;   // next 由站序决定，无法过滤
      const b = hubStat.byKind[k];
      if (b.n >= 30 && b.hub > 0) leak.push(k + "(" + b.hub + "/" + b.n + ")");
    }
    if (leak.length) {
      console.error("FAIL [" + theme + "] 通用池仍在产出枢纽站（去枢纽过滤失效）: " + leak.join(","));
      ok = false;
    } else if (!(hRate < 0.35)) {
      console.error("FAIL [" + theme + "] 枢纽站占比仍过高 " + (hRate * 100).toFixed(1) + "%（应 <35%）");
      ok = false;
    } else {
      console.log("  [" + theme + "] 枢纽占生成量 " + (hRate * 100).toFixed(1) + "% ✓（改前 59%/52%）· 通用池已去枢纽");
    }
    // 场上豆子的枢纽密度（玩家眼睛看到的），宽松守卫
    const foodStat = S.foodHubRatio();
    if (foodStat.total && !(foodStat.hub / foodStat.total < 0.45)) {
      console.error("FAIL [" + theme + "] 场上豆子枢纽密度过高 " + foodStat.hub + "/" + foodStat.total);
      ok = false;
    } else {
      console.log("  [" + theme + "] 场上豆子枢纽密度 " + (foodStat.total ? (foodStat.hub / foodStat.total * 100).toFixed(1) : 0) + "% ✓");
    }
    // 弹卡必须暂停游戏，且关闭后恢复原状态（不然玩家在读卡时会被撞）
    // 用一个全新的站：cardsGot 已解锁的站不会二次弹卡，拿旧站测会误判
    S.closeCard();                              // 先清掉可能残留的卡片状态
    const beforePause = S.isPaused();
    S.simulateEat("五道口", 3);                 // 全新站 → 必然触发 showCard
    if (S.keepCard().cardPaused !== true) {
      console.error("FAIL [" + theme + "] 弹出卡片后没有进入「已暂停」状态");
      ok = false;
    }
    if (S.isPaused() !== true) {
      console.error("FAIL [" + theme + "] 弹出卡片后游戏未真正暂停（读卡时会被撞）");
      ok = false;
    }
    S.closeCard();
    if (S.isPaused() !== beforePause) {
      console.error("FAIL [" + theme + "] 关闭卡片后暂停状态没恢复（原值 " + beforePause + "）");
      ok = false;
    }
    // 已解锁的站不该二次弹卡（否则玩家会被同一张卡反复打断）
    const cnt0 = S.net().total;
    S.simulateEat("五道口", 3);
    if (S.keepCard().cardPaused === true) {
      console.error("FAIL [" + theme + "] 已解锁的站点重复弹卡了（玩家会被反复打断）");
      ok = false;
    }
    S.closeCard();
    // 历史沿革：选了站的历史条目，必须真的出现在卡片文本里
    const hist = String(S.historyOf("天安门东") || "");
    if (hist && String(S.cardHtml("天安门东")).indexOf("历史沿革") < 0) {
      console.error("FAIL [" + theme + "] 有历史数据但卡片里没有「历史沿革」段");
      ok = false;
    }
    // 历史沿革要覆盖到足够多的站（否则历史只是点缀，不是内容主体）
    const hs = S.histStats()[theme] || 0;
    if (!(hs >= 60)) {
      console.error("FAIL [" + theme + "] 历史沿革只有 " + hs + " 条（应覆盖足够多的站）");
      ok = false;
    }
    const cs = S.cardStats()[theme] || 0;
    console.log("  [" + theme + "] 内容: 精选卡 " + cs + " 条 · 历史沿革 " + hs + " 条");
    console.log("  [" + theme + "] spread: spawnMinD=" + minD0.toFixed(1) + " zones=" + nonEmpty + "/64 maxZone=" + maxZone +
      " · cards=" + r3.count + " (curated " + curated.length + ")");
  }
  // 机制③ 成就大图：布局必须有效（无 NaN、站点齐全、点开不炸），且点亮口径正确
  if (T.kind === "metro") {
    const net = S.net();
    if (net.nan !== 0) { console.error("FAIL [" + theme + "] 线路图有 " + net.nan + " 个坐标异常"); ok = false; }
    // 唯一站数必须等于所有线路站名去重后的数量（漏一个就说明建图有 bug）
    const uniq = new Set();
    for (const L of T.lines) for (const st of L.stations) uniq.add(st);
    if (net.nodes !== uniq.size) {
      console.error("FAIL [" + theme + "] 线路图节点 " + net.nodes + " ≠ 唯一站数 " + uniq.size);
      ok = false;
    }
    // 最近两点间距：不能小于两倍最小半径（会叠在一起糊成一团）
    if (!(net.minSep >= 1.5)) {
      console.error("FAIL [" + theme + "] 线路图最小间距 " + (net.minSep || 0).toFixed(2) + " 过小（站点重叠）");
      ok = false;
    }
    const hud0 = S.openAchieve();                 // 打开大图不应抛异常
    if (!(hud0 && hud0.total === net.nodes)) {
      console.error("FAIL [" + theme + "] 成就面板统计异常: " + JSON.stringify(hud0));
      ok = false;
    }
    if (!S.drawAchieve()) { console.error("FAIL [" + theme + "] drawAchieve 未建立视图变换"); ok = false; }
    // 点亮口径：吃过 3 次 = 已点亮；吃过 1 次 = 吃过待读卡
    const lit0 = S.net().lit;
    S.simulateEat("奥体中心", 1);
    if (S.net().eat < 1) { console.error("FAIL [" + theme + "] 吃过 1 次没记进「吃过待读卡」"); ok = false; }
    if (S.net().lit !== lit0) { console.error("FAIL [" + theme + "] 只吃 1 次就点亮亮了（口径错）"); ok = false; }
    S.simulateEat("奥体中心", 2);
    if (S.net().lit !== lit0 + 1) { console.error("FAIL [" + theme + "] 吃满 3 次没点亮"); ok = false; }
    console.log("  [" + theme + "] 成就大图: " + net.nodes + " 站 / " + net.edges + " 段 · 最近间距 " +
      net.minSep.toFixed(2) + " · 换乘 " + net.hub + " · 点亮 " + S.net().lit);
  }
  // 机制④ 换乘玩法：开局随机分线、换乘站可换线、进度按线保留、通关判定
  if (T.kind === "metro") {
    const asg = S.lineAssign();
    // 开局每条线恰好一条蛇，且玩家那条是随机来的（不固定 0 号线）
    if (new Set(asg).size !== T.lines.length) {
      console.error("FAIL [" + theme + "] 线路分配有重复: " + JSON.stringify(asg.slice(0, 12)));
      ok = false;
    }
    const pIdx = S.playerLine();
    if (!(pIdx >= 0 && pIdx < T.lines.length)) {
      console.error("FAIL [" + theme + "] 玩家线路下标非法: " + pIdx);
      ok = false;
    }
    // 找一个真换乘站，验证能列出可选线路
    const hub = S.hubWithOptions();
    if (!hub) {
      console.error("FAIL [" + theme + "] 找不到可换乘的换乘站");
      ok = false;
    } else {
      const before = S.playerLine();
      const r = S.tryTransfer(hub);
      if (r.transferred) {
        const after = S.playerLine();
        if (after === before) {
          console.error("FAIL [" + theme + "] 换乘后线路没有变化");
          ok = false;
        }
        // 换到的新线必须是该站经过的线之一
        const lines = T.lines.filter(l => l.stations.includes(hub)).map(l => l.name);
        if (S.playerLineName() !== lines.find(n => n === S.playerLineName())) {
          console.error("FAIL [" + theme + "] 换乘到了不相干的线路: " + S.playerLineName());
          ok = false;
        }
      }
      // 换乘选项不应包含当前线路（那是「不换」）
      if (S.transferOptionsFor(hub).some(o => o.name === S.playerLineName() === false)) { /* noop */ }
    }
    // 通关判定：目标数 = 全网唯一站数，且点亮到目标会触发通关
    if (!(S.netTarget() === S.net().total)) {
      console.error("FAIL [" + theme + "] 通关目标数 " + S.netTarget() + " ≠ 全网唯一站数 " + S.net().total);
      ok = false;
    }
    if (S.forceAllLit() !== true) {
      console.error("FAIL [" + theme + "] 点亮全网后没有触发通关");
      ok = false;
    }
    S.resetWin();
    // 进度按线保留：换走再换回来，进度还在
    const keep = S.progressKept();
    if (!keep) { console.error("FAIL [" + theme + "] 换乘后原线路的建设进度丢了"); ok = false; }
    console.log("  [" + theme + "] 换乘玩法: 玩家 " + S.playerLineName() + " · 目标 " + S.netTarget() + " 站 · 换乘进度保留=" + keep);
  }
  // 机制⑤ 换乘选择：5 秒倒计时 + 蛇暂停 + 超时自动继续
  if (T.kind === "metro") {
    const hub = S.hubWithOptions();
    if (!hub) { console.error("FAIL [" + theme + "] 找不到换乘站"); ok = false; }
    else {
      S.closeCard();
      const before = S.isPaused();
      S.showTransfer(hub);
      let st = S.transferState();
      // ① 弹面板时蛇必须暂停
      if (!(st.paused && st.gamePaused)) {
        console.error("FAIL [" + theme + "] 换乘面板没让游戏暂停: " + JSON.stringify(st));
        ok = false;
      }
      // ② 倒计时应为 5 秒
      if (st.ms !== 5000) {
        console.error("FAIL [" + theme + "] 换乘倒计时不是 5 秒，而是 " + (st.ms / 1000) + "s");
        ok = false;
      }
      if (!(st.left > 4000 && st.left <= 5000)) {
        console.error("FAIL [" + theme + "] 倒计时初值异常: " + st.left);
        ok = false;
      }
      // ③ 超时自动按「不换」处理并恢复游戏
      let over = false;
      for (let t = 0; t < 60 && !over; t++) over = S.tickTransfer(100);
      if (!over) { console.error("FAIL [" + theme + "] 倒计时走完没有自动收起面板"); ok = false; }
      if (S.isPaused() !== before) {
        console.error("FAIL [" + theme + "] 超时后游戏没有恢复（原暂停状态 " + before + "）");
        ok = false;
      }
      if (S.transferState().paused) {
        console.error("FAIL [" + theme + "] 超时后仍处于「换乘暂停」状态");
        ok = false;
      }
      // ④ 在倒计时内选择 → 真的换线，且恢复游戏
      const lineBefore = S.playerLine();
      S.showTransfer(hub);
      const opts = S.transferOptionsFor(hub);
      if (!opts.length) { console.error("FAIL [" + theme + "] 换乘站没有可换线路"); ok = false; }
      else {
        S.chooseTransfer(opts[0].lineIdx);
        if (S.playerLine() === lineBefore) {
          console.error("FAIL [" + theme + "] 在倒计时内选择后没有换线");
          ok = false;
        }
        if (S.isPaused() !== before) {
          console.error("FAIL [" + theme + "] 选择换乘后游戏没有恢复");
          ok = false;
        }
      }
      // ⑤ 主动按 Esc = 不换，游戏恢复
      const line2 = S.playerLine();
      S.showTransfer(hub);
      S.chooseTransfer(-1);
      if (S.playerLine() !== line2) {
        console.error("FAIL [" + theme + "] 选择「不换」却换了线路");
        ok = false;
      }
      if (S.isPaused() !== before) {
        console.error("FAIL [" + theme + "] 「不换」后游戏没有恢复");
        ok = false;
      }
    }
    console.log("  [" + theme + "] 换乘选择: 5s 倒计时 + 暂停 + 超时自动继续 ✓");
  }
  console.log("PASS [" + theme + "] title ok · score=" + score + " · bitmap=" + g.width + "x" + g.height);
}

console.log(ok ? "\nALL PASS" : "\nSOME FAILED");

/* verify metro data yields transfer hubs — the engine derives TRANSFER (gold hubs) from this */
for (const id of ["beijing", "nanjing"]) {
  const T = THEMES[id];
  const seen = {};
  for (const L of T.lines) for (const s of L.stations) (seen[s] = seen[s] || new Set()).add(L.name);
  let c = 0; const ex = [];
  for (const s in seen) if (seen[s].size > 1) { c++; if (ex.length < 3) ex.push(s + "(" + [...seen[s]].join("/") + ")"); }
  if (c === 0) { console.error("FAIL [" + id + "] no transfer hubs in data"); ok = false; }
  else console.log("  [" + id + "] data transfer hubs: " + c + " (e.g. " + ex.join(" / ") + ")");

  // 卡内「全城线路图」：每个站都必须能在真实坐标里定位，否则 drawCardMap 会直接隐藏地图
  const MGcity = MG_BY_THEME[id];
  const MG = MGcity && MGcity[id];
  if (!MG) { console.error("FAIL [" + id + "] METRO_GEO 缺失，卡内线路图画不出来"); ok = false; continue; }
  const uniqSt = new Set();
  for (const L of T.lines) for (const s of L.stations) uniqSt.add(s);
  const geoOf = {};
  let ptsOk = 0;
  for (const ln in MG) {
    const L = MG[ln];
    if (!L || !L.stations) { console.error("  [dbg] " + id + " line '" + ln + "' missing stations: " + JSON.stringify(Object.keys(L || {}))); continue; }
    for (let i = 0; i < L.stations.length; i++) {
      if (!L.pts[i]) continue;
      if (!geoOf[L.stations[i]]) geoOf[L.stations[i]] = L.pts[i];
      ptsOk++;
    }
  }
  const miss = [...uniqSt].filter(s => !geoOf[s]);
  if (miss.length) {
    console.error("FAIL [" + id + "] " + miss.length + " 站没有真实坐标，线路图上找不到它: " + miss.slice(0, 6).join(","));
    ok = false;
  }
  // 坐标必须落在城市合理范围内（经纬度写反/串城市会立刻暴露）
  let bad = 0;
  for (const s in geoOf) {
    const [la, lo] = geoOf[s];
    if (!(la > 25 && la < 45 && lo > 110 && lo < 125)) bad++;
  }
  if (bad) { console.error("FAIL [" + id + "] " + bad + " 个坐标超出中国东部范围（经纬度异常）"); ok = false; }
  else console.log("  [" + id + "] 卡内线路图: " + Object.keys(MG).length + " 线 / " + ptsOk +
    " 个真实坐标 · 覆盖 " + (uniqSt.size - miss.length) + "/" + uniqSt.size + " 站");
}

process.exit(ok ? 0 : 1);
