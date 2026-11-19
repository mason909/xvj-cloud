// 一次性自检：把前端「编辑器浮层」（窗口名 window_names + 测试背景 window_testcard）的收敛逻辑
// 从 public/index.html 抠出来跑断言（不起服务、不连库、不动数据）。
// 风险全在时序上（连点开关、切房间、写失败），断言只盯：发给谁、带什么、会不会重复/漏发。
const fs = require('fs');
const src = fs.readFileSync(require('path').join(__dirname, 'public/index.html'), 'utf8').replace(/\r\n/g, '\n');

function grab(name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('未找到 ' + name);
  const eol = src.indexOf('\n', i);
  if (src.slice(i, eol).trim().endsWith('}')) return src.slice(i, eol);
  const j = src.indexOf('\n}\n', i);
  if (j < 0) throw new Error('未找到 ' + name + ' 结尾');
  return src.slice(i, j + 2);
}
const names = ['_putWindowOverlays', '_syncWindowOverlays'];

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log('  ok  ' + label); }
  else { fail++; console.log('  XX  ' + label + '\n      got  ' + g + '\n      want ' + w); }
};
const tick = () => new Promise(r => setTimeout(r, 0));

/** 沙箱：假 apiCall 记录每次 PUT，何时成功由测试说了算 */
function mkEnv() {
  const h = { sent: [] };
  const s = { rf: 'room_1', _windowEditorActive: false };
  const apiCall = function (url, opts) {
    const body = JSON.parse(opts.body);
    const rec = { url, cfg: JSON.parse(body.config) };
    h.sent.push(rec);
    return new Promise(function (res, rej) {
      rec.resolve = function (ok, err) {
        ok ? res({ success: true }) : rej(new Error(err || 'HTTP 500'));
      };
    });
  };
  const code = 'var _winOverlayActual = \'\';\nvar _winOverlayBusy = false;\n' + names.map(grab).join('\n');
  const box = {};
  new Function('s', 'apiCall', 'box', code + '\nObject.assign(box,{s:s,sync:_syncWindowOverlays,'
    + 'actual:function(){return _winOverlayActual;},busy:function(){return _winOverlayBusy;}});')(s, apiCall, box);
  box.sent = h.sent;
  box.s = s;
  return box;
}

(async function main() {
  console.log('开关浮层:');
  {
    const E = mkEnv();
    E.sync();
    eq('没开编辑器 → 一个请求都不发', E.sent.length, 0);
    E.s._windowEditorActive = true;
    E.sync();
    await tick();
    eq('开编辑器 → 一次 PUT 同时置 window_names 与 window_testcard（部分 config，服务端继承其余）',
      [E.sent.length, E.sent[0].url, E.sent[0].cfg],
      [1, '/api/rooms/room_1', { window_names: true, window_testcard: true }]);
    E.sent[0].resolve(true);
    await tick();
    E.sync(); E.sync();
    eq('重复重绘不重复发（rmDevice 很勤，一步一脚印就成灾）', E.sent.length, 1);
    E.s._windowEditorActive = false;
    E.sync();
    await tick();
    eq('关编辑器 → 同一间两个键一起置回 false', [E.sent.length, E.sent[1].url, E.sent[1].cfg],
      [2, '/api/rooms/room_1', { window_names: false, window_testcard: false }]);
    E.sent[1].resolve(true);
    await tick();
    eq('收敛后不再多发', E.sent.length, 2);
  }

  console.log('开着编辑器切房间:');
  {
    const E = mkEnv();
    E.s._windowEditorActive = true;
    E.sync();
    await tick();
    E.sent[0].resolve(true);
    await tick();
    E.s.rf = 'room_2';
    E.sync();
    await tick();
    eq('旧间关、新间开（两条都发，各归各房）',
      E.sent.slice(1).map(r => [r.url, r.cfg.window_names, r.cfg.window_testcard]),
      [['/api/rooms/room_1', false, false], ['/api/rooms/room_2', true, true]]);
    E.sent[1].resolve(true);
    E.sent[2].resolve(true);
    await tick();
    eq('新房间成为"以为开着"的那间', E.actual(), 'room_2');
  }

  console.log('连点开关（第一条还在飞）:');
  {
    const E = mkEnv();
    E.s._windowEditorActive = true;
    E.sync();
    await tick();
    eq('第一条已发', E.sent.length, 1);
    E.s._windowEditorActive = false;   // 还没落地就关掉
    E.sync();
    eq('在飞时不抢发第二条（并发两发顺序不可控）', E.sent.length, 1);
    E.sent[0].resolve(true);
    await tick(); await tick();
    eq('落地后按最新意图补一条 false', E.sent.length, 2);
    eq('补的是关指令（两个键都关）', [E.sent[1].cfg.window_names, E.sent[1].cfg.window_testcard], [false, false]);
    E.sent[1].resolve(true);
    await tick();
    eq('最终状态 = 关，不残留"以为开着"', E.actual(), '');
  }

  console.log('写失败:');
  {
    const E = mkEnv();
    E.s._windowEditorActive = true;
    E.sync();
    await tick();
    E.sent[0].resolve(false, '服务端炸了');
    await tick(); await tick();
    eq('失败不记成"已开"（下次重绘要能补）', E.actual(), '');
    E.sync();
    await tick();
    eq('下次重绘自动补发', E.sent.length, 2);
    eq('补的还是开指令', [E.sent[1].cfg.window_names, E.sent[1].cfg.window_testcard], [true, true]);
    E.sent[1].resolve(true);
    await tick();
    eq('补成功后才记', E.actual(), 'room_1');
  }

  console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})();
