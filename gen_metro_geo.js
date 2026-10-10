/* gen_metro_geo.js —— 用真实坐标生成「全网线路图」数据块
 * 输入：station_poi_<city>.json（抓 OSM 时已算好的每站坐标）
 *       play.html 的 lines（真实站序）
 * 输出：metro_geo.js —— var METRO_GEO={ beijing:{ "1号线":[[lat,lon],...], ...}, nanjing:{...} }
 *
 * 用途：站点卡片弹框里画一张真实的全城地铁线路图，并标出「这个站在哪」。
 */
const fs = require("fs"), vm = require("vm");

const html = fs.readFileSync("play.html", "utf8");
const a = html.indexOf("const THEMES"), b = html.indexOf("THEMES.cc=", a);
const ctx = {}; vm.createContext(ctx);
vm.runInContext(html.slice(a, b) + "\nvar __o=THEMES;", ctx);
const THEMES = ctx.__o;

const out = {};
for (const city of ["beijing", "nanjing"]) {
  const sp = JSON.parse(fs.readFileSync("station_poi_" + city + ".json", "utf8"));
  const T = THEMES[city];
  if (!T || !T.lines) continue;
  out[city] = {};
  let miss = 0, tot = 0;
  T.lines.forEach(L => {
    const pts = [];
    L.stations.forEach(n => {
      tot++;
      const c = sp[n] && sp[n].coord;
      if (c) pts.push([+c[0].toFixed(4), +c[1].toFixed(4)]);
      else { miss++; pts.push(null); }        // 缺坐标的站留空，画线时跳过
    });
    out[city][L.name] = { color: L.color, pts: pts, stations: L.stations };
  });
  console.log(city + ": " + T.lines.length + " 线 · " + tot + " 站 · 缺坐标 " + miss);
}

// 输出为可直接内联的 JS（紧凑，4 位小数 ≈ 0.01km 精度，够画示意图）
let s = "/* 地铁线路真实坐标（OSM，ODbL）—— 供卡片弹框画「全城线路图 + 本站在哪」\n"
      + "   由 gen_metro_geo.js 从 station_poi_<city>.json 生成，勿手改。\n"
      + "   pts 与该线 stations 一一对应；null = 该站没拿到坐标，画线时跳过。 */\n"
      + "var METRO_GEO=" + JSON.stringify(out) + ";\n";
fs.writeFileSync("metro_geo.js", s);
console.log("已生成 metro_geo.js  " + (s.length / 1024).toFixed(1) + "KB");
