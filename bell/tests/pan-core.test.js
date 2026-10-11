'use strict';
const assert=require('node:assert/strict');
const P=require('../pan-core.js');
let passed=0;
function check(name,fn){fn();passed++;console.log('✓',name);}
function state(){return P.create(()=>.4,0);}
check('54 unique cards including two jokers',()=>{
 const d=P.deck(()=>.5);
 assert.equal(d.length,54);assert.equal(new Set(d.map(x=>x.id)).size,54);
 assert.equal(d.filter(x=>x.rank===0).length,2);
 assert.deepEqual(state().hands.map(x=>x.length),[27,27]);
});
check('rank 7, J/Q/K and jokers trigger immediate bell',()=>{
 for(const rank of [0,7,11,12,13]){
  const g=state();g.piles=[[{rank,suit:'♠'}],[]];
  assert.equal(P.trigger(g).yes,true);
 }
});
check('face-up numeric sum multiple of 7 triggers',()=>{
 for(const [a,b] of [[2,5],[4,10],[1,6]]){
  const g=state();g.piles=[[{rank:a,suit:'♠'}],[{rank:b,suit:'♦'}]];
  assert.equal(P.trigger(g).yes,true);
 }
});
check('non target does not ring',()=>{
 const g=state();g.piles=[[{rank:2,suit:'♠'}],[{rank:3,suit:'♦'}]];
 assert.equal(P.trigger(g).yes,false);
});
check('flip only current player',()=>{
 const g=state();assert.equal(P.flip(g,1,0).ok,false);
 const r=P.flip(g,0,0);assert.equal(r.ok,true);assert.equal(r.state.turn,1);
 assert.equal(r.state.piles[0].length,1);
});
check('correct slap collects entire face-up piles and +2',()=>{
 const g=state();g.piles=[[{rank:7,suit:'♠'}],[{rank:2,suit:'♦'},{rank:4,suit:'♣'}]];
 const r=P.ring(g,0,0);
 assert.equal(r.correct,true);assert.equal(r.state.hands[0].length,30);
 assert.equal(r.state.scores[0],2);assert.deepEqual(r.state.piles,[[],[]]);
});
check('false slap loses one card and -1',()=>{
 const r=P.ring(state(),0,0);
 assert.equal(r.correct,false);assert.equal(r.state.hands[0].length,26);
 assert.equal(r.state.hands[1].length,28);assert.equal(r.state.scores[0],-1);
});
check('time limit uses score as primary tiebreak',()=>{
 const g=state();g.scores=[-1,3];const r=P.finish(g,180001);
 assert.equal(r.state.winner,1);assert.equal(r.state.phase,'ended');
 assert.equal(P.finish(g,1).ok,false);
});
check('elimination overrides score',()=>{
 const g=state();g.hands[1]=[];g.scores=[-100,100];
 g.piles=[[{rank:7,suit:'♠'}],[{rank:2,suit:'♣'}]];
 const r=P.ring(g,0,0);assert.equal(r.state.winner,0);
});
console.log('Pan Heart checks passed:',passed);
