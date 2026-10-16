/* Bell Duel 77 vs 315 | 永久两人牌桌
   - 房间固定：房间码写死为 77315，不需要创建/邀请码，链接不变、随时回来还是这张桌子。
   - 座位固定：座位 0 永远是 77，座位 1 永远是 315；座位号直接等于游戏里的玩家索引，
     所以「77」在两边屏幕上永远是第 1 位，不会因为谁先来而颠倒。
   - 角色动态：谁先打开谁临时当房主（裁决端）。做法是抢注固定的 peer id，
     抢不到（unavailable-id）就自动降级为客人去连对方 —— 座位顺序不受角色影响。 */
(() => {
'use strict';
const Core=window.MultiBellCore;
const $=id=>document.getElementById(id);
const PREFIX='cgames-bell-duel-v1-';
const ROOM='77315';
const HOST_ID=PREFIX+ROOM+'-host';
const SEATS=['77','315'];
const FRUITS={strawberry:'🍓',banana:'🍌',lime:'🍋',plum:'🍇'};

let mySeat=-1, role='', peer=null, conn=null, guestConn=null;
let seats=[{here:false,ready:false,voice:false},{here:false,ready:false,voice:false}];
let seatPeer={};
let kind='classic', phase='lobby', game=null, view=null;
let lastBellSent=0, toastTimer=null, retryTimer=null;
let mic=null, micOn=false, openingMic=false, outgoing=null, incoming=null, audioEl=null;

function toast(msg){ const t=$('toast'); t.textContent=msg; t.classList.add('show'); clearTimeout(toastTimer); toastTimer=setTimeout(()=>t.classList.remove('show'),3000); }
function status(msg,level){ $('networkText').textContent=msg; $('networkDot').className='status-light '+(level||''); }
function connected(){ if(role==='host') return true; return !!(conn&&conn.open); }
function bothHere(){ return !!(seats[0].here&&seats[1].here); }
function canStart(){ return role==='host'&&phase==='lobby'&&bothHere()&&seats[0].ready&&seats[1].ready; }
function seatOf(pid){ for(const k in seatPeer) if(seatPeer[k]===pid) return parseInt(k,10); return -1; }
function otherId(){ if(role==='guest') return HOST_ID; return seatPeer[1-mySeat]||null; }

function roomPacket(t){
  return {type:t||'room', seats:seats.map(s=>({here:!!s.here,ready:!!s.ready,voice:!!s.voice})),
          kind:kind, phase:phase, state:view};
}
function broadcast(d){ if(role!=='host') return; if(guestConn&&guestConn.open){ try{ guestConn.send(d); }catch(_){} } }
function send(d){ if(role==='guest'&&conn&&conn.open){ try{ conn.send(d); return true; }catch(_){} } return false; }
function sendGame(){ if(role!=='host') return; view=Core.snapshot(game); broadcast(roomPacket('state')); render(); }

/* ---------- 房主收到的客人消息 ---------- */
function fromGuest(d){
  if(!d||!d.type) return;
  if(d.type==='join'){
    const seat=d.seat;
    if(seat!==0&&seat!==1){ try{guestConn.send({type:'reject',reason:'座位无效'});}catch(_){} return; }
    if(seats[seat].here){ try{guestConn.send({type:'reject',reason:'座位 '+SEATS[seat]+' 已经有人坐了'});}catch(_){} return; }
    seats[seat]={here:true,ready:false,voice:false};
    seatPeer[seat]=guestConn.peer;
    broadcast(roomPacket()); render();
    toast(SEATS[seat]+' 坐下了');
    return;
  }
  const seat=seatOf(guestConn&&guestConn.peer);
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
  if(d.type==='reject'){
    toast(d.reason||'坐不下');
    mySeat=-1; role=''; cleanupPeer();
    $('roomView').classList.add('hidden'); $('seatPicker').classList.remove('hidden');
    return;
  }
  if(d.type==='room'||d.type==='state'){
    if(Array.isArray(d.seats)) seats=d.seats.map(s=>({here:!!s.here,ready:!!s.ready,voice:!!s.voice}));
    if(d.kind) kind=d.kind;
    if(d.phase) phase=d.phase;
    view = phase==='playing' ? (d.state||null) : null;
    status('已连上牌桌','live'); render();
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
    st.textContent=!s.here?'空着，等人来':(s.ready?'✓ 已准备':(s.voice?'已坐下 · 🎙 开麦':'已坐下 · 未准备'));
    card.appendChild(num); card.appendChild(nm); card.appendChild(st); box.appendChild(card);
  }
  const mine=mySeat>=0?seats[mySeat]:null;
  $('readyButton').disabled = !(mine&&mine.here&&phase==='lobby');
  $('readyButton').textContent = (mine&&mine.ready)?'取消准备':'我准备好了';
  const sb=$('startButton');
  sb.classList.toggle('hidden', role!=='host');
  sb.disabled=!canStart();
  sb.textContent=canStart()?'两边都准备好了 · 开局':'等待两边准备';
  $('lobbyHint').textContent = !bothHere() ? '把链接发给对方，等 TA 坐下。'
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
    badge.textContent = remain===0?'已出局':(s.turn===i&&s.phase==='playing'?'轮到 TA 翻牌':'已翻 '+s.piles[i].length);
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
  const srcs=['https://cdn.jsdelivr.net/npm/peerjs@1.5.5/dist/peerjs.min.js','https://unpkg.com/peerjs@1.5.5/dist/peerjs.min.js'];
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
  if(peer){ try{ if(!peer.destroyed) peer.destroy(); }catch(_){} peer=null; }
  conn=null; guestConn=null;
}
function tryHost(){
  cleanupPeer(); status('正在占座…');
  let p; try{ p=new window.Peer(HOST_ID,{debug:0}); }catch(_){ becomeGuest(); return; }
  peer=p;
  p.on('open',()=>{
    role='host';
    seats[mySeat]={here:true,ready:false,voice:false};
    seatPeer={};
    status('已坐下 · 等对方','live'); render();
  });
  p.on('connection',c=>{
    if(role!=='host'){ c.close(); return; }
    guestConn=c;
    c.on('data',d=>fromGuest(d));
    c.on('close',onGuestGone);
    c.on('error',onGuestGone);
  });
  p.on('call',inc=>{ incoming=inc; bindCall(inc); try{ inc.answer(mic||undefined); }catch(_){ try{inc.answer();}catch(__){} } });
  p.on('error',e=>{
    if(e&&e.type==='unavailable-id'){ try{ p.destroy(); }catch(_){} peer=null; becomeGuest(); }
    else { status('连接异常 · '+(e&&e.type||'请检查网络')); scheduleRetry(); }
  });
  p.on('disconnected',()=>{ if(p&&!p.destroyed) p.reconnect(); });
}
function becomeGuest(){
  cleanupPeer(); status('正在加入牌桌…');
  let p; try{ p=new window.Peer({debug:0}); }catch(_){ status('初始化失败'); return; }
  peer=p;
  p.on('open',()=>{ role='guest'; joinHost(); });
  p.on('call',inc=>{ incoming=inc; bindCall(inc); try{ inc.answer(mic||undefined); }catch(_){ try{inc.answer();}catch(__){} } });
  p.on('error',e=>{ status('连接异常 · '+(e&&e.type||'')); scheduleRetry(); });
  p.on('disconnected',()=>{ if(p&&!p.destroyed) p.reconnect(); });
}
function joinHost(){
  const c=peer.connect(HOST_ID,{reliable:true,serialization:'json'});
  conn=c;
  let opened=false;
  c.on('open',()=>{ opened=true; c.send({type:'join',seat:mySeat}); });
  c.on('data',d=>fromHost(d));
  c.on('close',()=>{ status('对方离开了，尝试重新占座…'); scheduleRetry(); });
  c.on('error',()=>scheduleRetry());
  /* 房主那边的 id 可能还残留在服务器上（TA 刚关页面），连上去会一直挂着不返回。
     6 秒没握手成功就再抢一次固定 id，抢到就自己当房主。 */
  setTimeout(()=>{ if(!opened&&conn===c){ try{c.close();}catch(_){} status('没找到牌桌，正在重新占座…'); scheduleRetry(); } },6000);
}
function onGuestGone(){
  const pid=guestConn&&guestConn.peer;
  const seat=seatOf(pid);
  guestConn=null; dropCalls();
  if(seat>=0){ seats[seat]={here:false,ready:false,voice:false}; delete seatPeer[seat]; }
  if(phase==='playing') resetLobby(); else { broadcast(roomPacket()); render(); }
  status('对方离开了 · 位置给你留着');
}
function scheduleRetry(){
  clearTimeout(retryTimer);
  retryTimer=setTimeout(()=>{ if(mySeat>=0) tryHost(); },2500);
}
function pickSeat(seat){
  mySeat=seat;
  $('seatPicker').classList.add('hidden');
  $('roomView').classList.remove('hidden');
  render();
  loadPeerJS().then(()=>tryHost()).catch(e=>{ status('联机不可用'); toast(e.message||'联机模块加载失败'); });
}

/* ---------- 事件 ---------- */
Array.prototype.forEach.call(document.querySelectorAll('.seat-btn'),b=>{
  b.addEventListener('click',()=>pickSeat(parseInt(b.getAttribute('data-seat'),10)));
});
/* 支持 ?seat=77 / ?seat=315 直接入座：77 和 315 可以各存各的链接，打开就是自己的座位 */
(function autoSeat(){
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
  let u=''; try{ const x=new URL(location.href); x.search=''; x.hash=''; u=x.toString(); }catch(_){ u=location.href||''; }
  try{ if(navigator.clipboard&&navigator.clipboard.writeText) navigator.clipboard.writeText(u).then(()=>toast('链接已复制'),()=>window.prompt('复制牌桌链接：',u));
       else window.prompt('复制牌桌链接：',u); }catch(_){ window.prompt('复制牌桌链接：',u); }
});
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

window.__duelDebug={get:()=>({mySeat,role,seats:seats.map(s=>({here:s.here,ready:s.ready})),kind,phase,turn:view&&view.turn})};
})();
