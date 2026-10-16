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

function buildSandbox() {
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
    navigator: {},
    location: { href: 'https://example.github.io/C-games/bell/duel/', search: '' },
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
function boot() {
  const ctx = buildSandbox();
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
    ok('抢注了固定 peer id', peers.length >= 1 && peers[0].id === 'cgames-bell-duel-v1-77315-host', peers[0] && peers[0].id);
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
    ok('固定 id 被占用后换随机 id', peers[peers.length - 1].id !== 'cgames-bell-duel-v1-77315-host', peers[peers.length - 1].id);
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
    const ctx = buildSandbox();
    ctx.sandbox.location.search = '?seat=315';
    loadInto(ctx.sandbox, 'bell/multi/core.js');
    loadInto(ctx.sandbox, 'bell/duel/app.js');
    await tick();
    const st = ctx.sandbox.__duelDebug.get();
    ok('?seat=315 直接坐到座位 1', st.mySeat === 1, JSON.stringify(st));
  }

  console.log('\n————————————————————————');
  console.log(fail === 0 ? `BELL DUEL SMOKE: ALL PASS (${pass})` : `BELL DUEL SMOKE: ${pass} pass / ${fail} FAIL`);
  process.exit(fail === 0 ? 0 : 1);
})();
