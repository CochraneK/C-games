/* Bell Duel 77 vs 315 | 房间 SU77315（两个固定座位）
   - 房间固定：房间码写死为 SU77315，不用创建、链接不变、随时回来还是这张桌子。
   - 座位固定：座位 0 永远是 77，座位 1 永远是 315；座位号直接等于游戏里的玩家索引，
     所以「77」在两边屏幕上永远是第 1 位，不会因为谁先来而颠倒。
   - 角色动态：谁先打开谁临时当房主（裁决端）。做法是抢注固定的 peer id，
     抢不到（unavailable-id）就自动降级为客人去连对方 —— 座位顺序不受角色影响。 */
(() => {
'use strict';
const Core=window.MultiBellCore;
const $=id=>document.getElementById(id);
const PREFIX='cgames-bell-duel-v1-';
const ROOM='su77315';
const ROOM_CODE='SU77315';
const HOST_ID=PREFIX+ROOM+'-host';
const SEATS=['77','315'];
const FRUITS={strawberry:'🍓',banana:'🍌',lime:'🍋',plum:'🍇'};

let mySeat=-1, role='', peer=null, conn=null;
/* 房主侧按「连接」记账，而不是只留最近一条：
   曾经用单一 guestConn，结果一条已断开的野连接会把真正客人的座位清掉。 */
let conns=new Set();
let seats=[{here:false,ready:false,voice:false},{here:false,ready:false,voice:false}];
let seatPeer={};
let kind='classic', phase='lobby', game=null, view=null;
let lastBellSent=0, toastTimer=null;
let mic=null, micOn=false, openingMic=false, outgoing=null, incoming=null, audioEl=null;
/* 房间码闸门：放文件顶部，避免 pickSeat 之类的函数在初始化前读到 TDZ */
let gateOk=true;

/* ---------- 联机可靠性 ---------- */
/* PeerJS 默认只配 Google 的 STUN。国内 Google 的 STUN 基本不通，双方就只剩
   局域网候选，跨网络时数据通道根本建不起来 —— 表现正是「对面说进来了，我这边没反应」。
   这里换成本地可达的 STUN + 一个免费 TURN 兜底（对称 NAT 只有 TURN 能穿）。 */
const ICE={
  iceServers:[
    {urls:['stun:stun.qq.com:3478','stun:stun.miwifi.com:3478','stun:stun.chat.bilibili.com:3478']},
    {urls:['stun:stun.l.google.com:19302','stun:stun.cloudflare.com:3478']},
    {urls:['turn:openrelay.metered.ca:80','turn:openrelay.metered.ca:443','turn:openrelay.metered.ca:443?transport=tcp'],
     username:'openrelayproject',credential:'openrelayproject'}
  ],
  iceCandidatePoolSize:2
};
/* 这台设备的固定标识：重连时用来区分「同一个人回来了」和「别人抢座」 */
const CLIENT=(function(){
  try{
    const k='bell-duel-client';
    let v=localStorage.getItem(k);
    if(!v){ v='c'+Math.random().toString(36).slice(2,10); localStorage.setItem(k,v); }
    return v;
  }catch(_){ return 'c'+Math.random().toString(36).slice(2,10); }
})();
let joined=false;          /* 只有房主确认（welcome）之后才算真的坐进牌桌 */
let lastHostAt=0;          /* 最近一次收到房主任何消息的时间 */
let joinAttempt=0;         /* 连续重连次数，用来做退避 */
let joinTimer=null, hbTimer=null, watchTimer=null;
let hostFails=0, probePeer=null, lastProbeAt=0;

function toast(msg){ const t=$('toast'); t.textContent=msg; t.classList.add('show'); clearTimeout(toastTimer); toastTimer=setTimeout(()=>t.classList.remove('show'),3000); }
function status(msg,level){ $('networkText').textContent=msg; $('networkDot').className='status-light '+(level||''); }
function connected(){ return joined&&(role==='host'||!!(conn&&conn.open)); }
function bothHere(){ return !!(seats[0].here&&seats[1].here); }
function canStart(){ return role==='host'&&joined&&phase==='lobby'&&bothHere()&&seats[0].ready&&seats[1].ready; }
function seatOf(pid){ for(const k in seatPeer) if(seatPeer[k]===pid) return parseInt(k,10); return -1; }
function otherId(){ if(role==='guest') return HOST_ID; return seatPeer[1-mySeat]||null; }
/* 清空两边的占座信息。换角色（房主→客人）时必须清，否则上一次会话残留的
   「已坐下」会一直占着座位，对面重连过来会被当成抢座拒绝 —— 也就是
   「对方明明进来了，我这边牌桌上还是空的」。 */
function resetOccupancy(){
  seats=[{here:false,ready:false,voice:false},{here:false,ready:false,voice:false}];
  seatPeer={};
}
function replyTo(c,d){ if(c&&c.open){ try{ c.send(d); return true; }catch(_){} } return false; }

function roomPacket(t){
  return {type:t||'room', seats:seats.map(s=>({here:!!s.here,ready:!!s.ready,voice:!!s.voice})),
          kind:kind, phase:phase, state:view};
}
function broadcast(d){
  if(role!=='host') return;
  conns.forEach(c=>{ if(c&&c.open){ try{ c.send(d); }catch(_){} } });
}
function send(d){ if(role==='guest'&&conn&&conn.open){ try{ conn.send(d); return true; }catch(_){} } return false; }
function sendGame(){ if(role!=='host') return; view=Core.snapshot(game); broadcast(roomPacket('state')); render(); }

/* ---------- 房主收到的客人消息 ---------- */
function fromGuest(c,d){
  if(!c||!d||!d.type) return;
  if(d.type==='join'){
    const seat=d.seat;
    if(seat!==0&&seat!==1){ replyTo(c,{type:'reject',reason:'座位无效'}); return; }
    /* 这个座位可能已经有连接。三种情况都应该让新连接接管，而不是一律回
       「已经有人坐了」——后者会让掉线重连的人永远回不来：
         1. 旧连接已经关了；
         2. 旧连接还开着，但 7 秒没消息（链路悄悄死了，WebRTC 经常这样）；
         3. 新连接带的是同一台设备的 CLIENT 标识（本人重连）。 */
    const oldPid=seatPeer[seat];
    let old=null;
    conns.forEach(x=>{ if(x!==c&&x.peer===oldPid) old=x; });
    const sameClient=!!(old&&d.cid&&old.__cid===d.cid);
    const stale=!!old&&(!old.open||(Date.now()-(old.__lastSeen||0)>7000));
    if(seats[seat].here&&!sameClient&&!stale){
      replyTo(c,{type:'reject',reason:'座位 '+SEATS[seat]+' 已经有人在线了（如果是你自己卡住了，点「重新连接」）'});
      return;
    }
    if(old){ old.__gone=true; try{ old.close(); }catch(_){} conns.delete(old); }
    c.__cid=d.cid||'';
    seats[seat]={here:true,ready:false,voice:false};
    seatPeer[seat]=c.peer;
    /* 先单独回执，再广播：客人只有收到 welcome 才敢显示「已坐下」 */
    replyTo(c,Object.assign(roomPacket('welcome'),{you:seat}));
    broadcast(roomPacket()); render();
    toast(SEATS[seat]+' 坐下了');
    status('对方已在牌桌上','live');
    return;
  }
  if(d.type==='ping'){ replyTo(c,{type:'pong',t:d.t}); return; }
  const seat=seatOf(c.peer);
  if(seat<0) return;
  if(d.type==='ready'&&phase==='lobby'&&typeof d.ready==='boolean'){
    seats[seat].ready=d.ready; broadcast(roomPacket()); render();
  } else if(d.type==='flip'&&phase==='playing'){ flip(seat); }
  else if(d.type==='bell'&&phase==='playing'){ bell(seat); }
  else if(d.type==='voice'&&typeof d.enabled==='boolean'){ seats[seat].voice=d.enabled; broadcast(roomPacket()); renderVoice(); }
  else if(d.type==='reset'){ resetLobby(); }
  else if(d.type==='kind'&&['classic','pan'].indexOf(d.kind)>=0&&d.kind!==kind){ changeKind(d.kind); }
}
/* ---------- 客人收到的房主消息 ---------- */
function fromHost(d){
  if(!d||!d.type) return;
  lastHostAt=Date.now();
  if(d.type==='hb'||d.type==='pong') return;      /* 心跳不算状态变化，别触发重绘 */
  if(d.type==='reject'){
    joined=false;
    toast(d.reason||'坐不下');
    mySeat=-1; role=''; cleanupPeer();
    /* 清掉占位，否则回到选座页再选另一边时，名单上会残留「已坐下」 */
    resetOccupancy();
    $('roomView').classList.add('hidden'); $('seatPicker').classList.remove('hidden');
    render();
    return;
  }
  if(d.type==='welcome'||d.type==='room'||d.type==='state'){
    const first=!joined;
    if(d.type==='welcome'&&(d.you===0||d.you===1)) mySeat=d.you;
    if(Array.isArray(d.seats)) seats=d.seats.map(s=>({here:!!s.here,ready:!!s.ready,voice:!!s.voice}));
    if(d.kind) kind=d.kind;
    if(d.phase) phase=d.phase;
    view = phase==='playing' ? (d.state||null) : null;
    joined=true; joinAttempt=0;
    status('已连上牌桌','live'); render();
    if(first) toast('已进入牌桌');
  }
}

/* ---------- 游戏动作 ---------- */
function flip(seat){
  if(role!=='host'||phase!=='playing'||!game) return;
  const r=Core.flip(game,seat);
  if(r.ok){ game=r.state; sendGame(); }
}
function bell(seat){
  if(role!=='host'||phase!=='playing'||!game) return;
  const r=Core.ring(game,seat);
  if(r.ok){ game=r.state; sendGame(); if(r.correct) ringSound(); }
}
function doFlip(){
  if(phase!=='playing'||!view||view.phase!=='playing') return;
  if(view.turn!==mySeat||!view.hands[mySeat]) return;
  if(role==='host') flip(mySeat); else send({type:'flip'});
}
function doBell(){
  if(phase!=='playing'||!view||view.phase!=='playing') return;
  if(!(view.hands[mySeat]+view.piles[mySeat].length>0)) return;
  const now=Date.now(); if(now-lastBellSent<220) return; lastBellSent=now;
  if(role==='host') bell(mySeat); else send({type:'bell'});
}
function setReady(v){
  if(mySeat<0) return;
  if(role==='host'){ seats[mySeat].ready=v; broadcast(roomPacket()); render(); }
  else send({type:'ready',ready:v});
}
function begin(){
  if(role!=='host'||!canStart()) return;
  game=Core.create(kind,2); phase='playing'; view=Core.snapshot(game);
  broadcast(roomPacket('state')); render(); toast('开局！');
}
function resetLobby(){
  if(role!=='host'){ send({type:'reset'}); return; }
  phase='lobby'; game=null; view=null;
  seats[0].ready=false; seats[1].ready=false;
  broadcast(roomPacket()); render();
}
function changeKind(k){
  if(k===kind) return;
  if(role!=='host'){ send({type:'kind',kind:k}); return; }
  kind=k; resetLobby(); toast(k==='pan'?'已切到潘神心脏病':'已切到德国心脏病');
}
function ringSound(){
  try{
    const AC=window.AudioContext||window.webkitAudioContext; if(!AC) return;
    const c=new AC(); if(c.state==='suspended') c.resume().catch(()=>{});
    const t=c.currentTime;
    [[850,0],[1280,1],[1780,2]].forEach(([hz,n])=>{
      const o=c.createOscillator(), g=c.createGain();
      o.frequency.value=hz; g.gain.setValueAtTime(0.0001,t);
      g.gain.exponentialRampToValueAtTime(0.09/(n+1),t+0.02);
      g.gain.exponentialRampToValueAtTime(0.0001,t+0.44);
      o.connect(g).connect(c.destination); o.start(t); o.stop(t+0.46);
    });
    setTimeout(()=>{ try{c.close();}catch(_){} },800);
  }catch(_){}
}

/* ---------- 渲染 ---------- */
function makeCard(card){
  const div=document.createElement('div'); div.className='play-card';
  if(!card){ div.classList.add('empty'); div.textContent='✳'; return div; }
  if(kind==='classic'){
    const f=document.createElement('div'); f.className='fruit';
    for(let i=0;i<card.count;i++){ const sp=document.createElement('span'); sp.textContent=FRUITS[card.fruit]||'●'; f.appendChild(sp); }
    div.appendChild(f);
  } else {
    const r=document.createElement('strong'); r.className='rank';
    r.textContent=card.rank===0?'王':card.rank===1?'A':card.rank===11?'J':card.rank===12?'Q':card.rank===13?'K':String(card.rank);
    const su=document.createElement('span'); su.className='suit'; su.textContent=card.rank===0?'✦':card.suit;
    if(['♥','♦','RED'].indexOf(card.suit)>=0) div.classList.add('red');
    div.appendChild(r); div.appendChild(su);
  }
  return div;
}
function render(){
  if(mySeat<0) return;
  ['classic','pan'].forEach(k=>{
    const id=k==='classic'?'classicTab':'panTab', sel=kind===k;
    $(id).classList.toggle('selected',sel); $(id).setAttribute('aria-pressed',String(sel));
  });
  if(phase==='playing') renderGame(); else renderLobby();
  renderVoice();
}
function renderLobby(){
  $('lobby').classList.remove('hidden'); $('playing').classList.add('hidden');
  const box=$('roster'); box.innerHTML='';
  const here=seats.filter(s=>s.here).length;
  $('lobbyCount').textContent=here+' / 2 人';
  for(let i=0;i<2;i++){
    const s=seats[i], card=document.createElement('div');
    card.className='seat'+(s.here?' occupied':'');
    const num=document.createElement('div'); num.className='number'+(i===mySeat?' me':''); num.textContent=SEATS[i];
    const nm=document.createElement('strong'); nm.className='seat-name'; nm.textContent=SEATS[i]+(i===mySeat?' · 你':'');
    const st=document.createElement('span'); st.className='seat-status'+(s.ready?' ready':'');
    st.textContent = s.here ? (s.ready?'✓ 已准备':(s.voice?'已坐下 · 🎙 开麦':'已坐下 · 未准备'))
      : (i===mySeat ? (joined?'正在确认…':'正在进入…') : '空着，等人来');
    card.appendChild(num); card.appendChild(nm); card.appendChild(st); box.appendChild(card);
  }
  const mine=mySeat>=0?seats[mySeat]:null;
  $('readyButton').disabled = !(mine&&mine.here&&phase==='lobby');
  $('readyButton').textContent = (mine&&mine.ready)?'取消准备':'我准备好了';
  const sb=$('startButton');
  sb.classList.toggle('hidden', role!=='host');
  sb.disabled=!canStart();
  sb.textContent=canStart()?'两边都准备好了 · 开局':'等待两边准备';
  $('lobbyHint').textContent = !joined ? '正在连上牌桌…'
    : !bothHere() ? '把链接发给对方，等 TA 坐下。'
    : (seats[0].ready&&seats[1].ready ? (role==='host'?'两边都准备好了，你可以开局。':'两边都好了，等房主开局。')
      : (mine&&mine.ready?'你已准备，等对面。':'人齐了，点「我准备好了」。'));
}
function renderGame(){
  $('lobby').classList.add('hidden'); $('playing').classList.remove('hidden');
  $('gameTitle').textContent = kind==='pan'?'潘神心脏病':'德国心脏病';
  $('roundLabel').textContent = kind==='pan'?'本局还剩':'不限时对局';
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
    badge.textContent = remain===0?'已出局'
      :(s.turn===i&&s.phase==='playing'?(i===mySeat?'轮到你翻牌':'轮到 TA 翻牌'):'已翻 '+s.piles[i].length);
    seat.appendChild(badge); board.appendChild(seat);
    const chip=document.createElement('span'); chip.className='score-chip'+(i===mySeat?' me':'');
    chip.textContent=SEATS[i]+(kind==='pan'?(' · '+s.scores[i]+' 分'):(' · '+remain+' 张'))+(seats[i]&&seats[i].voice?' 🎙':'');
    sc.appendChild(chip);
  }
  $('gameMessage').textContent = s.phase==='ended'
    ? (s.winner===null?'本局平局！':(s.winner===mySeat?'你赢啦！':SEATS[s.winner]+' 赢了！')) : s.last;
  $('flipButton').disabled = !(connected()&&s.phase==='playing'&&s.turn===mySeat&&s.hands[mySeat]>0);
  $('flipButton').textContent = s.phase==='ended'?'本局已结束':(s.turn===mySeat?'翻一张牌 ↗':'等 '+SEATS[s.turn]+' 翻牌');
  $('bellButton').disabled = !(connected()&&s.phase==='playing'&&(s.hands[mySeat]+s.piles[mySeat].length>0));
  updateClock();
}
function updateClock(){
  if(phase!=='playing'||!view) return;
  if(kind!=='pan'){ $('clock').textContent='🔔'; return; }
  const sec=Math.max(0,Math.ceil((view.deadline-Date.now())/1000));
  $('clock').textContent=String(Math.floor(sec/60)).padStart(2,'0')+':'+String(sec%60).padStart(2,'0');
}
function renderVoice(){
  $('voiceButton').textContent = micOn?'静音':'开启语音';
  const other = mySeat>=0 ? seats[1-mySeat] : null;
  $('voiceText').textContent = !micOn ? '语音未开启 · 对面可以自己开麦'
    : ('你的麦克风已开' + (other&&other.voice ? ' · 对面也开麦了' : ' · 等对面上麦'));
}

/* ---------- 语音（点对点，一条 call 双向） ---------- */
function bindCall(call){
  call.on('stream',st=>{
    if(!audioEl){ audioEl=document.createElement('audio'); audioEl.autoplay=true; audioEl.playsInline=true; document.body.appendChild(audioEl); }
    audioEl.srcObject=st; const p=audioEl.play(); if(p&&p.catch) p.catch(()=>toast('音频被拦，再点一次语音'));
    renderVoice();
  });
  call.on('close',()=>{ if(outgoing===call) outgoing=null; if(incoming===call) incoming=null; renderVoice(); });
  call.on('error',()=>{ if(outgoing===call) outgoing=null; if(incoming===call) incoming=null; });
}
function ensureCall(){
  if(!mic||!micOn||!peer||!peer.open) return;
  const oid=otherId(); if(!oid||outgoing) return;
  try{ outgoing=peer.call(oid,mic); bindCall(outgoing); }catch(_){}
}
function dropCalls(){
  if(outgoing){ try{outgoing.close();}catch(_){} outgoing=null; }
  if(incoming){ try{incoming.close();}catch(_){} incoming=null; }
  if(audioEl) audioEl.srcObject=null;
}
function broadcastVoice(){
  if(role==='host'){ if(mySeat>=0) seats[mySeat].voice=micOn; broadcast(roomPacket()); }
  else send({type:'voice',enabled:micOn});
}
function toggleVoice(){
  if(openingMic) return;
  if(mic){ micOn=!micOn; mic.getAudioTracks().forEach(t=>{ t.enabled=micOn; });
    if(!micOn) dropCalls(); broadcastVoice(); if(micOn) ensureCall(); renderVoice(); return; }
  if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia){ toast('需要 HTTPS 并授权麦克风'); return; }
  openingMic=true; $('voiceButton').disabled=true;
  navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false})
    .then(st=>{ mic=st; micOn=true; broadcastVoice(); ensureCall(); renderVoice(); toast('麦克风已开'); })
    .catch(e=>toast(e&&e.name==='NotAllowedError'?'请在地址栏允许麦克风':'麦克风启动失败'))
    .then(()=>{ openingMic=false; $('voiceButton').disabled=false; });
}

/* ---------- 连接：抢注固定 id 当房主，抢不到就当客人 ---------- */
function loadPeerJS(){
  if(window.Peer) return Promise.resolve();
  const srcs=[
    'https://cdn.jsdelivr.net/npm/peerjs@1.5.5/dist/peerjs.min.js',
    'https://fastly.jsdelivr.net/npm/peerjs@1.5.5/dist/peerjs.min.js',
    'https://unpkg.com/peerjs@1.5.5/dist/peerjs.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/peerjs/1.5.5/peerjs.min.js'
  ];
  return (async()=>{
    for(const src of srcs){
      try{ await new Promise((res,rej)=>{
        const s=document.createElement('script'); s.src=src; s.async=true;
        const to=setTimeout(()=>{ if(s.parentNode) s.parentNode.removeChild(s); rej(Error('timeout')); },9000);
        s.onload=()=>{ clearTimeout(to); window.Peer?res():rej(Error('missing')); };
        s.onerror=()=>{ clearTimeout(to); if(s.parentNode) s.parentNode.removeChild(s); rej(Error('cdn')); };
        (document.head||document.documentElement).appendChild(s);
      }); return; }catch(_){}
    }
    throw Error('联机模块加载失败，请检查网络');
  })();
}
function cleanupPeer(){
  clearTimeout(joinTimer); joinTimer=null;
  if(probePeer){ try{ probePeer.destroy(); }catch(_){} probePeer=null; }
  joined=false; conn=null;
  conns.forEach(c=>{ c.__gone=true; try{ c.close(); }catch(_){} });
  conns.clear();
  if(peer){ try{ if(!peer.destroyed) peer.destroy(); }catch(_){} peer=null; }
}

/* ---- 房主侧 ---- */
function tryHost(){
  cleanupPeer(); resetOccupancy(); status('正在占座…'); render();
  let p;
  try{ p=new window.Peer(HOST_ID,{debug:0,config:ICE}); }
  catch(_){ becomeGuest(); return; }
  wireHost(p);
}
function wireHost(p){
  peer=p; role='host';
  let opened=false;
  p.on('open',()=>{ opened=true; onHostReady(p); });
  p.on('connection',c=>acceptConn(c));
  p.on('call',inc=>{ incoming=inc; bindCall(inc); try{ inc.answer(mic||undefined); }catch(_){ try{inc.answer();}catch(__){} } });
  p.on('error',e=>onHostError(p,e));
  p.on('disconnected',()=>{ if(peer===p&&!p.destroyed){ try{ p.reconnect(); }catch(_){} } });
  /* 信令服务器没反应时 Peer 可能一直不 open，也没有 error。
     等 12 秒还没起来就换个身份重来，别让界面永远停在「正在占座…」。 */
  setTimeout(()=>{
    if(opened||p.open||peer!==p) return;   /* 已经 open 的（比如探测接管来的）不能再判死 */
    try{ p.destroy(); }catch(_){}
    if(peer===p) peer=null;
    becomeGuest();
  },12000);
}
function onHostReady(p){
  if(peer!==p) return;
  role='host'; joined=true; hostFails=0; lastHostAt=Date.now();
  /* 清掉没有连接挂着的幽灵座位，但保留仍然活着的客人状态。
     信令断线重连后 Peer 会再 open 一次，这时候数据通道通常还在——
     无脑清空会让牌桌把还在座的人显示成空的，正是「他说进来了我这边没显示」。 */
  const alive=[];
  conns.forEach(c=>{ if(c&&c.open){ const s=seatOf(c.peer); if(s>=0) alive.push([s,c.peer]); } });
  resetOccupancy();
  alive.forEach(([s,pid])=>{ seats[s]={here:true,ready:false,voice:false}; seatPeer[s]=pid; });
  if(mySeat>=0) seats[mySeat]={here:true,ready:false,voice:false};
  status(alive.length?'对方在牌桌上':'已坐下 · 等对方','live');
  render();
}
function onHostError(p,e){
  if(peer!==p) return;
  if(e&&e.type==='unavailable-id'){          /* 对面已经是房主了，降级去连他 */
    try{ p.destroy(); }catch(_){}
    if(peer===p) peer=null;
    becomeGuest(); return;
  }
  hostFails++;
  status('连接不稳 · 正在恢复…');
  /* 不要一有风吹草动就重建 peer —— 那会把已经在座的人全部踢掉。
     先试着重连信令，连续失败 3 次再整个重来。 */
  if(hostFails>=3){ hostFails=0; tryHost(); }
  else { try{ p.reconnect&&p.reconnect(); }catch(_){} }
}
function acceptConn(c){
  if(role!=='host'||!c){ try{ c&&c.close(); }catch(_){} return; }
  conns.add(c);
  c.__lastSeen=Date.now();
  const gone=()=>{ if(c.__gone) return; c.__gone=true; onGuestGone(c); };
  c.on('data',d=>{ c.__lastSeen=Date.now(); fromGuest(c,d); });
  c.on('close',gone);
  c.on('error',gone);
}

/* ---- 客人侧 ---- */
function becomeGuest(){
  cleanupPeer(); resetOccupancy();
  role='guest'; status('正在加入牌桌…'); render();
  let p;
  try{ p=new window.Peer({debug:0,config:ICE}); }
  catch(_){ status('联机初始化失败 · 刷新页面试试'); return; }
  peer=p;
  p.on('open',()=>{ if(peer!==p) return; joinAttempt=0; joinHost(); });
  p.on('call',inc=>{ incoming=inc; bindCall(inc); try{ inc.answer(mic||undefined); }catch(_){ try{inc.answer();}catch(__){} } });
  p.on('error',e=>{
    if(peer!==p) return;
    /* peer-unavailable = 对面现在没有裁判端。连续几次都这样就说明那张桌子没人了
       （固定 id 只是还没释放），主动去把它抢过来自己当房主。 */
    if(e&&e.type==='peer-unavailable'&&joinAttempt>=2) probeHost();
    status('正在重连…');
    scheduleRejoin(1200);
  });
  p.on('disconnected',()=>{ if(peer===p&&!p.destroyed){ try{ p.reconnect(); }catch(_){} } });
}
function joinHost(){
  if(role!=='guest') return;
  if(!peer||peer.destroyed){ becomeGuest(); return; }
  if(!peer.open){ scheduleRejoin(900); return; }
  if(conn&&conn.open){
    if(joined) return;
    /* 通道还开着只是没被确认：先复用这条补发 join，
       超过 6 秒还是没回话才作废重建，避免同时挂好几条连接。 */
    if(Date.now()-(conn.__t0||0)>6000){ try{ conn.close(); }catch(_){} conn=null; }
    else { try{ conn.send({type:'join',seat:mySeat,cid:CLIENT}); }catch(_){} return; }
  }
  clearTimeout(joinTimer); joinTimer=null;
  let c;
  try{ c=peer.connect(HOST_ID,{reliable:true,serialization:'json'}); }
  catch(_){ scheduleRejoin(1200); return; }
  conn=c; c.__cid=CLIENT; c.__t0=Date.now();
  let acked=false;
  c.on('open',()=>{
    if(conn!==c) return;
    try{ c.send({type:'join',seat:mySeat,cid:CLIENT}); }catch(_){}
    /* 通道通了但房主没回话（可能刚打开、监听还没挂好）：1.8 秒补发一次 */
    setTimeout(()=>{ if(conn===c&&c.open&&!acked){ try{ c.send({type:'join',seat:mySeat,cid:CLIENT}); }catch(_){} } },1800);
  });
  c.on('data',d=>{
    if(conn!==c||!d) return;
    if(d.type==='welcome'||d.type==='room'||d.type==='state') acked=true;
    fromHost(d);
  });
  c.on('close',()=>{
    if(conn!==c) return;
    conn=null; joined=false;
    if(role==='guest'){ status('连接断了 · 正在重连…'); render(); scheduleRejoin(400); }
  });
  c.on('error',()=>{
    if(conn!==c) return;
    joined=false;
    if(role==='guest') scheduleRejoin(800);
  });
  /* 8 秒还没握手就废掉这条连接重来，但**保留 peer id**：
     每重试一次就换新 peer 的话，房主那边会堆一串野连接，
     最后自己重连反而被「这个座位已经有人了」挡住。 */
  setTimeout(()=>{
    if(conn!==c||acked) return;
    try{ c.close(); }catch(_){}
    if(role==='guest') scheduleRejoin(200);
  },8000);
}
function scheduleRejoin(minDelay){
  if(role!=='guest'||mySeat<0) return;
  clearTimeout(joinTimer);
  joinAttempt++;
  const back=Math.min(700*Math.pow(1.7,Math.min(joinAttempt,4)),6000);
  const wait=Math.max(minDelay||0,back*(0.85+Math.random()*0.3));
  if(joinAttempt===1) status('正在加入牌桌…');
  else status('还没连上 · 第 '+joinAttempt+' 次重试…');
  joinTimer=setTimeout(()=>{
    if(role!=='guest') return;
    /* 连信令都没连上（peer 一直没 open）时，光重试 join 是空转，要整个重建 */
    if(!peer||peer.destroyed||(!peer.open&&joinAttempt>=3)){ becomeGuest(); return; }
    if(joinAttempt>=4) probeHost();
    joinHost();
  },wait);
}
/* 用一个临时 peer 探一下固定 id 是不是空出来了；抢到就接管当房主。
   比「干等服务器释放 id」快得多，也不会把现任房主挤掉（他占着就会 unavailable-id）。 */
function probeHost(){
  if(role==='host'||mySeat<0) return;
  /* 别探得太勤：每次探测都是一次额外的信令连接，公共服务器会限流 */
  const t=Date.now();
  if(lastProbeAt&&t-lastProbeAt<12000) return;
  lastProbeAt=t;
  if(probePeer){ try{ probePeer.destroy(); }catch(_){} probePeer=null; }
  let p;
  try{ p=new window.Peer(HOST_ID,{debug:0,config:ICE}); }catch(_){ return; }
  probePeer=p;
  let done=false;
  const finish=()=>{ if(done) return; done=true; if(probePeer===p) probePeer=null; try{ p.destroy(); }catch(_){} };
  p.on('open',()=>{ if(done) return; done=true; probePeer=null; adoptHost(p); });
  p.on('error',()=>finish());
  setTimeout(finish,7000);
}
function adoptHost(p){
  const old=peer;
  conn=null; joined=false;
  conns.forEach(c=>{ c.__gone=true; try{ c.close(); }catch(_){} });
  conns.clear();
  if(old&&old!==p){ try{ if(!old.destroyed) old.destroy(); }catch(_){} }
  wireHost(p);
  onHostReady(p);
  toast('牌桌没人，已接管');
}
function onGuestGone(c){
  if(!conns.delete(c)) return;          // 已经清算过（例如 cleanupPeer 里清空），别重复处理
  /* 关键：用「关闭的那条连接」的 peer id 找座位，不要用某条全局引用——
     否则一条早该断开的野连接收尾时，会把真正客人的座位清掉。 */
  const seat=seatOf(c&&c.peer);
  if(seat<0) return;                    // 没坐到座位的野连接（被拒/还没 join），不影响牌桌
  dropCalls();
  seats[seat]={here:false,ready:false,voice:false}; delete seatPeer[seat];
  if(phase==='playing') resetLobby(); else { broadcast(roomPacket()); render(); }
  status('对方离开了 · 位置给你留着');
}
/* 心跳：房主每 1.5 秒广播一次；客人每 3 秒 ping 一次。
   没有心跳的话，WebRTC 链路悄悄死掉时两边都以为对方还在。 */
function startHeartbeat(){
  clearInterval(hbTimer); let beat=0;
  hbTimer=setInterval(()=>{
    beat++;
    if(role==='host'&&joined){ broadcast({type:'hb',t:Date.now()}); }
    else if(role==='guest'&&conn&&conn.open&&beat%2===0){ try{ conn.send({type:'ping',t:Date.now()}); }catch(_){} }
  },1500);
}
/* 看门狗：房主清掉 9 秒没动静的客人；客人 6.5 秒收不到房主消息就主动重连 */
function startWatchdog(){
  clearInterval(watchTimer);
  watchTimer=setInterval(()=>{
    const now=Date.now();
    if(role==='host'){
      conns.forEach(c=>{ if(c.open&&now-(c.__lastSeen||0)>9000){ try{ c.close(); }catch(_){} } });
    } else if(role==='guest'&&joined){
      if(now-lastHostAt>6500){
        joined=false; status('对方没有响应 · 正在重连…'); render();
        try{ conn&&conn.close(); }catch(_){}
        scheduleRejoin(300);
      }
    }
  },1500);
}
/* 手动「重新连接」/ 从后台切回来：整条链路重建一次 */
function hardReconnect(){
  if(mySeat<0) return;
  toast('正在重新连接…');
  joinAttempt=0; hostFails=0;
  tryHost();
}
function pickSeat(seat){
  if(!gateOk) return;
  mySeat=seat;
  /* 这里是关键改动：不再本地假装「已坐下」。
     以前点完座位就把自己标成已入座，数据通道其实没通，界面也显示成功 ——
     对面当然看不到你，而你只会说「我进来了啊」。现在只有房主回 welcome 才算数。 */
  resetOccupancy();
  $('seatPicker').classList.add('hidden');
  $('roomView').classList.remove('hidden');
  render();
  loadPeerJS().then(()=>tryHost()).catch(e=>{ status('联机不可用'); toast(e.message||'联机模块加载失败'); });
}

/* ---------- 事件 ---------- */
/* ---------- 房间码校验：不带码直接进也放行（方便直接发链接），带错码则拦下 ---------- */
(function gate(){
  try{
    const p=new URLSearchParams(location.search||'');
    const given=(p.get('room')||p.get('code')||'').trim().toUpperCase();
    if(!given||given===ROOM_CODE) return;
    gateOk=false;
    $('seatPicker').classList.add('hidden');
    $('roomView').classList.add('hidden');
    const g=$('gate'); if(g) g.classList.remove('hidden');
  }catch(_){}
})();
Array.prototype.forEach.call(document.querySelectorAll('.seat-btn'),b=>{
  b.addEventListener('click',()=>pickSeat(parseInt(b.getAttribute('data-seat'),10)));
});
/* 支持 ?seat=77 / ?seat=315 直接入座：77 和 315 可以各存各的链接，打开就是自己的座位 */
(function autoSeat(){
  if(!gateOk) return;
  try{
    const t=new URLSearchParams(location.search||'').get('seat');
    if(t===null) return;
    const s=String(t).trim();
    const seat = s==='77'?0 : s==='315'?1 : s==='0'?0 : s==='1'?1 : -1;
    if(seat>=0) pickSeat(seat);
  }catch(_){}
})();
$('readyButton').addEventListener('click',()=>{ const m=seats[mySeat]; setReady(!(m&&m.ready)); });
$('startButton').addEventListener('click',begin);
$('classicTab').addEventListener('click',()=>changeKind('classic'));
$('panTab').addEventListener('click',()=>changeKind('pan'));
$('flipButton').addEventListener('click',doFlip);
$('bellButton').addEventListener('click',doBell);
$('resetButton').addEventListener('click',resetLobby);
$('voiceButton').addEventListener('click',toggleVoice);
$('rulesButton').addEventListener('click',()=>$('rulesDialog').showModal());
$('closeRules').addEventListener('click',()=>$('rulesDialog').close());
$('gotIt').addEventListener('click',()=>$('rulesDialog').close());
$('copyButton').addEventListener('click',()=>{
  let u=''; try{ const x=new URL(location.href); x.search=''; x.hash=''; x.searchParams.set('room',ROOM_CODE); u=x.toString(); }catch(_){ u=location.href||''; }
  try{ if(navigator.clipboard&&navigator.clipboard.writeText) navigator.clipboard.writeText(u).then(()=>toast('链接已复制'),()=>window.prompt('复制牌桌链接：',u));
       else window.prompt('复制牌桌链接：',u); }catch(_){ window.prompt('复制牌桌链接：',u); }
});
$('reconnectButton').addEventListener('click',hardReconnect);
/* 手机切到后台会挂起连接，回到前台时如果已经断了就主动重连一次 */
document.addEventListener('visibilitychange',()=>{
  if(document.hidden||mySeat<0) return;
  if(role==='guest'&&(!joined||Date.now()-lastHostAt>4000)){ joinAttempt=0; scheduleRejoin(0); }
});
startHeartbeat();
startWatchdog();
window.addEventListener('keydown',e=>{
  if(e.target&&e.target.matches&&e.target.matches('input,select,textarea,button')||e.metaKey||e.ctrlKey||e.altKey) return;
  if(mySeat<0||phase!=='playing') return;
  if(e.code==='Space'){ e.preventDefault(); if(!e.repeat) doBell(); }
  if(e.code==='Enter'){ e.preventDefault(); if(!e.repeat) doFlip(); }
});
window.addEventListener('pagehide',()=>{
  if(mic&&mic.getTracks) mic.getTracks().forEach(t=>t.stop());
  dropCalls(); cleanupPeer();
});
setInterval(()=>{
  if(role==='host'&&phase==='playing'&&kind==='pan'&&game&&game.phase==='playing'){
    const r=Core.finish(game); if(r.ok){ game=r.state; sendGame(); }
  }
  if(phase==='playing') updateClock();
},400);

window.__duelDebug={
  get:()=>({mySeat,role,joined,seats:seats.map(s=>({here:s.here,ready:s.ready})),kind,phase,turn:view&&view.turn}),
  reconnect:()=>hardReconnect(),
  client:CLIENT
};
})();
