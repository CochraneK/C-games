/* C-games / Turtle Soup（海龟汤）: 对话式情境猜谜的纯规则核心。
   与网络层解耦，浏览器里挂 window.TurtleCore，node 里 module.exports，方便单测。 */
(function(root,factory){
 'use strict';
 const api=factory();
 if(typeof module==='object'&&module.exports)module.exports=api;
 root.TurtleCore=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
 'use strict';
 const MIN_PLAYERS=2, MAX_PLAYERS=8;
 /* 房主对「提问」的三种标准回答 */
 const VERDICTS=['yes','no','na'];           // 是 / 不是 / 与此无关
 const MAX_TEXT=400;
 const KINDS=['ask','say','answer','hint','system','solve'];

 function cleanText(s){
  return String(s==null?'':s).replace(/[\x00-\x1f\x7f]+/g,'').replace(/\s+/g,' ').trim().slice(0,MAX_TEXT);
 }

 /* 房主出题校验：汤面要能立住一个情境，谜底不能空 */
 function validatePuzzle(p){
  const rawSurface=String(p&&p.surface==null?'':p.surface);
  const rawLen=rawSurface.replace(/\s+/g,'').length;
  const surface=cleanText(rawSurface), answer=cleanText(p&&p.answer);
  const errors=[];
  if(rawLen<4) errors.push('汤面太短（至少 4 个字）');
  if(rawLen>MAX_TEXT) errors.push('汤面过长');
  if(!answer) errors.push('谜底不能为空');
  return {ok:errors.length===0, errors:errors, puzzle:{surface:surface, answer:answer}};
 }

 function create(puzzle, now){
  const v=validatePuzzle(puzzle);
  if(!v.ok) throw Error(v.errors.join('；'));
  return {phase:'guessing', puzzle:v.puzzle, messages:[], solvedBy:null, hints:0,
          createdAt:now||Date.now()};
 }
 function copy(s){
  return {phase:s.phase, puzzle:{surface:s.puzzle.surface, answer:s.puzzle.answer},
          messages:s.messages.map(m=>({id:m.id, from:m.from, kind:m.kind, text:m.text,
            verdict:m.verdict||null, ts:m.ts})),
          solvedBy:s.solvedBy==null?null:s.solvedBy, hints:s.hints, createdAt:s.createdAt};
 }

 /* 追加一条对话。kind 决定它是什么：ask=提问（可被房主回答）、say=闲聊/陈述、
    answer=房主回答、hint=提示、system=系统消息（无需正文）、solve=猜底宣言 */
 function addMessage(s,msg){
  if(s.phase!=='guessing') return {ok:false, reason:'本局已结束'};
  let kind=KINDS.indexOf(msg.kind)>=0?msg.kind:'say';
  const text=cleanText(msg.text);
  if(kind!=='system'&&!text) return {ok:false, reason:'内容不能为空'};
  if(kind==='answer'&&VERDICTS.indexOf(msg.verdict)<0) return {ok:false, reason:'回答缺少判定'};
  const n=copy(s);
  n.messages.push({id:n.messages.length?n.messages[n.messages.length-1].id+1:1,
    from:msg.from, kind:kind, text:text, verdict:msg.verdict||null, ts:msg.ts||Date.now()});
  if(kind==='hint') n.hints++;
  return {ok:true, state:n};
 }

 /* 房主回答某条提问。只有 kind==='ask' 且尚未被回答过的问题能答 */
 function answerQuestion(s,msgId,verdict){
  if(s.phase!=='guessing') return {ok:false, reason:'本局已结束'};
  if(VERDICTS.indexOf(verdict)<0) return {ok:false, reason:'无效判定'};
  const n=copy(s), m=n.messages.find(x=>x.id===msgId);
  if(!m) return {ok:false, reason:'找不到这条消息'};
  if(m.kind!=='ask') return {ok:false, reason:'只能回答「提问」'};
  if(m.verdict) return {ok:false, reason:'这条已经回答过了'};
  m.verdict=verdict;
  return {ok:true, state:n};
 }

 /* 猜中 / 未猜中。correct=true 时翻牌并记下猜中者 */
 function markSolved(s,playerIdx,correct){
  if(s.phase!=='guessing') return {ok:false, reason:'本局已结束'};
  const n=copy(s);
  if(correct){ n.phase='solved'; n.solvedBy=playerIdx; }
  return {ok:true, state:n};
 }

 /* 房主直接翻牌（不猜中也公布） */
 function reveal(s){
  if(s.phase!=='guessing') return {ok:false, reason:'本局已结束'};
  const n=copy(s); n.phase='revealed'; n.solvedBy=null;
  return {ok:true, state:n};
 }

 function progress(s){
  const asked=s.messages.filter(m=>m.kind==='ask');
  return {asked:asked.length, answered:asked.filter(m=>m.verdict).length,
          hints:s.hints, total:s.messages.length};
 }
 function verdictLabel(v){ return v==='yes'?'是':v==='no'?'不是':v==='na'?'与此无关':''; }
 function kindLabel(k){
  return k==='ask'?'提问':k==='say'?'闲聊':k==='answer'?'房主回答':k==='hint'?'提示':k==='solve'?'猜底':'系统';
 }

 /* 猜底粗校验：清掉空白与常见标点后比对，命中关键词即算沾边（给房主做参考，不替房主裁决） */
function guessMatch(guess, answer){
 const norm=x=>String(x||'').replace(/[\s，。！？、,.!?~～的了的吧呀吗呢哦]+/g,'');
 const g=norm(guess), a=norm(answer);
 if(!g||!a) return false;
 if(g===a) return true;
 if(g.length>=2 && g.length<=a.length){
   const set=new Set(a.split(''));
   let hit=0; for(const ch of g.split('')) if(set.has(ch)) hit++;
   if(hit===g.length) return true; // 全部实词命中，允许错序/分散
 }
 return a.indexOf(g)>=0;
}

 return {MIN_PLAYERS:MIN_PLAYERS, MAX_PLAYERS:MAX_PLAYERS, VERDICTS:VERDICTS, KINDS:KINDS,
   MAX_TEXT:MAX_TEXT, cleanText:cleanText, validatePuzzle:validatePuzzle, create:create,
   copy:copy, addMessage:addMessage, answerQuestion:answerQuestion, markSolved:markSolved,
   reveal:reveal, progress:progress, verdictLabel:verdictLabel, kindLabel:kindLabel,
   guessMatch:guessMatch};
});
