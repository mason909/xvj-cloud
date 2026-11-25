// 一次性自检：PAD 签权的纯函数（【S-16】）。不连库、不起服务。
// 覆盖：配对码/token 归一与哈希、pad_key/pad_name 收敛、Bearer 解析、离线判定、
//      公开视图不得带 token_hash/pad_key、配对码过期、试错锁与到时解锁。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8').replace(/\r\n/g, '\n');

const startMark = 'const PAD_ONLINE_MS = 60 * 1000;';
const endMark = '/** 房间当前的主执行器（优先在线）';
const start = src.indexOf(startMark);
const end = src.indexOf(endMark, start);
if (start < 0 || end < 0) throw new Error('未找到【S-16】纯函数区块');
const block = src.slice(start, end);

const names = ['sha256Hex', 'padCodeHash', 'padTokenHash', 'normalizePadKey', 'normalizePadName',
  'padTokenOf', 'padLastSeenMs', 'padOnline', 'padPublicView', 'padDeviceBrief',
  'padFindPairRoom', 'padBindFail', 'padBindLocked'];
const sandbox = {};
new Function('exports', 'crypto', block + '\nObject.assign(exports, {' + names.join(',')
  + ',padPairCodes:padPairCodes,padBindFails:padBindFails,PAD_ONLINE_MS:PAD_ONLINE_MS,PAD_CODE_TTL_MS:PAD_CODE_TTL_MS,PAD_BIND_MAX_FAILS:PAD_BIND_MAX_FAILS,PAD_BIND_LOCK_MS:PAD_BIND_LOCK_MS});')(sandbox, crypto);

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log('  ok  ' + label); }
  else { fail++; console.log('  XX  ' + label + '\n      got  ' + g + '\n      want ' + w); }
};
const ok = (label, cond) => eq(label, !!cond, true);

eq('sha256Hex 长度/值', sandbox.sha256Hex('a'), 'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb');

// ---- 配对码 / token 归一 ----
eq('配对码大小写与空格等价', sandbox.padCodeHash(' 7f3a9c21 '), sandbox.padCodeHash('7F3A9C21'));
ok('不同配对码哈希不同', sandbox.padCodeHash('7F3A9C21') !== sandbox.padCodeHash('7F3A9C22'));
eq('token 大小写等价', sandbox.padTokenHash('AbCdEf0123456789abcdef0123456789abcdef01'),
  sandbox.padTokenHash('abcdef0123456789abcdef0123456789abcdef01'));
eq('token 哈希带域前缀', sandbox.padTokenHash('aa'), sandbox.sha256Hex('xvj-pad-token:aa'));

// ---- pad_key ----
ok('pad_key android id 可接受', sandbox.normalizePadKey(' 9774d56d682e549c '));
ok('pad_key 带分隔符可接受', sandbox.normalizePadKey('xvj:pad-A_01.2'));
eq('pad_key 太短拒绝', sandbox.normalizePadKey('abc1234'), null);
eq('pad_key 空格拒绝', sandbox.normalizePadKey('abc 12345'), null);
eq('pad_key 中文拒绝', sandbox.normalizePadKey('平板平板平板平板'), null);
eq('pad_key 65 位拒绝', sandbox.normalizePadKey('a'.repeat(65)), null);
eq('pad_key 非字符串拒绝', sandbox.normalizePadKey(null), null);

// ---- pad_name ----
eq('pad_name 去控制字符/首尾空格', sandbox.normalizePadName('  包间\x00PAD\x1f  '), '包间PAD');
eq('pad_name 空值默认', sandbox.normalizePadName('   '), '未命名 PAD');
eq('pad_name 截到 64', sandbox.normalizePadName('中'.repeat(100)).length, 64);

// ---- Bearer ----
const tok = 'a'.repeat(48);
eq('Bearer 解析', sandbox.padTokenOf({ headers: { authorization: 'Bearer ' + tok.toUpperCase() }, body: {} }), tok);
eq('body.token 解析', sandbox.padTokenOf({ headers: {}, body: { token: tok } }), tok);
eq('残缺 token 拒绝', sandbox.padTokenOf({ headers: { authorization: 'Bearer abc' }, body: {} }), '');
eq('非 Bearer 拒绝', sandbox.padTokenOf({ headers: { authorization: 'Basic ' + tok }, body: {} }), '');

// ---- 在线判定 ----
const now = Date.parse('2026-11-25T12:00:00Z');
eq('刚报到算在线', sandbox.padOnline(new Date(now - 15 * 1000), now), true);
eq('60 秒前算离线', sandbox.padOnline(new Date(now - 60 * 1000), now), false);
eq('MySQL DATETIME 字符串可判', sandbox.padLastSeenMs('2026-11-25 12:00:00') > 0, true);
eq('空值离线', sandbox.padOnline(null, now), false);
eq('脏值离线', sandbox.padOnline('not-a-date', now), false);

// ---- 公开视图 ----
const row = { id: 'pad_1', name: 'PAD', pad_key: 'secretkey', token_hash: 'secrethash',
  bound_at: '2026-11-25T11:00:00Z', last_seen: new Date(now - 5000), last_ip: '10.0.0.9' };
const view = sandbox.padPublicView(row, now);
eq('公开视图无 pad_key/token_hash', Object.keys(view).sort(), ['bound_at', 'id', 'last_ip', 'last_seen', 'name', 'online'].sort());
eq('公开视图在线', view.online, true);
eq('设备摘要在线', sandbox.padDeviceBrief({ id: 'd1', name: '盒子', status: 'online' }), { id: 'd1', name: '盒子', status: 'online', online: true });
eq('无设备摘要', sandbox.padDeviceBrief(null), null);

// ---- 配对码查找 ----
sandbox.padPairCodes.clear();
const h1 = sandbox.padCodeHash('7F3A9C21');
sandbox.padPairCodes.set('room_a', { hash: h1, exp: now + 1000 });
eq('配对码找到房间', sandbox.padFindPairRoom(h1, now), 'room_a');
eq('过期码找不到且被清掉', sandbox.padFindPairRoom(h1, now + 2000), null);
eq('过期条目已删除', sandbox.padPairCodes.size, 0);

// ---- 试错锁 ----
sandbox.padBindFails.clear();
for (let i = 0; i < sandbox.PAD_BIND_MAX_FAILS - 1; i++) sandbox.padBindFail('1.2.3.4', now);
eq('未到上限不锁', sandbox.padBindLocked('1.2.3.4', now), false);
sandbox.padBindFail('1.2.3.4', now);
eq('到上限锁住', sandbox.padBindLocked('1.2.3.4', now), true);
eq('别的来源不受影响', sandbox.padBindLocked('5.6.7.8', now), false);
eq('过了锁定时长自动解锁', sandbox.padBindLocked('1.2.3.4', now + sandbox.PAD_BIND_LOCK_MS + 1), false);

// ---- 路由与表结构的静态不变量 ----
// PAD 没有管理台凭据：绑定/心跳两条口一旦被挪到写接口闸门之后，PAD 就再也绑不上（而且很容易没人发现）
const iBind = src.indexOf("app.post('/api/pad/bind'");
const iBeat = src.indexOf("app.post('/api/pad/heartbeat'");
const iGate = src.indexOf("app.use('/api', (req, res, next) =>");
ok('bind 有路由', iBind > 0);
ok('heartbeat 有路由', iBeat > 0);
ok('bind 注册在写闸门之前', iBind > 0 && iBind < iGate);
ok('heartbeat 注册在写闸门之前', iBeat > 0 && iBeat < iGate);
ok('GET 绑定状态要求登录', /app\.get\('\/api\/rooms\/:id\/pad', requireAuth/.test(src));
ok('删房间级联 room_pads', src.indexOf('DELETE FROM room_pads WHERE room_id = ?') > 0);
ok('room_id 唯一（一房一 PAD）', /UNIQUE KEY unique_room_pad \(room_id\)/.test(src));
ok('pad_key 唯一（一 PAD 一房）', /UNIQUE KEY unique_pad_key \(pad_key\)/.test(src));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);