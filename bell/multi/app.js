/* Bell Multiplayer | host-authoritative room with nickname, 2–8 players, optional WebRTC mesh audio. */
(() => {
'use strict';
const Core=window.MultiBellCore;
const $=id=>document.getElementById(id);
const FRUITS={strawberry:'🍓',banana:'🍌',lime:'🍋',plum:'🍇'};
const PREFIX='cgames-bell-multi-v1-';
const CODE_RE=/^[A-Z2-9]{8,12}$/;
const FAIR_WINDOW=180;
let role='welcome',phase='lobby',kind='classic',capacity=4,code='',myName='';
let peer=null,hostConnection=null,connections=new Map(),members=[],game=null,view=null;
let pending=null,locked=false,toastTimer=null,botTimer=null;
let mic=null,micOn=false,openingMic=false,mediaCalls=new Map(),audioNodes=new Map();
let lastBellSent=0,connecting=false;
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
function roomPacket(type='roster'){return {type,kind,phase,capacity,members:members.map(m=>({...m})),state:view};}
function sendRoster(){broadcast(roomPacket());render();}
function sendGame(){if(role!=='host')return;view=game?Core.snapshot(game):null;broadcast(roomPacket('state'));render();}
function resetLobby(){
 phase='lobby';for(const m of members)m.ready=false;
 pending=null;if(pending?.timer)clearTimeout(pending.timer);game=null;view=null;
 sendRoster();
}
function validMembers(data){
 return Array.isArray(data)&&data.length<=Core.MAX_PLAYERS&&data.length>=1&&data.every(m=>
 m&&typeof m.peerId==='string'&&m.peerId.length<=90&&
 typeof m.name==='string'&&m.name.length>=1&&m.name.length<=16&&
 typeof m.ready==='boolean'&&typeof m.voice==='boolean');
}
function applyRoom(data){
 if(!data||!validMembers(data.members)||!['lobby','playing'].includes(data.phase)||
 !['classic','pan'].includes(data.kind)||!Number.isInteger(data.capacity)||data.capacity<2||data.capacity>8)return;
 members=data.members;phase=data.phase;kind=data.kind;capacity=data.capacity;
 if(data.state&&validState(data.state))view=data.state;
 if(phase==='lobby')view=null;
 render();syncCalls();
}
function validState(s){
 const n=members.length;
 return s&&typeof s==='object'&&s.kind===kind&&['playing','ended'].includes(s.phase)&&
 Number.isInteger(s.turn)&&s.turn>=0&&s.turn<n&&Number.isInteger(s.revision)&&
 Array.isArray(s.hands)&&s.hands.length===n&&s.hands.every(x=>Number.isInteger(x)&&x>=0&&x<=56)&&
 Array.isArray(s.piles)&&s.piles.length===n&&s.piles.every(p=>p&&Number.isInteger(p.length)&&p.length>=0&&p.length<=56)&&
 Array.isArray(s.scores)&&s.scores.length===n&&typeof s.last==='string'&&s.last.length<=250;
}
function ready(){
 if(!connected()||phase!=='lobby')return;
 const i=me();if(i<0)return;
 const value=!members[i].ready;
 if(role==='host'){members[i].ready=value;sendRoster();}
 else toHost({type:'ready',ready:value});
}
function canStart(){return role==='host'&&phase==='lobby'&&members.length>=2&&members.every(m=>m.ready)&&members.slice(1).every(m=>connections.get(m.peerId)?.open);}
function begin(){
 if(!canStart()){toast('至少两人在线，并且所有人都需要准备');return;}
 game=Core.create(kind,members.length);phase='playing';pending=null;
 view=Core.snapshot(game);broadcast(roomPacket('state'));render();
 toast('大家都准备好了，开始！');
}
function changeKind(want){
 if(!['classic','pan'].includes(want)||want===kind)return;
 if(role==='guest'){if(connected())toHost({type:'kind-request',kind:want});return;}
 if(role!=='host')return;
 if(phase==='playing'&&!window.confirm('切换玩法需要返回准备房间，确定吗？'))return;
 kind=want;resetLobby();toast(want==='pan'?'已切换到潘神心脏病':'已切换到德国心脏病');
}
function resetRequest(){
 if(role==='host'){resetLobby();toast('已返回准备房间');}
 else if(role==='guest')toHost({type:'reset-request'});
}
function flip(player){
 if(role!=='host'||phase!=='playing'||pending||!game)return;
 const result=Core.flip(game,player);
 if(result.ok){game=result.state;sendGame();}
 else if(player===me())toast(result.reason);
}
function bell(player){
 if(role!=='host'||phase!=='playing'||!game||!Number.isInteger(player)||player<0||
 player>=members.length||!Core.active(game).includes(player))return;
 if(pending){
  if(pending.revision===game.revision)pending.tries.add(player);
  return;
 }
 const current={revision:game.revision,tries:new Set([player]),timer:null};
 pending=current;
 current.timer=setTimeout(()=>{
  if(pending!==current||game?.revision!==current.revision){pending=null;return;}
  const contenders=[...current.tries];
  const seed=new Uint32Array(1);crypto.getRandomValues(seed);
  const winner=contenders[seed[0]%contenders.length];
  pending=null;
  const result=Core.ring(game,winner);
  if(result.ok){
   game=result.state;
   if(contenders.length>1)game.last='多人几乎同时抢铃，抽签判定 · '+game.last;
   sendGame();ringSound();
  }
 },FAIR_WINDOW);
 render();
}
function doFlip(){if(phase!=='playing'||!view||view.phase!=='playing')return;const id=me();
 if(view.turn!==id||!view.hands[id]||pending)return;
 if(role==='host')flip(id);else toHost({type:'flip'});
}
function doBell(){if(phase!=='playing'||!view||view.phase!=='playing')return;const id=me();
 if(id<0||view.hands[id]+view.piles[id].length===0)return;
 const now=Date.now();if(now-lastBellSent<220)return;lastBellSent=now;
 if(role==='host')bell(id);else toHost({type:'bell'});ringSound();
}
function ringSound(){
 try{const Audio=window.AudioContext||window.webkitAudioContext;if(!Audio)return;
 const ctx=new Audio();if(ctx.state==='suspended')ctx.resume().catch(()=>{});
 const t=ctx.currentTime;
 for(const [n,hz] of [850,1280,1780].entries()){
  const osc=ctx.createOscillator(),gain=ctx.createGain();
  osc.frequency.value=hz;gain.gain.setValueAtTime(0.0001,t);
  gain.gain.exponentialRampToValueAtTime(.09/(n+1),t+.02);
  gain.gain.exponentialRampToValueAtTime(.0001,t+.44);
  osc.connect(gain).connect(ctx.destination);osc.start(t);osc.stop(t+.46);
 }
 setTimeout(()=>ctx.close(),800);
 }catch(_){}
}
function showRoom(){
 $('welcome').classList.add('hidden');$('roomView').classList.remove('hidden');
 $('roomCode').textContent=code;render();
}
function render(){
 if(role==='welcome')return;
 $('roomCode').textContent=code;
 $('lobby').classList.toggle('hidden',phase!=='lobby');
 $('playing').classList.toggle('hidden',phase!=='playing');
 for(const [key,id] of [['classic','classicTab'],['pan','panTab']]){
  const selected=kind===key;
  $(id).classList.toggle('selected',selected);$(id).setAttribute('aria-pressed',String(selected));
 }
 const online=members.length,local=me();
 $('lobbyCount').textContent=online+' / '+capacity+' 人';
 $('roster').replaceChildren();
 for(let i=0;i<capacity;i++){
  const m=members[i],card=document.createElement('div');
  card.className='seat'+(m?' occupied':'');
  const circle=document.createElement('div');circle.className='number';circle.textContent=i+1;
  const name=document.createElement('strong');name.className='seat-name';name.textContent=m?(m.name+(i===local?' · 你':'')):'空座位';
  const state=document.createElement('span');state.className='seat-status'+(m?.ready?' ready':'');
  state.textContent=!m?'等待加入':m.ready?'✓ 已准备':m.voice?'已入座 · 🎙 开麦':'已入座 · 未准备';
  card.append(circle,name,state);$('roster').appendChild(card);
 }
 $('readyButton').disabled=!connected()||phase!=='lobby';
 $('readyButton').textContent=members[local]?.ready?'取消准备':'我准备好了';
 $('startButton').classList.toggle('hidden',role!=='host');
 $('startButton').disabled=!canStart();$('startButton').textContent=canStart()?'大家都准备好了 · 开始':'等待全部准备';
 $('lobbyHint').textContent=online<2?'把邀请链接发给朋友，至少两人才能开始。':
 members.every(m=>m.ready)?(role==='host'?'大家准备好了！你可以开始。':'大家都准备好了，等房主开局。'):
 (members[local]?.ready?'你已准备，等待其他人。':'人到了，点击「我准备好了」。');
 $('hostNote').textContent=role==='host'?'你是房主，可以选择玩法；开局后不接受新玩家加入。':
 '房主统一管理牌局。切换游戏或有人离开，需要重新准备。';
 renderGame();renderVoice();
}
function makeCard(card){
 const div=document.createElement('div');div.className='play-card';
 if(!card){div.classList.add('empty');div.textContent='✳';return div;}
 if(kind==='classic'){
  const fruits=document.createElement('div');fruits.className='fruit';
  for(let i=0;i<card.count;i++){let el=document.createElement('span');el.textContent=FRUITS[card.fruit]||'●';fruits.appendChild(el);}
  div.appendChild(fruits);
 }else{
  const rank=document.createElement('strong');rank.className='rank';
  rank.textContent=card.rank===0?'王':card.rank===1?'A':card.rank===11?'J':card.rank===12?'Q':card.rank===13?'K':String(card.rank);
  const suit=document.createElement('span');suit.className='suit';suit.textContent=card.rank===0?'✦':card.suit;
  if(['♥','♦','RED'].includes(card.suit))div.classList.add('red');
  div.append(rank,suit);
 }
 return div;
}
function renderGame(){
 if(phase!=='playing')return;
 $('gameTitle').textContent=kind==='pan'?'潘神心脏病':'德国心脏病';
 $('roundLabel').textContent=kind==='pan'?'本局还剩':'不限时对局';
 $('gameBoard').replaceChildren();$('scoreboard').replaceChildren();
 const s=view,local=me();if(!s)return;
 for(let i=0;i<members.length;i++){
  const member=members[i],seat=document.createElement('div');
  const remain=s.hands[i]+s.piles[i].length;
  seat.className='table-seat'+(i===local?' me':'')+(s.turn===i&&s.phase==='playing'?' turn':'')+(remain===0?' out':'');
  const header=document.createElement('div');header.className='seat-head';
  const name=document.createElement('strong');name.textContent=member.name+(i===local?' · 你':'');
  const cnt=document.createElement('span');cnt.textContent=s.hands[i]+' 张';header.append(name,cnt);
  const badge=document.createElement('span');badge.className='badge';
  badge.textContent=remain===0?'已出局':s.turn===i&&s.phase==='playing'?'轮到 TA 翻牌':'已翻 '+s.piles[i].length;
  seat.append(header,makeCard(s.piles[i].top),badge);$('gameBoard').appendChild(seat);
  const chip=document.createElement('span');chip.className='score-chip'+(i===local?' me':'');
  chip.textContent=member.name+(kind==='pan'?' · '+s.scores[i]+' 分':' · '+remain+' 张')+(member.voice?' 🎙':'');
  $('scoreboard').appendChild(chip);
 }
 $('gameMessage').textContent=s.phase==='ended'?
 (s.winner===null?'本局平局！':(s.winner===local?'你赢啦！':members[s.winner]?.name+' 赢了！')):s.last;
 $('flipButton').disabled=!connected()||s.phase!=='playing'||s.turn!==local||
 !s.hands[local]||!!pending;
 $('flipButton').textContent=s.phase==='ended'?'本局已结束':s.turn===local?'翻一张牌 ↗':'等 '+members[s.turn]?.name+' 翻牌';
 $('bellButton').disabled=!connected()||s.phase!=='playing'||local<0||
 s.hands[local]+s.piles[local].length===0;
 updateClock();
}
function updateClock(){
 if(phase!=='playing'||!view)return;
 if(kind!=='pan'){$('clock').textContent='🔔';return;}
 const sec=Math.max(0,Math.ceil((view.deadline-Date.now())/1000));
 $('clock').textContent=String(Math.floor(sec/60)).padStart(2,'0')+':'+String(sec%60).padStart(2,'0');
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
 if(connecting)return;
 const nickname=cleanName($('nickname').value);
 if(!nickname){toast('先输入你的昵称');$('nickname').focus();return;}
 myName=nickname;role=which;
 if(which==='host'){
  capacity=Number($('capacity').value);
  code=randomCode();
  members=[];kind='classic';phase='lobby';
 }else{
  code=$('joinCode').value.trim().toUpperCase();
  if(!CODE_RE.test(code)){role='welcome';toast('请输入有效的 8–12 位邀请码');return;}
 }
 connecting=true;showRoom();status('连接信令服务中…');
 history.replaceState(null,'',inviteUrl());
 startPeer();
}
async function startPeer(){
 try{await loadPeerJS();}catch(e){status(e.message,'off');toast(e.message);connecting=false;return;}
 const chosen=role==='host'?PREFIX+code+'-host':undefined;
 try{peer=chosen?new window.Peer(chosen,{debug:0}):new window.Peer({debug:0});}
 catch(e){status('连接初始化失败','off');toast(String(e));connecting=false;return;}
 peer.on('open',()=>{
  connecting=false;
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
 hostConnection.on('close',()=>{status('与房主断开，请刷新重新加入','off');members=[];phase='lobby';clearCalls();render();});
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
  // Never trust the guest's chosen seat index; authority lives with host.
  connections.set(id,c);members.push({peerId:id,name,ready:false,voice:false});
  hostSend(id,roomPacket('welcome'));sendRoster();
  status(members.length+' 人已入座','live');
  toast(name+' 已加入房间');
  return;
 }
 if(!connections.has(id))return;
 const index=members.findIndex(m=>m.peerId===id);if(index<1)return;
 if(d.type==='ready'&&phase==='lobby'&&typeof d.ready==='boolean'){
  members[index].ready=d.ready;sendRoster();
 }else if(d.type==='flip'&&phase==='playing'){
  flip(index);
 }else if(d.type==='bell'&&phase==='playing'){
  bell(index);
 }else if(d.type==='reset-request'){
  if(window.confirm(members[index].name+' 希望回到准备房间，是否同意？'))resetLobby();
 }else if(d.type==='kind-request'&&['classic','pan'].includes(d.kind)&&d.kind!==kind){
  if(window.confirm(members[index].name+' 想切换游戏，要同意吗？'))changeKind(d.kind);
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
 if(phase==='playing')resetLobby();
 else {for(const m of members)m.ready=false;sendRoster();}
 status('有玩家离开 · '+members.length+' 人在线','live');
 toast(name+' 离开了房间，大家需要重新准备');
}
function fromHost(d){
 if(!d||typeof d.type!=='string')return;
 if(d.type==='reject'){status('无法加入：'+d.reason,'off');toast(d.reason||'无法加入');return;}
 if(['welcome','roster','state'].includes(d.type)){
  applyRoom(d);status('已进入房间 · '+members.length+' 人在线','live');
  if(d.type==='welcome')toast('入座成功！等待大家准备');
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
$('readyButton').addEventListener('click',ready);
$('startButton').addEventListener('click',begin);
$('classicTab').addEventListener('click',()=>changeKind('classic'));
$('panTab').addEventListener('click',()=>changeKind('pan'));
$('voiceButton').addEventListener('click',toggleVoice);
$('flipButton').addEventListener('click',doFlip);
$('bellButton').addEventListener('click',doBell);
$('resetButton').addEventListener('click',resetRequest);
$('rulesButton').addEventListener('click',showRules);
$('closeRules').addEventListener('click',()=>$('rulesDialog').close());
$('gotIt').addEventListener('click',()=>$('rulesDialog').close());
window.addEventListener('keydown',e=>{
 if(e.target?.matches?.('input,select,textarea,button')||e.metaKey||e.ctrlKey||e.altKey||role==='welcome'||phase!=='playing')return;
 if(e.code==='Space'){e.preventDefault();if(!e.repeat)doBell();}
 if(e.code==='Enter'){e.preventDefault();if(!e.repeat)doFlip();}
});
setInterval(()=>{
 if(role==='host'&&phase==='playing'&&kind==='pan'&&game?.phase==='playing'){
  const result=Core.finish(game);if(result.ok){game=result.state;sendGame();}
 }
 if(phase==='playing')updateClock();
},400);
window.addEventListener('pagehide',()=>{if(mic)mic.getTracks().forEach(t=>t.stop());clearCalls();try{peer?.destroy();}catch(_){}});
const params=new URLSearchParams(location.search);
const incoming=(params.get('room')||'').toUpperCase();
if(CODE_RE.test(incoming)){$('joinCode').value=incoming;$('joinCode').parentElement?.classList.add('from-link');}
window.__multiDebug={get:()=>({role,phase,kind,capacity,members:members.map(m=>({...m})),view,connected:connected()}),core:Core};
})();
