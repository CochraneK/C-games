'use strict';
// Run with: node bell/tests/lobby.test.js
// Simulates two isolated browser pages and a minimal PeerJS data channel.
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const dir=path.resolve(__dirname,'..');
const app=fs.readFileSync(path.join(dir,'app.js'),'utf8');
const BellCore=require('../game-core.js');
const PanCore=require('../pan-core.js');
let scheduled=[], peers=new Map(), counter=0;
function later(cb){scheduled.push(cb);return scheduled.length;}
function flushQueue(){let count=0;while(scheduled.length&&count++<100)scheduled.shift()();assert.ok(count<100,'callback queue overflow');}
class Emitter{
 constructor(){this.handlers={};}
 on(key,cb){(this.handlers[key]??=[]).push(cb);}
 emit(key,arg){for(const f of this.handlers[key]??[])f(arg);}
}
class Link extends Emitter{
 constructor(id){super();this.peer=id;this.open=false;}
 send(message){assert.ok(this.open,'cannot send before connection');this.other.emit('data',JSON.parse(JSON.stringify(message)));}
 close(){if(!this.open)return;this.open=false;this.emit('close');this.other.open=false;this.other.emit('close');}
}
class FakePeer extends Emitter{
 constructor(id){super();this.id=typeof id==='string'?id:'guest'+(++counter);this.open=false;this.destroyed=false;peers.set(this.id,this);later(()=>{this.open=true;this.emit('open');});}
 connect(id){const target=peers.get(id);assert.ok(target,'peer exists');
  const here=new Link(id),there=new Link(this.id);here.other=there;there.other=here;
  later(()=>{target.emit('connection',there);here.open=there.open=true;there.emit('open');here.emit('open');});return here;}
 call(){throw Error('audio is separately verified in real browsers');}
 reconnect(){}
}
function node(id){
 const classes=new Set(),events={};
 return {id,tagName:'BUTTON',value:'',textContent:'',innerHTML:'',disabled:false,
  classList:{add:k=>classes.add(k),remove:k=>classes.delete(k),contains:k=>classes.has(k),
   toggle:(k,forced)=>{if(forced===true)classes.add(k);else if(forced===false)classes.delete(k);else if(classes.has(k))classes.delete(k);else classes.add(k);}},
  addEventListener:(k,cb)=>events[k]=cb,setAttribute(){},replaceChildren(){},appendChild(){},
  click(){events.click?.({target:this});}};
}
function makePage(url){
 const nodes=new Map();const $=id=>{if(!nodes.has(id))nodes.set(id,node(id));return nodes.get(id);};
 const win={Peer:FakePeer,BellCore,PanCore,location:{href:url},confirm:()=>true,addEventListener(){}};
 const doc={getElementById:$,body:node('body'),head:{appendChild(){}},createElement:()=>node('new'),createTextNode:s=>s};
 const location={pathname:'/C-games/bell/',search:new URL(url).search};
 const history={replaceState:(a,b,url)=>{win.location.href=String(url);}};
 const navigator={clipboard:{writeText:async()=>{}},mediaDevices:{}};
 const crypto={getRandomValues:a=>a.fill(1)};
 new Function('window','document','navigator','history','location','setTimeout','clearTimeout',
  'setInterval','crypto','URL','URLSearchParams','Peer',app)
  (win,doc,navigator,history,location,later,()=>{},()=>{},crypto,URL,URLSearchParams,FakePeer);
 return {$,win,room:()=>win.__bellDebug.getRoom(),state:()=>win.__bellDebug.getState()};
}
async function pump(){for(let i=0;i<12;i++){await Promise.resolve();flushQueue();}}
(async()=>{
 const host=makePage('https://test.local/C-games/bell/');
 host.$('hostButton').click();await pump();
 assert.equal(host.room().connected,false);
 assert.equal(host.room().phase,'lobby');
 assert.match(host.win.location.href,/room=/);
 host.$('readyButton').click();
 assert.deepEqual(host.room().ready,[true,false],'host may ready before guest arrives');
 const guest=makePage(host.win.location.href+'&join=1');await pump();
 assert.equal(host.room().connected,true);
 assert.equal(guest.room().connected,true);
 assert.deepEqual(guest.room().ready,[true,false],'host readiness survives guest joining');
 assert.equal(host.$('flipButton').disabled,true,'cannot flip before game starts');
 assert.equal(host.$('startButton').disabled,true,'both must be ready');
 guest.$('readyButton').click();
 assert.deepEqual(host.room().ready,[true,true]);
 assert.equal(host.$('startButton').disabled,false);
 host.$('startButton').click();
 assert.equal(guest.room().phase,'playing');
 const initial=host.state().revision;
 host.$('flipButton').click();
 assert.equal(host.state().revision,initial+1);
 assert.equal(guest.state().revision,initial+1);
 host.$('tabPan').click();
 assert.equal(guest.room().phase,'lobby','switching modes returns both users to lobby');
 assert.deepEqual(guest.room().ready,[false,false]);
 assert.match(guest.$('gameTitle').innerHTML,/潘神/);
 host.$('readyButton').click();guest.$('readyButton').click();host.$('startButton').click();
 assert.equal(host.state().hands[0],27,'Pan uses 54 cards split equally');
 assert.equal(guest.state().hands[1],27);
 guest.$('restartButton').click();
 assert.equal(host.room().phase,'lobby','guest can request returning to lobby');
 assert.equal(guest.room().phase,'lobby');
 console.log('Bell lobby integration: PASS (dual presence, reciprocal ready, start gate, flip sync, mode switch, reset).');
})().catch(e=>{console.error(e);process.exitCode=1});
