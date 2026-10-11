const assert=require('node:assert/strict');
const C=require('../game-core.js');
function test(title,fn){try{fn();console.log('PASS',title)}catch(e){console.error('FAIL',title,e);process.exitCode=1}}
test('full deck: 56 cards, 14 per fruit, exact multiplicity',()=>{
 const deck=C.deck(()=>.314159);
 assert.equal(deck.length,56);
 assert.equal(new Set(deck.map(c=>c.id)).size,56);
 for(const fruit of C.FRUITS){
  assert.equal(deck.filter(c=>c.fruit===fruit).length,14);
  for(let n=1;n<=5;n++)assert.equal(deck.filter(c=>c.fruit===fruit&&c.count===n).length,C.DISTRIBUTION[n-1]);
 }
});
test('state starts split 28/28, no hidden order in snapshot',()=>{
 const g=C.create(()=>.4);
 assert.deepEqual(g.hands.map(h=>h.length),[28,28]);
 const s=C.snapshot(g);
 assert.deepEqual(s.hands,[28,28]);
 assert.equal(JSON.stringify(s).includes('strawberry'),false);
});
test('flip enforces turns and displays only latest face-up card',()=>{
 let g=C.create(()=>.17);
 assert.equal(C.flip(g,1).ok,false);
 const a=C.flip(g,0);assert.equal(a.ok,true);g=a.state;
 assert.equal(g.piles[0].length,1);assert.equal(g.turn,1);
 assert.equal(C.flip(g,0).ok,false);
 g=C.flip(g,1).state;
 assert.equal(g.piles[1].length,1);assert.equal(g.turn,0);
});
test('exactly five valid, four/six invalid and covering can enable 5',()=>{
 const a={id:1,fruit:'banana',count:4},b={id:2,fruit:'banana',count:1},c={id:3,fruit:'banana',count:2};
 const g=C.create();g.piles=[[a],[b]];assert.equal(C.isFive(g),true);
 g.piles=[[a],[c]];assert.equal(C.isFive(g),false);
 g.piles=[[{id:9,fruit:'banana',count:3},a],[b]];assert.equal(C.isFive(g),true);
});
test('correct bell awards face-up piles to winner and increments round',()=>{
 let g=C.create(()=>.25);
 g.piles=[[{id:100,fruit:'banana',count:4}],[{id:102,fruit:'lime',count:2},{id:101,fruit:'banana',count:1}]];
 g.hands=[[{id:103,fruit:'plum',count:1}],[{id:104,fruit:'plum',count:3}]];
 const r=C.ring(g,1);assert.equal(r.correct,true);
 assert.equal(r.state.hands[1].length,4);assert.equal(r.state.piles[0].length,0);assert.equal(r.state.piles[1].length,0);assert.equal(r.state.turn,1);assert.equal(r.state.round,g.round+1);
});
test('false bell transfers exactly one unseen card',()=>{
 const g=C.create(()=>.4);const a=g.hands[0].length,b=g.hands[1].length;
 const r=C.ring(g,0);assert.equal(r.correct,false);
 assert.equal(r.state.hands[0].length,a-1);assert.equal(r.state.hands[1].length,b+1);
 assert.equal(g.hands[0].length,a);
});
test('winner declared when opponent is out after a correct bell',()=>{
 const g=C.create();g.hands=[[],[]];g.piles=[[{id:1,fruit:'lime',count:5}],[]];
 const r=C.ring(g,1);assert.equal(r.state.phase,'ended');assert.equal(r.state.winner,1);
});