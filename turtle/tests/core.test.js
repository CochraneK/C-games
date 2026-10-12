/* TurtleSoup 核心规则单测（node tests/core.test.js） */
'use strict';
const assert=require('assert');
const Core=require('../core.js');

let pass=0, fail=0;
function t(name,fn){
 try{ fn(); pass++; console.log('  ✓ '+name); }
 catch(e){ fail++; console.error('  ✗ '+name+' → '+e.message); }
}

const PUZZLE={surface:'一个男人走进餐厅点了一碗海龟汤，喝了一口就回家自杀了。', answer:'他曾在海难中吃过人肉，那碗汤让他意识到当年吃的是妻子'};

t('出题校验：汤面太短被拒', ()=>{
 const v=Core.validatePuzzle({surface:'短', answer:'谜底'});
 assert.ok(!v.ok && v.errors.length>0);
});
t('出题校验：谜底为空被拒', ()=>{
 const v=Core.validatePuzzle({surface:'这是一个足够长的汤面内容', answer:'  '});
 assert.ok(!v.ok);
});
t('出题校验：合法题目通过并清洗空白', ()=>{
 const v=Core.validatePuzzle({surface:'  汤面内容在这里  ', answer:' 谜底在这里 '});
 assert.ok(v.ok);
 assert.strictEqual(v.puzzle.surface,'汤面内容在这里');
 assert.strictEqual(v.puzzle.answer,'谜底在这里');
});
t('create 后进入猜题阶段且消息为空', ()=>{
 const s=Core.create(PUZZLE);
 assert.strictEqual(s.phase,'guessing');
 assert.strictEqual(s.messages.length,0);
});
t('addMessage：提问可追加，空内容被拒', ()=>{
 let s=Core.create(PUZZLE);
 let r=Core.addMessage(s,{from:1,kind:'ask',text:'他为什么自杀？'});
 assert.ok(r.ok); s=r.state;
 assert.strictEqual(s.messages.length,1);
 assert.strictEqual(s.messages[0].kind,'ask');
 assert.strictEqual(s.messages[0].id,1);
 r=Core.addMessage(s,{from:1,kind:'ask',text:'   '});
 assert.ok(!r.ok);
});
t('answerQuestion：只能回答提问，且不能重复回答', ()=>{
 let s=Core.create(PUZZLE);
 s=Core.addMessage(s,{from:1,kind:'ask',text:'他喝的是真海龟汤吗？'}).state;
 s=Core.addMessage(s,{from:1,kind:'say',text:'我猜和他妻子有关'}).state;
 const askId=s.messages[0].id, sayId=s.messages[1].id;
 assert.ok(!Core.answerQuestion(s,sayId,'yes').ok, '闲聊不能被回答');
 const r=Core.answerQuestion(s,askId,'yes'); assert.ok(r.ok); s=r.state;
 assert.strictEqual(s.messages[0].verdict,'yes');
 assert.ok(!Core.answerQuestion(s,askId,'no').ok, '已回答过不能改');
});
t('answerQuestion：无效判定被拒', ()=>{
 const s=Core.create(PUZZLE);
 const s2=Core.addMessage(s,{from:1,kind:'ask',text:'问题？'}).state;
 assert.ok(!Core.answerQuestion(s2,s2.messages[0].id,'maybe').ok);
});
t('markSolved：猜中后翻牌并记录猜中者', ()=>{
 let s=Core.create(PUZZLE);
 const r=Core.markSolved(s,1,true);
 assert.ok(r.ok); s=r.state;
 assert.strictEqual(s.phase,'solved');
 assert.strictEqual(s.solvedBy,1);
 assert.ok(!Core.addMessage(s,{from:0,kind:'say',text:'还能说吗'}).ok, '结束后不能再加消息');
});
t('markSolved：猜错不改变阶段', ()=>{
 const s=Core.create(PUZZLE);
 const r=Core.markSolved(s,1,false);
 assert.ok(r.ok && r.state.phase==='guessing' && r.state.solvedBy===null);
});
t('reveal：房主可直接翻牌', ()=>{
 const s=Core.create(PUZZLE);
 const r=Core.reveal(s);
 assert.ok(r.ok && r.state.phase==='revealed');
});
t('progress：统计提问数/已回答数/提示数', ()=>{
 let s=Core.create(PUZZLE);
 s=Core.addMessage(s,{from:1,kind:'ask',text:'问题一？'}).state;
 s=Core.addMessage(s,{from:1,kind:'ask',text:'问题二？'}).state;
 s=Core.addMessage(s,{from:0,kind:'hint',text:'想想海难'}).state;
 s=Core.answerQuestion(s,s.messages[0].id,'no').state;
 const p=Core.progress(s);
 assert.strictEqual(p.asked,2); assert.strictEqual(p.answered,1); assert.strictEqual(p.hints,1);
});
t('guessMatch：命中/包含/无关', ()=>{
 assert.ok(Core.guessMatch('他吃过人肉','他曾在海难中吃过人肉'));
 assert.ok(Core.guessMatch('他曾在海难中吃过人肉','他曾在海难中吃过人肉'));
 assert.ok(!Core.guessMatch('他中彩票了','他曾在海难中吃过人肉'));
 assert.ok(!Core.guessMatch('','谜底'));
});
t('copy 是深拷贝：改副本不影响原件', ()=>{
 const s=Core.create(PUZZLE);
 const n=Core.copy(s);
 n.messages.push({id:1,from:1,kind:'ask',text:'x',verdict:null,ts:1});
 n.puzzle.answer='被改了';
 assert.strictEqual(s.messages.length,0);
 assert.strictEqual(s.puzzle.answer,PUZZLE.answer);
});
t('文本清洗：控制字符与超长截断', ()=>{
 const v=Core.validatePuzzle({surface:'汤面'.padEnd(500,'啊'), answer:'谜底'});
 assert.ok(!v.ok && /过长/.test(v.errors.join()));
 const c=Core.cleanText('a\u0000b\u001fc   d');
 assert.strictEqual(c,'abc d');
});

console.log('\nTurtleSoup core: '+pass+' passed, '+fail+' failed');
process.exit(fail?1:0);
