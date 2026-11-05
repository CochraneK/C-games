/* 稳定通道无头测试：两个 vm 客户端互相投递消息，实测跨端同步。
   不启动浏览器、不连真实 ntfy —— fetch 被替换成「把 POST 的 JSON 交给另一端 recv」。 */
const fs=require('fs'),vm=require('vm'),path=require('path');
const ROOT=__dirname;
let pass=0,fail=0;
function ok(name,cond,extra){ if(cond){pass++;console.log('PASS  '+name);} else {fail++;console.log('FAIL  '+name+(extra!==undefined?'  -> '+extra:''));} }
const tick=()=>new Promise(r=>setImmediate(r));

function makeClassList(){
  const s=new Set();
  return {add:(...x)=>x.forEach(v=>s.add(v)),remove:(...x)=>x.forEach(v=>s.delete(v)),
    contains:x=>s.has(x),toggle:(x,f)=>{const on=f===undefined?!s.has(x):!!f;on?s.add(x):s.delete(x);return on;}};
}
function makeEl(id,attrs){
  const el={
    id,textContent:'',innerHTML:'',disabled:false,className:'',value:'',
    classList:makeClassList(),handlers:{},children:[],_attrs:attrs||{},
    setAttribute(k,v){el._attrs[k]=v;},getAttribute(k){return el._attrs[k]===undefined?null:el._attrs[k];},
    appendChild(c){el.children.push(c);el.textContent+=String(c.textContent||'');return c;},
    removeChild(){},addEventListener(t,fn){(el.handlers[t]=el.handlers[t]||[]).push(fn);},
    matches(){return false;},showModal(){},close(){},focus(){},
    fire(t,ev){(el.handlers[t]||[]).forEach(fn=>fn(ev||{preventDefault(){},target:null}));}
  };
  Object.defineProperty(el,'innerHTML',{
    get(){return el._html||'';},
    set(v){ el._html=v; if(v===''){ el.textContent=''; el.children.length=0; } }
  });
  return el;
}
const clients=[];
let clock=1770000000000;
let seq=0;

function build(search){
  const els={};
  const seatBtns=[makeEl('sb0',{'data-seat':'0'}),makeEl('sb1',{'data-seat':'1'})];
  const document={
    getElementById(id){
      if(!els[id]){
        els[id]=makeEl(id);
        if(['gate','roomView','playing','startButton'].indexOf(id)>=0) els[id].classList.add('hidden');
      }
      return els[id];
    },
    querySelectorAll(sel){ return sel==='.seat-btn'?seatBtns:[]; },
    createElement(tag){ return makeEl(tag); },
    addEventListener(){},hidden:false,
    head:makeEl('head'),body:makeEl('body'),documentElement:makeEl('html')
  };
  /* 预创建所有会用到的元素，并让 gate/roomView/playing/startButton 带上初始 hidden */
  ['gate','seatPicker','roomView','networkText','networkDot','diagSeat','diagLink','diagPeer',
   'toast','roster','readyButton','startButton','lobbyHint','lobbyCount','lobby','playing',
   'gameBoard','scoreboard','gameTitle','roundLabel','gameMessage','flipButton','bellButton',
   'clock','resetButton','copyButton','reconnectButton','rulesButton','closeRules','gotIt',
   'rulesDialog','classicTab','panTab'].forEach(id=>document.getElementById(id));
  const ctx={sandbox:null,els,seatBtns,EventSource:null,es:null,pending:[]};
  class FakeEventSource{
    constructor(url){ this.url=url;this.onopen=null;this.onmessage=null;this.onerror=null;this.closed=false;ctx.es=this; }
    emitOpen(){ if(this.onopen)this.onopen(); }
    emitError(){ if(this.onerror)this.onerror(); }
    emitMessage(d){
      if(!this.onmessage)return;
      this.onmessage({data:JSON.stringify({id:'msg'+(++seq),event:'message',time:Math.floor(clock/1000),message:JSON.stringify(d)})});
    }
    close(){ this.closed=true; }
  }
  const fetchStub=(url,opts)=>{
    if(opts&&opts.method==='POST'&&opts.body){
      let d;try{d=JSON.parse(opts.body);}catch(_){return Promise.resolve({ok:true});}
      clients.forEach(c=>{
        if(c===ctx)return;
        const D=c.sandbox.__relayDebug;
        if(D){ try{D.recv(d);}catch(e){console.log('ROUTE ERR',e.message);} }
        else c.pending.push(d);   /* 对方脚本还没加载完，真实浏览器里 SSE 事件也会排队到脚本执行完 */
      });
    }
    return Promise.resolve({ok:true,status:200});
  };
  const sandbox={
    console,document,Math,JSON,String,Number,Array,Object,Error,Promise,parseInt,parseFloat,
    Date:{now:()=>clock},
    URL,URLSearchParams,
    setTimeout:()=>0,clearTimeout:()=>{},setInterval:()=>0,clearInterval:()=>{},
    fetch:fetchStub,EventSource:FakeEventSource,
    location:{href:'https://cochranek.github.io/C-games/bell/duel/relay.html'+(search||''),search:search||''},
    navigator:{},addEventListener(){},removeEventListener(){}
  };
  sandbox.window=sandbox;sandbox.globalThis=sandbox;sandbox.self=sandbox;
  ctx.EventSource=FakeEventSource;
  vm.createContext(sandbox);
  ctx.sandbox=sandbox;
  clients.push(ctx);
  return ctx;
}
function load(ctx,file){
  vm.runInContext(fs.readFileSync(path.join(ROOT,file),'utf8'),ctx.sandbox,{filename:file});
}
function boot(search){
  const ctx=build(search);
  load(ctx,'bell/multi/core.js');
  load(ctx,'bell/duel/relay.js');
  const D=ctx.sandbox.__relayDebug;
  ctx.pending.splice(0).forEach(d=>{ try{D.recv(d);}catch(_){} });
  return ctx;
}
function link(ctx){
  /* 模拟 EventSource onopen；同时把内部 linkOk 置真 */
  const D=ctx.sandbox.__relayDebug;
  if(ctx.es)ctx.es.emitOpen();
  D.setLink(true);
  return D;
}
function pair(){
  const a=boot('?room=SU77315&seat=77');
  const b=boot('?room=SU77315&seat=315');
  link(a);link(b);
  return {a,b,DA:a.sandbox.__relayDebug,DB:b.sandbox.__relayDebug};
}

async function main(){
  console.log('=== BELL RELAY SMOKE ===\n');

  console.log('[1] 房间码');
  {
    clients.length=0;   /* 每个场景隔离，避免上一条用例的客户端继续广播串扰 */
    const c=boot('');
    ok('不带码放行（拦截页隐藏）',c.els['gate'].classList.contains('hidden'));
    ok('不带码时选座页可见',!c.els['seatPicker'].classList.contains('hidden'));
    const bad=boot('?room=WRONG');
    ok('错码显示拦截页',!bad.els['gate'].classList.contains('hidden'));
    ok('错码隐藏选座页',bad.els['seatPicker'].classList.contains('hidden'));
    const right=boot('?room=su77315');
    ok('大小写不敏感',right.els['gate'].classList.contains('hidden'));
  }

  console.log('\n[2] 固定座位与角色');
  {
    clients.length=0;   /* 每个场景隔离，避免上一条用例的客户端继续广播串扰 */
    const {a,b,DA,DB}=pair();
    ok('77 坐座位 0',DA.get().mySeat===0,String(DA.get().mySeat));
    ok('315 坐座位 1',DB.get().mySeat===1,String(DB.get().mySeat));
    ok('77 是裁决端（host）',DA.get().mySeat===0);
    ok('315 已被 77 确认在座',DA.get().seats[1].here===true,JSON.stringify(DA.get().seats));
    ok('315 收到回执才 joined',DB.get().joined===true,JSON.stringify(DB.get()));
    ok('77 端看到两个人',DA.get().seats[0].here&&DA.get().seats[1].here);
  }

  console.log('\n[3] 握手前不许假装入座');
  {
    clients.length=0;   /* 每个场景隔离，避免上一条用例的客户端继续广播串扰 */
    /* 先只让 315 一个人进来：没有裁决端回执，绝不能显示「已坐下」 */
    const b=boot('?room=SU77315&seat=315');
    link(b);
    const DB=b.sandbox.__relayDebug;
    ok('没有裁决端回执时 joined=false',DB.get().joined===false,JSON.stringify(DB.get()));
    ok('名单显示「正在进入…」',String(b.els['roster'].textContent).includes('正在进入'),String(b.els['roster'].textContent));
    ok('准备按钮禁用',b.els['readyButton'].disabled===true);
    const a=boot('?room=SU77315&seat=77');
    link(a);
    ok('77 上线但还没收到 315 的 hello 时仍是空位',a.sandbox.__relayDebug.get().seats[1].here===false);
    DB.tick();                              /* 315 重新声明在座 */
    await tick();
    ok('收到 77 回执后 joined=true',DB.get().joined===true,JSON.stringify(DB.get()));
    ok('77 端也显示 315 在座',a.sandbox.__relayDebug.get().seats[1].here===true);
  }

  console.log('\n[4] 完整对局（客人动作 → 77 裁决 → 广播）');
  {
    clients.length=0;   /* 每个场景隔离，避免上一条用例的客户端继续广播串扰 */
    const {a,b,DA,DB}=pair();
    a.els['readyButton'].fire('click');
    b.els['readyButton'].fire('click');
    await tick();
    ok('两边都准备好了',DA.get().seats[0].ready&&DA.get().seats[1].ready,JSON.stringify(DA.get().seats));
    ok('客人也同步到准备状态',DB.get().seats[0].ready&&DB.get().seats[1].ready,JSON.stringify(DB.get().seats));
    ok('开局按钮在 77 端可用',a.els['startButton'].disabled===false);
    a.els['startButton'].fire('click');
    await tick();
    ok('进入对局 phase=playing',DA.get().phase==='playing',DA.get().phase);
    ok('客人同步到对局',DB.get().phase==='playing',DB.get().phase);
    ok('先手是座位 0 = 77',DA.get().turn===0,String(DA.get().turn));
    ok('牌桌渲染出 77 和 315',String(a.els['gameBoard'].textContent).includes('77')&&String(a.els['gameBoard'].textContent).includes('315'));
    ok('自己的座位显示「轮到你翻牌」',String(a.els['gameBoard'].textContent).includes('轮到你翻牌'));
    a.els['flipButton'].fire('click');
    await tick();
    ok('翻牌后轮到座位 1 = 315',DA.get().turn===1,String(DA.get().turn));
    ok('客人也看到轮次变化',DB.get().turn===1,String(DB.get().turn));
    b.els['flipButton'].fire('click');
    await tick();
    ok('客人翻牌由 77 裁决并回传',DA.get().turn===0,String(DA.get().turn));
    b.els['bellButton'].fire('click');
    await tick();
    ok('抢铃不崩且状态一致',DA.get().phase==='playing'&&DB.get().phase==='playing');
    b.els['resetButton'].fire('click');
    await tick();
    ok('返回座位（两端同步）',DA.get().phase==='lobby'&&DB.get().phase==='lobby');
  }

  console.log('\n[5] 玩法切换与复制');
  {
    clients.length=0;   /* 每个场景隔离，避免上一条用例的客户端继续广播串扰 */
    const {a,b,DA,DB}=pair();
    a.els['panTab'].fire('click');
    await tick();
    ok('切到潘神心脏病（两端）',DA.get().kind==='pan'&&DB.get().kind==='pan');
    a.els['copyButton'].fire('click');
    ok('复制链接带房间码',String(a.els['toast'].textContent).includes('SU77315')||String(a.els['toast'].textContent).includes('relay.html'),String(a.els['toast'].textContent));
  }

  console.log('\n[6] 座位冲突：字典序小的留下');
  {
    clients.length=0;   /* 每个场景隔离，避免上一条用例的客户端继续广播串扰 */
    const a=boot('?room=SU77315');const b=boot('?room=SU77315');
    link(a);link(b);
    a.seatBtns[1].fire('click');
    b.seatBtns[1].fire('click');
    await tick();
    const ga=a.sandbox.__relayDebug.get(),gb=b.sandbox.__relayDebug.get();
    ok('同一座位不会两边都占住',!(ga.mySeat===1&&gb.mySeat===1),JSON.stringify([ga.mySeat,gb.mySeat]));
    ok('至少一方退回选座',ga.mySeat===-1||gb.mySeat===-1);
  }

  console.log('\n[7] 离线清理与重连');
  {
    clients.length=0;   /* 每个场景隔离，避免上一条用例的客户端继续广播串扰 */
    const {a,b,DA}=pair();
    clock+=10000;                       /* 客人 10 秒没发 hello */
    DA.tick();
    ok('77 端清掉离线客人',DA.get().seats[1].here===false,JSON.stringify(DA.get().seats));
    clock-=10000;
    b.sandbox.__relayDebug.tick();      /* 客人回来发 hello */
    await tick();
    ok('客人重连后重新在座',DA.get().seats[1].here===true,JSON.stringify(DA.get().seats));
  }

  console.log('\n[8] SSE 解析与静态审计');
  {
    clients.length=0;   /* 每个场景隔离，避免上一条用例的客户端继续广播串扰 */
    const a=boot('?room=SU77315&seat=77');
    const D=a.sandbox.__relayDebug;
    const es=a.es;
    let threw=false;
    try{ if(es){ es.emitOpen(); es.emitMessage({v:2,room:'SU77315',from:'other-cid',seat:1,ts:clock,type:'hello'}); } }catch(_){threw=true;}
    ok('SSE message 解析不抛异常',!threw);
    ok('SSE 发来的 hello 被接受',D.get().seats[1].here===true,JSON.stringify(D.get().seats));

    const bell=fs.readFileSync(path.join(ROOT,'bell/app.js'),'utf8');
    const multi=fs.readFileSync(path.join(ROOT,'bell/multi/app.js'),'utf8');
    ok('大厅入口指向 relay.html',/'\.\/duel\/relay\.html\?room='/.test(bell));
    ok('多人页入口指向 ../duel/relay.html',/'\.\.\/duel\/relay\.html\?room='/.test(multi));
    ok('relay.html 真实存在',fs.existsSync(path.join(ROOT,'bell/duel/relay.html')));
    ok('旧版页面留了稳定通道入口',/relay\.html\?room=SU77315/.test(fs.readFileSync(path.join(ROOT,'bell/duel/index.html'),'utf8')));

    const html=fs.readFileSync(path.join(ROOT,'bell/duel/relay.html'),'utf8');
    const js=fs.readFileSync(path.join(ROOT,'bell/duel/relay.js'),'utf8');
    const ids=new Set([...html.matchAll(/id="([^"]+)"/g)].map(m=>m[1]));
    const used=new Set([...js.matchAll(/\$\(\s*'([^']+)'\s*\)/g)].map(m=>m[1]));
    const miss=[...used].filter(x=>!ids.has(x));
    ok('JS 引用的 DOM id 全存在',miss.length===0,miss.join(','));
  }

  console.log('\n————————————————————————');
  console.log(fail?('FAILED: '+fail+'  /  passed '+pass):('BELL RELAY SMOKE: ALL PASS ('+pass+')'));
  process.exit(fail?1:0);
}
main().catch(e=>{console.error('HARNESS ERROR',e);process.exit(1)});
