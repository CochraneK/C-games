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
    id, _text: '', _html: '', disabled: false, className: '',
    classList: makeClassList(), handlers: {}, children: [],
    setAttribute() {}, getAttribute() { return null; },
    appendChild(c) { el.children.push(c); if (c && typeof c._text === 'string') el._text += c._text; return c; },
    removeChild() {}, addEventListener(t, fn) { (el.handlers[t] = el.handlers[t] || []).push(fn); },
    matches() { return false; }, showModal() {}, close() {}, focus() {},
    fire(t, ev) { (el.handlers[t] || []).forEach(fn => fn(ev || { preventDefault() {}, target: null })); }
  };
  // textContent / innerHTML 要能真实累积文本，否则没法断言渲染出的座位名
  Object.defineProperty(el, 'textContent', {
    get() { return el._text; },
    set(v) { el._text = String(v); el.children.length = 0; }
  });
  Object.defineProperty(el, 'innerHTML', {
    get() { return el._html; },
    set(v) { el._html = String(v); el._text = ''; el.children.length = 0; }
  });
  return el;
}
function seatBtn(seat) { const e = makeEl('btn' + seat); e.getAttribute = () => String(seat); return e; }

const HOST_ID = 'cgames-bell-duel-v1-su77315-host';   // 房间码 SU77315

/* 可控时钟：心跳/看门狗这类逻辑必须靠「推进时间」才能测到 */
function makeClock() {
  let now = 1000, seq = 1;
  const timers = new Map();
  const clock = {
    setTimeout(fn, ms) { const id = seq++; timers.set(id, { fn, at: now + (ms || 0), every: 0 }); return id; },
    clearTimeout(id) { timers.delete(id); },
    setInterval(fn, ms) { const id = seq++; timers.set(id, { fn, at: now + (ms || 1), every: Math.max(1, ms || 1) }); return id; },
    clearInterval(id) { timers.delete(id); },
    advance(ms) {
      const end = now + ms;
      for (let guard = 0; guard < 20000; guard++) {
        let hit = null, hid = null;
        timers.forEach((t, id) => { if (t.at <= end && (hit === null || t.at < hit.at)) { hit = t; hid = id; } });
        if (!hit) break;
        now = hit.at;
        if (hit.every) hit.at = now + hit.every; else timers.delete(hid);
        try { hit.fn(); } catch (_) {}
      }
      now = end;
    },
    get now() { return now; }
  };
  const RealDate = Date;
  function FakeDate(...a) { return a.length ? new RealDate(...a) : new RealDate(now); }
  FakeDate.now = () => now;
  FakeDate.parse = RealDate.parse;
  FakeDate.UTC = RealDate.UTC;
  FakeDate.prototype = RealDate.prototype;
  clock.Date = FakeDate;
  return clock;
}

function buildSandbox(search, clock) {
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
    console, document, Math, Date: clock ? clock.Date : Date, JSON, String, Number, Array, Object, Error, Promise,
    setTimeout: clock ? clock.setTimeout : () => 0,
    clearTimeout: clock ? clock.clearTimeout : () => {},
    setInterval: clock ? clock.setInterval : () => 0,
    clearInterval: clock ? clock.clearInterval : () => {},
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
  function Peer(id, opts) {
    // 客人侧是 new Peer({debug:0,config:...})，第一个参数是配置对象
    if (id && typeof id === 'object') { opts = id; id = undefined; }
    const self = this;
    this.id = id || ('rand-' + Math.random().toString(36).slice(2, 8));
    this.options = opts || {};
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
function boot(search, clock) {
  const ctx = buildSandbox(search, clock);
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
    ok('候场名单真的渲染出 77 与 315',
      String(els['roster'].textContent).includes('77') && String(els['roster'].textContent).includes('315'),
      String(els['roster'].textContent));

    els['readyButton'].fire('click');              // 房主（77）准备
    gc.fireData({ type: 'ready', ready: true });   // 315 准备
    ok('双方已准备', D.get().seats[0].ready && D.get().seats[1].ready, JSON.stringify(D.get().seats));

    els['startButton'].fire('click');
    let st = D.get();
    ok('进入对局 phase=playing', st.phase === 'playing', st.phase);
    ok('先手是座位 0 = 77', st.turn === 0, String(st.turn));
    ok('牌桌真的渲染出两个座位名',
      String(els['gameBoard'].textContent).includes('77') && String(els['gameBoard'].textContent).includes('315'),
      String(els['gameBoard'].textContent));
    ok('轮到自己时文案是「轮到你翻牌」', String(els['gameBoard'].textContent).includes('轮到你翻牌'), String(els['gameBoard'].textContent));

    els['flipButton'].fire('click');
    st = D.get();
    ok('翻牌后轮到座位 1 = 315', st.turn === 1, String(st.turn));
    ok('轮到对方时文案是「轮到 TA 翻牌」',
      String(els['gameBoard'].textContent).includes('轮到 TA 翻牌'),
      String(els['gameBoard'].textContent));

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

  console.log('\n[8] JS 内跳转路径能否真正解析到文件（防 ./duel/ 这类 404）');
  {
    const pathMod = require('path');
    const pages = [
      ['bell/index.html', 'bell/app.js'],
      ['bell/multi/index.html', 'bell/multi/app.js'],
      ['bell/duel/index.html', 'bell/duel/app.js']
    ];
    const broken = [];
    for (const [page, js] of pages) {
      const dir = pathMod.dirname(page);
      const src = fs.readFileSync(pathMod.join(__dirname, js), 'utf8');
      for (const m of src.matchAll(/location\.href\s*=\s*'([^']+)'/g)) {
        const u = m[1];
        if (/^https?:/.test(u)) continue;
        const rel = pathMod.normalize(pathMod.join(dir, u.split('?')[0]));
        const abs = pathMod.join(__dirname, rel);
        const exists = fs.existsSync(abs) || fs.existsSync(pathMod.join(abs, 'index.html'));
        if (!exists) broken.push(js + ' → ' + u + '（解析为 ' + rel + '）');
      }
    }
    ok('所有 location.href 目标都存在', broken.length === 0, broken.join('  |  '));
  }

  console.log('\n[9] 入座握手：没收到房主确认前不能显示「已坐下」');
  {
    const ctx = boot('');
    const D = ctx.sandbox.__duelDebug;
    ctx.seatBtns[1].fire('click');
    await tick();

    // 这条是「对方说进来了、我这边没显示」的根因：以前点完座位就本地标成已坐下
    ok('点完座位不假装已入座', D.get().seats[1].here === false, JSON.stringify(D.get().seats));
    ok('名单显示「正在进入…」', /正在进入/.test(String(ctx.els['roster'].textContent)), String(ctx.els['roster'].textContent));
    ok('未确认时 joined = false', D.get().joined === false);

    ctx.Peer.__registry[0].emit('error', { type: 'unavailable-id' });
    await tick();
    const peers = ctx.Peer.__registry;
    const gp = peers[peers.length - 1];
    gp.open = true; gp.emit('open');
    await tick();
    const c = gp.conns[0];
    c.fireOpen();
    ok('join 带上座位号 + 本机标识', c.sent.length && c.sent[0].type === 'join' && c.sent[0].seat === 1 && !!c.sent[0].cid, JSON.stringify(c.sent));

    c.fireData({ type: 'welcome', you: 1, seats: [{ here: true, ready: false, voice: false }, { here: true, ready: false, voice: false }], kind: 'classic', phase: 'lobby', state: null });
    ok('收到 welcome 后才 joined = true', D.get().joined === true);
    ok('welcome 之后自己确实在座', D.get().seats[1].here === true, JSON.stringify(D.get().seats));
  }

  console.log('\n[10] 客人被拒后回到选座页并清空占位');
  {
    const ctx = boot('');
    const D = ctx.sandbox.__duelDebug;
    ctx.seatBtns[1].fire('click');
    await tick();

    ctx.Peer.__registry[0].emit('error', { type: 'unavailable-id' });
    await tick();
    const peers = ctx.Peer.__registry;
    const gp = peers[peers.length - 1];
    gp.open = true; gp.emit('open');
    await tick();
    const c = gp.conns[0];
    c.fireOpen();
    c.fireData({ type: 'reject', reason: '座位 315 已经有人坐了' });

    const st = D.get();
    ok('被拒后 mySeat 回到 -1', st.mySeat === -1, String(st.mySeat));
    ok('被拒后占位被清空', st.seats[1].here === false, JSON.stringify(st.seats));
    ok('被拒后 joined = false', st.joined === false);
    ok('被拒后回到选座页', !ctx.els['seatPicker'].classList.contains('hidden'));
    ok('被拒后房间视图隐藏', ctx.els['roomView'].classList.contains('hidden'));
  }

  console.log('\n[11] 野连接断开不能把真正客人踢掉');
  {
    const { sandbox, seatBtns, Peer } = boot('');
    const D = sandbox.__duelDebug;
    seatBtns[0].fire('click');
    await tick();
    const host = Peer.__registry[0];
    host.open = true; host.emit('open');

    const stray = makeConn('stray-tab');          // 同一个人开的第二个标签页
    host.emit('connection', stray);
    stray.fireOpen();

    const real = makeConn('guest-315');
    host.emit('connection', real);
    real.fireOpen();
    real.fireData({ type: 'join', seat: 1 });
    ok('315 已坐下', D.get().seats[1].here === true, JSON.stringify(D.get().seats));

    stray.fire('close');                          // 野连接迟到的关闭事件
    ok('野连接断开后 315 座位仍在', D.get().seats[1].here === true, JSON.stringify(D.get().seats));

    const before = real.sent.length;
    real.fireData({ type: 'ready', ready: true });
    ok('真正客人的消息仍被处理', D.get().seats[1].ready === true, JSON.stringify(D.get().seats));
    ok('广播仍能到达真正客人', real.sent.length > before);
  }

  console.log('\n[12] 掉线重连要能拿回自己的座位（而不是被「已有人」挡住）');
  {
    const { sandbox, seatBtns, Peer } = boot('');
    const D = sandbox.__duelDebug;
    seatBtns[0].fire('click');
    await tick();
    const host = Peer.__registry[0];
    host.open = true; host.emit('open');

    const a = makeConn('phone-a');
    host.emit('connection', a);
    a.fireOpen();
    a.fireData({ type: 'join', seat: 1, cid: 'X1' });
    ok('第一次入座成功', D.get().seats[1].here === true, JSON.stringify(D.get().seats));

    // 同一个人换了一条连接回来（手机切后台后常见）
    const b = makeConn('phone-a-2');
    host.emit('connection', b);
    b.fireOpen();
    b.fireData({ type: 'join', seat: 1, cid: 'X1' });
    ok('同一台设备重连能接管座位', D.get().seats[1].here === true && !b.sent.some(p => p && p.type === 'reject'), JSON.stringify(b.sent));
    ok('旧连接被主动关掉', a.open === false);

    // 别人来抢同一个座位仍然要拒
    const c = makeConn('stranger');
    host.emit('connection', c);
    c.fireOpen();
    c.fireData({ type: 'join', seat: 1, cid: 'ZZZ' });
    ok('别人抢座仍被拒绝', !!c.sent.find(p => p && p.type === 'reject'), JSON.stringify(c.sent));
    ok('被拒后座位没被弄乱', D.get().seats[1].here === true);
  }

  console.log('\n[13] 房主点「重新连接」后不能残留幽灵座位');
  {
    const { sandbox, seatBtns, Peer } = boot('');
    const D = sandbox.__duelDebug;
    seatBtns[0].fire('click');
    await tick();
    let host = Peer.__registry[0];
    host.open = true; host.emit('open');

    const g = makeConn('guest-315');
    host.emit('connection', g);
    g.fireOpen();
    g.fireData({ type: 'join', seat: 1, cid: 'G1' });
    ok('315 已在座', D.get().seats[1].here === true);

    host.emit('open');                              // 信令断线重连后 Peer 会再 open 一次
    ok('信令重连不会把在座的人清成空位', D.get().seats[1].here === true, JSON.stringify(D.get().seats));

    D.reconnect();                                  // 相当于点「重新连接」/ 页面卡住后重来
    ok('重建后不再残留「已坐下」', D.get().seats[1].here === false, JSON.stringify(D.get().seats));

    host = Peer.__registry[Peer.__registry.length - 1];
    host.open = true; host.emit('open');
    const g2 = makeConn('guest-315b');
    host.emit('connection', g2);
    g2.fireOpen();
    g2.fireData({ type: 'join', seat: 1, cid: 'G1' });
    ok('对方能重新坐回 315', D.get().seats[1].here === true, JSON.stringify(D.get().seats));
  }

  console.log('\n[14] 心跳看门狗：房主没动静 6.5 秒 → 客人自动重连');
  {
    const clock = makeClock();
    const ctx = boot('', clock);
    const D = ctx.sandbox.__duelDebug;
    ctx.seatBtns[1].fire('click');
    await tick();
    ctx.Peer.__registry[0].emit('error', { type: 'unavailable-id' });
    await tick();
    const gp = ctx.Peer.__registry[ctx.Peer.__registry.length - 1];
    gp.open = true; gp.emit('open');
    await tick();
    const c1 = gp.conns[0];
    c1.fireOpen();
    c1.fireData({ type: 'welcome', you: 1, seats: [{ here: true, ready: false, voice: false }, { here: true, ready: false, voice: false }], kind: 'classic', phase: 'lobby', state: null });
    ok('收到 welcome 后已连上', D.get().joined === true);

    clock.advance(3000);
    c1.fireData({ type: 'hb' });
    ok('有心跳时不会误判掉线', D.get().joined === true, String(D.get().joined));

    clock.advance(9000);                 // 房主那边彻底没消息了
    ok('超过 6.5 秒没消息 → joined 置 false', D.get().joined === false, String(D.get().joined));

    clock.advance(4000);
    ok('看门狗自动重建了一条连接', gp.conns.length >= 2, 'conns=' + gp.conns.length);
  }

  console.log('\n[15] 对面已经走了、固定 id 还没释放 → 探测到空位就接管');
  {
    const clock = makeClock();
    const ctx = boot('', clock);
    const D = ctx.sandbox.__duelDebug;
    ctx.seatBtns[1].fire('click');
    await tick();
    const first = ctx.Peer.__registry[0];
    first.emit('error', { type: 'unavailable-id' });
    await tick();
    const gp = ctx.Peer.__registry[ctx.Peer.__registry.length - 1];
    gp.open = true; gp.emit('open');
    await tick();
    ok('先降级为客人去连对面', D.get().role === 'guest', D.get().role);

    let probe = null;
    for (let i = 0; i < 15 && !probe; i++) {
      clock.advance(2000);
      probe = ctx.Peer.__registry.find(p => p !== first && p !== gp && p.id === HOST_ID && !p.destroyed) || null;
    }
    ok('连续连不上时会去探测固定 id', !!probe, ctx.Peer.__registry.map(p => p.id).join(','));
    if (probe) {
      probe.open = true; probe.emit('open');
      await tick();
      ok('抢到空位后接管当房主', D.get().role === 'host', D.get().role);
      ok('座位号没被角色变化带跑：仍是 315', D.get().mySeat === 1, String(D.get().mySeat));
    }
  }

  console.log('\n————————————————————————');
  console.log(fail === 0 ? `BELL DUEL SMOKE: ALL PASS (${pass})` : `BELL DUEL SMOKE: ${pass} pass / ${fail} FAIL`);
  process.exit(fail === 0 ? 0 : 1);
})();
