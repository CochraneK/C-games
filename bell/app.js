(() => {
'use strict';
let C=window.BellCore;
let gameKind='classic';
const $=id=>document.getElementById(id);
const FRUIT={strawberry:'🍓',banana:'🍌',lime:'🍋',plum:'🍇'};
const PREFIX='cochranek-belltogether-v1-';
const BELL_WINDOW=180;
const ALLOWED=/^[A-Z2-9]{8,12}$/;
const dom={
  welcome:$('welcome'),gameArea:$('gameArea'),host:$('hostButton'),practice:$('practiceButton'),join:$('joinButton'),roomInput:$('roomInput'),
  status:$('statusText'),dot:$('statusDot'),roomLabel:$('roomLabel'),copy:$('copyButton'),message:$('gameMessage'),bell:$('bellButton'),flip:$('flipButton'),
  voice:$('voiceButton'),voiceText:$('voiceText'),micIcon:$('micIcon'),restart:$('restartButton'),toast:$('toast'),audio:$('remoteAudio')
};
let mode='welcome', room='', peer=null,conn=null,game=null,view=null,started=false,pending=null;
let roomPhase='lobby',seatReady=[false,false],remoteVoiceEnabled=false;
let mic=null,call=null,remoteReady=false,voiceEnabled=false,voiceConnected=false;
let practiceBotTimer=null,botBellTimer=null,lastGuestBell=0,lastLocalBell=0,retryCount=0;
let toastTimer=0,audioContext=null,openingVoice=false;
function message(s){dom.message.textContent=s;}
function status(s,level){dom.status.textContent=s;dom.dot.className='status-dot '+(level||'');}
function toast(s){dom.toast.textContent=s;dom.toast.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>dom.toast.classList.remove('show'),3400);}
function randomRoom(){const chars='ABCDEFGHJKMNPQRSTUVWXYZ23456789';const bytes=crypto.getRandomValues(new Uint8Array(10));return Array.from(bytes,b=>chars[b%chars.length]).join('');}
function urlOf(code,join){const u=new URL(window.location.href);u.search='';u.hash='';u.searchParams.set('room',code);if(join)u.searchParams.set('join','1');return u.toString();}
function showGame(){dom.welcome.classList.add('hidden');dom.gameArea.classList.remove('hidden');render();}
function setReady(ready){started=ready;render();}
function canAct(){return mode==='practice'||(roomPhase==='playing'&&started&&conn?.open);}
function selfSeat(){return mode==='guest'?1:0;}
function share(){return room?urlOf(room,true):window.location.href;}
function send(data){if(conn&&conn.open){try{conn.send(data);return true;}catch(e){toast('发送失败，请检查连接');}}return false;}
function snapshot(){return game?C.snapshot(game):null;}
function roomDetails(){return {phase:roomPhase,ready:seatReady.slice(),kind:gameKind};}
function broadcastRoom(){if(mode==='host')send({type:'room-status',...roomDetails()});}
function broadcast(){if(mode==='host'&&game)send({type:'state',kind:gameKind,state:snapshot(),...roomDetails()});}
function acceptRoomState(d){
 if(!d||!['lobby','playing'].includes(d.phase)||!Array.isArray(d.ready)||d.ready.length!==2||
   !d.ready.every(v=>typeof v==='boolean'))return false;
 roomPhase=d.phase;seatReady=d.ready.slice();
 return true;
}
function readyToggle(){
 if(mode==='practice'||roomPhase!=='lobby'||!conn?.open)return;
 const seat=selfSeat();
 if(mode==='guest'){
  seatReady[seat]=!seatReady[seat];
  if(!send({type:'ready',value:seatReady[seat]})){seatReady[seat]=!seatReady[seat];}
 }else{
  seatReady[0]=!seatReady[0];broadcastRoom();
 }
 render();
}
function beginRound(){
 if(mode!=='host'||!conn?.open||roomPhase!=='lobby'||!seatReady.every(Boolean)){
  toast('需要两个人都已连接并准备好');return;
 }
 roomPhase='playing';resetGame();broadcastRoom();
 status('双方正在游戏中','live');toast('双方准备完成，开始！');
}
function returnToLobby(){
 roomPhase='lobby';seatReady=[false,false];pending=null;
 if(mode==='host'){resetGame();broadcastRoom();}
 render();
}
function renderLobby(){
 const lobby=$('roomLobby');
 const showing=mode!=='practice'&&mode!=='welcome'&&roomPhase==='lobby';
 lobby.classList.toggle('hidden',!showing);
 document.body.classList.toggle('in-lobby',showing);
 const connected=Boolean(conn?.open);
 const seat=selfSeat(),self=seatReady[seat],other=seatReady[1-seat];
 $('selfPresence').textContent=connected?'已连接':'已入座 · 等待连接';
 $('peerPresence').textContent=connected?'已连线 · 在线':'等待朋友加入…';
 $('selfReady').textContent=self?'✓ 已准备':'未准备';
 $('peerReady').textContent=!connected?'未入座':other?'✓ 已准备':'未准备';
 $('selfReady').classList.toggle('ready',self);
 $('peerReady').classList.toggle('ready',connected&&other);
 $('seatPeer').classList.toggle('occupied',connected);
 $('seatSelf').classList.toggle('occupied',true);
 $('lobbyGame').textContent=gameKind==='pan'?'潘神心脏病':'德国心脏病';
 const canReady=connected;
 $('readyButton').disabled=!canReady;
 $('readyButton').textContent=self?'取消准备':'我准备好了';
 $('startButton').classList.toggle('hidden',mode!=='host');
 const both=connected&&seatReady.every(Boolean);
 $('startButton').disabled=!both;
 $('startButton').textContent=both?'两个人都准备好了 · 开始！':'等待双方准备';
 $('lobbyMessage').textContent=!connected?'房间已留好位置，复制邀请链接等朋友进入。':
   both?'两个人都准备好了！'+(mode==='host'?'由你按下开始。':'等待房主开始。'):
   self?(other?'双方已准备':'你已准备，等对方准备就能玩。'):
   other?'对方已准备，轮到你啦。':'两个人都到啦，先点「我准备好了」。';
 $('lobbyNote').textContent=mode==='host'?
   '你是房主。双方准备后由你开始；切换玩法会重新准备。':
   '你是访客。双方准备后，房主会开始游戏。';
 $('lobbyVoiceButton').disabled=mode==='practice';
 $('lobbyMicIcon').textContent=dom.micIcon.textContent;
 $('lobbyVoiceText').textContent=dom.voiceText.textContent;
}

function apply(next){game=next;view=snapshot();render();broadcast();scheduleBot();}

function updatePanClock(){
 const box=$('panClock');
 if(!box||gameKind!=='pan')return;
 if(mode==='host'&&roomPhase!=='playing'){box.textContent='等待开局';return;}
 const remaining=view?.deadline&&view.phase==='playing'?Math.max(0,view.deadline-Date.now()):0;
 const sec=Math.ceil(remaining/1000);
 box.textContent=String(Math.floor(sec/60)).padStart(2,'0')+':'+String(sec%60).padStart(2,'0');
}
function selectGame(kind,fromRemote=false){
 if(!['classic','pan'].includes(kind)||kind===gameKind)return;
 gameKind=kind; C=gameKind==='pan'?window.PanCore:window.BellCore;
 pending=null;clearTimeout(practiceBotTimer);clearTimeout(botBellTimer);
 if(fromRemote){game=null;view=null;render();return;}
 if(mode!=='practice'){roomPhase='lobby';seatReady=[false,false];}
 resetGame();broadcastRoom();
 toast(kind==='pan'?'潘神心脏病 · 双人计时赛开始':'切换回德国心脏病');
}
function requestGame(kind){
 if(kind===gameKind||!['classic','pan'].includes(kind))return;
 if(mode==='guest'){
   if(!conn?.open){toast('等待房主重新连接');return;}
   send({type:'switch-request',kind});toast('已请求房主切换玩法');return;
 }
 if(window.confirm('切换玩法会开始新的一局，但语音保持连接。确定切换吗？'))selectGame(kind);
}
function render(){
 const s=view;
 const pan=gameKind==='pan';
 document.body.classList.toggle('pan-mode',pan);
 $('tabClassic').classList.toggle('selected',!pan);
 $('tabPan').classList.toggle('selected',pan);
 $('tabClassic').setAttribute('aria-pressed',String(!pan));
 $('tabPan').setAttribute('aria-pressed',String(pan));
 $('panSummary').classList.toggle('hidden',!pan||(mode!=='practice'&&roomPhase==='lobby'));
 renderLobby();
 $('gameTitle').innerHTML=pan?'潘神心脏病<span class="sparkle">♠</span>':'叮！一起玩<span class="sparkle">✳</span>';
 $('gameLead').textContent=pan?'逢 7、整 7、J Q K 和大小王，快一步拍铃！':'看见恰好五个同种水果，就先一步按响铃铛。';
 $('gameHint').textContent=pan?'A=1，数字牌相加逢 7 的倍数可拍；任一张是 7、J、Q、K 或王也可拍。空格抢铃，回车翻牌。':'轮到你时点“翻一张牌”或按 Enter。谁都可以随时抢铃。';
 if(pan){
  const seat=selfSeat(),other=1-seat;
  $('panYouScore').textContent=s?.scores?.[seat]??0;
  $('panOtherScore').textContent=s?.scores?.[other]??0;
  $('panYouHits').textContent='拍中 '+(s?.hits?.[seat]??0)+' · 误拍 '+(s?.fouls?.[seat]??0);
  $('panOtherHits').textContent='拍中 '+(s?.hits?.[other]??0)+' · 误拍 '+(s?.fouls?.[other]??0);
  updatePanClock();
 }

 const seat=selfSeat();
 if(room)dom.roomLabel.textContent='房间 '+room;
 dom.copy.classList.toggle('hidden',!room);
 for(let i=0;i<2;i++){
  $('name'+i).textContent=mode==='practice'?(i===0?'你':'练习对手'):(i===seat?'你':'对方');
  $('pileName'+i).textContent=mode==='practice'?(i===0?'你':'练习对手'):(i===seat?'你':'对方');
  $('player'+i).classList.toggle('active',Boolean(s&&s.phase==='playing'&&s.turn===i));
  $('count'+i).textContent=s?s.hands[i]:'—';
  $('pileCount'+i).textContent=s?s.piles[i].length:0;
  const card=$('card'+i);
  const top=s&&s.piles[i].top;
  card.classList.toggle('active-card',Boolean(top));
  card.classList.toggle('poker-card',pan);
  card.classList.remove('poker-red','poker-joker');
  if(pan&&top&&Number.isInteger(top.rank)&&top.rank>=0&&top.rank<=13){
   card.replaceChildren();
   const label=document.createElement('strong');
   const suit=document.createElement('span');
   const foot=document.createElement('small');
   const rank=top.rank;
   label.className='poker-rank';
   suit.className='poker-suit';
   foot.className='poker-foot';
   label.textContent=rank===0?'王':rank===1?'A':rank===11?'J':rank===12?'Q':rank===13?'K':String(rank);
   suit.textContent=rank===0?(top.suit==='RED'?'🃏':'✦'):top.suit;
   foot.textContent=rank===0?(top.suit==='RED'?'RED JOKER':'BLACK JOKER'):'PAN HEART';
   if(rank===0)card.classList.add('poker-joker');
   if(top.suit==='♥'||top.suit==='♦'||top.suit==='RED')card.classList.add('poker-red');
   card.append(label,suit,foot);
  }else if(!pan&&top&&FRUIT[top.fruit]&&Number.isInteger(top.count)&&top.count>=1&&top.count<=5){
    card.replaceChildren();const grid=document.createElement('div');grid.className='fruit-grid count-'+top.count;
    for(let k=0;k<top.count;k++){const fruit=document.createElement('span');fruit.textContent=FRUIT[top.fruit];grid.appendChild(fruit);}
    card.appendChild(grid);
  }else{card.replaceChildren(document.createTextNode('✳'));}
 }
 if(s){
   if(s.phase==='ended')message(s.winner===null?'平局，这一桌到此结束':(s.winner===seat?'恭喜，你赢了这一局！':'对方赢了这一局，再来一场？'));
   else message(s.last);
 }else message('还没开局。');
 const ended=Boolean(s&&s.phase==='ended');
 const hasTurn=Boolean(s&&s.turn===seat&&s.hands[seat]>0);
 dom.flip.disabled=!canAct()||ended||!hasTurn||!!pending;
 dom.bell.disabled=!canAct()||ended||!!pending?.attempts.has(seat);
 dom.restart.disabled=mode==='guest'?!Boolean(conn&&conn.open):mode==='host'?!Boolean(conn&&conn.open):mode!=='practice';
 dom.restart.textContent=mode==='practice'?'重新开局':s?.phase==='ended'?'再来一局':'回到准备房间';
 dom.flip.innerHTML=ended?'本局已结束':hasTurn?'翻一张牌 <span>↗</span>':mode==='practice'?'等对手翻牌':'等待对方翻牌';
 $('bellCaption').textContent=pending?'比拼反应中…':pan?'抢拍 · 空格':'抢铃 · 空格';
 if(!canAct()&&!ended){dom.flip.disabled=true;dom.bell.disabled=true;}
}
function playBell(){
 try{
  const AC=window.AudioContext||window.webkitAudioContext;
  if(!AC)return;
  if(!audioContext)audioContext=new AC();
  if(audioContext.state==='suspended')audioContext.resume().catch(()=>{});
  const t=audioContext.currentTime;
  [760,1140,1520].forEach((freq,i)=>{
    const o=audioContext.createOscillator(),g=audioContext.createGain();
    o.type='sine';o.frequency.setValueAtTime(freq,t);
    g.gain.setValueAtTime(0.0001,t);
    g.gain.exponentialRampToValueAtTime(.19/(i+1),t+.01);
    g.gain.exponentialRampToValueAtTime(.0001,t+.55);
    o.connect(g).connect(audioContext.destination);o.start(t);o.stop(t+.6);
  });
 }catch(_){/* sound is optional */}
}
function flash(){dom.bell.classList.add('ring');setTimeout(()=>dom.bell.classList.remove('ring'),160);playBell();}
function handleFlip(player){
 if(!canAct()||!game||pending)return;
 const res=C.flip(game,player);
 if(!res.ok){if(player===selfSeat())toast(res.reason);return;}
 apply(res.state);
}
function attemptBell(player){
 if(!canAct()||!game||game.phase!=='playing')return;
 const time=Date.now();
 if(player===1&&mode==='host'&&time-lastGuestBell<220)return;
 if(player===0&&time-lastLocalBell<220)return;
 if(player===1)lastGuestBell=time;else lastLocalBell=time;
 if(pending){if(!pending.attempts.has(player)&&pending.revision===game.revision){pending.attempts.add(player);pending.contested=true;}render();return;}
 pending={revision:game.revision,attempts:new Set([player]),contested:false};
 message('叮！正在裁定抢铃…');render();
 setTimeout(()=>{
   if(!pending||!game||pending.revision!==game.revision){pending=null;render();return;}
   const players=[...pending.attempts];
   const wasTie=players.length===2;
   const selected=wasTie?players[crypto.getRandomValues(new Uint8Array(1))[0]%2]:players[0];
   pending=null;
   const res=C.ring(game,selected);
   if(res.ok){if(wasTie)res.state.last='几乎同时按铃，随机裁定 · '+res.state.last;apply(res.state);flash();}
   else render();
 },BELL_WINDOW);
}
function handleBell(player){
 if(mode==='guest'){if(!canAct())return;if(Date.now()-lastLocalBell<220)return;lastLocalBell=Date.now();send({type:'bell'});flash();return;}
 attemptBell(player);
}
function scheduleBot(){
 if(mode!=='practice'||!game||game.phase!=='playing')return;
 clearTimeout(practiceBotTimer);clearTimeout(botBellTimer);
 if(C.isFive(game)){
  const seq=game.revision;
  botBellTimer=setTimeout(()=>{if(mode==='practice'&&game?.phase==='playing'&&game.revision===seq&&C.isFive(game))attemptBell(1);},1000);
 }
 if(game.turn===1&&game.hands[1].length){
  const seq=game.revision;
  practiceBotTimer=setTimeout(()=>{if(mode==='practice'&&game?.revision===seq&&!pending)handleFlip(1);},1100);
 }
}
function resetGame(){
 clearTimeout(practiceBotTimer);clearTimeout(botBellTimer);pending=null;
 game=C.create();view=snapshot();render();broadcast();scheduleBot();
}
function startPractice(){
 roomPhase='playing';mode='practice';room='';history.replaceState(null,'',location.pathname);
 status('单人练习 · 随时可以重新开始','live');
 showGame();setReady(true);resetGame();toast('练习模式：你和一位电脑对手');
 dom.copy.classList.add('hidden');dom.voice.disabled=true;dom.voiceText.textContent='语音仅限联机';
}
async function loadPeerJS(){
 if(window.Peer)return;
 const sources=[
  'https://cdn.jsdelivr.net/npm/peerjs@1.5.5/dist/peerjs.min.js',
  'https://unpkg.com/peerjs@1.5.5/dist/peerjs.min.js'
 ];
 for(const source of sources){
  try{
   await new Promise((resolve,reject)=>{
    const script=document.createElement('script');script.src=source;script.async=true;
    let finished=false;
    const finish=(error)=>{if(finished)return;finished=true;clearTimeout(timeout);if(error){script.remove();reject(error);}else resolve();};
    const timeout=setTimeout(()=>finish(new Error('加载超时')),8000);
    script.onload=()=>finish(window.Peer?null:new Error('模块不可用'));
    script.onerror=()=>finish(new Error('CDN 无法连接'));
    document.head.appendChild(script);
   });
   return;
  }catch(_){/* try another CDN */}
 }
 throw new Error('实时联机依赖目前不可达，请稍后重试，单人练习仍可用');
}

async function initPeer(){
 status('正在建立连接…');
 try{await loadPeerJS();}catch(e){status('联机依赖不可达','off');toast(e.message+'，可以先玩单人练习');return;}
 const id=mode==='host'?PREFIX+room+'-host':undefined;
 try{peer=id?new Peer(id,{debug:1}):new Peer({debug:1});}
 catch(e){status('连接初始化失败','off');toast(String(e));return;}
 peer.on('open',()=>{
  if(mode==='host'){status('房间已创建 · 等待对方');toast('房间已创建，点“复制邀请”发给朋友');}
  else connectHost();
 });
 peer.on('connection',c=>{
  if(mode!=='host'){c.close();return;}
  if(conn&&conn.open){c.on('open',()=>{c.send({type:'busy'});c.close();});return;}
  attachConnection(c);
 });
 peer.on('call',incoming=>{
  if(mode!=='guest'||!mic||!voiceEnabled||!conn||!conn.open||incoming.peer!==conn.peer){incoming.close();return;}
  if(call)call.close();
  call=incoming;
  bindCall(call);call.answer(mic);
 });
 peer.on('error',err=>{
  if(err?.type==='unavailable-id'&&mode==='host'){status('房间号已被占用','off');toast('请创建新房间');}
  else if(err?.type==='peer-unavailable'&&mode==='guest'){status('房主还没进入房间','off');toast('找不到房主，请等对方创建房间或刷新');}
  else{status('连接暂时失败','off');toast('连接异常：'+(err?.message||'请检查网络'));}
 });
 peer.on('disconnected',()=>{if(mode==='host'||mode==='guest'){status('信令中断，正在恢复…','off');if(!peer.destroyed)peer.reconnect();}});
 peer.on('close',()=>{status('连接已关闭','off');setReady(false);});
}
function connectHost(){
 if(!peer||peer.destroyed)return;
 status('正在等待房主响应…');
 try{const c=peer.connect(PREFIX+room+'-host',{reliable:true,serialization:'json'});attachConnection(c);}catch(e){toast('加入失败：'+e.message);}
}
function attachConnection(c){
 conn=c;
 c.on('open',()=>{
  if(c!==conn){c.close();return;}
  retryCount=0;
  if(mode==='host'){
    setReady(true);seatReady=[false,false];roomPhase='lobby';resetGame();
    status('对方已加入 · 等待准备','live');
    send({type:'welcome',kind:gameKind,state:snapshot(),...roomDetails()});
    broadcastRoom();toast('朋友已经入座！双方准备后开始');

    if(mic&&voiceEnabled)send({type:'voice-ready'});
  }else{
    status('已经连上房主','live');send({type:'hello'});
    if(mic&&voiceEnabled)send({type:'voice-ready'});
  }
  render();
 });
 c.on('data',data=>{if(c===conn)onData(data);});
 c.on('close',()=>{
  if(c!==conn)return;
  conn=null;remoteReady=false;voiceConnected=false;
  if(call){call.close();call=null;}
  setReady(false);
  if(mode==='host'){
    roomPhase='lobby';seatReady=[false,false];
    status('对方离线 · 等待重连','off');
  }
  if(mode==='guest'){
   roomPhase='lobby';seatReady=[false,false];
   status('与房主断开，尝试重连…','off');
   if(++retryCount<=3)setTimeout(()=>{if(mode==='guest'&&peer&&!conn&&peer.open)connectHost();},1200*retryCount);
  }
 });
 c.on('error',()=>{status('数据连接异常','off');});
}
function onData(data){
 if(!data||typeof data!=='object'||typeof data.type!=='string')return;
 if(mode==='host'){
  if(data.type==='hello'){
   send({type:'welcome',kind:gameKind,state:snapshot(),...roomDetails()});
   broadcastRoom();
  }
  if(data.type==='ready'&&roomPhase==='lobby'&&typeof data.value==='boolean'){
   seatReady[1]=data.value;broadcastRoom();render();
  }
  if(data.type==='flip')handleFlip(1);
  if(data.type==='bell')attemptBell(1);
  if(data.type==='switch-request'&&['classic','pan'].includes(data.kind)&&data.kind!==gameKind){
    if(window.confirm('对方提议切换到'+(data.kind==='pan'?'潘神心脏病':'德国心脏病')+'。切换会重开一局，语音继续。要同意吗？'))selectGame(data.kind);
    else send({type:'notice',text:'房主暂时没有切换玩法'});
  }
  if(data.type==='reset-request'){
    if(window.confirm('对方想返回准备房间，重新开始一局。要同意吗？')){
      returnToLobby();toast('已回到准备房间');
    }else send({type:'notice',text:'房主暂时没有重新开局'});
  }
 }else if(mode==='guest'){
  if(data.type==='room-status'){
   if(['classic','pan'].includes(data.kind)&&data.kind!==gameKind)selectGame(data.kind,true);
   if(acceptRoomState(data))render();
  }
  if((data.type==='welcome'||data.type==='state')&&validSnapshot(data.state)){
    if(['classic','pan'].includes(data.kind)&&data.kind!==gameKind)selectGame(data.kind,true);
    acceptRoomState(data);view=data.state;setReady(true);
    status(roomPhase==='playing'?'双方正在游戏中':'双方已入座 · 等待准备','live');
    render();
    if(data.type==='welcome')toast('你已经进入房间，准备好就可以开始啦');
    if(data.type==='state'&&view?.last?.includes('抢铃成功'))playBell();
  }
  if(data.type==='busy'){status('房间已经满了','off');toast('这个房间已有两位玩家');conn?.close();}
  if(data.type==='notice'&&typeof data.text==='string')toast(data.text.slice(0,90));
 }
 if(data.type==='voice-ready'){
  remoteReady=true;remoteVoiceEnabled=true;if(mode==='host')maybeCall();
  updateVoiceUI();renderLobby();
 }
 if(data.type==='voice-status'&&typeof data.enabled==='boolean'){
  remoteVoiceEnabled=data.enabled;renderLobby();
 }
 if(data.type==='voice-off'){remoteReady=false;remoteVoiceEnabled=false;voiceConnected=false;updateVoiceUI();renderLobby();if(call){call.close();call=null;}}
}
function validSnapshot(s){
 return s&&typeof s==='object'&&['playing','ended'].includes(s.phase)&&[0,1].includes(s.turn)&&
 Array.isArray(s.hands)&&s.hands.length===2&&s.hands.every(n=>Number.isInteger(n)&&n>=0&&n<=56)&&
 Array.isArray(s.piles)&&s.piles.length===2&&s.piles.every(p=>p&&Number.isInteger(p.length)&&p.length>=0&&p.length<=56)&&
 typeof s.last==='string'&&s.last.length<250&&Number.isInteger(s.revision);
}
function connectRoom(asHost,code){
 if(mode!=='welcome')return;
 room=code;
 mode=asHost?'host':'guest';
 history.replaceState(null,'',urlOf(room,!asHost));
 showGame();
 if(asHost){roomPhase='lobby';seatReady=[false,false];resetGame();status('创建房间中…');}else status('正在加入房间…');
 initPeer();
}
function bindCall(c){
 c.on('stream',stream=>{
  dom.audio.srcObject=stream;voiceConnected=true;updateVoiceUI();
  const p=dom.audio.play();if(p&&p.catch)p.catch(()=>toast('声音被浏览器阻止，请点击“开启语音”或允许自动播放'));
 });
 c.on('close',()=>{voiceConnected=false;updateVoiceUI();});
 c.on('error',()=>{voiceConnected=false;updateVoiceUI();toast('语音连接失败，可重试或使用其他通话方式');});
}
function maybeCall(){
 if(mode!=='host'||!peer||!conn?.open||!remoteReady||!mic||!voiceEnabled||call)return;
 try{call=peer.call(conn.peer,mic);bindCall(call);}catch(e){toast('语音拨号失败：'+e.message);call=null;}
}
function updateVoiceUI(){
 if(mode==='practice')return;
 if(!mic){dom.micIcon.textContent='♩';dom.voiceText.textContent='开启语音';renderLobby();return;}
 if(!voiceEnabled){dom.micIcon.textContent='⌁';dom.voiceText.textContent='麦克风已静音';renderLobby();return;}
 dom.micIcon.textContent=voiceConnected?'●':'◌';
 dom.voiceText.textContent=voiceConnected?'语音已连接':remoteReady?'正在连接语音':'等待对方开启语音';
 renderLobby();
}
async function toggleVoice(){
 if(mode==='practice'){toast('单人模式没有语音');return;}
 if(openingVoice)return;
 if(mic){
  voiceEnabled=!voiceEnabled;
  mic.getAudioTracks().forEach(track=>track.enabled=voiceEnabled);
  send({type:'voice-status',enabled:voiceEnabled});
  updateVoiceUI();
  toast(voiceEnabled?'麦克风已打开':'麦克风已静音');
  return;
 }
 if(!navigator.mediaDevices?.getUserMedia){toast('浏览器不支持麦克风，请通过 HTTPS 打开');return;}
 openingVoice=true;dom.voice.disabled=true;
 try{
   mic=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false});
   voiceEnabled=true;send({type:'voice-ready'});send({type:'voice-status',enabled:true});updateVoiceUI();
   if(mode==='host')maybeCall();
   toast('麦克风已就绪；双方都点击开启语音后就能通话');
 }catch(e){toast(e?.name==='NotAllowedError'?'未获得麦克风权限，请在浏览器地址栏允许麦克风':'麦克风开启失败：'+(e?.message||''));}
 finally{openingVoice=false;dom.voice.disabled=false;}
}
function doFlip(){
 if(!canAct())return;
 if(mode==='guest')send({type:'flip'});
 else handleFlip(0);
}
function doBell(){
 if(!canAct())return;
 handleBell(selfSeat());
}
function restart(){
 if(mode==='practice'){resetGame();toast('新的一局，开始啦！');}
 else if(mode==='host'){returnToLobby();toast('回到准备房间，双方需要重新准备');}
 else {send({type:'reset-request'});toast('已请求返回准备房间');}
}
async function copyInvite(){
 const link=share();
 try{await navigator.clipboard.writeText(link);toast('已复制邀请链接，发给朋友就能加入');}
 catch(e){window.prompt('复制下面的邀请链接：',link);}
}
function closeRules(){$('rulesModal').classList.add('hidden');}
function showRules(){
 $('classicRules').classList.toggle('hidden',gameKind!=='classic');
 $('panRules').classList.toggle('hidden',gameKind!=='pan');
 $('rulesModal').classList.remove('hidden');
}
dom.host.addEventListener('click',()=>connectRoom(true,randomRoom()));
dom.practice.addEventListener('click',startPractice);
dom.join.addEventListener('click',()=>{
 const code=dom.roomInput.value.trim().toUpperCase();
 if(!ALLOWED.test(code)){toast('请输入 8–12 位房间码（字母或数字）');return;}
 connectRoom(false,code);
});
dom.roomInput.addEventListener('keydown',e=>{if(e.key==='Enter')dom.join.click();});
dom.copy.addEventListener('click',copyInvite);
dom.flip.addEventListener('click',doFlip);
dom.bell.addEventListener('click',doBell);
dom.restart.addEventListener('click',restart);
dom.voice.addEventListener('click',toggleVoice);
$('lobbyVoiceButton').addEventListener('click',toggleVoice);
$('readyButton').addEventListener('click',readyToggle);
$('startButton').addEventListener('click',beginRound);
$('tabClassic').addEventListener('click',()=>requestGame('classic'));
$('tabPan').addEventListener('click',()=>requestGame('pan'));
setInterval(()=>{
 if(gameKind!=='pan'||dom.gameArea.classList.contains('hidden'))return;
 if((mode==='practice'||(mode==='host'&&started&&roomPhase==='playing'))&&game?.phase==='playing'){
  const result=window.PanCore.finish(game);
  if(result.ok){pending=null;apply(result.state);}
 }
 updatePanClock();
},300);
$('helpButton').addEventListener('click',showRules);
$('closeRules').addEventListener('click',closeRules);
$('rulesGotIt').addEventListener('click',closeRules);
$('rulesModal').addEventListener('click',e=>{if(e.target===$('rulesModal'))closeRules();});
window.addEventListener('keydown',e=>{
 if(!$('rulesModal').classList.contains('hidden')){if(e.key==='Escape')closeRules();return;}
 if(dom.gameArea.classList.contains('hidden'))return;
 if(e.target?.tagName==='INPUT'||e.target?.tagName==='TEXTAREA'||e.ctrlKey||e.metaKey||e.altKey)return;
 if(e.code==='Space'){e.preventDefault();if(!e.repeat)doBell();}
 if(e.code==='Enter'){e.preventDefault();if(!e.repeat)doFlip();}
});
window.addEventListener('pagehide',()=>{if(mic)mic.getTracks().forEach(t=>t.stop());if(call)call.close();});
// Designed for no remote-network test injection; never sends raw data via GitHub Pages.
window.__bellDebug={getState:()=>view, getMode:()=>mode, getRoom:()=>({phase:roomPhase,ready:seatReady.slice(),connected:Boolean(conn?.open)}),isFive:()=>Boolean(game&&C.isFive(game))};
const params=new URLSearchParams(location.search);
const code=(params.get('room')||'').toUpperCase();
if(ALLOWED.test(code))connectRoom(params.get('join')!=='1',code);
else if(params.get('practice')==='1')startPractice();
})();