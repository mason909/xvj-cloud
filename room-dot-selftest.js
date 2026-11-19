// 一次性自检：房间 tab 在线小绿点（refreshRoomDots / applyRoomDots）。
// 风险全在「点该不该亮」和「重复轮询不能叠点」：设备在线判定只看 status==='online' 且有 room_id；
// 刷新只增删 .room-dot，不重画 tab。
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, 'public/index.html'), 'utf8').replace(/\r\n/g, '\n');

const start = src.indexOf('// 房间 tab 右上角在线小绿点');
if (start < 0) throw new Error('未找到房间在线小绿点区块');
const endMark = 'function sd(store)';
const end = src.indexOf(endMark, start);
if (end < 0) throw new Error('未找到 sd() 边界');
const block = src.slice(start, end);

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log('  ok  ' + label); }
  else { fail++; console.log('  XX  ' + label + '\n      got  ' + g + '\n      want ' + w); }
};

function mkTab(roomId) {
  return {
    attrs: roomId === undefined ? {} : { 'data-room': roomId },
    children: [],
    getAttribute: function(k) { return this.attrs[k]; },
    appendChild: function(c) { c.parentNode = this; this.children.push(c); },
    querySelector: function(sel) {
      if (sel !== '.room-dot') return null;
      for (let i = 0; i < this.children.length; i++) {
        if (this.children[i].className === 'room-dot') return this.children[i];
      }
      return null;
    },
    removeChild: function(c) {
      const i = this.children.indexOf(c);
      if (i >= 0) this.children.splice(i, 1);
    }
  };
}

function mkEnv(tabs) {
  let devices = [];
  let rejectNext = false;
  const env = {
    tabs: tabs || [],
    doc: {
      querySelectorAll: function(sel) { return sel === '#df .tab[data-room]' ? env.tabs : []; },
      createElement: function() { return { className: '', parentNode: null }; }
    },
    s: {},
    apiGet: async function() {
      if (rejectNext) { rejectNext = false; throw new Error('network'); }
      return devices;
    },
    asList: function(x) { return Array.isArray(x) ? x : []; },
    setDevices: function(list) { devices = list; },
    rejectOnce: function() { rejectNext = true; }
  };
  const api = new Function('apiGet', 'asList', 'document', 's', block + '\nreturn {refreshRoomDots: refreshRoomDots, applyRoomDots: applyRoomDots};')(
    env.apiGet, env.asList, env.doc, env.s
  );
  env.api = api;
  return env;
}

const dotsOf = (tab) => tab.children.filter(c => c.className === 'room-dot').length;

(async function() {
  // 静态锚点：CSS 与接线在
  eq('CSS .room-dot 存在', /\.room-dot\{/.test(src), true);
  eq('悬停让位给删除 ×', /\.tab:hover \.room-dot\{display:none\}/.test(src), true);
  eq('房间 tab 带 data-room', /class="tab ' \+ act \+ '" data-room="/.test(src), true);
  eq('30s 轮询已接', /setInterval\(refreshRoomDots, 30000\)/.test(src), true);
  eq('rd() 重绘后立刻补点', /document\.getElementById\('df'\)\.innerHTML = h;\s*\n\s*applyRoomDots\(\);/.test(src), true);

  // 在线判定：只认 online + room_id
  let env = mkEnv([mkTab('r1'), mkTab('r2')]);
  env.setDevices([
    { status: 'online', room_id: 'r1' },
    { status: 'offline', room_id: 'r2' },
    { status: 'online', room_id: null },
    { status: 'online' }
  ]);
  await env.api.refreshRoomDots();
  eq('r1 在线亮灯', dotsOf(env.tabs[0]), 1);
  eq('r2 离线不亮', dotsOf(env.tabs[1]), 0);
  eq('缓存只记有房的在线设备', env.s._roomOnline, { r1: true });

  // 幂等：重复轮询不叠点
  await env.api.refreshRoomDots();
  await env.api.refreshRoomDots();
  eq('重复刷新只有一个点', dotsOf(env.tabs[0]), 1);

  // 状态翻转
  env.setDevices([{ status: 'online', room_id: 'r2' }]);
  await env.api.refreshRoomDots();
  eq('r1 掉线点撤掉', dotsOf(env.tabs[0]), 0);
  eq('r2 上线点补上', dotsOf(env.tabs[1]), 1);

  // 全掉线
  env.setDevices([]);
  await env.api.refreshRoomDots();
  eq('全离线无点', dotsOf(env.tabs[0]) + dotsOf(env.tabs[1]), 0);

  // 一台都没授权时 /api/devices 返回非数组
  env.setDevices(null);
  await env.api.refreshRoomDots();
  eq('非数组当空处理', env.s._roomOnline, {});

  // 网络失败：不抛、不清旧点（保留上次真相，下轮再修）
  env.setDevices([{ status: 'online', room_id: 'r1' }]);
  await env.api.refreshRoomDots();
  env.rejectOnce();
  let threw = false;
  try { await env.api.refreshRoomDots(); } catch (e) { threw = true; }
  eq('网络失败不抛出', threw, false);
  eq('失败保留上一轮的点', dotsOf(env.tabs[0]), 1);

  console.log('\n' + pass + '/' + fail + (fail ? '  ❌ 有失败' : '  ✅ 全过'));
  process.exit(fail ? 1 : 0);
})();
