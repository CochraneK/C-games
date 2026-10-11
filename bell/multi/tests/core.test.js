'use strict';
const assert=require('node:assert/strict');
const C=require('../core.js');
const test=(label,fn)=>{fn();console.log('PASS',label);};
test('Deck counts + distribution for 2 to 8 players',()=>{
 for(let n=2;n<=8;n++)for(let kind of ['classic','pan']){
  const g=C.create(kind,n,()=>.42,0);
  assert.equal(g.hands.length,n);
  assert.equal(g.hands.reduce((a,h)=>a+h.length,0),kind==='classic'?56:54);
  assert.ok(Math.max(...g.hands.map(h=>h.length))-Math.min(...g.hands.map(h=>h.length))<=1);
 }
});
test('Every player's exposed fruits are included',()=>{
 const g=C.create('classic',5,()=>.42,0);
 g.piles=[[{fruit:'banana',count:1}],[],[{fruit:'banana',count:2}],[],[{fruit:'banana',count:2}]];
 assert.equal(C.target(g).yes,true);
 g.piles[4][0].count=3;assert.equal(C.target(g).yes,false);
});
test('Pan sums every numerical face-up card; special triggers',()=>{
 const g=C.create('pan',4,()=>.42,0);
 g.piles=[[{rank:1,suit:'♠'}],[{rank:2,suit:'♥'}],[{rank:4,suit:'♣'}],[]];
 assert.equal(C.target(g).yes,true);g.piles[2][0].rank=5;assert.equal(C.target(g).yes,false);
 g.piles[3].push({rank:11,suit:'♦'});assert.equal(C.target(g).yes,true);
});
test('Flip turn advances, cannot flip out of turn',()=>{
 const g=C.create('classic',8,()=>.42,0);
 assert.equal(C.flip(g,3,0).ok,false);
 const x=C.flip(g,0,0);
 assert.equal(x.ok,true);assert.equal(x.state.turn,1);
});
test('Correct bell collects entire piles',()=>{
 const g=C.create('classic',3,()=>.42,0);
 g.piles=[[{fruit:'lime',count:2}],[{fruit:'lime',count:3}],[{fruit:'plum',count:1}]];
 const before=g.hands[2].length;
 const x=C.ring(g,2,0);
 assert.equal(x.correct,true);
 assert.equal(x.state.hands[2].length,before+3);
 assert.ok(x.state.piles.every(p=>p.length===0));
});
test('False bell passes one card to next active player',()=>{
 const g=C.create('classic',4,()=>.42,0);const lengths=g.hands.map(x=>x.length);
 const x=C.ring(g,0,0);
 assert.equal(x.correct,false);
 assert.equal(x.state.hands[0].length,lengths[0]-1);
 assert.equal(x.state.hands[1].length,lengths[1]+1);
});
test('Pan clock winner based on score',()=>{
 const g=C.create('pan',8,()=>.42,0);g.scores[7]=3;
 assert.equal(C.finish(g,179999).ok,false);
 const r=C.finish(g,180000);
 assert.equal(r.ok,true);assert.equal(r.state.winner,7);
 assert.equal(r.state.phase,'ended');
});
console.log('Multiplayer rule checks passed.');
