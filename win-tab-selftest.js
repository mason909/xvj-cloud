// 一次性自检：把前端「窗口配置」双卡（素材窗 / 点歌窗）的归类与新建逻辑从 public/index.html 抠出来跑断言。
// 只盯三件事：HDMI 归点歌窗、其余归素材窗；切卡时清掉异类选中；「+ 添加」按当前卡给类型与名字编号。
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

const code = grab('_winKind') + '\n' + grab('setWinTab') + '\n' + grab('addWin');
const h = { renders: 0, puts: [] };
const box = {};

/** 沙箱：假 _loadRoomCfg/fetch/render，直接把 addWin 整只函数跑起来 */
function mkEnv(winTab, curScene, wins) {
  const cfg = {
    scenes: {
      A: { windows: curScene === 'A' ? wins : [] },
      B: { windows: curScene === 'B' ? wins : [] }
    }
  };
  const r = { id: 'room_1', config: cfg };
  const s = { rooms: [r], rf: 'room_1', _curScene: curScene, _winTab: winTab, _selWin: null };
  h.renders = 0; h.puts.length = 0;
  const env = {
    s: s,
    _loadRoomCfg: function () { return cfg; },
    _setWinCache: function (w) { s._winCache = w; },
    renderWinEditorFull: function () { h.renders++; },
    fetch: function (url, o) { h.puts.push({ url: url, body: JSON.parse(o.body) }); return Promise.resolve({ ok: true, json: function () { return Promise.resolve({ success: true }); } }); },
    alert: function (m) { throw new Error('不该弹窗: ' + m); },
    window: {},
    _designW: 1920,
    _designH: 1080
  };
  new Function('s', '_loadRoomCfg', '_setWinCache', 'renderWinEditorFull', 'fetch', 'alert', 'window', '_designW', '_designH', 'box',
    'var _winTab;\n' + code + '\nObject.assign(box,{kind:_winKind,setTab:setWinTab,add:addWin});')
    (env.s, env._loadRoomCfg, env._setWinCache, env.renderWinEditorFull, env.fetch, env.alert, env.window, env._designW, env._designH, box);
  box.s = s; box.cfg = cfg;
  return box;
}

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log('  ok  ' + label); }
  else { fail++; console.log('  XX  ' + label + '\n      got  ' + g + '\n      want ' + w); }
};
const tick = () => new Promise(r => setTimeout(r, 0));

(async function main() {
  console.log('归类:');
  {
    mkEnv('material', 'A', []);
    eq('HDMI → 点歌窗', box.kind({ content: { type: 'HDMI' } }), 'video');
    eq('小写 hdmi 也算点歌窗', box.kind({ content: { type: 'hdmi' } }), 'video');
    eq('SCENE_A → 素材窗', box.kind({ content: { type: 'SCENE_A' } }), 'material');
    eq('SCENE_B → 素材窗', box.kind({ content: { type: 'SCENE_B' } }), 'material');
    eq('存量 color → 素材窗', box.kind({ content: { type: 'color' } }), 'material');
    eq('缺 content / 空对象 / null 都不炸，归素材窗',
      [box.kind({}), box.kind(null), box.kind({ content: {} })], ['material', 'material', 'material']);
  }

  console.log('切卡:');
  {
    mkEnv('material', 'A', []);
    box.s._selWin = { id: 'w1', content: { type: 'HDMI' } };
    box.setTab('material');
    eq('从点歌窗选中态切到素材窗 → 选中被清掉（属性栏不能编辑列表看不见的窗）', [box.s._winTab, box.s._selWin], ['material', null]);
    box.s._selWin = { id: 'w1', content: { type: 'SCENE_A' } };
    box.setTab('material');
    eq('同类卡切换保留选中', [box.s._winTab, box.s._selWin && box.s._selWin.id], ['material', 'w1']);
    box.setTab('乱写的值');
    eq('未知值回落素材窗', box.s._winTab, 'material');
    eq('每次切卡都重绘', h.renders, 3);
  }

  console.log('+ 添加（点歌窗卡）:');
  {
    mkEnv('video', 'A', [
      { id: 'a', name: '点歌机', content: { type: 'HDMI' } },
      { id: 'b', name: '点歌屏1', content: { type: 'HDMI' } },
      { id: 'c', name: '点歌屏3', content: { type: 'HDMI' } },
      { id: 'd', name: '新窗口9', content: { type: 'SCENE_A' } }
    ]);
    box.add();
    await tick();
    const w = box.s._winCache[box.s._winCache.length - 1];
    eq('类型固定 HDMI 且默认模式1（与当前幕无关）', w.content, { type: 'HDMI', mode: 1 });
    eq('名字接着同类最大编号（点歌屏4；「点歌机」无编号、素材窗的 9 不参与）', w.name, '点歌屏4');
    eq('只落当前幕、带 sceneId', [box.cfg.scenes.A.windows.length, box.cfg.scenes.B.windows.length, h.puts[0].body.sceneId], [5, 0, 'A']);
    eq('新窗被选中', box.s._selWin && box.s._selWin.name, '点歌屏4');
  }

  console.log('+ 添加（素材窗卡）:');
  {
    mkEnv('material', 'B', [
      { id: 'a', name: '新窗口1', content: { type: 'SCENE_B' } },
      { id: 'b', name: '新窗口2', content: { type: 'SCENE_B' } },
      { id: 'c', name: '点歌屏7', content: { type: 'HDMI' } }
    ]);
    box.add();
    await tick();
    const w = box.s._winCache[box.s._winCache.length - 1];
    eq('B 幕建 SCENE_B 且默认跟随墙板', w.content, { type: 'SCENE_B', follow: true });
    eq('名字接着 新窗口N 编号（点歌屏7 不参与）', w.name, '新窗口3');
    eq('落 B 幕', [box.cfg.scenes.B.windows.length, h.puts[0].body.sceneId], [4, 'B']);
  }

  console.log('+ 添加（素材窗卡、A 幕、无存量同名前缀）:');
  {
    mkEnv('material', 'A', []);
    box.add();
    await tick();
    const w = box.s._winCache[0];
    eq('A 幕 SCENE_A，首个新窗口1', [w.content.type, w.name], ['SCENE_A', '新窗口1']);
  }

  console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})();