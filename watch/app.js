/* 一起看 | 房主授权房间 + 硬同步播放器 + 讨论区 + WebRTC 网状语音
   硬同步原理：
   - 视频跑在我们自己的 <video> 元素里（不是别人的 iframe），所以 pause()/play()/currentTime 完全可控，
     同源策略管不着 —— 这才是「一方暂停、另一方真的停」的关键（B 站那种 iframe 做不到）。
   - 房主是真值源：每秒心跳广播 {paused, t, ts}，接收端用 ts 补偿网络延迟算出「此刻该在哪」。
   - 漂移校正：偏差 >0.45s 直接 seek；0.12~0.45s 用倍速微调（1.06 / 0.94），比硬跳平滑。
   - 任何人操作都会同步给全体（成员发给房主 → 房主 apply 后广播）；apply 时置 syncing 抑制回环。 */
(() => {
'use strict';
const $=id=>document.getElementById(id);
const PREFIX='cgames-watch-v1-';
const CODE_RE=/^[A-Z2-9]{4}$/;
const DRIFT_SEEK=0.45;      // 超过这个偏差直接跳
const DRIFT_NUDGE=0.12;     // 小偏差用倍速微调
const HEARTBEAT=1000;       // 房主心跳
const THROTTLE=130;         // 事件广播节流

let role='welcome', code='', myName='', peer=null, connecting=false;
let members=[], connections=new Map();
let mic=null, micOn=false, openingMic=false, mediaCalls=new Map(), audioNodes=new Map();
let prevIds=[], prevNames={}, mpBoot=true;

const video=$('video');
let localReady=false, syncing=false, lastBroadcast=0, bcTimer=null;
let srcKind='url', srcUrlVal='', curName='';
let hostSrc=null, pendingApply=null, objUrl=null;

function cleanName(s){ return String(s==null?'':s).replace(/[\u0000-\u001f\u007f<>]/g,'').trim().replace(/\s+/g,' ').slice(0,16); }
function fmt(s){ s=Math.max(0,Math.floor(s||0)); const m=Math.floor(s/60); return String(m).padStart(2,'0')+':'+String(s%60).padStart(2,'0'); }
let toastTimer=null;
function toast(msg){ const t=$('toast'); t.textContent=msg; t.classList.add('show'); clearTimeout(toastTimer); toastTimer=setTimeout(()=>t.classList.remove('show'),3200); }
function localId(){ return (peer&&peer.id)||''; }
function me(){ return members.findIndex(m=>m.peerId===localId()); }
function memberOf(id){ return members.find(m=>m.peerId===id); }
function connected(){ return role==='host'||(role==='guest'&&connections.get(PREFIX+code+'-host')&&connections.get(PREFIX+code+'-host').open&&me()>=0); }
function hostSend(id,d){ const c=connections.get(id); if(c&&c.open){ try{ c.send(d); return true; }catch(_){ return false; } } return false; }
function broadcast(d){ if(role!=='host') return; members.forEach((m,i)=>{ if(i>0) hostSend(m.peerId,d); }); }
function toHost(d){ if(role!=='guest'){ return false; } const c=connections.get(PREFIX+code+'-host'); if(c&&c.open){ try{ c.send(d); return true; }catch(_){} } return false; }
function roomPacket(t){ return {type:t||'roster', members:members.map(m=>({peerId:m.peerId,name:m.name,voice:!!m.voice}))}; }
function sendRoster(){ broadcast(roomPacket()); renderMembers(); syncCalls(); }
function randomCode(){ const a='ABCDEFGHJKMNPQRSTUVWXYZ23456789'; let s=''; for(let i=0;i<4;i++) s+=a[Math.floor(Math.random()*a.length)]; return s; }
function inviteUrl(){ try{ const u=new URL(location.href); u.search=''; u.hash=''; u.searchParams.set('room',code); return u.toString(); }catch(_){ return location.href||''; } }

/* ---------- 播放器：加载源 ---------- */
function setLocal(url, name){
  curName=name||''; localReady=false;
  video.src=url; video.load();
  renderSrc(); updateTime();
}
function loadFromUrl(u){
  if(!u) return;
  srcKind='url'; srcUrlVal=u;
  setLocal(u, (u.split('/').pop()||u).split('?')[0]);
}
function loadFromFile(f){
  if(!f) return;
  srcKind='file';
  if(objUrl) { try{ URL.revokeObjectURL(objUrl); }catch(_){} }
  objUrl=URL.createObjectURL(f);
  setLocal(objUrl, f.name);
}
/* ---------- 播放器：状态同步 ---------- */
function statePacket(){
  return {type:'state', paused:video.paused, t:video.currentTime, dur:video.duration||0,
          ts:Date.now(), name:curName, ready:localReady, hasSrc:!!video.src};
}
function broadcastState(){ if(role==='host'&&localReady) broadcast(statePacket()); }
function scheduleBroadcast(){
  const now=Date.now();
  if(now-lastBroadcast<THROTTLE){ clearTimeout(bcTimer); bcTimer=setTimeout(()=>{ lastBroadcast=Date.now(); broadcastState(); },THROTTLE); return; }
  lastBroadcast=now; broadcastState();
}
function applyState(d){
  if(!d) return;
  if(!localReady){ pendingApply=d; return; }
  let target = d.paused ? d.t : d.t + (Date.now()-d.ts)/1000;
  if(d.dur) target=Math.max(0, Math.min(target, d.dur-0.05));
  syncing=true;
  if(d.paused!==video.paused){
    if(d.paused) video.pause();
    else { const p=video.play(); if(p&&p.catch) p.catch(()=>toast('浏览器拦住了自动播放，点一下画面或播放键')); }
  }
  const diff = target - video.currentTime;
  if(Math.abs(diff)>DRIFT_SEEK){ try{ video.currentTime=target; }catch(_){} video.playbackRate=1; }
  else if(!d.paused && Math.abs(diff)>DRIFT_NUDGE){ video.playbackRate = diff>0 ? 1.06 : 0.94; }
  else video.playbackRate=1;
  setTimeout(()=>{ syncing=false; },120);
  updateSync(diff);
}
function requestControl(paused, t){
  if(role==='host'){
    syncing=true;
    if(paused) video.pause(); else { const p=video.play(); if(p&&p.catch) p.catch(()=>{}); }
    if(typeof t==='number'&&isFinite(t)){ try{ video.currentTime=t; }catch(_){} }
    setTimeout(()=>{ syncing=false; },120);
    scheduleBroadcast();
  } else toHost({type:'ctl', paused:paused, t:t});
}
function updateTime(){ $('timeText').textContent = fmt(video.currentTime)+' / '+fmt(video.duration); }
function updateSync(diff){
  const el=$('syncText');
  if(diff==null||!isFinite(diff)){ el.textContent='未同步'; el.className='sync'; return; }
  const ms=Math.abs(diff)*1000;
  el.textContent = ms<150 ? '已同步' : '偏差 '+Math.round(ms)+'ms';
  el.className='sync '+(ms<150?'ok':'off');
}
video.addEventListener('loadedmetadata',()=>{
  localReady=true; updateTime();
  if(role==='host'){
    broadcast({type:'src', kind:srcKind, url:(srcKind==='url'?srcUrlVal:null), name:curName, dur:video.duration});
    scheduleBroadcast();
  } else {
    if(hostSrc&&hostSrc.dur&&Math.abs((video.duration||0)-hostSrc.dur)>2)
      toast('注意：你的时长 '+fmt(video.duration)+'，房主是 '+fmt(hostSrc.dur)+'，可能不是同一个文件');
    if(pendingApply){ applyState(pendingApply); pendingApply=null; }
  }
  renderSrc();
});
video.addEventListener('timeupdate',updateTime);
['play','pause','seeked'].forEach(ev=>{
  video.addEventListener(ev,()=>{
    if(syncing) return;
    if(role==='host') scheduleBroadcast();
    else if(localReady) toHost({type:'ctl', paused:video.paused, t:video.currentTime});
  });
});

/* ---------- 界面 ---------- */
function renderSrc(){
  $('srcName').textContent = curName ? ('当前：'+curName+(localReady?(' · 时长 '+fmt(video.duration)):' · 加载中…'))
    : (hostSrc&&hostSrc.kind==='file' ? ('房主在用本地文件《'+(hostSrc.name||'')+'》——请在下方选择你电脑里的同一个文件')
      : '还没有视频源。填一个直链，或选一个本地文件。');
}
function renderMembers(){
  const box=$('members'); box.innerHTML='';
  members.forEach((m,i)=>{
    const row=document.createElement('div'); row.className='seat';
    const dot=document.createElement('span'); dot.className='dot';
    const who=document.createElement('span'); who.className='who'; who.textContent=m.name+(i===me()?' · 你':'')+(i===0?' · 房主':'');
    const st=document.createElement('span'); st.className='st'; st.textContent=m.voice?'🎙 开麦':'';
    row.appendChild(dot); row.appendChild(who); row.appendChild(st); box.appendChild(row);
  });
  $('roomMeta').textContent = members.length+' 人在房间';
}
function addMsg(name, text, sys){
  const box=$('chat');
  const d=document.createElement('div'); d.className='msg'+(sys?' sys':'');
  if(sys){ d.textContent=text; }
  else { const w=document.createElement('span'); w.className='who'; w.textContent=name+'：'; d.appendChild(w); d.appendChild(document.createTextNode(text)); }
  box.appendChild(d); box.scrollTop=box.scrollHeight;
}
function announceDiff(){
  const cur=members.map(m=>m.peerId);
  const curSet={}; cur.forEach(id=>{curSet[id]=1;});
  if(mpBoot){ prevIds=cur; members.forEach(m=>{prevNames[m.peerId]=m.name;}); mpBoot=false; return; }
  cur.forEach(id=>{ if(prevIds.indexOf(id)<0&&id!==localId()){ const m=memberOf(id); toast((m?m.name:'有人')+' 加入了房间'); addMsg('',(m?m.name:'有人')+' 加入了房间',true); } });
  prevIds.forEach(id=>{ if(!curSet[id]&&id!==localId()){ toast((prevNames[id]||'有人')+' 离开了房间'); addMsg('',(prevNames[id]||'有人')+' 离开了房间',true); } });
  prevIds=cur; prevNames={}; members.forEach(m=>{prevNames[m.peerId]=m.name;});
}
function showRoom(){
  $('welcome').classList.add('hidden');
  $('room').classList.remove('hidden');
  $('roomCode').textContent=code;
  renderMembers(); renderSrc();
}

/* ---------- PeerJS ---------- */
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
function choose(which){
  if(connecting) return;
  const nick=cleanName($('nickname').value);
  if(!nick){ toast('先输入昵称'); $('nickname').focus(); return; }
  myName=nick; role=which; mpBoot=true; prevIds=[]; prevNames={};
  if(which==='host'){ code=randomCode(); members=[]; }
  else { code=($('joinCode').value||'').trim().toUpperCase(); if(!CODE_RE.test(code)){ role='welcome'; toast('邀请码是 4 位字母或数字'); return; } }
  connecting=true; showRoom();
  try{ if(history&&history.replaceState) history.replaceState(null,'',inviteUrl()); }catch(_){}
  startPeer();
}
function startPeer(){
  loadPeerJS().then(()=>{
    const id=role==='host'?PREFIX+code+'-host':undefined;
    try{ peer=id?new window.Peer(id,{debug:0}):new window.Peer({debug:0}); }
    catch(e){ toast(String(e)); connecting=false; return; }
    peer.on('open',()=>{
      connecting=false;
      if(role==='host'){ members=[{peerId:peer.id,name:myName,voice:false}]; sendRoster(); toast('房间已建好，把邀请链接发给朋友'); }
      else joinHost();
    });
    peer.on('connection',c=>{
      if(role!=='host'){ c.close(); return; }
      c.on('data',d=>fromGuest(c,d));
      c.on('close',()=>guestLeft(c));
      c.on('error',()=>guestLeft(c));
    });
    peer.on('call',inc=>{
      const m=memberOf(inc.peer); if(!m||!mic||!micOn||!m.voice){ try{inc.close();}catch(_){} return; }
      bindCall(inc); try{ inc.answer(mic); }catch(_){}
    });
    peer.on('error',e=>{ toast((e&&e.message)||'连接遇到问题'); });
    peer.on('disconnected',()=>{ if(peer&&!peer.destroyed) peer.reconnect(); });
  }).catch(e=>{ toast(e.message||'联机模块加载失败'); connecting=false; });
}
function joinHost(){
  const c=peer.connect(PREFIX+code+'-host',{reliable:true,serialization:'json'});
  connections.set(PREFIX+code+'-host',c);
  c.on('open',()=>c.send({type:'join',name:myName}));
  c.on('data',d=>fromHost(d));
  c.on('close',()=>{ toast('与房主断开'); members=[]; renderMembers(); });
  c.on('error',()=>toast('进不去这个房间'));
}
function fromGuest(c,d){
  if(!d||!d.type) return; const id=c.peer;
  if(d.type==='join'){
    if(memberOf(id)){ hostSend(id,roomPacket('welcome')); return; }
    if(!c.open||members.length>=8){ try{c.send({type:'reject',reason:'房间已满'});setTimeout(()=>c.close(),120);}catch(_){} return; }
    const name=cleanName(d.name); if(!name){ try{c.close();}catch(_){} return; }
    connections.set(id,c); members.push({peerId:id,name:name,voice:false});
    hostSend(id,roomPacket('welcome')); sendRoster();
    // 让新成员立刻拿到当前的源与播放状态
    if(hostSrc) hostSend(id,{type:'src',kind:hostSrc.kind,url:hostSrc.url,name:hostSrc.name,dur:hostSrc.dur});
    if(localReady) hostSend(id,statePacket());
    return;
  }
  if(!connections.has(id)) return;
  const i=members.findIndex(m=>m.peerId===id); if(i<1) return;
  if(d.type==='ctl'){
    syncing=true;
    if(d.paused) video.pause(); else { const p=video.play(); if(p&&p.catch) p.catch(()=>{}); }
    if(typeof d.t==='number'&&isFinite(d.t)){ try{ video.currentTime=d.t; }catch(_){} }
    setTimeout(()=>{ syncing=false; },120);
    scheduleBroadcast();
  } else if(d.type==='chat'&&typeof d.text==='string'){
    const txt=d.text.slice(0,200);
    broadcast({type:'chat',name:members[i].name,text:txt});
    addMsg(members[i].name,txt);
  } else if(d.type==='voice'&&typeof d.enabled==='boolean'){
    members[i].voice=d.enabled; sendRoster();
  }
}
function guestLeft(c){
  const i=members.findIndex(m=>m.peerId===c.peer);
  if(i<1||connections.get(c.peer)!==c) return;
  connections.delete(c.peer); dropCall(c.peer);
  members.splice(i,1); sendRoster();
}
function fromHost(d){
  if(!d||!d.type) return;
  if(d.type==='reject'){ toast('无法加入：'+(d.reason||'')); return; }
  if(d.type==='welcome'||d.type==='roster'){
    if(!Array.isArray(d.members)) return;
    members=d.members; renderMembers(); syncCalls();
    if(d.type==='welcome') toast('进来了！等房主放视频，或自己选一个文件');
  } else if(d.type==='src'){
    hostSrc={kind:d.kind,url:d.url,name:d.name,dur:d.dur};
    if(d.kind==='url'&&d.url) loadFromUrl(d.url);
    else renderSrc();
  } else if(d.type==='state'){
    applyState(d);
  } else if(d.type==='chat'){
    addMsg(d.name||'匿名', String(d.text||'').slice(0,200));
  }
}

/* ---------- 语音 ---------- */
function broadcastVoice(){ if(role==='host'){ if(members[0]){ members[0].voice=micOn; sendRoster(); } } else toHost({type:'voice',enabled:micOn}); }
function dropCall(id){ const c=mediaCalls.get(id); if(c){ mediaCalls.delete(id); try{c.close();}catch(_){} }
  const a=audioNodes.get(id); if(a){ a.srcObject=null; if(a.parentNode) a.parentNode.removeChild(a); audioNodes.delete(id); } }
function clearCalls(){ mediaCalls.forEach((_,id)=>dropCall(id)); }
function bindCall(call){
  const id=call.peer, old=mediaCalls.get(id); if(old&&old!==call) dropCall(id);
  mediaCalls.set(id,call);
  call.on('stream',st=>{
    let a=audioNodes.get(id);
    if(!a){ a=document.createElement('audio'); a.autoplay=true; a.playsInline=true; document.body.appendChild(a); audioNodes.set(id,a); }
    a.srcObject=st; const p=a.play(); if(p&&p.catch) p.catch(()=>toast('音频被拦，再点一次语音'));
    renderMembers();
  });
  call.on('close',()=>{ if(mediaCalls.get(id)===call){ mediaCalls.delete(id); const a=audioNodes.get(id); if(a){ a.srcObject=null; if(a.parentNode) a.parentNode.removeChild(a); audioNodes.delete(id); } renderMembers(); } });
  call.on('error',()=>{ if(mediaCalls.get(id)===call) dropCall(id); });
}
function syncCalls(){
  if(!mic||!micOn||!peer||!peer.open) return;
  const ids=new Set(); members.forEach(m=>{ if(m.voice&&m.peerId!==peer.id) ids.add(m.peerId); });
  mediaCalls.forEach((_,id)=>{ if(!ids.has(id)) dropCall(id); });
  ids.forEach(id=>{ if(mediaCalls.has(id)) return;
    if(peer.id.localeCompare(id)<0){ try{ const c=peer.call(id,mic); if(c) bindCall(c); }catch(_){} } });
  renderMembers();
}
function toggleVoice(){
  if(role==='welcome'||openingMic) return;
  if(mic){ micOn=!micOn; mic.getAudioTracks().forEach(t=>{ t.enabled=micOn; });
    if(!micOn) clearCalls(); broadcastVoice(); if(micOn) syncCalls(); renderMembers(); return; }
  if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia){ toast('需要 HTTPS 并授权麦克风'); return; }
  openingMic=true; $('micBtn').disabled=true;
  navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false})
    .then(st=>{ mic=st; micOn=true; broadcastVoice(); syncCalls(); renderMembers(); toast('麦克风已开'); })
    .catch(e=>toast(e&&e.name==='NotAllowedError'?'请在地址栏允许麦克风':'麦克风启动失败'))
    .then(()=>{ openingMic=false; $('micBtn').disabled=false; });
}

/* ---------- 事件 ---------- */
$('createBtn').addEventListener('click',()=>choose('host'));
$('joinBtn').addEventListener('click',()=>choose('guest'));
$('nickname').addEventListener('keydown',e=>{ if(e.key==='Enter'){ e.preventDefault(); ($('joinCode').value?$('joinBtn'):$('createBtn')).click(); } });
$('joinCode').addEventListener('keydown',e=>{ if(e.key==='Enter'){ e.preventDefault(); $('joinBtn').click(); } });
$('playBtn').addEventListener('click',()=>{ requestControl(!video.paused, video.currentTime); });
$('loadUrlBtn').addEventListener('click',()=>{
  const u=$('srcUrl').value.trim(); if(!u){ toast('先填一个视频直链'); return; }
  loadFromUrl(u);
  if(role!=='host') toast('你自己换了源，会和大家不同步');
});
$('srcFile').addEventListener('change',e=>{
  const f=e.target.files&&e.target.files[0]; if(!f) return;
  loadFromFile(f);
  if(role!=='host') toast('已加载本地文件，正在和房主对齐');
});
$('sendBtn').addEventListener('click',sendChat);
$('chatInput').addEventListener('keydown',e=>{ if(e.key==='Enter'){ e.preventDefault(); sendChat(); } });
$('copyBtn').addEventListener('click',()=>{
  const u=inviteUrl();
  try{ if(navigator.clipboard&&navigator.clipboard.writeText) navigator.clipboard.writeText(u).then(()=>toast('邀请链接已复制'),()=>window.prompt('复制邀请链接：',u));
       else window.prompt('复制邀请链接：',u); }catch(_){ window.prompt('复制邀请链接：',u); }
});
$('micBtn').addEventListener('click',toggleVoice);
$('leaveBtn').addEventListener('click',()=>{
  clearCalls(); if(mic&&mic.getTracks) mic.getTracks().forEach(t=>t.stop());
  try{ if(peer&&!peer.destroyed) peer.destroy(); }catch(_){}
  peer=null; members=[]; mic=null; micOn=false; role='welcome'; code=''; hostSrc=null; localReady=false;
  $('room').classList.add('hidden'); $('welcome').classList.remove('hidden');
});
window.addEventListener('pagehide',()=>{ if(mic&&mic.getTracks) mic.getTracks().forEach(t=>t.stop()); clearCalls(); try{ if(peer&&!peer.destroyed) peer.destroy(); }catch(_){} });

function sendChat(){
  const v=$('chatInput').value.trim(); if(!v) return;
  $('chatInput').value='';
  if(role==='host'){ broadcast({type:'chat',name:myName,text:v}); addMsg(myName,v); }
  else toHost({type:'chat',name:myName,text:v});
}

/* 房主心跳：持续校正大家的漂移 */
setInterval(()=>{ if(role==='host'&&localReady) broadcast(statePacket()); },HEARTBEAT);
/* 同步状态指示：本地自己也算一下和上次广播的差 */
setInterval(()=>{ if(role!=='welcome'&&!syncing) updateTime(); },500);

try{ const ps=new URLSearchParams(location.search); const inc=(ps.get('room')||'').toUpperCase(); if(CODE_RE.test(inc)) $('joinCode').value=inc; }catch(_){}
renderSrc(); updateTime();
window.__watchDebug={get:()=>({role,code,members:members.map(m=>({name:m.name,voice:m.voice})),ready:localReady,paused:video.paused,t:video.currentTime,src:curName})};
})();
