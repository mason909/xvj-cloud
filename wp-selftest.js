// One-shot probe for the wall panel (485) config fields. ASCII-only payloads; comments may be Chinese.
// Run from /var/www/xvj:  node wp-selftest.js
// Creates throwaway rooms/devices (all ids prefixed zzwp), drives the HTTP routes on localhost,
// captures what actually lands on MQTT, then deletes every row it created.
// Contract under test (2026-11-13): no panel numbers, no per-scene codes. config.wallpanel_bindings is
// a flat [{frame,folder,source}] at the top level — up to two codes per folder (source 'player' = 点歌机,
// 'panel' = 墙板; missing source defaults to panel), shared by A/B; folder ids are stored bare (01) and only
// get the scene prefix on the scene-payload path. 'source' is a human-facing column label the device ignores.
// Every wallpanel_* change travels on set_wallpanel and never touches rev.
const http = require('http');
const mqtt = require('mqtt');
const config = require('./config');
const mysql = require('mysql2');

const conn = mysql.createConnection({
  host: config.database.host, user: config.database.user,
  password: config.database.password, database: config.database.name, charset: 'utf8mb4'
});
const q = (sql, args) => new Promise((res, rej) => conn.query(sql, args, (e, r) => e ? rej(e) : res(r)));

const KEY = config.apiKey;
function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({
      host: '127.0.0.1', port: config.port || 3000, path, method,
      headers: Object.assign({ 'x-api-key': KEY },
        data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {})
    }, res => {
      let buf = '';
      res.on('data', d => buf += d);
      res.on('end', () => { let j = null; try { j = JSON.parse(buf); } catch (e) { } resolve({ code: res.statusCode, j, buf }); });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) { pass++; console.log('PASS ' + name); } else { fail++; console.log('FAIL ' + name + ' << ' + detail); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const R1 = 'zzwproom_panel';    // has an authorized device -> commands must land on its topic
const R2 = 'zzwproom_dirty';    // no device: write/egress shapes only
const D1 = 'zzwpdev1', FP1 = 'zzwpfp1';

const sceneA = () => ({ name: 'A', folder_mappings: { '01': ['m_a1'], '02': ['m_a2'] }, windows: [{ id: 'win_1', name: 'W1', content: { type: 'SCENE_A', folderId: '01' } }], master: { brightness: 1 } });
const sceneB = () => ({ name: 'B', folder_mappings: {}, windows: [], master: { brightness: 1 } });
const cfgOf = (binds, extra) => Object.assign(
  { debug: false, scenes: { A: sceneA(), B: sceneB() } },
  binds === undefined ? {} : { wallpanel_bindings: binds },
  extra || {}
);
const rule = (frame, folder, source) => [{ frame: frame, folder: folder, source: source }];

const captured = [];
// 服务端对每台设备按 {id, fingerprint} 双发（publishToDeviceCommand），探针两个 topic 都订了：
// 按报文文本去重，一条通知才算一条 —— 否则所有条数断言都要翻倍
const cmds = () => {
  const seen = {}, out = [];
  captured.forEach(c => {
    if (seen[c.text]) return;
    seen[c.text] = 1;
    try { out.push(JSON.parse(c.text)); } catch (e) { }
  });
  return out;
};
const countOf = action => cmds().filter(c => c.action === action).length;
const lastOf = action => { const l = cmds().filter(c => c.action === action); return l[l.length - 1]; };
const actions = () => JSON.stringify(cmds().map(x => x.action));

async function main() {
  await q("DELETE FROM rooms WHERE id LIKE 'zzwproom%'");
  await q("DELETE FROM devices WHERE id LIKE 'zzwpdev%'");
  const mkRoom = (id, cfg) => q("INSERT INTO rooms (id,store_name,name,folder_mappings,config) VALUES (?,?,?,?,?)",
    [id, 'zzwpstore', id.replace('zzwproom_', 'zzwp '), '{}', JSON.stringify(cfg)]);
  await mkRoom(R1, cfgOf({}));
  await mkRoom(R2, cfgOf({}));
  await q("INSERT INTO devices (id,name,fingerprint,mqtt_id,model,authorized,room_id,store,status) VALUES (?,?,?,?,?,?,?,?,?)",
    [D1, 'zzwp dev', FP1, D1, 'probe', 1, R1, 'zzwpstore', 'offline']);

  const client = mqtt.connect('mqtt://' + config.mqtt.host + ':' + config.mqtt.port,
    { username: config.mqtt.username || undefined, password: config.mqtt.password || undefined });
  await new Promise((res, rej) => { client.on('connect', res); client.on('error', rej); setTimeout(() => rej(new Error('mqtt timeout')), 8000); });
  client.subscribe(['xvj/device/' + D1 + '/command', 'xvj/device/' + FP1 + '/command']);
  client.on('message', (t, m) => captured.push({ topic: t, text: m.toString() }));
  console.log('SETUP OK');

  // 其它房间（含现场那间 201）的配置必须一字不动：新字段落库不该让存量 rev 抖一次
  const othersBefore = (await q("SELECT id, MD5(config) m FROM rooms WHERE id NOT LIKE 'zzwp%' ORDER BY id"))
    .map(r => r.id + '=' + r.m).join('|');

  const put = (room, cfg) => req('PUT', '/api/rooms/' + room, { config: JSON.stringify(cfg) });
  const readCfg = async (room) => JSON.parse((await q("SELECT config c FROM rooms WHERE id=?", [room]))[0].c);
  const sync = async (room) => (await req('POST', '/api/rooms/' + room + '/sync', {})).j;

  // ── 0. 房间 rev 基线：墙板任何字段都不该动它 ──
  const revStart = (await sync(R1)).command.rev;
  check('sync rev is a 12-char string', typeof revStart === 'string' && revStart.length === 12, String(revStart));
  await sleep(400);   // 手工 sync 的 publish 到订阅回调要几毫秒：不等它落袋就清，会被算到下一段的头上

  // ── 1. 学码：落库裸格名、大写帧、按帧排序；同一格两路码（点歌机 + 墙板）都要收下；只发一条 set_wallpanel ──
  //      带上小麦那族的单字节码（d3）：它在协议里就是 1 字节，不能被"帧至少两字节"的闸挡掉。
  //      来源只是人看的列标签（设备端不看），缺省一律算墙板码。
  captured.length = 0;
  let res = await put(R1, cfgOf([
    { frame: 'f50521', folder: 'A01', source: 'player' }, { frame: 'F5a5b5', folder: '02' },
    { frame: 'd3', folder: '03', source: 'panel' },
    { frame: 'b5', folder: '05', source: 'player' }, { frame: 'aa55', folder: '05', source: 'panel' }
  ]));
  check('bindings write -> 200', res.code === 200, res.code + ' ' + res.buf);
  let c1 = await readCfg(R1);
  const WANT_BIND = [
    { frame: 'AA55', folder: '05', source: 'panel' },
    { frame: 'B5', folder: '05', source: 'player' },
    { frame: 'D3', folder: '03', source: 'panel' },
    { frame: 'F50521', folder: '01', source: 'player' },
    { frame: 'F5A5B5', folder: '02', source: 'panel' }
  ];
  check('DB stores uppercase frames + bare folders + source (incl. single-byte D3, two codes on folder 05)',
    same(c1.wallpanel_bindings, WANT_BIND), JSON.stringify(c1.wallpanel_bindings));
  await sleep(700);
  check('bindings change -> exactly one set_wallpanel',
    countOf('set_wallpanel') === 1 && countOf('update_windows') === 0 && countOf('sync_room_materials') === 0, actions());
  let sw = lastOf('set_wallpanel');
  check('set_wallpanel carries the bindings', !!sw && same(sw.wallpanel_bindings, c1.wallpanel_bindings), sw ? JSON.stringify(sw.wallpanel_bindings) : 'none');
  check('set_wallpanel carries no rev and no default number',
    !!sw && sw.rev === undefined && !('wallpanel_default_no' in sw), sw ? JSON.stringify({ rev: sw.rev, d: sw.wallpanel_default_no }) : 'none');
  check('set_wallpanel carries the whole hardware field set',
    !!sw && sw.wallpanel_enabled === false && sw.wallpanel_serial_path === '/dev/ttyUSB0' &&
    sw.wallpanel_baud === null && sw.wallpanel_data_bits === 8 && sw.wallpanel_parity === 'none' && sw.wallpanel_stop_bits === 1,
    sw ? JSON.stringify(sw) : 'none');

  // ── 2. 幂等：同一份 config 再 PUT 一次，一条命令都不该再发 ──
  captured.length = 0;
  res = await put(R1, c1);
  await sleep(700);
  check('idempotent re-PUT sends nothing', res.code === 200 && cmds().length === 0, actions());

  // ── 3. 写坏的绑定表：一律 400 报出去（不静默丢），DB 与设备都保持原样 ──
  const many = [];
  for (let i = 0; i < 65; i++) many.push({ frame: 'F5' + (i < 16 ? '0' : '') + i.toString(16).toUpperCase(), folder: '01' });
  const badWrites = [
    ['duplicate frame', rule('F50521', '01').concat(rule('F50521', '02')), '绑了不止一条'],
    ['same folder, same column, two codes', rule('F50521', '01', 'panel').concat(rule('AA0102', '01', 'panel')), '只能录一个码'],
    ['unknown source', rule('AA0102', '01', 'ipad'), '来源只能是'],
    ['odd-length frame', rule('F50', '01'), '形状不对'],
    ['folder 31 out of range', rule('AA01', '31'), '形状不对'],
    ['folder 00 out of range', rule('AA01', '00'), '形状不对'],
    ['bindings not an array', 'abc', '数组'],
    ['per-scene object shape', { A: [], B: [] }, '不再按 A/B 分幕录码'],
    ['over 64 rules', many, '超出上限 64']
  ];
  captured.length = 0;
  const bindAfterStep1 = JSON.stringify(c1.wallpanel_bindings);
  for (const [label, binds, needle] of badWrites) {
    res = await put(R1, Object.assign({}, c1, { wallpanel_bindings: binds }));
    const now = JSON.stringify((await readCfg(R1)).wallpanel_bindings);
    check('reject: ' + label, res.code === 400 && res.buf.indexOf(needle) >= 0 && now === bindAfterStep1,
      res.code + ' ' + res.buf.slice(0, 160) + ' db=' + now);
  }
  await sleep(400);
  check('rejected writes send nothing', cmds().length === 0, actions());

  // ── 4. 脏键只整形不报错；夹带幕前缀的格名归一成裸格名 ──
  res = await put(R2, cfgOf([{ frame: 'f50521', folder: 'A01', type: 'panel_no', no: 3 }]));
  c1 = await readCfg(R2);
  check('type/no leftovers are dropped, A01 -> 01, source defaults to panel',
    res.code === 200 && same(c1.wallpanel_bindings, [{ frame: 'F50521', folder: '01', source: 'panel' }]),
    res.code + ' ' + JSON.stringify(c1.wallpanel_bindings));

  // ── 5. 解绑：显式空表必须清空，不能被 DB 旧值继承回来 ──
  res = await put(R2, Object.assign({}, c1, { wallpanel_bindings: [] }));
  c1 = await readCfg(R2);
  check('wallpanel_bindings:[] clears the table', res.code === 200 && JSON.stringify(c1.wallpanel_bindings) === '[]', JSON.stringify(c1.wallpanel_bindings));

  // ── 6. 没带 bindings 键：继承 DB（前端只改别的字段时不能抹掉学习表） ──
  await put(R2, cfgOf(rule('AABBCC', '05')));
  const noKey = JSON.parse(JSON.stringify(await readCfg(R2)));
  delete noKey.wallpanel_bindings;
  delete noKey.wallpanel_enabled;
  res = await put(R2, noKey);
  c1 = await readCfg(R2);
  check('omitting the keys inherits them',
    res.code === 200 && same(c1.wallpanel_bindings, [{ frame: 'AABBCC', folder: '05', source: 'panel' }]), res.code + ' ' + JSON.stringify(c1.wallpanel_bindings));

  // ── 7. 存量默认编号：写库时清掉，且它单独出现不触发任何命令 ──
  captured.length = 0;
  res = await put(R1, Object.assign({}, await readCfg(R1), { wallpanel_default_no: 5 }));
  c1 = await readCfg(R1);
  await sleep(500);
  check('legacy wallpanel_default_no is dropped on write',
    res.code === 200 && !('wallpanel_default_no' in c1), res.code + ' ' + JSON.stringify(c1.wallpanel_default_no));
  check('legacy key alone sends nothing', cmds().length === 0, actions());

  // ── 8. 硬件字段：归一后落库并下发；真值写错（1/字符串）落成 false 且不发命令 ──
  captured.length = 0;
  res = await put(R1, Object.assign({}, await readCfg(R1), { wallpanel_enabled: 1 }));
  c1 = await readCfg(R1);
  await sleep(500);
  check('wallpanel_enabled:1 normalizes to false, no command', res.code === 200 && c1.wallpanel_enabled === false && cmds().length === 0,
    res.code + ' ' + JSON.stringify(c1.wallpanel_enabled) + ' ' + actions());

  captured.length = 0;
  res = await put(R1, Object.assign({}, await readCfg(R1), {
    wallpanel_enabled: true, wallpanel_serial_path: '/dev/ttyS1', wallpanel_baud: '9600',
    wallpanel_data_bits: '7', wallpanel_parity: 'odd', wallpanel_stop_bits: '2'
  }));
  c1 = await readCfg(R1);
  check('hardware fields land normalized',
    res.code === 200 && c1.wallpanel_enabled === true && c1.wallpanel_serial_path === '/dev/ttyS1' &&
    c1.wallpanel_baud === 9600 && c1.wallpanel_data_bits === 7 && c1.wallpanel_parity === 'odd' && c1.wallpanel_stop_bits === 2,
    res.code + ' ' + JSON.stringify(c1) );
  await sleep(700);
  sw = lastOf('set_wallpanel');
  check('hardware change -> exactly one set_wallpanel',
    cmds().length === 1 && countOf('set_wallpanel') === 1 && !!sw && sw.wallpanel_baud === 9600 && sw.wallpanel_data_bits === 7 &&
    sw.wallpanel_parity === 'odd' && sw.wallpanel_stop_bits === 2 && sw.wallpanel_serial_path === '/dev/ttyS1',
    actions() + ' ' + JSON.stringify(sw));

  // ── 9. 非法硬件值：400 报出来（静默回落等于替运营改了硬件参数） ──
  const badHw = [
    ['baud not in whitelist', { wallpanel_baud: 12345 }, '波特率只能'],
    ['serial path outside /dev', { wallpanel_serial_path: '/etc/passwd' }, '串口节点'],
    ['data bits out of range', { wallpanel_data_bits: 9 }, '数据位'],
    ['unknown parity', { wallpanel_parity: 'mark' }, '校验位'],
    ['stop bits out of range', { wallpanel_stop_bits: 3 }, '停止位']
  ];
  captured.length = 0;
  for (const [label, patch, needle] of badHw) {
    res = await put(R1, Object.assign({}, await readCfg(R1), patch));
    const now = await readCfg(R1);
    check('reject: ' + label, res.code === 400 && res.buf.indexOf(needle) >= 0 && now.wallpanel_baud === 9600,
      res.code + ' ' + res.buf.slice(0, 160) + ' baud=' + now.wallpanel_baud);
  }
  await sleep(400);
  check('rejected hardware sends nothing', cmds().length === 0, actions());

  // ── 10. 学习窗：有设备才开，on/seconds 原样下发；坏 seconds 400；无设备 409 ──
  captured.length = 0;
  res = await req('POST', '/api/rooms/' + R1 + '/wallpanel/learn', { on: true, seconds: 5 });
  check('learn open -> 200', res.code === 200 && res.j && res.j.seconds === 5 && (res.j.devices || []).indexOf(D1) >= 0, res.code + ' ' + res.buf);
  await sleep(600);
  let lc = lastOf('wallpanel_learn');
  check('learn open reaches the device', countOf('wallpanel_learn') === 1 && !!lc && lc.on === true && lc.seconds === 5, actions() + ' ' + JSON.stringify(lc));
  captured.length = 0;
  res = await req('POST', '/api/rooms/' + R1 + '/wallpanel/learn', { on: false });
  await sleep(600);
  lc = lastOf('wallpanel_learn');
  check('learn close defaults to 20s', res.code === 200 && !!lc && lc.on === false && lc.seconds === 20, JSON.stringify(lc));
  for (const bad of [0, 61, 2.5, 'x']) {
    res = await req('POST', '/api/rooms/' + R1 + '/wallpanel/learn', { on: true, seconds: bad });
    check('reject learn seconds=' + JSON.stringify(bad), res.code === 400, res.code + ' ' + res.buf);
  }
  res = await req('POST', '/api/rooms/' + R2 + '/wallpanel/learn', { on: true });
  check('learn without a device -> 409', res.code === 409, res.code + ' ' + res.buf);

  // ── 11. 学习帧回传：设备报上来的候选帧落进 GET /api/devices 的 d.frames ──
  client.publish('xvj/device/' + D1 + '/frames',
    JSON.stringify({ learning: true, frames: [{ hex: 'f50521', n: 3, age: 1800 }, { hex: 'zz', n: 9, age: 1 }, { hex: 'AABBCC', n: 0, age: -5 }] }));
  await sleep(600);
  res = await req('GET', '/api/devices?room_id=' + R1);
  const devRow = Array.isArray(res.j) ? res.j.filter(d => d.id === D1)[0] : null;
  check('device frames are surfaced and normalized',
    !!devRow && Array.isArray(devRow.frames) && devRow.frames.length === 2 &&
    devRow.frames[0].hex === 'F50521' && devRow.frames[0].n === 3 && devRow.frames[0].age === 1800 &&
    devRow.frames[1].hex === 'AABBCC' && devRow.frames[1].n === 1 && devRow.frames[1].age === 0,
    JSON.stringify(devRow && devRow.frames));

  // ── 12. 手工同步：载荷带全墙板字段（含绑定表），rev 与开头一致 ──
  const sy = await sync(R1);
  check('sync rev unchanged by bindings/hardware', sy.command.rev === revStart, sy.command.rev + ' vs ' + revStart);
  check('sync payload carries the bindings (incl. single-byte D3 + two codes on 05)',
    same(sy.command.wallpanel_bindings, WANT_BIND),
    JSON.stringify(sy.command.wallpanel_bindings));
  check('sync payload carries the hardware fields',
    sy.command.wallpanel_enabled === true && sy.command.wallpanel_baud === 9600 &&
    sy.command.wallpanel_data_bits === 7 && sy.command.wallpanel_parity === 'odd' && sy.command.wallpanel_stop_bits === 2,
    JSON.stringify({ e: sy.command.wallpanel_enabled, b: sy.command.wallpanel_baud }));
  check('sync scenes keep the scene prefix', !!sy.command.scenes && !!sy.command.scenes.A &&
    same(Object.keys(sy.command.scenes.A.folder_mappings || {}).sort(), ['A01', 'A02']),
    JSON.stringify(sy.command.scenes && sy.command.scenes.A && sy.command.scenes.A.folder_mappings));

  // ── 13. 部分 PUT 不带墙板键：继承，且不再补发命令 ──
  c1 = await readCfg(R1);
  await sleep(400);   // 同第 1 段：先等手工 sync 的那条落袋再清
  captured.length = 0;
  const partial = JSON.parse(JSON.stringify(c1));
  ['wallpanel_enabled', 'wallpanel_bindings', 'wallpanel_baud', 'wallpanel_serial_path',
    'wallpanel_data_bits', 'wallpanel_parity', 'wallpanel_stop_bits', 'debug'].forEach(k => delete partial[k]);
  res = await put(R1, partial);
  const c13 = await readCfg(R1);
  await sleep(500);
  check('partial PUT inherits every wallpanel field',
    res.code === 200 && c13.wallpanel_enabled === true && c13.wallpanel_baud === 9600 &&
    same(c13.wallpanel_bindings, c1.wallpanel_bindings) && c13.debug === false,
    res.code + ' ' + JSON.stringify(c13.wallpanel_bindings));
  check('inheriting them sends no command', cmds().length === 0, actions());

  // ── 14. 手工命令口：两个新 action 在白名单里，乱写的仍然 400 ──
  res = await req('POST', '/api/devices/' + D1 + '/command', { command: { action: 'set_wallpanel', wallpanel_enabled: false } });
  check('command route allows set_wallpanel', res.code === 200, res.code + ' ' + res.buf);
  res = await req('POST', '/api/devices/' + D1 + '/command', { command: { action: 'wallpanel_learn', on: true, seconds: 3 } });
  check('command route allows wallpanel_learn', res.code === 200, res.code + ' ' + res.buf);
  res = await req('POST', '/api/devices/' + D1 + '/command', { command: { action: 'set_wallpanel_x' } });
  check('unknown action still 400', res.code === 400, res.code + ' ' + res.buf);

  // ── 15. 存量脏绑定表（绕过写入口直接落库）：下发侧整形，不炸也不带脏键 ──
  await q("UPDATE rooms SET config=? WHERE id=?", [JSON.stringify({
    debug: false,
    wallpanel_bindings: [
      { frame: 'bbcc', folder: '02' }, { frame: 'BBCC', folder: '05' }, { frame: 'zz', folder: '01' },
      { frame: 'aabbee', folder: 'A07', type: 'panel_no', no: 2 }, null, 'x',
      { frame: 'c101', folder: 'A07', source: 'player', type: 'panel_no' }
    ]
  }), R2]);
  const legacy = (await sync(R2)).command;
  check('egress normalizes legacy rows (dedupe + sort + bare folders + source, dirty dropped)',
    same(legacy.wallpanel_bindings, [
      { frame: 'AABBEE', folder: '07', source: 'panel' },
      { frame: 'BBCC', folder: '02', source: 'panel' },
      { frame: 'C101', folder: '07', source: 'player' }
    ]),
    JSON.stringify(legacy.wallpanel_bindings));

  const othersAfter = (await q("SELECT id, MD5(config) m FROM rooms WHERE id NOT LIKE 'zzwp%' ORDER BY id"))
    .map(r => r.id + '=' + r.m).join('|');
  check('other rooms untouched (incl. live 201)', othersBefore === othersAfter, 'config md5 moved');

  await q("DELETE FROM rooms WHERE id LIKE 'zzwproom%'");
  await q("DELETE FROM devices WHERE id LIKE 'zzwpdev%'");
  const left = await q("SELECT COUNT(*) n FROM rooms WHERE id LIKE 'zzwp%'");
  const leftDev = await q("SELECT COUNT(*) n FROM devices WHERE id LIKE 'zzwp%'");
  console.log('TEARDOWN leftovers ' + JSON.stringify(left[0]) + ' ' + JSON.stringify(leftDev[0]));
  console.log('== pass=' + pass + ' fail=' + fail);
  client.end(true);
  conn.end();
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('PROBE ERROR', e); process.exit(2); });
