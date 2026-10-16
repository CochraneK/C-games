/* bell/duel 无头冒烟测试：验证座位永久绑定 + 双人对局流程 + 房主裁决
   用法：node duel-smoke.js  （仓库根目录） */
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  → ' + extra : '')); }
}
const tick = () => new Promise(r => setImmediate(r));

function makeClassList() {
  const set = new Set();
  return {
    add: c => set.add(c), remove: c => set.delete(c),
    toggle: (c, on) => { if (on === undefined) { set.has(c) ? set.delete(c) : set.add(c); } else { on ? set.add(c) : set.delete(c); } },
    contains: c => set.has(c), _set: set
  };
}
function makeEl(id) {
  const el = {
    id, textContent: '', innerHTML: '', disabled: false, className: '',
    classList: makeClassList(), handlers: {}, children: [],
    setAttribute() {}, getAttribute() { return null; },
    appendChild(c) { el.children.push(c); return c; },
    removeChild() {}, addEventListener(t, fn) { (el.handlers[t] = el.handlers[t] || []).push(fn); },
    matches() { return false; }, showModal() {}, close() {}, focus() {},
    fire(t, ev) { (el.handlers[t] || []).forEach(fn => fn(ev || { preventDefault() {}, target: null })); }
  };
  return el;
}
function seatBtn(seat) { const e = makeEl('btn' + seat); e.getAttribute = () => String(seat); return e; }

const HOST_ID = 'cgames-bell-duel-v1-su77315-host';   // 房间码 SU77315
function buildSandbox(search) {
  const els = {};
  const seatBtns = [seatBtn(0), seatBtn(1)];
  const document = {
    getElementById(id) { return els[id] || (els[id] = makeEl(id)); },
    querySelectorAll(sel) { return sel === '.seat-btn' ? seatBtns : []; },
    querySelector() { return null; },
    createElement() { return makeEl('dyn'); },
    createTextNode() { return { textContent: '' }; },
    head: makeEl('head'), body: makeEl('body'), documentElement: makeEl('html'),
    addEventListener() {}
  };
  const Peer = makePeerClass();
  const sandbox = {
    console, document, Math, Date, JSON, String, Number, Array, Object, Error, Promise,
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    URLSearchParams, URL,
    history: { replaceState() {}, pushState() {} },
    navigator: {},
    location: { href: 'https://example.github.io/C-games/bell/duel/', search: search || '' },
    Peer
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.addEventListener = () => {};
  sandbox.removeEventListener = () => {};
  vm.createContext(sandbox);
  return { sandbox, els, seatBtns, Peer };
}
function makePeerClass() {
  const registry = [];
  function Peer(id) {
    const self = this;
    this.id = id || ('rand-' + Math.random().toString(36).slice(2, 8));
    this.open = false; this.destroyed = false; this.handlers = {}; this.conns = [];
    this.on = (t, fn) => { (self.handlers[t] = self.handlers[t] || []).push(fn); return self; };
    this.emit = (t, a) => { (self.handlers[t] || []).slice().forEach(fn => fn(a)); };
    this.destroy = () => { self.destroyed = true; self.open = false; };
    this.reconnect = () => {};
    this.connect = () => { const c = makeConn(this.id, 'host'); self.conns.push(c); return c; };
    this.call = () => ({ on() {}, close() {}, answer() {} });
    registry.push(this);
  }
  Peer.__registry = registry;
  return Peer;
}
function makeConn(from) {
  const c = { peer: from, open: false, handlers: {}, sent: [] };
  c.on = (t, fn) => { (c.handlers[t] = c.handlers[t] || []).push(fn); return c; };
  c.send = d => c.sent.push(d);
  c.close = () => { c.open = false; (c.handlers.close || []).forEach(f => f()); };
  c.fireOpen = () => { c.open = true; (c.handlers.open || []).slice().forEach(f => f()); };
  c.fireData = d => { (c.handlers.data || []).slice().forEach(f => f(d)); };
  c.fire = (t, a) => { (c.handlers[t] || []).slice().forEach(f => f(a)); };
  return c;
}
function loadInto(sandbox, rel) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, rel), 'utf8'), sandbox, { filename: rel });
}
function boot(search) {
  const ctx = buildSandbox(search);
  // 模拟 index.html 的初始 class 状态（stub 元素不会解析 HTML 属性）
  const d = ctx.sandbox.document;
  d.getElementById('gate').classList.add('hidden');
  d.getElementById('seatPicker').classList.remove('hidden');
  d.getElementById('roomView').classList.add('hidden');
  loadInto(ctx.sandbox, 'bell/multi/core.js');
  loadInto(ctx.sandbox, 'bell/duel/app.js');
  return ctx;
}

(async function main() {
  console.log('\n[1] 77 先占座 → 房主；315 后到 → 客人');
  {
    const { sandbox, els, seatBtns, Peer } = boot();
    const D = sandbox.__duelDebug;
    ok('MultiBellCore 已挂载', !!sandbox.MultiBellCore);
    ok('调试接口存在', !!D);

    seatBtns[0].fire('click');                     // 77 选座
    await tick();
    ok('mySeat = 0（77）', D.get().mySeat === 0, JSON.stringify(D.get()));

    const peers = Peer.__registry;
    ok('抢注了固定 peer id（房间码 SU77315）', peers.length >= 1 && peers[0].id === HOST_ID, peers[0] && peers[0].id);
    peers[0].open = true; peers[0].emit('open');
    ok('角色 = host', D.get().role === 'host', D.get().role);
    ok('77 已在座', D.get().seats[0].here === true);

    const gc = makeConn('guest-315');
    peers[0].emit('connection', gc);
    gc.fireOpen();
    gc.fireData({ type: 'join', seat: 1 });
    ok('315 已在座', D.get().seats[1].here === true, JSON.stringify(D.get().seats));
    ok('座位顺序不被角色影响：0=77 / 1=315', D.get().seats[0].here && D.get().seats[1].here);

    els['readyButton'].fire('click');              // 房主（77）准备
    gc.fireData({ type: 'ready', ready: true });   // 315 准备
    ok('双方已准备', D.get().seats[0].ready && D.get().seats[1].ready, JSON.stringify(D.get().seats));

    els['startButton'].fire('click');
    let st = D.get();
    ok('进入对局 phase=playing', st.phase === 'playing', st.phase);
    ok('先手是座位 0 = 77', st.turn === 0, String(st.turn));

    els['flipButton'].fire('click');
    st = D.get();
    ok('翻牌后轮到座位 1 = 315', st.turn === 1, String(st.turn));

    const states = gc.sent.filter(p => p && p.type === 'state');
    ok('房主向客人广播牌局', states.length >= 1);
    const last = states[states.length - 1];
    ok('快照只有两个座位（77 与 315）', last && last.state && last.state.hands.length === 2);

    els['bellButton'].fire('click');               // 房主（77）抢铃
    ok('抢铃后有新广播', gc.sent.filter(p => p && p.type === 'state').length >= 2);
    ok('广播里带座位快照', !!(gc.sent.filter(p => p && p.type === 'state').pop() || {}).state);
  }

  console.log('\n[2] 315 先占座 → 房主；77 后到 → 座位仍是 0');
  {
    const { sandbox, els, seatBtns, Peer } = boot();
    const D = sandbox.__duelDebug;
    seatBtns[1].fire('click');                     // 315 选座
    await tick();
    ok('mySeat = 1（315）', D.get().mySeat === 1, JSON.stringify(D.get()));
    const peers = Peer.__registry;
    peers[0].open = true; peers[0].emit('open');
    ok('315 变成房主', D.get().role === 'host', D.get().role);
    ok('房主仍占座位 1（没被挪到 0）', D.get().seats[1].here === true && D.get().seats[0].here === false);

    const c = makeConn('p77');
    peers[0].emit('connection', c);
    c.fireOpen();
    c.fireData({ type: 'join', seat: 0 });         // 77 坐 0
    ok('77 坐在座位 0', D.get().seats[0].here === true);
    els['readyButton'].fire('click');
    c.fireData({ type: 'ready', ready: true });
    els['startButton'].fire('click');
    const st = D.get();
    ok('先手仍是座位 0 = 77', st.phase === 'playing' && st.turn === 0, JSON.stringify(st));
  }

  console.log('\n[3] 77 已在座时另一个人再抢 77 → 拒绝');
  {
    const { sandbox, seatBtns, Peer } = boot();
    const D = sandbox.__duelDebug;
    seatBtns[0].fire('click');
    await tick();
    const peers = Peer.__registry;
    peers[0].open = true; peers[0].emit('open');
    const c = makeConn('impostor');
    peers[0].emit('connection', c);
    c.fireOpen();
    c.fireData({ type: 'join', seat: 0 });
    ok('重复占座被拒绝', !!c.sent.find(p => p && p.type === 'reject'), JSON.stringify(c.sent));
    ok('座位状态未被污染', D.get().seats[1].here === false);
  }

  console.log('\n[4] 抢不到固定 id → 自动降级为客人并同步状态');
  {
    const { sandbox, seatBtns, Peer } = boot();
    const D = sandbox.__duelDebug;
    seatBtns[1].fire('click');                     // 315 选座
    await tick();
    const peers = Peer.__registry;
    peers[0].emit('error', { type: 'unavailable-id' });
    await tick();
    ok('固定 id 被占用后换随机 id', peers[peers.length - 1].id !== HOST_ID, peers[peers.length - 1].id);
    const gp = peers[peers.length - 1];
    gp.open = true; gp.emit('open');
    await tick();
    ok('降级为客人', D.get().role === 'guest', D.get().role);
    ok('客人主动连固定 host id', gp.conns.length === 1);
    const c = gp.conns[0];
    c.fireOpen();
    ok('客人 join 带自己的座位号 1', c.sent.length && c.sent[0].type === 'join' && c.sent[0].seat === 1, JSON.stringify(c.sent));
    c.fireData({ type: 'room', seats: [{ here: true, ready: true, voice: false }, { here: true, ready: false, voice: false }], kind: 'classic', phase: 'lobby', state: null });
    const st = D.get();
    ok('客人同步到 2 人', st.seats[0].here && st.seats[1].here, JSON.stringify(st.seats));
    ok('客人自己的座位还是 1 = 315', st.mySeat === 1, String(st.mySeat));
  }

  console.log('\n[5] ?seat= 参数直接入座');
  {
    const ctx = boot('?seat=315');
    await tick();
    const st = ctx.sandbox.__duelDebug.get();
    ok('?seat=315 直接坐到座位 1', st.mySeat === 1, JSON.stringify(st));
  }

  console.log('\n[6] 房间码 SU77315 校验');
  {
    const el = (ctx, id) => ctx.sandbox.document.getElementById(id);
    const noCode = boot('');
    await tick();
    ok('不带房间码也放行（可直接发链接）', el(noCode, 'gate').classList.contains('hidden'));

    const good = boot('?room=SU77315&seat=77');
    await tick();
    ok('正确房间码放行', el(good, 'gate').classList.contains('hidden'));
    ok('正确房间码 + seat=77 → 座位 0', good.sandbox.__duelDebug.get().mySeat === 0, JSON.stringify(good.sandbox.__duelDebug.get()));

    const lower = boot('?room=su77315');
    await tick();
    ok('房间码大小写不敏感', el(lower, 'gate').classList.contains('hidden'));

    const bad = boot('?room=WRONGCODE&seat=77');
    await tick();
    ok('错误房间码不放行', bad.sandbox.__duelDebug.get().mySeat === -1, JSON.stringify(bad.sandbox.__duelDebug.get()));
    ok('错误房间码显示拦截页', !el(bad, 'gate').classList.contains('hidden'));
    ok('错误房间码隐藏座位选择', el(bad, 'seatPicker').classList.contains('hidden'));
    ok('错误房间码隐藏房间视图', el(bad, 'roomView').classList.contains('hidden'));

    let copied = '';
    good.sandbox.prompt = (m, u) => { copied = u; return u; };
    good.sandbox.document.getElementById('copyButton').fire('click');
    ok('复制的邀请链接带房间码', /room=SU77315/.test(String(copied)), String(copied));
  }

  console.log('\n[7] 大厅输入 su77315 → 跳到双人房间');
  {
    const ctx = buildSandbox('');
    loadInto(ctx.sandbox, 'bell/game-core.js');
    loadInto(ctx.sandbox, 'bell/pan-core.js');
    let nav = '';
    Object.defineProperty(ctx.sandbox.location, 'href', {
      configurable: true,
      get() { return 'https://example.github.io/C-games/bell/'; },
      set(v) { nav = v; }
    });
    loadInto(ctx.sandbox, 'bell/app.js');
    const d = ctx.sandbox.document;
    d.getElementById('roomInput').value = 'su77315';       // 故意小写
    d.getElementById('joinButton').fire('click');
    ok('跳转 ./duel/?room=SU77315', /duel\/\?room=SU77315$/.test(String(nav)), String(nav));

    // 普通房间码不能受影响（后面 render 需要真实 DOM，这里只关心「没有发生跳转」）
    nav = '';
    d.getElementById('roomInput').value = 'ABCDEFGH';
    try { d.getElementById('joinButton').fire('click'); } catch (_) {}
    ok('普通 8 位房间码不走跳转', nav === '', String(nav));
  }

  console.log('\n————————————————————————');
  console.log(fail === 0 ? `BELL DUEL SMOKE: ALL PASS (${pass})` : `BELL DUEL SMOKE: ${pass} pass / ${fail} FAIL`);
  process.exit(fail === 0 ? 0 : 1);
})();
