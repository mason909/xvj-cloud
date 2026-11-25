// 一次性自检：工作台「PAD设置」面板的渲染分支（【F-06k】）。不启浏览器、不发请求。
// 覆盖：读取中 / 未绑定 / 配对码展示与过期 / 刷新后只剩 pending / 已绑定在线离线 / 无盒子告警 / 名称转义。
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, 'public/index.html'), 'utf8').replace(/\r\n/g, '\n');

function slice(fromMark, toMark) {
  const a = src.indexOf(fromMark);
  const b = src.indexOf(toMark, a);
  if (a < 0 || b < 0) throw new Error('未找到区块 ' + fromMark);
  return src.slice(a, b);
}
const escSrc = slice('function esc(s) {', '\n');
const block = slice('function _padFmt(v) {', 'async function padStartPair()');

const state = { rf: 'room_a', _pad: null };
const sandbox = {};
new Function('exports', 's', escSrc + '\n' + block + '\nObject.assign(exports,{_padHtml:_padHtml,_padFmt:_padFmt,_padLeft:_padLeft});')(sandbox, state);

let pass = 0, fail = 0;
const ok = (label, cond) => {
  if (cond) { pass++; console.log('  ok  ' + label); }
  else { fail++; console.log('  XX  ' + label); }
};
const html = () => sandbox._padHtml();
const set = (patch) => { state._pad = Object.assign({ roomId: 'room_a' }, patch); };

ok('无状态 = 读取中', html().indexOf('读取中') >= 0);
set({ loading: true });
ok('loading = 读取中', html().indexOf('读取中') >= 0);

set({ loading: false, bound: false });
let h = html();
ok('未绑定标题', h.indexOf('未绑定 PAD') >= 0);
ok('未绑定有发起配对', h.indexOf('padStartPair()') >= 0);
ok('未绑定时没有配对码块', h.indexOf('pad-code') < 0);
ok('未绑定说明一房一 PAD', h.indexOf('一房一 PAD') >= 0);

set({ loading: false, bound: false, pair: { code: '7F3A9C21', expires_at: new Date(Date.now() + 300000).toISOString() } });
h = html();
ok('配对码上屏', h.indexOf('7F3A9C21') >= 0);
ok('配对待过期倒计时', /约 \d+:\d\d 后过期/.test(h));
ok('配对可重新生成', h.indexOf('重新生成') >= 0);
ok('配对码不进 placeholder/属性', h.indexOf('value="7F3A9C21"') < 0);

set({ loading: false, bound: false, pair: { code: '7F3A9C21', expires_at: new Date(Date.now() - 1000).toISOString() },
  pending: { expires_at: new Date(Date.now() + 1000).toISOString() } });
h = html();
ok('过期码不再显示', h.indexOf('7F3A9C21') < 0);
ok('过期且有 pending 走"刷新后不显示"', h.indexOf('本页刷新后不再显示明文') >= 0);

const boundBase = {
  loading: false, bound: true,
  pad: { id: 'pad_1', name: '包厢 PAD', bound_at: '2026-11-25T03:00:00Z', last_seen: new Date().toISOString(), last_ip: '10.0.0.9', online: true },
  device: { id: '0123456789abcdef', name: '盒子A', status: 'online', online: true }
};
set(boundBase);
h = html();
ok('已绑定显示名称', h.indexOf('包厢 PAD') >= 0);
ok('已绑定显示在线', h.indexOf('正在向本房盒子报到') >= 0);
ok('盒子 id 取前 8 位', h.indexOf('01234567') >= 0 && h.indexOf('0123456789abcdef') < 0);
ok('显示最近报到 IP', h.indexOf('10.0.0.9') >= 0);
ok('有解绑按钮', h.indexOf('padUnbind()') >= 0);
ok('已绑定不出现配对码', h.indexOf('pad-code') < 0);

set(Object.assign({}, boundBase, { device: null, pad: Object.assign({}, boundBase.pad, { online: false, last_seen: '2026-11-25T02:00:00Z' }) }));
h = html();
ok('离线态文案', h.indexOf('离线') >= 0);
ok('无盒子告警', h.indexOf('本房还没有已授权盒子') >= 0);

set(Object.assign({}, boundBase, { pad: Object.assign({}, boundBase.pad, { name: '<img src=x onerror=alert(1)>' }) }));
h = html();
ok('PAD 名称转义', h.indexOf('<img src=x') < 0 && h.indexOf('&lt;img src=x') >= 0);

set(Object.assign({}, boundBase, { err: '读取 PAD 状态失败: boom' }));
ok('错误行显示', html().indexOf('读取 PAD 状态失败: boom') >= 0);

ok('_padLeft 过期为空', sandbox._padLeft(new Date(Date.now() - 1000).toISOString()) === '');
ok('_padLeft 余 1 分钟', /^0:5\d$/.test(sandbox._padLeft(new Date(Date.now() + 59000).toISOString())));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);