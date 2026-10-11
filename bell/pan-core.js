/* Pan Heart — 54-card / two-player adaptation. Host is authoritative. */
(function(root,factory){
 const api=factory(); if(typeof module==='object'&&module.exports)module.exports=api;
 root.PanCore=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
 'use strict';
 const SUITS=['♠','♥','♣','♦'];
 const ROUND_MS=180000;
 function deck(rng=Math.random){
  const cards=[];
  for(const suit of SUITS)for(let rank=1;rank<=13;rank++)cards.push({id:cards.length,rank,suit});
  cards.push({id:52,rank:0,suit:'BLACK'},{id:53,rank:0,suit:'RED'});
  for(let i=cards.length-1;i>0;i--){let j=Math.floor(rng()*(i+1));[cards[i],cards[j]]=[cards[j],cards[i]];}
  return cards;
 }
 function create(rng=Math.random,now=Date.now()){
  const d=deck(rng);
  return {phase:'playing',hands:[d.slice(0,27),d.slice(27)],piles:[[],[]],turn:0,revision:0,
   last:'潘神规则 · 轮到玩家一翻牌',winner:null,round:1,
   scores:[0,0],hits:[0,0],fouls:[0,0],deadline:now+ROUND_MS,endedBy:''};
 }
 function tops(g){return g.piles.map(p=>p.at(-1)||null);}
 function trigger(g){
  const cards=tops(g).filter(Boolean);
  const special=cards.some(c=>c.rank===0||c.rank>=11||c.rank===7);
  const sum=cards.reduce((acc,c)=>acc+(c.rank>=1&&c.rank<=10?c.rank:0),0);
  const multiple=sum>0&&sum%7===0;
  return {yes:special||multiple,special,multiple,sum};
 }
 function isFive(g){return trigger(g).yes;} // API compatibility with original bot scheduler
 function copy(g){return {...g,hands:g.hands.map(x=>x.slice()),piles:g.piles.map(x=>x.slice()),scores:g.scores.slice(),hits:g.hits.slice(),fouls:g.fouls.slice()};}
 function outcome(g,reason){
  g.phase='ended';g.endedBy=reason;
  g.winner=g.scores[0]===g.scores[1]?
   (g.hands[0].length===g.hands[1].length?null:(g.hands[0].length>g.hands[1].length?0:1)):
   (g.scores[0]>g.scores[1]?0:1);
  g.last=reason+' · '+(g.winner===null?'双方平局':'玩家'+(g.winner===0?'一':'二')+'获胜')+
   '（'+g.scores[0]+':'+g.scores[1]+'）';
  return g;
 }
 function finish(input,now=Date.now()){
  if(input.phase!=='playing'||now<input.deadline)return {ok:false,reason:'尚未到结算时间'};
  const g=copy(input);outcome(g,'三分钟到，积分结算');g.revision++;return {ok:true,state:g};
 }
 function snapshot(g){
  return {phase:g.phase,hands:g.hands.map(h=>h.length),
   piles:g.piles.map(p=>({length:p.length,top:p.at(-1)||null})),turn:g.turn,
   revision:g.revision,last:g.last,winner:g.winner,round:g.round,
   scores:g.scores.slice(),hits:g.hits.slice(),fouls:g.fouls.slice(),
   deadline:g.deadline,endedBy:g.endedBy,trigger:trigger(g).yes};
 }
 function flip(input,player,now=Date.now()){
  if(input.phase!=='playing')return {ok:false,reason:'本局已经结束'};
  if(now>=input.deadline)return finish(input,now);
  if(player!==input.turn)return {ok:false,reason:'还没轮到你'};
  if(!input.hands[player].length)return {ok:false,reason:'你手上已经没有可以翻的牌'};
  const g=copy(input),card=g.hands[player].shift();
  g.piles[player].push(card);
  g.turn=g.hands[1-player].length?1-player:player;
  g.revision++;
  g.last='玩家'+(player===0?'一':'二')+'翻牌：'+(card.rank===0?'王':card.rank===1?'A':card.rank===11?'J':card.rank===12?'Q':card.rank===13?'K':card.rank)+
    (card.rank===0?'':card.suit);
  if(!g.hands[0].length&&!g.hands[1].length&&!trigger(g).yes)outcome(g,'两人手牌都已翻完');
  return {ok:true,state:g};
 }
 function ring(input,player,now=Date.now()){
  if(input.phase!=='playing')return {ok:false,reason:'本局已经结束'};
  if(now>=input.deadline)return finish(input,now);
  if(![0,1].includes(player))return {ok:false,reason:'无效玩家'};
  const g=copy(input),correct=trigger(g).yes,other=1-player;
  const name='玩家'+(player===0?'一':'二');
  if(correct){
    const prize=g.piles[0].concat(g.piles[1]);
    g.hands[player].push(...prize);g.piles=[[],[]];
    g.hits[player]++;g.scores[player]+=2;g.turn=player;g.round++;
    g.last='拍中了！'+name+'收走 '+prize.length+' 张牌，+2 分';
    if(!g.hands[other].length)outcome(g,name+'收走对方最后的明牌');
  }else{
    // No need for a 3rd-party dispute referee in the two-player edition.
    // Prefer penalty from hand; if already empty, penalize the own face-up pile.
    const lost=g.hands[player].length?g.hands[player].shift():g.piles[player].shift();
    g.fouls[player]++;g.scores[player]-=1;
    if(lost){g.hands[other].push(lost);g.last=name+'拍错了，赔对方一张牌，−1 分';}
    else{g.last=name+'拍错了，没有可赔的牌，−1 分';}
    if(!g.hands[g.turn].length&&g.hands[other].length)g.turn=other;
    if(!g.hands[player].length&&!g.piles[player].length)outcome(g,name+'已经没有可保留的牌');
  }
  g.revision++;return {ok:true,state:g,correct};
 }
 return {SUITS,ROUND_MS,deck,create,tops,trigger,isFive,snapshot,flip,ring,finish};
});
