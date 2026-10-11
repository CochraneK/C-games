'use strict';
// Tiny DOM + PeerJS transport simulation. Run: node bell/multi/tests/room.test.js
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const Core=require('../core.js');
const app=fs.readFileSync(path.resolve(__dirname,'../app.js'),'utf8');
let timers=[],network=new Map(),sequence=0,randomCode=0;
const later=fn=>(timers.push(fn),timers.length);
function drain(){let count=0;while(timers.length&&count++<900)timers.shift()();assert.ok(count<900,'timer loop');}
class Events{
 constructor(){this.listeners={};}
 on(k,fn){(this.listeners[k]??=[]).push(fn);}
 emit(k,d){for(const fn of this.listeners[k]??[])fn(d);}
}
class Conn extends Events{
 constructor(peer){super();this.peer=peer;this.open=false;}
 send(data){assert.ok(this.open,'connection open before send');this.twin.emit('data',JSON.parse(JSON.stringify(data)));}
 close(){if(!this.open)return;this.open=false;this.emit('close');if(this.twin.open){this.twin.open=false;this.twin.emit('close');}}
}
class FakePeer extends Events{
 constructor(id){super();this.id=typeof id==='string'?id:'guest-'+(++sequence);this.open=false;this.destroyed=false;this.connections=[];
 network.set(this.id,this);later(()=>{this.open=true;this.emit('open');});}
 connect(id){const remote=network.get(id);assert.ok(remote,'host exists');const a=new Conn(id),b=new Conn(this.id);
 a.twin=b;b.twin=a;this.connections.push(a);later(()=>{remote.emit('connection',b);a.open=b.open=true;b.emit('open');a.emit('open');});return a;}
 reconnect(){}call(){throw Error('voice requires real WebRTC devices; not emulated');}
}
function node(id){
 const classes=new Set(),handlers={};
 return {id,tagName:'BUTTON',textContent:'',innerHTML:'',disabled:false,
  value:id==='capacity'?'4':'',parentElement:{classList:{add(){}}},
  classList:{add:k=>classes.add(k),remove:k=>classes.delete(k),contains:k=>classes.has(k),
   toggle:(k,b)=>b===true?classes.add(k):b===false?classes.delete(k):classes.has(k)?classes.delete(k):classes.add(k)},
  addEventListener:(k,f)=>handlers[k]=f,setAttribute(){},replaceChildren(){},appendChild(){},append(){},remove(){},focus(){},
  click(){handlers.click?.({target:this});}};
}
function page(url,nickname,host=false,capacity=4){
 const nodes=new Map(),$=id=>{if(!nodes.has(id))nodes.set(id,node(id));return nodes.get(id);};
 const win={Peer:FakePeer,MultiBellCore:Core,location:{href:url},confirm:()=>true,prompt:()=>{},addEventListener(){}};
 const doc={getElementById:$,createElement:()=>node('created'),body:node('body'),head:{appendChild(){}}};
 const loc={href:url,search:new URL(url).search,pathname:'/C-games/bell/multi/'};
 const history={replaceState:(a,b,u)=>{win.location.href=String(u);loc.href=String(u);}};
 const nav={clipboard:{writeText:async()=>{}},mediaDevices:{}};
 const crypto={getRandomValues(arr){arr.fill((++randomCode)%24);return arr;}};
 new Function('window','document','location','history','navigator','crypto','setTimeout','clearTimeout','setInterval',
  'URL','URLSearchParams',app)
 (win,doc,loc,history,nav,crypto,later,()=>{},()=>{},URL,URLSearchParams);
 $('nickname').value=nickname;
 $('capacity').value=String(capacity);
 if(host)$('createButton').click();
 else $('joinButton').click();
 return {win,$,get:()=>win.__multiDebug.get()};
}
async function tick(){for(let i=0;i<12;i++){await Promise.resolve();drain();}}
(async()=>{
 const host=page('https://local.test/C-games/bell/multi/','Host',true,4);
 await tick();
 assert.equal(host.get().role,'host');
 assert.equal(host.get().members.length,1);
 host.$('readyButton').click();
 const guests=[];
 for(const name of ['Su','Lee','Kai']){
  const guest=page(host.win.location.href,name);
  guests.push(guest);await tick();
 }
 assert.deepEqual(host.get().members.map(m=>m.name),['Host','Su','Lee','Kai']);
 for(const g of guests)assert.equal(g.get().members.length,4,'roster broadcasts to every guest');
 assert.equal(guests[0].get().members[0].ready,true,'host readiness retained');
 assert.equal(host.$('startButton').disabled,true,'cannot start before guests ready');
 for(const g of guests)g.$('readyButton').click();
 assert.ok(host.get().members.every(m=>m.ready));
 assert.equal(host.$('startButton').disabled,false);
 host.$('startButton').click();
 assert.equal(host.get().phase,'playing');
 for(const g of guests)assert.equal(g.get().phase,'playing');
 const first=host.get().view.revision;host.$('flipButton').click();
 assert.equal(host.get().view.revision,first+1);
 for(const g of guests)assert.equal(g.get().view.revision,first+1);
 guests[0].$('flipButton').click();
 assert.equal(host.get().view.revision,first+2,'guest can act on own turn');
 guests[0].$('resetButton').click();
 assert.equal(host.get().phase,'lobby');
 assert.ok(guests.every(g=>g.get().phase==='lobby'));
 host.$('panTab').click();
 assert.ok(guests.every(g=>g.get().kind==='pan'));
 host.$('readyButton').click();for(const g of guests)g.$('readyButton').click();
 host.$('startButton').click();
 assert.equal(host.get().view.hands.reduce((a,b)=>a+b,0),54);
 assert.ok(guests.every(g=>g.get().view.hands.length===4));
 // Disconnect while playing must return everyone to the lobby.
 const departing=guests[2];
 const leavingId=departing.get().members.find(m=>m.name==='Kai').peerId;
 network.get(leavingId).connections[0].close();await tick();
 assert.equal(host.get().members.length,3,'disconnected player removed');
 assert.equal(host.get().phase,'lobby','host returns to lobby after disconnect');
 assert.ok(guests.slice(0,2).every(g=>g.get().phase==='lobby'),'remaining clients return to lobby');
 assert.ok(host.get().members.every(m=>!m.ready),'readiness reset after disconnection');
 // Create another room and fill all eight slots, then reject the ninth.
 const eight=page('https://local.test/C-games/bell/multi/','Owner',true,8);await tick();
 for(let k=1;k<=7;k++){
  const newcomer=page(eight.win.location.href,'Friend'+k);
  await tick();assert.equal(eight.get().members.length,k+1,'member joined: '+k);
 }
 assert.equal(eight.get().members.length,8,'eight seats occupied');
 const overflow=page(eight.win.location.href,'TooMany');await tick();
 assert.equal(eight.get().members.length,8,'ninth user rejected');
 assert.equal(overflow.get().members.length,0,'rejected guest not given roster');
 console.log('Bell multi room checks: PASS (four nicknames, ready, turn sync, mode switch, disconnect, eight-seat capacity, 54-card Pan).');
})().catch(e=>{console.error(e);process.exitCode=1});
