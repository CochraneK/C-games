/* Bell Together — deterministic, UI-agnostic rules; distributed game host is authoritative. */
(function(root,factory){
  const api=factory();
  if(typeof module==='object' && module.exports) module.exports=api;
  root.BellCore=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const FRUITS=['strawberry','banana','lime','plum'];
  // Each fruit has 14 cards: 1×5, 2×3, 3×3, 4×2, 5×1 (56 total).
  const DISTRIBUTION=[5,3,3,2,1];
  function deck(rng=Math.random){
    const cards=[];
    FRUITS.forEach(fruit=>DISTRIBUTION.forEach((copies,i)=>{
      for(let c=0;c<copies;c++) cards.push({id:cards.length,fruit,count:i+1});
    }));
    for(let i=cards.length-1;i>0;i--){const j=Math.floor(rng()*(i+1));[cards[i],cards[j]]=[cards[j],cards[i]];}
    return cards;
  }
  function create(rng=Math.random){
    const cards=deck(rng);
    return {phase:'playing',hands:[cards.slice(0,28),cards.slice(28)],piles:[[],[]],turn:0,revision:0,last:'轮到玩家一翻牌',winner:null,round:1};
  }
  function counts(g){
    const c=Object.fromEntries(FRUITS.map(f=>[f,0]));
    g.piles.forEach(p=>{const top=p[p.length-1];if(top)c[top.fruit]+=top.count;});
    return c;
  }
  function isFive(g){return Object.values(counts(g)).some(n=>n===5);}
  function copy(g){return {...g,hands:g.hands.map(h=>h.slice()),piles:g.piles.map(p=>p.slice())};}
  function snapshot(g){
    // No hidden card order leaks over WebRTC; only the host retains the deck.
    return {phase:g.phase,turn:g.turn,hands:g.hands.map(h=>h.length),
      piles:g.piles.map(p=>({length:p.length,top:p.at(-1)||null})),
      revision:g.revision,last:g.last,winner:g.winner,round:g.round};
  }
  function flip(input,player){
    if(input.phase!=='playing')return {ok:false,reason:'本局已经结束'};
    if(player!==input.turn)return {ok:false,reason:'还没轮到你翻牌'};
    if(!input.hands[player].length)return {ok:false,reason:'没有可翻的牌'};
    const g=copy(input);
    const card=g.hands[player].shift();
    g.piles[player].push(card);
    const next=1-player;
    g.turn=g.hands[next].length?next:player;
    g.revision++;
    g.last=`玩家${player===0?'一':'二'}翻了一张牌`;
    if(!g.hands[0].length&&!g.hands[1].length){
      // If neither player can flip, compare card holdings to avoid a deadlock.
      if(!isFive(g)){g.phase='ended';g.winner=g.piles[0].length===g.piles[1].length?null:(g.piles[0].length>g.piles[1].length?0:1);g.last='双方牌堆均已翻完，按剩余牌数结算';}
    }
    return {ok:true,state:g};
  }
  function ring(input,player){
    if(input.phase!=='playing')return {ok:false,reason:'本局已经结束'};
    if(player!==0&&player!==1)return {ok:false,reason:'无效玩家'};
    const g=copy(input);
    const correct=isFive(g);
    if(correct){
      const prize=[...g.piles[0],...g.piles[1]];
      g.hands[player].push(...prize);
      g.piles=[[],[]];
      g.turn=player;
      g.round++;
      g.last=`叮！玩家${player===0?'一':'二'}抢铃成功，收走 ${prize.length} 张牌`;
      if(g.hands[1-player].length===0){g.phase='ended';g.winner=player;g.last+= ' · 获胜！';}
    }else{
      const other=1-player;
      if(g.hands[player].length){
        g.hands[other].push(g.hands[player].shift());
        g.last=`玩家${player===0?'一':'二'}误按铃铛，交给对方 1 张牌`;
      }else{
        g.last=`玩家${player===0?'一':'二'}无牌可罚，判负`;
        g.phase='ended';g.winner=other;
      }
      if(g.phase==='playing'&&!g.hands[g.turn].length&&g.hands[other].length)g.turn=other;
    }
    g.revision++;
    return {ok:true,state:g,correct};
  }
  return {FRUITS,DISTRIBUTION,deck,create,counts,isFive,snapshot,flip,ring};
});