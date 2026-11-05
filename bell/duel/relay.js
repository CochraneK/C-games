/* Bell 双人房间 SU77315 | 稳定通道（纯 HTTPS 中继，不依赖 WebRTC 打洞）
   ---------------------------------------------------------------------------
   为什么有这一版：PeerJS 的 DataConnection 是 WebRTC。一边 WiFi 一边手机流量时，
   运营商级 NAT 基本打不通，而免费的公共 TURN 又不可用 —— 表现就是
   「对方说进来了，我这边不显示」。STUN / TURN / 信令全都在这一版里用不到。

   做法：翻牌、抢铃这些消息每秒最多几条，走普通 HTTPS 就够了。
   - 订阅：EventSource(SSE) 长连接，服务器有新消息就推过来
   - 发布：fetch POST 一条 JSON
   只要能打开这个网页就能同步，两端在哪个网络都无所谓。

   角色不再靠「抢注册固定 id」决定（那套依赖信令服务器）：
   **座位 0 = 77 固定当裁决端**，座位 1 = 315 当客人。没有竞态，也不影响先手。
   所有规则运算只在 77 端跑（MultiBellCore），改完广播快照，315 端只显示。
   客人点座位后必须收到 77 端回执才显示「已坐下」，避免本地假装入座。 */
(() => {
'use strict';
const Core=window.MultiBellCore;
const $=id=>document.getElementById(id);
const ROOM='SU77315';
const SEATS=['77','315'];
const FRUITS={strawberry:'🍓',banana:'🍌',lime:'🍋',plum:'🍇'};
const NTFY='https://ntfy.sh';
/* topic 不直接用房间码：避免别人猜到 topic 往里发消息 */
const TOPIC='cgames-r2-su77315-7f3c9a1b';
const URL_POST=NTFY+'/'+TOPIC;
/* 不带 since=all：ntfy 公共实例若缓存了历史消息，新加入的人会短暂看到几小时前的旧牌局。
   这里只要订阅之后的新消息 —— 房主每 2.5s 广播一次，且收到 hello 会立刻回一次，够快。 */
const URL_SSE=NTFY+'/'+TOPIC+'/sse';
const BUILD='v2';
const HELLO_MS=2500;      /* 心跳间隔 */
const STATE_MS=2500;      /* 裁决端广播间隔 */
const PEER_TIMEOUT=9000;  /* 多久没动静算离线 */
const MAX_SEEN=300;

const CLIENT='c'+Math.random().toString(36).slice(2,10)+Date.now().toString(36);
let mySeat=-1, joined=false, linkOk=false, es=null;
let seats=[blank(),blank()];
let peerSeen=[0,0], lastHostAt=0, rev=0, publishFail=0;
/* 记住每个座位最近一次是谁在声明，哪怕自己还没选座。
   否则两人几乎同时坐同一边时，先坐那位发出的 hello 会被后到者忽略，
   两边都觉得自己占住了（要等下一个 2.5s 心跳才收敛）。 */
let lastHello=[{cid:'',at:0},{cid:'',at:0}];
let kind='classic', phase='lobby', game=null, view=null;
let toastTimer=null, helloTimer=null, clockTimer=null, openTimer=null, lastBell=0;
let gateOk=true;
const seen=new Set();

function blank(){ return {here:false,cid:'',ready:false}; }
function isHost(){ return mySeat===0; }
function connected(){ return joined&&linkOk&&(isHost()||Date.now()-lastHostAt<PEER_TIMEOUT); }
function toast(msg){ const t=$('toast'); t.textContent=msg; t.classList.add('show'); clearTimeout(toastTimer); toastTimer=setTimeout(()=>t.classList.remove('show'),3000); }
function status(msg,level){ $('networkText').textContent=msg; $('networkDot').className='status-light '+(level||''); }
function diag(id,txt,cls){ const e=$(id); if(!e)return; e.textContent=txt; e.className=cls||''; }

/* ---------- 通道 ---------- */
function publish(d){
  const body=JSON.stringify(Object.assign({v:2,room:ROOM,from:CLIENT,seat:mySeat,ts:Date.now()},d));
  try{
    const p=(typeof fetch==='function'?fetch:window.fetch)(URL_POST,{method:'POST',body,mode:'cors',cache:'no-store'});
    if(p&&typeof p.then==='function') p.then(r=>{ if(!r||!r.ok) throw 0; publishFail=0; },()=>{
      publishFail++; if(publishFail>=3) status('发不出消息 · 检查网络或换个网络');
    });
  }catch(_){ publishFail++; }
}
function startRelay(){
  closeRelay();
  try{ es=new EventSource(URL_SSE); }
  catch(_){ status('无法建立订阅'); diag('diagLink','订阅失败','diag-wait'); return; }
  es.onopen=()=>{ clearTimeout(openTimer); linkOk=true; publishFail=0; diag('diagLink','已连上中继','diag-ok'); status('通道已连上','live'); render(); };
  es.onmessage=ev=>{
    let outer,d;
    try{ outer=JSON.parse(ev.data); if(outer.event!=='message')return; d=JSON.parse(outer.message); }catch(_){ return; }
    if(outer.id){ if(seen.has(outer.id))return; seen.add(outer.id); if(seen.size>MAX_SEEN)seen.clear(); }
    recv(d);
  };
  es.onerror=()=>{ linkOk=false; diag('diagLink','中继断开 · 自动重试','diag-wait'); status('连接中断 · 正在重试'); render(); };
  /* 8 秒还没订阅上就直说，不要让用户对着「订阅中…」干等 */
  clearTimeout(openTimer);
  openTimer=setTimeout(()=>{
    if(!linkOk){ diag('diagLink','中继不可达','diag-wait'); status('连不上中继 · 换个网络试试'); }
  },8000);
  clearInterval(helloTimer); helloTimer=setInterval(tick,HELLO_MS);
  clearInterval(clockTimer); clockTimer=setInterval(updateClock,1000);
  publish({type:'hello'});
  if(isHost()) broadcastState();
}
function closeRelay(){
  clearTimeout(openTimer); openTimer=null;
  clearInterval(helloTimer); helloTimer=null;
  clearInterval(clockTimer); clockTimer=null;
  if(es){ try{ es.close(); }catch(_){} es=null; }
  linkOk=false;
}

/* ---------- 收消息 ---------- */
function recv(d){
  if(!d||d.v!==2||d.room!==ROOM||d.from===CLIENT) return;
  if(d.seat===0||d.seat===1) peerSeen[d.seat]=Date.now();
  const seat=d.seat;
  if(d.type==='hello'&&(seat===0||seat===1)) lastHello[seat]={cid:d.from,at:Date.now()};

  if(d.type==='hello'){
    /* 同一个座位来了两个不同的人：字典序小的留下，另一个退让。
       用确定性规则而不是「谁先谁后」，避免两边同时觉得自己占住了。 */
    if(seat===mySeat&&seat>=0){
      if(d.from<CLIENT) yieldSeat();
      return;
    }
    if(!isHost()||seat!==1) return;
    const was=seats[1];
    if(!was.here||was.cid===d.from||Date.now()-peerSeen[1]>PEER_TIMEOUT){
      const fresh=!was.here||was.cid!==d.from;
      seats[1]={here:true,cid:d.from,ready:fresh?false:was.ready};
      if(fresh) toast('315 坐下了');
      broadcastState(); render();
    }
    return;
  }

  if(d.type==='state'){
    if(isHost()) return;                       /* 裁决端只信自己 */
    if(typeof d.rev==='number'&&d.rev<rev) return;
    rev=d.rev||rev; lastHostAt=Date.now();
    if(Array.isArray(d.seats)) seats=d.seats.map(s=>({here:!!s.here,cid:String(s.cid||''),ready:!!s.ready}));
    if(d.kind) kind=d.kind;
    if(d.phase) phase=d.phase;
    view=phase==='playing'?(d.view||null):null;
    /* 握手：只有裁决端明确把我的 cid 写进座位，才承认入座 */
    const mine=seats[mySeat];
    if(mine&&mine.here&&mine.cid===CLIENT){
      if(!joined){ joined=true; toast('已进入牌桌'); }
      status('已连上牌桌','live');
    }else{
      joined=false;
      if(mine&&mine.here&&mine.cid&&mine.cid!==CLIENT){ status('座位被占用'); }
      else status('正在确认座位…');
    }
    render();
    return;
  }

  if(d.type==='intent'){
    if(!isHost()||seat!==1) return;
    if(!seats[1].here||seats[1].cid!==d.from) return;   /* 只接受在座客人的动作 */
    applyAct(1,d.act,d.value);
    return;
  }

  if(d.type==='bye'){
    if(isHost()&&seat===1){ seats[1]=blank(); if(phase==='playing'){ phase='lobby'; game=null; view=null; } broadcastState(); render(); }
  }
}
function yieldSeat(){
  closeRelay(); publish({type:'bye'});
  mySeat=-1; joined=false; seats=[blank(),blank()]; rev=0; phase='lobby'; game=null; view=null;
  $('roomView').classList.add('hidden'); $('seatPicker').classList.remove('hidden');
  status('这个座位已经有人了'); toast('座位 77/315 已被占用，请选另一边');
  render();
}

/* ---------- 裁决端：唯一的规则运算处 ---------- */
function broadcastState(){
  if(!isHost()) return;
  rev++;
  publish({type:'state',seats:seats.map(s=>({here:s.here,cid:s.cid,ready:s.ready})),
    kind,phase,view:phase==='playing'?view:null,rev});
  lastHostAt=Date.now();
}
function applyAct(seat,act,value){
  if(act==='ready'){
    if(phase!=='lobby')return;
    seats[seat].ready=!!value;
  }else if(act==='kind'){
    if(phase!=='lobby'||(value!=='classic'&&value!=='pan'))return;
    kind=value;
  }else if(act==='reset'){
    phase='lobby'; game=null; view=null; seats.forEach(s=>{s.ready=false;});
  }else if(act==='start'){
    if(phase!=='lobby'||!seats[0].here||!seats[1].here||!seats[0].ready||!seats[1].ready)return;
    game=Core.create(kind,2); phase='playing'; view=Core.snapshot(game);
  }else if(act==='flip'){
    if(phase!=='playing'||!game)return;
    const r=Core.flip(game,seat); if(!r.ok)return; game=r.state; view=Core.snapshot(game);
  }else if(act==='bell'){
    if(phase!=='playing'||!game)return;
    if(Date.now()-lastBell<180)return; lastBell=Date.now();
    const r=Core.ring(game,seat); if(!r.ok)return; game=r.state; view=Core.snapshot(game);
  }else return;
  broadcastState(); render();
}
/* 客人只发意图，由 77 端裁决后广播回来 */
function act(a,value){
  if(mySeat<0||!connected())return;
  if(isHost()) applyAct(mySeat,a,value);
  else publish({type:'intent',act:a,value,seat:mySeat});
}
function tick(){
  if(mySeat<0)return;
  publish({type:'hello'});
  const now=Date.now();
  if(isHost()){
    if(seats[1].here&&now-peerSeen[1]>PEER_TIMEOUT){
      seats[1]=blank();
      if(phase==='playing'){ phase='lobby'; game=null; view=null; }
      toast('对方离开了');
    }
    broadcastState();
  }else if(joined&&now-lastHostAt>PEER_TIMEOUT){
    joined=false; status('等 77 端回应…');
  }else if(!joined){
    status('正在确认座位…');
  }
  render();
}

/* ---------- 渲染（复用 bell/multi/style.css 的类名） ---------- */
function makeCard(card){
  const div=document.createElement('div'); div.className='play-card';
  if(!card){ div.classList.add('empty'); div.textContent='✳'; return div; }
  if(kind==='classic'){
    const f=document.createElement('div'); f.className='fruit';
    for(let i=0;i<card.count;i++){ const sp=document.createElement('span'); sp.textContent=FRUITS[card.fruit]||'●'; f.appendChild(sp); }
    div.appendChild(f);
  }else{
    const r=document.createElement('strong'); r.className='rank';
    r.textContent=card.rank===0?'王':card.rank===1?'A':card.rank===11?'J':card.rank===12?'Q':card.rank===13?'K':String(card.rank);
    const su=document.createElement('span'); su.className='suit'; su.textContent=card.rank===0?'✦':card.suit;
    if(['♥','♦','RED'].indexOf(card.suit)>=0) div.classList.add('red');
    div.appendChild(r); div.appendChild(su);
  }
  return div;
}
function render(){
  if(mySeat<0)return;
  ['classic','pan'].forEach(k=>{
    const id=k==='classic'?'classicTab':'panTab', sel=kind===k;
    $(id).classList.toggle('selected',sel); $(id).setAttribute('aria-pressed',String(sel));
  });
  diag('diagSeat','座位 '+SEATS[mySeat]+'（你）'+(isHost()?' · 裁决端':''),'diag-ok');
  const other=seats[1-mySeat];
  const otherOk=isHost()? (seats[1].here&&Date.now()-peerSeen[1]<PEER_TIMEOUT)
                        : (seats[0].here&&Date.now()-lastHostAt<PEER_TIMEOUT);
  diag('diagPeer','对方 '+SEATS[1-mySeat]+'：'+(otherOk?'已坐下':'未到场')+(other&&other.ready?' · 已准备':''),
       otherOk?'diag-ok':'diag-wait');
  if(phase==='playing') renderGame(); else renderLobby();
}
function renderLobby(){
  $('lobby').classList.remove('hidden'); $('playing').classList.add('hidden');
  const box=$('roster'); box.innerHTML='';
  $('lobbyCount').textContent=seats.filter(s=>s.here).length+' / 2 人';
  for(let i=0;i<2;i++){
    const s=seats[i], card=document.createElement('div');
    card.className='seat'+(s.here?' occupied':'');
    const num=document.createElement('div'); num.className='number'+(i===mySeat?' me':''); num.textContent=SEATS[i];
    const nm=document.createElement('strong'); nm.className='seat-name'; nm.textContent=SEATS[i]+(i===mySeat?' · 你':'');
    const st=document.createElement('span'); st.className='seat-status'+(s.ready?' ready':'');
    const confirmed = i===mySeat ? (joined||isHost()) : s.here;
    st.textContent = confirmed ? (s.ready?'✓ 已准备':'已坐下 · 未准备')
      : (i===mySeat?'正在进入…':'空着，等人来');
    card.appendChild(num); card.appendChild(nm); card.appendChild(st); box.appendChild(card);
  }
  const mine=seats[mySeat];
  $('readyButton').disabled=!(connected()&&mine&&mine.here);
  $('readyButton').textContent=(mine&&mine.ready)?'取消准备':'我准备好了';
  const sb=$('startButton');
  sb.classList.toggle('hidden',!isHost());
  const canStart=isHost()&&seats[0].here&&seats[1].here&&seats[0].ready&&seats[1].ready;
  sb.disabled=!canStart;
  sb.textContent=canStart?'两边都准备好了 · 开局':'等待两边准备';
  $('lobbyHint').textContent = !connected() ? '正在连上牌桌…'
    : (seats[0].here&&seats[1].here)
      ? (seats[0].ready&&seats[1].ready ? (isHost()?'两边都好了，你可以开局。':'两边都好了，等 77 开局。')
        : (mine&&mine.ready?'你已准备，等对面。':'人齐了，点「我准备好了」。'))
      : '把链接发给对方，等 TA 坐下。';
}
function renderGame(){
  $('lobby').classList.add('hidden'); $('playing').classList.remove('hidden');
  $('gameTitle').textContent=kind==='pan'?'潘神心脏病':'德国心脏病';
  $('roundLabel').textContent=kind==='pan'?'本局还剩':'不限时对局';
  const board=$('gameBoard'), sc=$('scoreboard');
  board.innerHTML=''; sc.innerHTML='';
  const s=view; if(!s){ $('gameMessage').textContent='等待牌局…'; return; }
  for(let i=0;i<2;i++){
    const remain=s.hands[i]+s.piles[i].length;
    const seat=document.createElement('div');
    seat.className='table-seat'+(i===mySeat?' me':'')+(s.turn===i&&s.phase==='playing'?' turn':'')+(remain===0?' out':'');
    const head=document.createElement('div'); head.className='seat-head';
    const nm=document.createElement('strong'); nm.textContent=SEATS[i]+(i===mySeat?' · 你':'');
    const cnt=document.createElement('span'); cnt.textContent=s.hands[i]+' 张';
    head.appendChild(nm); head.appendChild(cnt); seat.appendChild(head);
    seat.appendChild(makeCard(s.piles[i].top));
    const badge=document.createElement('span'); badge.className='badge';
    badge.textContent=remain===0?'已出局'
      :(s.turn===i&&s.phase==='playing'?(i===mySeat?'轮到你翻牌':'轮到 '+SEATS[i]+' 翻牌'):'已翻 '+s.piles[i].length);
    seat.appendChild(badge); board.appendChild(seat);
    const chip=document.createElement('span'); chip.className='score-chip'+(i===mySeat?' me':'');
    chip.textContent=SEATS[i]+(kind==='pan'?(' · '+s.scores[i]+' 分'):(' · '+remain+' 张'));
    sc.appendChild(chip);
  }
  $('gameMessage').textContent=s.phase==='ended'
    ? (s.winner===null?'本局平局！':(s.winner===mySeat?'你赢啦！':SEATS[s.winner]+' 赢了！')) : s.last;
  $('flipButton').disabled=!(connected()&&s.phase==='playing'&&s.turn===mySeat&&s.hands[mySeat]>0);
  $('flipButton').textContent=s.phase==='ended'?'本局已结束':(s.turn===mySeat?'翻一张牌 ↗':'等 '+SEATS[s.turn]+' 翻牌');
  $('bellButton').disabled=!(connected()&&s.phase==='playing'&&(s.hands[mySeat]+s.piles[mySeat].length>0));
  updateClock();
}
function updateClock(){
  if(phase!=='playing'||!view)return;
  if(kind!=='classic'&&view.deadline){ const sec=Math.max(0,Math.ceil((view.deadline-Date.now())/1000)); $('clock').textContent=String(Math.floor(sec/60)).padStart(2,'0')+':'+String(sec%60).padStart(2,'0'); }
  else $('clock').textContent='🔔';
}

/* ---------- 入座与交互 ---------- */
function pickSeat(seat){
  if(!gateOk||seat<0||seat>1)return;
  /* 入座瞬间就做冲突仲裁：字典序小的 cid 留下，大的直接让位。
     不依赖「对方等会儿再发一次心跳」，避免两人同时坐下时都显示已占座。 */
  const prev=lastHello[seat];
  if(prev.cid&&prev.cid!==CLIENT&&Date.now()-prev.at<PEER_TIMEOUT&&prev.cid<CLIENT){
    toast('这个座位已经有人了，请选另一边');
    status('座位已被占用');
    return;
  }
  mySeat=seat; joined=isHost();          /* 裁决端自己就是权威，客人要等回执 */
  seats=[blank(),blank()]; peerSeen=[0,0]; rev=0; phase='lobby'; game=null; view=null;
  seats[seat]={here:true,cid:CLIENT,ready:false};
  if(isHost()) peerSeen[0]=Date.now();
  $('seatPicker').classList.add('hidden'); $('roomView').classList.remove('hidden');
  status(isHost()?'已坐下 · 等对方':'正在加入牌桌…');
  render(); startRelay();
}
/* 房间码：不带码直接进（方便发链接），带对码放行，带错码拦下 */
(function gate(){
  try{
    const raw=new URLSearchParams(location.search||'').get('room');
    if(raw===null)return;
    if(String(raw).trim().toUpperCase()!==ROOM){
      gateOk=false;
      $('gate').classList.remove('hidden'); $('seatPicker').classList.add('hidden');
    }
  }catch(_){}
})();
(function autoSeat(){
  if(!gateOk)return;
  try{
    const t=new URLSearchParams(location.search||'').get('seat');
    if(t===null)return;
    const s=String(t).trim();
    const seat=s==='77'||s==='0'?0 : s==='315'||s==='1'?1 : -1;
    if(seat>=0)pickSeat(seat);
  }catch(_){}
})();
Array.prototype.forEach.call(document.querySelectorAll('.seat-btn'),b=>{
  b.addEventListener('click',()=>pickSeat(parseInt(b.getAttribute('data-seat'),10)));
});
$('readyButton').addEventListener('click',()=>{ const m=seats[mySeat]; act('ready',!(m&&m.ready)); });
$('startButton').addEventListener('click',()=>act('start'));
$('flipButton').addEventListener('click',()=>act('flip'));
$('bellButton').addEventListener('click',()=>act('bell'));
$('resetButton').addEventListener('click',()=>act('reset'));
['classic','pan'].forEach(k=>{ $(k==='classic'?'classicTab':'panTab').addEventListener('click',()=>act('kind',k)); });
$('reconnectButton').addEventListener('click',()=>{ if(mySeat>=0){ closeRelay(); startRelay(); toast('正在重新连接'); } });
$('copyButton').addEventListener('click',()=>{
  let u='';
  try{ const x=new URL(location.href); x.hash=''; x.search='?room='+ROOM; u=x.toString(); }
  catch(_){ u=location.href||''; }
  if(navigator.clipboard&&navigator.clipboard.writeText) navigator.clipboard.writeText(u).then(()=>toast('邀请链接已复制'),()=>toast(u));
  else toast(u);
});
$('rulesButton').addEventListener('click',()=>{ try{ $('rulesDialog').showModal(); }catch(_){} });
$('closeRules').addEventListener('click',()=>{ try{ $('rulesDialog').close(); }catch(_){} });
$('gotIt').addEventListener('click',()=>{ try{ $('rulesDialog').close(); }catch(_){} });
window.addEventListener('keydown',e=>{
  if(!connected()||phase!=='playing')return;
  if(e.key==='Enter'&&view&&view.turn===mySeat){ e.preventDefault(); act('flip'); }
  else if(e.key===' '||e.key==='Spacebar'){ e.preventDefault(); act('bell'); }
});
document.addEventListener('visibilitychange',()=>{
  if(!document.hidden&&mySeat>=0&&!linkOk){ closeRelay(); startRelay(); }
});
window.addEventListener('pagehide',()=>{ if(mySeat>=0)publish({type:'bye'}); closeRelay(); });
window.addEventListener('pageshow',()=>{ if(mySeat>=0&&!es)startRelay(); });

/* 给无头测试用的探针；生产环境无副作用 */
window.__relayDebug={
  get:()=>({mySeat,joined,linkOk,seats:seats.map(s=>({here:s.here,cid:s.cid,ready:s.ready})),
    kind,phase,turn:view&&view.turn,rev,build:BUILD,topic:TOPIC}),
  recv,act,tick,pickSeat,publish,
  setLink:v=>{ linkOk=v; diag('diagLink',v?'已连上中继':'订阅中…',v?'diag-ok':'diag-wait'); render(); },
  reset:()=>{ closeRelay(); mySeat=-1; joined=false; seats=[blank(),blank()]; phase='lobby'; game=null; view=null; }
};
})();
