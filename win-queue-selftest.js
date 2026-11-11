// 一次性自检：把前端「窗口写库串行队列」从 public/index.html 抠出来跑断言（不起服务、不连库、不动数据）。
// 这块改动的全部风险都在时序上（谁先发、谁后发、排队期间用户切了房间怎么办），所以断言只盯时序。
const fs = require('fs');
const src = fs.readFileSync(require('path').join(__dirname, 'public/index.html'), 'utf8');

function grab(name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('未找到 ' + name);
  // async 关键字在 'function' 前面，不从它起头抠出来的就是个普通函数，里面的 await 直接语法错
  const start = src.slice(i - 6, i) === 'async ' ? i - 6 : i;
  const eol = src.indexOf('\n', start);
  if (src.slice(start, eol).trim().endsWith('}')) return src.slice(start, eol);   // 单行函数
  const j = src.indexOf('\n}\n', i);
  if (j < 0) throw new Error('未找到 ' + name + ' 结尾');
  return src.slice(start, j + 2);
}
const names = ['_winCacheKey', '_setWinCache', '_getWinCache', 'flushAutoSync', 'saveWindows', '_saveWindows'];
// 队列的两个模块级状态自己造（_winSaveTail 是尾巴，_autoSyncTimer 用来模拟"防抖里还压着一次编辑"）
const code = 'var _autoSyncTimer = null;\nvar _winSaveTail = Promise.resolve();\n' + names.map(grab).join('\n');

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log('  ok  ' + label); }
  else { fail++; console.log('  XX  ' + label + '\n      got  ' + g + '\n      want ' + w); }
};
const tick = () => new Promise(r => setTimeout(r, 0));

/** 造一个只有队列逻辑的沙箱：假 fetch 记录每次请求，何时成功由测试说了算 */
function mkEnv() {
  const h = { sent: [], alerts: [], cleared: 0 };   // sent 的顺序就是请求真正抵达服务端的顺序
  const cfgOf = (winsA, winsB) => JSON.stringify({
    scenes: { A: { windows: winsA, master: { brightness: 1 } }, B: { windows: winsB || [] } }
  });
  const s = {
    rf: 'room_1', _curScene: 'A',
    rooms: [{ id: 'room_1', config: cfgOf([{ id: 'w1', name: '一' }]) },
            { id: 'room_2', config: cfgOf([{ id: 'w9', name: '别间的' }]) }],
    _winCache: null, _winKey: null, _selWin: null
  };
  const fetch = function (url, init) {
    const rec = { url, body: JSON.parse(init.body), live: init.body.includes('"live":true') };
    h.sent.push(rec);
    return new Promise(function (res) {
      // 何时"服务端回话"由测试决定 —— 要的就是能把第一条按住、看第二条会不会抢跑
      rec.resolve = function (ok, err) {
        res({ status: ok ? 200 : 500,
              json: () => Promise.resolve(ok ? { success: true } : { success: false, error: err }) });
      };
    });
  };
  const box = {};
  new Function('h', 's', 'document', 'fetch', 'alert', 'clearTimeout',
    code + '\nObject.assign(h,{s:s,saveWindows:saveWindows,_saveWindows:_saveWindows,flushAutoSync:flushAutoSync,'
      + 'setTimer:function(v){_autoSyncTimer=v;},tail:function(){return _winSaveTail;}});'
  )(h, s, { getElementById: () => null }, fetch, msg => h.alerts.push(String(msg)), () => { h.cleared++; });
  h.cfgOf = cfgOf;
  return h;
}

(async function main() {
  console.log('FIFO 与入队定格:');
  {
    const E = mkEnv(), s = E.s;
    const a = E.saveWindows(false);
    s._winCache[0].name = '改后';                 // 入队之后又动了同一个数组
    const b = E.saveWindows(false);
    await tick();                              // 排到队首、真正发出
    eq('连开两写：第二条要等第一条落地才发（交叠=后落的抹掉先落的）', E.sent.length, 1);
    E.sent[0].resolve(true);
    await tick();
    eq('第一条落地的仍是入队那一刻的画面', E.sent[0].body.windows[0].name, '一');
    eq('第二条才带上后续改动', E.sent[1].body.windows[0].name, '改后');
    eq('两条都打在同一个房间', [E.sent[0].url, E.sent[1].url], ['/api/rooms/room_1/windows', '/api/rooms/room_1/windows']);
    E.sent[1].resolve(true);
    await Promise.all([a, b]);
  }

  console.log('失败不卡队列:');
  {
    const E = mkEnv();
    E.saveWindows(false);
    const p2 = E.saveWindows(false);
    await tick();
    E.sent[0].resolve(false, '服务端炸了');
    await tick();
    eq('前一条失败之后后一条照发（尾巴只负责排到我）', E.sent.length, 2);
    eq('失败只报一次警，不静默', E.alerts.length, 1);
    E.sent[1].resolve(true);
    await p2;
  }

  console.log('排队期间切房间:');
  {
    const E = mkEnv(), s = E.s;
    const p = E.saveWindows(false);
    s.rf = 'room_2'; s._winCache = null; s._winKey = null;   // 编辑器已切走（_resetWinEditorState 之后的状态）
    await tick();
    eq('请求照旧发给被编辑的那间（改动是它的，不能改投新房间）', E.sent[0].url, '/api/rooms/room_1/windows');
    E.sent[0].resolve(true);
    await p;
    eq('载荷按发起时那一间定格，不是切走后的新房间', E.sent[0].body.windows[0].id, 'w1');
    eq('被切走的这次不回写内存（room_2 的 config 仍是列表缓存原样）', s.rooms[1].config.includes('w9'), true);
    eq('也不把 room_1 的窗口塞进当前缓存', s._winCache, null);
  }

  console.log('flushAutoSync:');
  {
    const E = mkEnv();
    eq('没编辑也没在飞 → 尾巴已 resolve，await 立刻通过', await E.tail().then(() => 'done'), 'done');
    const p = E.flushAutoSync();
    eq('队列空时 flush 不多发一刀', E.sent.length, 0);
    await p;
    E.setTimer(12345);                       // 模拟防抖里还压着一次编辑
    const p2 = E.flushAutoSync();
    eq('顺手拆掉定时器（免得定时器到点后再发第二刀）', E.cleared, 1);
    await tick();
    eq('防抖中：立即落一条 live 轻推，不等定时器', E.sent.length, 1);
    eq('live 载荷带 live:true', E.sent[0].body.live, true);
    E.sent[0].resolve(true);
    await p2;
    eq('定时器已清 → 不会再自己冒出来', E.sent.length, 1);
  }

  console.log('没选房间:');
  {
    const E = mkEnv();
    E.s.rf = '';
    await E.saveWindows(false);
    eq('无房间 → 一个请求都不发', E.sent.length, 0);
    await E.flushAutoSync();
    eq('无房间时 flush 也不炸', E.sent.length, 0);
  }

  console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})();
