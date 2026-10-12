/* TurtleSoup 房间流程集成测试：模拟房主/客人消息流 + 答案脱敏（与 app.js 一致）。
   运行：node tests/flow.test.js */
'use strict';
const assert=require('assert');
const Core=require('../core.js');

/* 与 app.js 中 sanitize() 完全一致：谜底只在「已结束」时下发客人 */
function sanitize(g){
 const over=g.phase==='solved'||g.phase==='revealed';
 return {phase:g.phase, surface:g.puzzle.surface,
   answer: over?g.puzzle.answer:null,
   messages:g.messages.map(m=>({id:m.id,from:m.from,kind:m.kind,text:m.text,verdict:m.verdict||null})),
   hints:g.hints, solvedBy:g.solvedBy};
}

let pass=0,fail=0;
function t(name,fn){
 try{fn();pass++;console.log('  ✓ '+name);}
 catch(e){fail++;console.error('  ✗ '+name+' → '+e.message);}
}

const PUZZLE={surface:'一个人走进餐厅点海龟汤，喝一口就自杀了。', answer:'他海难中吃过人肉，那碗汤让他意识到吃的是妻子'};

t('房主出题 → 客人视图不含谜底',()=>{
 const game=Core.create(PUZZLE);
 const v=sanitize(game);
 assert.strictEqual(v.surface,PUZZLE.surface);
 assert.strictEqual(v.answer,null,'猜题阶段谜底不可下发');
 assert.strictEqual(v.phase,'guessing');
 assert.strictEqual(v.messages.length,0);
});

t('客人提问 → 房主回答「是」→ 客人可见判定',()=>{
 let game=Core.create(PUZZLE);
 let r=Core.addMessage(game,{from:1,kind:'ask',text:'他喝的是真海龟汤吗？'});
 assert.ok(r.ok);game=r.state;
 const askId=game.messages[0].id;
 r=Core.answerQuestion(game,askId,'yes');assert.ok(r.ok);game=r.state;
 const v=sanitize(game);
 assert.strictEqual(v.messages[0].verdict,'yes','客人能看到房主判定');
 assert.strictEqual(v.messages[0].kind,'ask');
});

t('客人「猜底」→ 房主判中 → 翻牌且谜底下发客人',()=>{
 let game=Core.create(PUZZLE);
 let r=Core.addMessage(game,{from:1,kind:'solve',text:'他当年吃的是妻子的人肉'});
 assert.ok(r.ok);game=r.state;
 const solveId=game.messages[0].id;
 r=Core.markSolved(game,1,true);assert.ok(r.ok);game=r.state;
 assert.strictEqual(game.phase,'solved');
 assert.strictEqual(game.solvedBy,1);
 const v=sanitize(game);
 assert.strictEqual(v.phase,'solved');
 assert.strictEqual(v.answer,PUZZLE.answer,'结束后谜底下发客人');
 assert.strictEqual(v.solvedBy,1);
});

t('客人「猜底」→ 房主判未中 → 阶段不变、谜底仍保密',()=>{
 let game=Core.create(PUZZLE);
 let r=Core.addMessage(game,{from:1,kind:'solve',text:'他中彩票了'});
 assert.ok(r.ok);game=r.state;
 r=Core.markSolved(game,1,false);assert.ok(r.ok);game=r.state;
 assert.strictEqual(game.phase,'guessing','判未中不改变阶段');
 assert.strictEqual(sanitize(game).answer,null,'未结束前仍保密');
});

t('房主直接翻牌 → 阶段 revealed、谜底下发',()=>{
 let game=Core.create(PUZZLE);
 let r=Core.reveal(game);assert.ok(r.ok);game=r.state;
 assert.strictEqual(game.phase,'revealed');
 assert.strictEqual(sanitize(game).answer,PUZZLE.answer);
});

t('房主本地索引为 0，客人按加入顺序 1..n',()=>{
 /* addMessage 的 from 由房主在 fromGuest 中按成员下标填入，引擎不校验下标范围，
    但约定房主=0；这里确认房主自发言 from:0 不破坏 messages 结构 */
 let game=Core.create(PUZZLE);
 let r=Core.addMessage(game,{from:0,kind:'hint',text:'想想海难'});
 assert.ok(r.ok);game=r.state;
 assert.strictEqual(game.messages[0].from,0);
 assert.strictEqual(game.messages[0].kind,'hint');
 assert.strictEqual(game.hints,1);
});

t('进度统计随回答/提示更新',()=>{
 let game=Core.create(PUZZLE);
 game=Core.addMessage(game,{from:1,kind:'ask',text:'问题一？'}).state;
 game=Core.addMessage(game,{from:1,kind:'ask',text:'问题二？'}).state;
 game=Core.addMessage(game,{from:0,kind:'hint',text:'提示'}).state;
 game=Core.answerQuestion(game,game.messages[0].id,'no').state;
 const p=Core.progress(game);
 assert.strictEqual(p.asked,2);assert.strictEqual(p.answered,1);assert.strictEqual(p.hints,1);
 const v=sanitize(game);
 assert.strictEqual(Core.progress(v).asked,2,'脱敏视图仍能统计');
});

console.log('\nTurtleSoup flow: '+pass+' passed, '+fail+' failed');
process.exit(fail?1:0);
