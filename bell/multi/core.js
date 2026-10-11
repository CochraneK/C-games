/* C-games / Bell Multiplayer: host-authoritative 2–8 player rules. */
(function(root,factory){
 'use strict';const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;root.MultiBellCore=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
 'use strict';
 const MIN_PLAYERS=2, MAX_PLAYERS=8, ROUND_MS=180000;
 const FRUITS=['strawberry','banana','lime','plum'],COPIES=[5,3,3,2,1],SUITS=['♠','♥','♣','♦'];
 function deck(kind,rng=Math.random){
  let out=[];
  if(kind==='classic')for(const fruit of FRUITS)COPIES.forEach((n,i)=>{for(let j=0;j<n;j++)out.push({id:out.length,fruit,count:i+1});});
  else if(kind==='pan'){
   for(const suit of SUITS)for(let rank=1;rank<=13;rank++)out.push({id:out.length,rank,suit});
   out.push({id:52,rank:0,suit:'BLACK'},{id:53,rank:0,suit:'RED'});
  }else throw Error('Invalid game kind');
  for(let i=out.length-1;i>0;i--){const j=Math.floor(rng()*(i+1));[out[i],out[j]]=[out[j],out[i]];}
  return out;
 }
 function create(kind,n,rng=Math.random,now=Date.now()){
  if(!Number.isInteger(n)||n<MIN_PLAYERS||n>MAX_PLAYERS)throw Error('Players must be 2 to 8');
  const cards=deck(kind,rng),hands=Array.from({length:n},()=>[]);
  cards.forEach((card,i)=>hands[i%n].push(card));
  return {kind,phase:'playing',hands,piles:Array.from({length:n},()=>[]),
   scores:Array(n).fill(0),hits:Array(n).fill(0),fouls:Array(n).fill(0),
   turn:0,revision:0,winner:null,round:1,last:'轮到第 1 位玩家翻牌',
   deadline:kind==='pan'?now+ROUND_MS:null,endedBy:null};
 }
 function copy(g){return {...g,hands:g.hands.map(h=>h.slice()),piles:g.piles.map(p=>p.slice()),
 scores:g.scores.slice(),hits:g.hits.slice(),fouls:g.fouls.slice()};}
 function isActive(g,i){return g.hands[i].length+g.piles[i].length>0;}
 function active(g){return g.hands.map((h,i)=>isActive(g,i)?i:-1).filter(i=>i>=0);}
 function nextTurn(g,from){for(let step=1;step<=g.hands.length;step++){const i=(from+step)%g.hands.length;if(g.hands[i].length)return i;}return null;}
 function tops(g){return g.piles.map(p=>p.length?p[p.length-1]:null);}
 function target(g){
  const visible=tops(g).filter(Boolean);
  if(g.kind==='classic'){
   const counts=Object.fromEntries(FRUITS.map(x=>[x,0]));
   visible.forEach(c=>{counts[c.fruit]+=c.count;});
   return {yes:Object.values(counts).some(n=>n===5),counts};
  }
  const special=visible.some(c=>c.rank===0||c.rank===7||c.rank>=11);
  const sum=visible.reduce((s,c)=>s+(c.rank>=1&&c.rank<=10?c.rank:0),0);
  return {yes:special||(sum>0&&sum%7===0),sum,special};
 }
 function finishWinner(g,reason){
  const players=active(g);
  if(players.length===1){g.winner=players[0];g.endedBy='last-standing';}
  else{
   const metrics=g.hands.map((h,i)=>({i,score:g.kind==='pan'?g.scores[i]:h.length+g.piles[i].length,
     cards:h.length+g.piles[i].length}));
   metrics.sort((a,b)=>b.score-a.score||b.cards-a.cards);
   const best=metrics[0],rivals=metrics.filter(x=>x.score===best.score&&x.cards===best.cards);
   g.winner=rivals.length===1?best.i:null;g.endedBy=reason;
  }
  g.phase='ended';
  g.last=reason+' · '+(g.winner===null?'平局':'第 '+(g.winner+1)+' 位玩家胜出');
  return g;
 }
 function finish(g,now=Date.now()){
  if(g.phase!=='playing'||g.deadline===null||now<g.deadline)return {ok:false,reason:'尚未到结算时刻'};
  const newG=copy(g);finishWinner(newG,'时间到，积分结算');newG.revision++;return {ok:true,state:newG};
 }
 function snapshot(g){return {kind:g.kind,phase:g.phase,turn:g.turn,
   hands:g.hands.map(x=>x.length),piles:g.piles.map(p=>({length:p.length,top:p.at(-1)||null})),
   scores:g.scores.slice(),hits:g.hits.slice(),fouls:g.fouls.slice(),
   revision:g.revision,winner:g.winner,round:g.round,last:g.last,deadline:g.deadline,endedBy:g.endedBy};}
 function flip(g,player,now=Date.now()){
  if(g.phase!=='playing')return {ok:false,reason:'本局已结束'};
  if(g.deadline!==null&&now>=g.deadline)return finish(g,now);
  if(player!==g.turn)return {ok:false,reason:'还没轮到你'};
  if(!g.hands[player]?.length)return {ok:false,reason:'没有可翻的牌'};
  const n=copy(g),card=n.hands[player].shift();n.piles[player].push(card);n.revision++;
  const next=nextTurn(n,player);
  if(next===null){if(!target(n).yes)finishWinner(n,'所有手牌均已翻完');}
  else n.turn=next;
  n.last=n.phase==='ended'?n.last:'第 '+(player+1)+' 位玩家翻了一张牌';
  return {ok:true,state:n};
 }
 function ring(g,player,now=Date.now()){
  if(g.phase!=='playing')return {ok:false,reason:'本局已结束'};
  if(!Number.isInteger(player)||player<0||player>=g.hands.length||!isActive(g,player))return {ok:false,reason:'当前玩家不可抢铃'};
  if(g.deadline!==null&&now>=g.deadline)return finish(g,now);
  const n=copy(g),correct=target(n).yes;
  if(correct){
   const prize=n.piles.flat();n.piles=n.piles.map(()=>[]);
   n.hands[player].push(...prize);
   n.scores[player]+=n.kind==='pan'?2:prize.length;
   n.hits[player]++;n.round++;
   n.turn=player;n.last='第 '+(player+1)+' 位玩家抢中，获得 '+prize.length+' 张牌';
  }else{
   const recipient=Array.from({length:n.hands.length-1},(_,i)=>(player+i+1)%n.hands.length)
     .find(i=>isActive(n,i));
   const lost=n.hands[player].length?n.hands[player].shift():n.piles[player].shift();
   if(lost&&recipient!==undefined)n.hands[recipient].push(lost);
   n.fouls[player]++;n.scores[player]-=1;
   n.last='第 '+(player+1)+' 位玩家误拍'+(lost?'，赔下一位在场玩家 1 张牌':'，没有牌可赔');
   if(!n.hands[n.turn]?.length){const next=nextTurn(n,n.turn);if(next!==null)n.turn=next;}
  }
  if(active(n).length<=1)finishWinner(n,'只剩一位玩家持牌');
  n.revision++;return {ok:true,state:n,correct};
 }
 return {MIN_PLAYERS,MAX_PLAYERS,ROUND_MS,FRUITS,COPIES,SUITS,deck,create,target,tops,snapshot,flip,ring,finish,active};
});