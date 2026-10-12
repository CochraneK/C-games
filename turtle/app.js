/* Turtle Soup (海龟汤) | host-authoritative room: 2–8 players, host sets puzzle,
   players converse, host answers 是/不是/与此无关, optional WebRTC mesh voice. */
(() => {
'use strict';
const Core=window.TurtleCore;
const $=id=>document.getElementById(id);
const PREFIX='cgames-turtle-v1-';
const CODE_RE=/^[A-Z2-9]{8,12}$/;
let role='welcome',phase='lobby',capacity=8,code='',myName='';
let peer=null,hostConnection=null,connections=new Map(),members=[],game=null,view=null;
let connected_flag=false,toastTimer=null,openingMic=false;
let mic=null,micOn=false,mediaCalls=new Map(),audioNodes=new Map();
function cleanName(raw){return String(raw??'').replace(/[\u0000-\u001f\u007f<>]/g,'').trim().replace(/\s+/g,' ').slice(0,16);}
function randomCode(){
 const alpha='ABCDEFGHJKMNPQRSTUVWXYZ23456789';
 const bytes=new Uint8Array(10);crypto.getRandomValues(bytes);
 return Array.from(bytes,b=>alpha[b%alpha.length]).join('');
}
function inviteUrl(){
 const u=new URL(location.href);u.search='';u.hash='';
 u.searchParams.set('room',code);return u.toString();
}
function status(message,level=''){
 $('networkText').textContent=message;$('networkDot').className='status-light '+level;
}
function toast(message){$('toast').textContent=message;$('toast').classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').classList.remove('show'),3100);}
function localId(){return peer?.id||'';}
function me(){return members.findIndex(m=>m.peerId===localId());}
function memberOf(id){return members.find(m=>m.peerId===id);}
function connected(){return role==='host'||(role==='guest'&&Boolean(hostConnection?.open)&&me()>=0);}
function hostSend(id,data){
 const c=connections.get(id);if(c?.open){try{c.send(data);return true;}catch(_){return false;}}return false;
}
function broadcast(data){if(role!=='host')return;for(const m of members.slice(1))hostSend(m.peerId,data);}
function toHost(data){
 if(role==='guest'&&hostConnection?.open){try{hostConnection.send(data);return true;}catch(_){}}
 return false;
}
/* Host keeps the full state (with answer). Guests only ever receive a sanitized
   copy where the answer is stripped — unless the round is already over. */
function sanitize(g){
 const over=g.phase==='solved'||g.phase==='revealed';
 return {phase:g.phase, surface:g.puzzle.surface,
   answer: over?g.puzzle.answer:null,
   messages:g.messages.map(m=>({id:m.id,from:m.from,kind:m.kind,text:m.text,verdict:m.verdict||null})),
   hints:g.hints, solvedBy:g.solvedBy};
}
function roomPacket(type='roster'){
 return {type, phase, capacity, members:members.map(m=>({...m})),
   state: phase==='lobby'?null:(role==='host'?sanitize(game):view)};
}
function sendRoster(){broadcast(roomPacket());render();syncCalls();}
function sendState(){if(role!=='host')return;broadcast(roomPacket('state'));render();}
function resetLobby(){
 phase='lobby';game=null;view=null;
 for(const m of members)m.ready=false;
 sendRoster();
}
function validRoom(data){
 return data&&Array.isArray(data.members)&&data.members.length>=1&&data.members.length<=Core.MAX_PLAYERS&&
  data.members.every(m=>m&&typeof m.peerId==='string'&&m.peerId.length<=90&&
   typeof m.name==='string'&&m.name.length>=1&&m.name.length<=16&&
   typeof m.ready==='boolean'&&typeof m.voice==='boolean')&&
  ['lobby','guessing','solved','revealed'].includes(data.phase)&&
  Number.isInteger(data.capacity)&&data.capacity>=2&&data.capacity<=8;
}
function applyRoom(data){
 if(!validRoom(data))return;
 members=data.members;phase=data.phase;capacity=data.capacity;
 if(phase!=='lobby'&&data.state&&data.state.messages)view=data.state;
 render();syncCalls();
}
function startPuzzle(){
 if(role!=='host'||phase!=='lobby')return;
 if(members.length<2){toast('至少 2 人才能开始这局');return;}
 const v=Core.validatePuzzle({surface:$('surfaceInput').value,answer:$('answerInput').value});
 if(!v.ok){toast(v.errors.join('；'));return;}
 game=Core.create(v.puzzle);phase='guessing';sendState();
 toast('出题成功，大家开始聊吧！');
}
function sendMessage(kind,text){
 const t=Core.cleanText(text);
 if(!t){toast('说点什么吧');return;}
 if(role==='host'){
   const r=Core.addMessage(game,{from:0,kind:kind,text:t});
   if(!r.ok){toast(r.reason);return;}
   game=r.state;sendState();
 }else if(connected()){
   toHost({type:'msg',kind:kind,text:t});
 }
}
function answer(msgId,verdict){
 if(role!=='host')return;
 const r=Core.answerQuestion(game,msgId,verdict);
 if(!r.ok){toast(r.reason);return;}
 game=r.state;sendState();
}
function resolveSolve(msgId,correct){
 if(role!=='host')return;
 const msg=game.messages.find(m=>m.id===msgId&&m.kind==='solve');
 if(!msg)return;
 const r=Core.markSolved(game,msg.from,correct);
 if(!r.ok){toast(r.reason);return;}
 game=r.state;sendState();
 if(correct)toast((members[msg.from]?.name||'有玩家')+' 猜中啦！');
}
function reveal(){
 if(role!=='host')return;
 const r=Core.reveal(game);
 if(!r.ok){toast(r.reason);return;}
 game=r.state;sendState();
}
function showRoom(){
 $('welcome').classList.add('hidden');$('roomView').classList.remove('hidden');
 $('roomCode').textContent=code;render();
}
function render(){
 if(role==='welcome')return;
 $('roomCode').textContent=code;
 const s=role==='host'?game:view;
 $('lobby').classList.toggle('hidden',phase!=='lobby');
 $('playing').classList.toggle('hidden',phase==='lobby');
 $('lobbyCount').textContent=members.length+' / '+capacity+' 人';
 renderRoster();
 if(role==='host'){
   $('hostSetup').classList.toggle('hidden',phase!=='lobby');
   $('guestWait').classList.add('hidden');
   $('startButton').disabled=!(phase==='lobby'&&members.length>=2);
 }else{
   $('guestWait').classList.toggle('hidden',phase!=='lobby');
   $('hostSetup').classList.add('hidden');
 }
 if(role==='host'){
   $('lobbyHint').textContent=members.length<2?'把邀请链接发给朋友，至少两人才能开始。':
     '人都到齐了，写下汤面和谜底，点「开始这局」。';
 }else{
   $('lobbyHint').textContent='等房主出题。房主设好谜底后，汤面会立刻出现在这里。';
 }
 if(phase!=='lobby'&&s){
   $('surfaceText').textContent=s.surface||'';
   const p=Core.progress(s);
   $('progressText').textContent=p.asked+' 问 · '+p.answered+' 答'+(p.hints?(' · '+p.hints+' 提示'):'');
   if(role==='host'){
     $('hostAnswer').classList.toggle('hidden',phase!=='guessing');
     $('answerText').textContent=game.puzzle.answer||'';
   }else $('hostAnswer').classList.add('hidden');
   const over=s.phase==='solved'||s.phase==='revealed';
   const truth=role==='host'?game.puzzle.answer:(s.answer||'');
   $('truthCard').classList.toggle('hidden',!over||!truth);
   if(over&&truth)$('truthText').textContent=truth;
   renderMessages(s);
 }
 renderVoice();
}
function renderRoster(){
 $('roster').replaceChildren();
 for(let i=0;i<capacity;i++){
  const m=members[i],card=document.createElement('div');
  card.className='seat'+(m?' occupied':'');
  const circle=document.createElement('div');circle.className='number';circle.textContent=i+1;
  const name=document.createElement('strong');name.className='seat-name';name.textContent=m?(m.name+(i===me()?' · 你':'')):'空座位';
  const state=document.createElement('span');state.className='seat-status'+(m?.voice?' voice-active':'');
  state.textContent=!m?'等待加入':m.voice?'已入座 · 🎙 开麦':'已入座';
  card.append(circle,name,state);$('roster').appendChild(card);
 }
}
function renderMessages(s){
 const box=$('messages');box.replaceChildren();
 if(!s||!s.messages.length){const e=document.createElement('p');e.className='empty-msg';e.textContent='还没有人说话，开聊吧。';box.appendChild(e);return;}
 for(const m of s.messages){
  const div=document.createElement('div');div.className='msg msg-'+m.kind;
  const who=members[m.from];const name=who?who.name:('玩家'+(m.from+1));
  const head=document.createElement('div');head.className='msg-head';
  const author=document.createElement('strong');author.textContent=name+(m.from===me()?' · 你':'');
  const tag=document.createElement('span');tag.className='msg-tag';tag.textContent='· '+Core.kindLabel(m.kind);
  head.append(author,tag);
  const body=document.createElement('p');body.className='msg-body';body.textContent=m.text;
  div.append(head,body);
  if(m.kind==='ask'){
   if(m.verdict){
    const v=document.createElement('span');v.className='verdict '+m.verdict;v.textContent='房主：'+Core.verdictLabel(m.verdict);
    div.appendChild(v);
   }else if(role==='host'){
    const b=document.createElement('div');b.className='verdict-btns';
    for(const [vd,lab] of [['yes','是'],['no','不是'],['na','与此无关']]){
     const btn=document.createElement('button');btn.type='button';btn.className='btn mini '+vd;btn.textContent=lab;
     btn.addEventListener('click',()=>answer(m.id,vd));b.appendChild(btn);
    }
    div.appendChild(b);
   }else{
    const w=document.createElement('span');w.className='pending';w.textContent='（待房主回答）';
    div.appendChild(w);
   }
  }
  if(m.kind==='solve'){
   if(role==='host'&&s.phase==='guessing'){
    const b=document.createElement('div');b.className='verdict-btns';
    const yes=document.createElement('button');yes.type='button';yes.className='btn mini yes';yes.textContent='猜中！';
    yes.addEventListener('click',()=>resolveSolve(m.id,true));
    const no=document.createElement('button');no.type='button';no.className='btn mini no';no.textContent='没猜中';
    no.addEventListener('click',()=>resolveSolve(m.id,false));
    b.append(yes,no);div.appendChild(b);
   }else{
    const ref=document.createElement('span');ref.className='pending';
    if(s.phase==='solved')ref.textContent=(m.from===s.solvedBy?'（这就是真相）':'（未猜中）');
    else if(s.phase==='revealed')ref.textContent='（房主已翻牌）';
    else ref.textContent='（等待房主判定）';
    div.appendChild(ref);
    if(s.phase==='solved'&&m.from===s.solvedBy)div.classList.add('winner');
   }
  }
  box.appendChild(div);
 }
}
function loadPeerJS(){
 if(window.Peer)return Promise.resolve();
 const sources=['https://cdn.jsdelivr.net/npm/peerjs@1.5.5/dist/peerjs.min.js',
  'https://unpkg.com/peerjs@1.5.5/dist/peerjs.min.js'];
 return (async()=>{
  for(const src of sources){
   try{await new Promise((resolve,reject)=>{
    const script=document.createElement('script');script.src=src;script.async=true;
    const timeout=setTimeout(()=>{script.remove();reject(Error('timeout'));},9000);
    script.onload=()=>{clearTimeout(timeout);window.Peer?resolve():reject(Error('PeerJS missing'));};
    script.onerror=()=>{clearTimeout(timeout);script.remove();reject(Error('CDN inaccessible'));};
    document.head.appendChild(script);
   });return;}catch(_){}
  }
  throw Error('联机模块无法加载，请检查网络或稍后再试');
 })();
}
function choose(which){
 const nickname=cleanName($('nickname').value);
 if(!nickname){toast('先输入你的昵称');$('nickname').focus();return;}
 myName=nickname;role=which;
 if(which==='host'){
  capacity=Number($('capacity').value);code=randomCode();
  members=[];phase='lobby';game=null;view=null;
 }else{
  code=$('joinCode').value.trim().toUpperCase();
  if(!CODE_RE.test(code)){role='welcome';toast('请输入有效的 8–12 位邀请码');return;}
 }
 showRoom();status('连接信令服务中…');
 history.replaceState(null,'',inviteUrl());
 startPeer();
}
async function startPeer(){
 try{await loadPeerJS();}catch(e){status(e.message,'off');toast(e.message);return;}
 const chosen=role==='host'?PREFIX+code+'-host':undefined;
 try{peer=chosen?new window.Peer(chosen,{debug:0}):new window.Peer({debug:0});}
 catch(e){status('连接初始化失败','off');toast(String(e));return;}
 peer.on('open',()=>{
  if(role==='host'){
   members=[{peerId:peer.id,name:myName,ready:false,voice:false}];
   status('房间已创建 · 等朋友加入','live');render();
  }else joinHost();
 });
 peer.on('connection',c=>{
  if(role!=='host'){c.close();return;}
  c.on('data',d=>fromGuest(c,d));
  c.on('close',()=>guestLeft(c));
  c.on('error',()=>guestLeft(c));
 });
 peer.on('call',incoming=>{
  const member=memberOf(incoming.peer);
  if(!member||!mic||!micOn||!member.voice){incoming.close();return;}
  bindCall(incoming);incoming.answer(mic);
 });
 peer.on('error',error=>{
  if(error?.type==='unavailable-id'&&role==='host')status('邀请码冲突，请刷新重新创建','off');
  else if(error?.type==='peer-unavailable'&&role==='guest')status('未找到房间，确认房主在线','off');
  else status('连接异常 · '+(error?.type||'请检查网络'),'off');
  toast(error?.message||'连接遇到问题');
 });
 peer.on('disconnected',()=>{status('信令暂时中断，尝试恢复…','off');if(!peer.destroyed)peer.reconnect();});
}
function joinHost(){
 status('正在加入朋友的房间…');
 hostConnection=peer.connect(PREFIX+code+'-host',{reliable:true,serialization:'json'});
 hostConnection.on('open',()=>hostConnection.send({type:'join',name:myName}));
 hostConnection.on('data',fromHost);
 hostConnection.on('close',()=>{status('与房主断开，请刷新重新加入','off');members=[];phase='lobby';view=null;clearCalls();render();});
 hostConnection.on('error',()=>{status('连接失败，请检查网络','off');toast('无法进入这个房间');});
}
function reject(c,reason){
 try{c.send({type:'reject',reason});setTimeout(()=>c.close(),120);}catch(_){c.close();}
}
function fromGuest(c,d){
 if(!d||typeof d.type!=='string')return;
 const id=c.peer;
 if(d.type==='join'){
  if(memberOf(id)){hostSend(id,roomPacket('welcome'));return;}
  if(!c.open||phase!=='lobby'){reject(c,'已开局，暂时无法加入');return;}
  if(members.length>=capacity){reject(c,'房间已满');return;}
  const name=cleanName(d.name);if(!name){reject(c,'昵称不能为空');return;}
  connections.set(id,c);members.push({peerId:id,name,ready:false,voice:false});
  hostSend(id,roomPacket('welcome'));sendRoster();
  status(members.length+' 人已入座','live');
  toast(name+' 已加入房间');
  return;
 }
 if(!connections.has(id))return;
 const index=members.findIndex(m=>m.peerId===id);if(index<1)return;
 if(d.type==='msg'&&phase!=='lobby'&&['ask','say','hint','solve'].includes(d.kind)){
  const r=Core.addMessage(game,{from:index,kind:d.kind,text:d.text});
  if(!r.ok){toast(r.reason);return;}
  game=r.state;sendState();
 }else if(d.type==='voice'&&typeof d.enabled==='boolean'){
  members[index].voice=d.enabled;sendRoster();
 }
}
function guestLeft(c){
 const i=members.findIndex(m=>m.peerId===c.peer);
 if(i<1||connections.get(c.peer)!==c)return;
 const name=members[i].name;
 connections.delete(c.peer);dropCall(c.peer);
 members.splice(i,1);
 if(phase!=='lobby')resetLobby();
 else {for(const m of members)m.ready=false;sendRoster();}
 status('有玩家离开 · '+members.length+' 人在线','live');
 toast(name+' 离开了房间，需要重新出题');
}
function fromHost(d){
 if(!d||typeof d.type!=='string')return;
 if(d.type==='reject'){status('无法加入：'+d.reason,'off');toast(d.reason||'无法加入');return;}
 if(['welcome','roster','state'].includes(d.type)){
  applyRoom(d);status('已进入房间 · '+members.length+' 人在线','live');
  if(d.type==='welcome')toast('入座成功！等房主出题');
 }
}
function broadcastVoice(){if(role==='host'){if(members[0]){members[0].voice=micOn;sendRoster();}}
 else toHost({type:'voice',enabled:micOn});}
function dropCall(id){
 const c=mediaCalls.get(id);if(c){mediaCalls.delete(id);try{c.close();}catch(_){}}
 const audio=audioNodes.get(id);if(audio){audio.srcObject=null;audio.remove();audioNodes.delete(id);}
}
function clearCalls(){for(const id of [...mediaCalls.keys()])dropCall(id);}
function bindCall(call){
 const id=call.peer;const old=mediaCalls.get(id);
 if(old&&old!==call)dropCall(id);
 mediaCalls.set(id,call);
 call.on('stream',stream=>{
  let audio=audioNodes.get(id);
  if(!audio){audio=document.createElement('audio');audio.autoplay=true;audio.playsInline=true;
   document.body.appendChild(audio);audioNodes.set(id,audio);}
  audio.srcObject=stream;audio.play().catch(()=>toast('音频自动播放被阻止，请再点一次语音按钮'));
  renderVoice();
 });
 call.on('close',()=>{if(mediaCalls.get(id)===call){mediaCalls.delete(id);
  const audio=audioNodes.get(id);if(audio){audio.remove();audioNodes.delete(id);}
  renderVoice();}});
 call.on('error',()=>{if(mediaCalls.get(id)===call)dropCall(id);renderVoice();});
}
function syncCalls(){
 if(!mic||!micOn||!peer?.open)return;
 const peerIDs=new Set(members.filter(m=>m.voice&&m.peerId!==peer.id).map(m=>m.peerId));
 for(const id of [...mediaCalls.keys()])if(!peerIDs.has(id))dropCall(id);
 for(const id of peerIDs){
  if(mediaCalls.has(id))continue;
  if(peer.id.localeCompare(id)<0){
   try{const call=peer.call(id,mic);bindCall(call);}catch(_){toast('某位玩家的语音连接失败');}
  }
 }
 renderVoice();
}
async function toggleVoice(){
 if(role==='welcome'||openingMic)return;
 if(mic){
  micOn=!micOn;mic.getAudioTracks().forEach(track=>track.enabled=micOn);
  if(!micOn)clearCalls();
  broadcastVoice();if(micOn)syncCalls();renderVoice();return;
 }
 if(!navigator.mediaDevices?.getUserMedia){toast('需要使用 HTTPS 并授权麦克风');return;}
 openingMic=true;$('voiceButton').disabled=true;
 try{
  mic=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false});
  micOn=true;broadcastVoice();syncCalls();renderVoice();toast('麦克风已开启，房间里其他开麦的玩家可以听到你');
 }catch(e){toast(e?.name==='NotAllowedError'?'请在地址栏允许麦克风':'麦克风启动失败');}
 finally{openingMic=false;$('voiceButton').disabled=false;}
}
function renderVoice(){
 if(role==='welcome')return;
 const names=members.filter(m=>m.peerId!==peer?.id&&m.voice);
 $('voiceButton').textContent=micOn?'静音麦克风':'开启语音';
 $('voiceText').textContent=!micOn?'语音未开启 · 其他人可自由选择是否开麦':
 '你的麦克风已开 · 其他开麦 '+names.length+' 人 · 已接通 '+audioNodes.size+' 人';
}
async function copyLink(){
 try{await navigator.clipboard.writeText(inviteUrl());toast('邀请链接已复制');}
 catch(_){window.prompt('请复制房间邀请链接：',inviteUrl());}
}
function showRules(){$('rulesDialog').showModal();}
$('createButton').addEventListener('click',()=>choose('host'));
$('joinButton').addEventListener('click',()=>choose('guest'));
$('nickname').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();$('joinCode').value?$('joinButton').click():$('createButton').click();}});
$('joinCode').addEventListener('keydown',e=>{if(e.key==='Enter')$('joinButton').click();});
$('copyButton').addEventListener('click',copyLink);
$('startButton').addEventListener('click',startPuzzle);
$('revealButton').addEventListener('click',reveal);
$('voiceButton').addEventListener('click',toggleVoice);
$('sendButton').addEventListener('click',()=>{const k=$('msgKind').value;sendMessage(k,$('msgInput').value);if(role==='host'||connected())$('msgInput').value='';});
$('msgInput').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();const k=$('msgKind').value;sendMessage(k,$('msgInput').value);$('msgInput').value='';}});
$('rulesButton').addEventListener('click',showRules);
$('closeRules').addEventListener('click',()=>$('rulesDialog').close());
$('gotIt').addEventListener('click',()=>$('rulesDialog').close());
window.addEventListener('pagehide',()=>{if(mic)mic.getTracks().forEach(t=>t.stop());clearCalls();try{peer?.destroy();}catch(_){}});
const params=new URLSearchParams(location.search);
const incoming=(params.get('room')||'').toUpperCase();
if(CODE_RE.test(incoming)){$('joinCode').value=incoming;$('joinCode').parentElement?.classList.add('from-link');}
window.__turtleDebug={get:()=>({role,phase,capacity,members:members.map(m=>({...m})),game,view,connected:connected()}),core:Core};
})();
