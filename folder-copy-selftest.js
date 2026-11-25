// 一次性自检：素材页「复制到房间」（copyFolderAll + _runFolderCopy）。
// 风险全在「整份 config PUT」：只准写弹窗里勾中的房间、只准写当前幕当前文件夹那一格；
// 完全同步语义 = 目标这一格整体替换（含清空），其它文件夹/幕/店铺一律不碰。
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, 'public/index.html'), 'utf8').replace(/\r\n/g, '\n');

const start = src.indexOf('// 文件夹级「复制到房间」');
if (start < 0) throw new Error('未找到 copyFolderAll 区块');
const end = src.indexOf('// 【F-08b】', start);
if (end < 0) throw new Error('未找到 【F-08b】 边界');
const block = src.slice(start, end);

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log('  ok  ' + label); }
  else { fail++; console.log('  XX  ' + label + '\n      got  ' + g + '\n      want ' + w); }
};

function mkCfg(o) { return JSON.stringify(o); }
function loadRoomCfg(r) {
  var c = {};
  try { c = r.config ? (typeof r.config === 'string' ? JSON.parse(r.config) : r.config) : {}; } catch (e) {}
  if (!c.scenes) c.scenes = {};
  ['A', 'B'].forEach(function (k) {
    if (!c.scenes[k] || typeof c.scenes[k] !== 'object') c.scenes[k] = { name: k === 'A' ? '第一幕' : '第二幕', folder_mappings: {}, windows: [], master: { brightness: 1 } };
    var sc = c.scenes[k];
    if (!sc.folder_mappings || typeof sc.folder_mappings !== 'object') sc.folder_mappings = {};
    if (!Array.isArray(sc.windows)) sc.windows = [];
    if (!sc.master || typeof sc.master !== 'object') sc.master = { brightness: 1 };
  });
  return c;
}

function mkEnv(opts) {
  opts = opts || {};
  const rooms = opts.rooms || {};
  const storeList = opts.storeList || ['cur', 'r2', 'r3'];
  const env = {
    alerts: [], puts: [], logs: [], gets: [], picked: null,
    s: { rf: opts.rf || 'cur', f: opts.f === undefined ? '03' : opts.f, _curScene: opts.scene || 'A', rooms: [{ id: opts.rf || 'cur', name: '201', store_name: opts.store || 'S' }] }
  };
  const apiGet = async function (url) {
    env.gets.push(url);
    if (url === '/api/rooms?store=' + encodeURIComponent(opts.store || 'S')) {
      return storeList.map(id => ({ id: id, name: id === 'cur' ? '201' : id }));
    }
    const m = /^\/api\/rooms\/([^?]+)$/.exec(url);
    if (m) {
      const id = decodeURIComponent(m[1]);
      if (opts.failGet && opts.failGet.indexOf(id) >= 0) throw new Error('HTTP 500');
      const r = rooms[id];
      if (!r) return { error: '房间不存在' };
      return JSON.parse(JSON.stringify(r));
    }
    throw new Error('unexpected GET ' + url);
  };
  const apiCall = async function (url, init) {
    env.puts.push({ url: url, cfg: JSON.parse(JSON.parse(init.body).config) });
    return { ok: true };
  };
  const envApi = {
    apiGet: apiGet,
    apiCall: apiCall,
    asList: function (x) { return Array.isArray(x) ? x : []; },
    flushAutoSync: async function () {},
    _loadRoomCfg: loadRoomCfg,
    esc: function (x) { return String(x); },
    alert: function (m) { env.alerts.push(m); },
    // 勾选弹窗的替身：记下候选，再按 opts.pick 决定回调收到哪几间；pickCancel 模拟取消（不回调）
    pickRoomsModal: function (title, list, note, okText, cb) {
      env.picked = list.map(r => r.id);
      if (opts.pickCancel) return;
      const want = opts.pick === undefined ? env.picked : opts.pick;
      cb(list.filter(r => want.indexOf(r.id) >= 0));
    },
    document: { getElementById: function () { return { disabled: false, textContent: '' }; } },
    lr: function () { env._lr = (env._lr || 0) + 1; },
    logAction: function (a, t, d) { env.logs.push({ action: a, data: d }); }
  };
  const api = new Function('apiGet', 'apiCall', 'asList', 'flushAutoSync', '_loadRoomCfg', 'esc', 'alert', 'pickRoomsModal', 'document', 'lr', 'logAction', 's', block + '\nreturn {copyFolderAll: copyFolderAll};')(
    envApi.apiGet, envApi.apiCall, envApi.asList, envApi.flushAutoSync, envApi._loadRoomCfg,
    envApi.esc, envApi.alert, envApi.pickRoomsModal, envApi.document, envApi.lr, envApi.logAction, env.s
  );
  env.copy = api.copyFolderAll;
  return env;
}

function room(o) { return { id: o.id, name: o.id, store_name: 'S', config: mkCfg({ scenes: o.scenes, wallpanel_enabled: true, output: { w: 1920, h: 1080 } }) }; }

// 勾选弹窗的回调 copyFolderAll 不等待（真机上是点「开始复制」之后才继续）：桩里同步触发后，
// 落库那条链还挂在微任务上，转一圈宏任务再断言，否则只会看到第一间写完。
const run = async (env) => { await env.copy(); await new Promise(r => setTimeout(r, 0)); };

(async function() {
  // 静态锚点
  eq('按钮已接入工具条', /id="folderCopyBtn"[^>]*onclick="copyFolderAll\(\)"/.test(src), true);
  eq('按钮改名为「复制到房间」', /onclick="copyFolderAll\(\)">复制到房间<\/button>/.test(src), true);
  eq('按钮带完全同步提示', /完全同步：多删少补/.test(src), true);
  eq('复制前先弹房间勾选框', /pickRoomsModal\(/.test(block), true);

  // 1) 正常替换：只动 A/03，其它格与 B 幕、其它键都保留
  let env = mkEnv({
    rooms: {
      cur: room({ id: 'cur', scenes: { A: { folder_mappings: { '03': ['m1', 'm2'], '04': ['c4'] }, windows: [{ id: 'wA' }] }, B: { folder_mappings: { '03': ['bx'] } } } }),
      r2: room({ id: 'r2', scenes: { A: { folder_mappings: { '03': ['old1', 'old2', 'old3'], '04': ['k4'] }, windows: [{ id: 'w2' }] }, B: { folder_mappings: { '03': ['b1'] } } } }),
      r3: room({ id: 'r3', scenes: { A: { folder_mappings: {} }, B: { folder_mappings: {} } } })
    }
  });
  await run(env);
  eq('候选房间不含当前房间', env.picked, ['r2', 'r3']);
  eq('只 PUT 其余两间', env.puts.map(p => p.url).sort(), ['/api/rooms/r2', '/api/rooms/r3']);
  const p2 = env.puts.find(p => p.url === '/api/rooms/r2').cfg;
  eq('r2 的 03 完全替换', p2.scenes.A.folder_mappings['03'], ['m1', 'm2']);
  eq('r2 的 04 不动', p2.scenes.A.folder_mappings['04'], ['k4']);
  eq('r2 的 B 幕不动', p2.scenes.B.folder_mappings['03'], ['b1']);
  eq('r2 窗口与输出基准不动', { wins: p2.scenes.A.windows, out: p2.output, wp: p2.wallpanel_enabled }, { wins: [{ id: 'w2' }], out: { w: 1920, h: 1080 }, wp: true });
  eq('r3 的空格写入', env.puts.find(p => p.url === '/api/rooms/r3').cfg.scenes.A.folder_mappings['03'], ['m1', 'm2']);
  eq('当前房未被写', env.puts.some(p => p.url === '/api/rooms/cur'), false);
  eq('有回执与审计', !!env.logs.find(l => l.action === 'folder_copy_all' && l.data.ok === 2), true);

  // 2) 源为空 → 删键清空目标
  env = mkEnv({
    rooms: {
      cur: room({ id: 'cur', scenes: { A: { folder_mappings: { '03': [] } }, B: { folder_mappings: {} } } }),
      r2: room({ id: 'r2', scenes: { A: { folder_mappings: { '03': ['gone'], '04': ['keep'] } }, B: { folder_mappings: {} } } })
    },
    storeList: ['cur', 'r2']
  });
  await run(env);
  const p2b = env.puts.find(p => p.url === '/api/rooms/r2').cfg;
  eq('空清单删除目标键', '03' in p2b.scenes.A.folder_mappings, false);
  eq('相邻格保留', p2b.scenes.A.folder_mappings['04'], ['keep']);

  // 3) 取消勾选 → 零写
  env = mkEnv({
    pickCancel: true,
    rooms: {
      cur: room({ id: 'cur', scenes: { A: { folder_mappings: { '03': ['m1'] } }, B: { folder_mappings: {} } } }),
      r2: room({ id: 'r2', scenes: { A: { folder_mappings: {} }, B: { folder_mappings: {} } } })
    },
    storeList: ['cur', 'r2']
  });
  await run(env);
  eq('取消后零 PUT', env.puts.length, 0);

  // 3b) 只勾一间 → 只写那一间，没勾的一概不动
  env = mkEnv({
    pick: ['r2'],
    rooms: {
      cur: room({ id: 'cur', scenes: { A: { folder_mappings: { '03': ['m1', 'm2'] } }, B: { folder_mappings: {} } } }),
      r2: room({ id: 'r2', scenes: { A: { folder_mappings: { '03': ['old'] } }, B: { folder_mappings: {} } } }),
      r3: room({ id: 'r3', scenes: { A: { folder_mappings: { '03': ['keep'] } }, B: { folder_mappings: {} } } })
    }
  });
  await run(env);
  eq('只 PUT 勾中的那间', env.puts.map(p => p.url), ['/api/rooms/r2']);
  eq('勾中房间被替换', env.puts[0].cfg.scenes.A.folder_mappings['03'], ['m1', 'm2']);
  eq('没勾的房间未被读也未被写', { gets: env.gets.indexOf('/api/rooms/r3') >= 0, put: env.puts.some(p => p.url === '/api/rooms/r3') }, { gets: false, put: false });
  eq('审计记下勾选目标', env.logs.find(l => l.action === 'folder_copy_all').data.targets, ['r2']);

  // 4) 单间失败不拦后面
  env = mkEnv({
    failGet: ['r2'],
    rooms: {
      cur: room({ id: 'cur', scenes: { A: { folder_mappings: { '03': ['m1'] } }, B: { folder_mappings: {} } } }),
      r2: room({ id: 'r2', scenes: { A: { folder_mappings: {} }, B: { folder_mappings: {} } } }),
      r3: room({ id: 'r3', scenes: { A: { folder_mappings: {} }, B: { folder_mappings: {} } } })
    }
  });
  await run(env);
  eq('失败间隔过、后面的照写', env.puts.map(p => p.url), ['/api/rooms/r3']);
  eq('回执里报失败', env.alerts.join('|').indexOf('1 间失败') >= 0, true);

  // 5) B 幕口径
  env = mkEnv({
    scene: 'B',
    rooms: {
      cur: room({ id: 'cur', scenes: { A: { folder_mappings: { '03': ['ax'] } }, B: { folder_mappings: { '03': ['b1', 'b2'] } } } }),
      r2: room({ id: 'r2', scenes: { A: { folder_mappings: { '03': ['keepA'] } }, B: { folder_mappings: { '03': [] } } } })
    },
    storeList: ['cur', 'r2']
  });
  await run(env);
  const p2c = env.puts.find(p => p.url === '/api/rooms/r2').cfg;
  eq('B 幕被替换', p2c.scenes.B.folder_mappings['03'], ['b1', 'b2']);
  eq('A 幕不动', p2c.scenes.A.folder_mappings['03'], ['keepA']);

  // 6) 防连点 & 非法文件夹
  env = mkEnv({
    rooms: { cur: room({ id: 'cur', scenes: { A: { folder_mappings: { '03': ['m1'] } }, B: { folder_mappings: {} } } }) }
  });
  env.s._folderCopying = true;
  await run(env);
  eq('进行中连点零 GET', env.gets.length, 0);

  env = mkEnv({ f: '99', rooms: { cur: room({ id: 'cur', scenes: { A: { folder_mappings: {} }, B: { folder_mappings: {} } } }) } });
  await run(env);
  eq('非法文件夹直接拦', { gets: env.gets.length, alert: env.alerts[0] }, { gets: 0, alert: '请先在上方选择一个素材文件夹标签（01-30）' });

  // 7) 本店只有自己 → 明确提示
  env = mkEnv({
    rooms: { cur: room({ id: 'cur', scenes: { A: { folder_mappings: { '03': ['m1'] } }, B: { folder_mappings: {} } } }) },
    storeList: ['cur']
  });
  await run(env);
  eq('无其它房间不写', { puts: env.puts.length, alert: env.alerts[0] }, { puts: 0, alert: '本店没有其它房间可复制。' });

  console.log('\n' + pass + '/' + fail + (fail ? '  ❌ 有失败' : '  ✅ 全过'));
  process.exit(fail ? 1 : 0);
})();
