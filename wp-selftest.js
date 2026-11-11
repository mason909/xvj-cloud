// One-shot probe for the wall panel (485) config fields. ASCII-only payloads; comments may be Chinese.
// Run from /var/www/xvj:  node wp-selftest.js
// Creates throwaway rooms/devices (all ids prefixed zzwp), drives the HTTP routes on localhost,
// captures what actually lands on MQTT, then deletes every row it created.
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

const R1 = 'zzwproom_panel';    // has an authorized device -> commands must land on its topic
const R2 = 'zzwproom_dirty';    // no device, input-shape cases
const D1 = 'zzwpdev1', FP1 = 'zzwpfp1';

const sceneA = (panelNo) => ({ name: 'A', folder_mappings: { '01': ['m_a1'], '02': ['m_a2'] }, panel_no: panelNo, windows: [{ id: 'win_1', name: 'W1', content: { type: 'SCENE_A', folderId: '01' } }], master: { brightness: 1 } });
const sceneB = (panelNo) => ({ name: 'B', folder_mappings: {}, panel_no: panelNo, windows: [], master: { brightness: 1 } });
const cfgOf = (pnA, pnB, extra) => Object.assign({ debug: false, scenes: { A: sceneA(pnA), B: sceneB(pnB) } }, extra || {});

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

async function main() {
  await q("DELETE FROM rooms WHERE id LIKE 'zzwproom%'");
  await q("DELETE FROM devices WHERE id LIKE 'zzwpdev%'");
  const mkRoom = (id, cfg) => q("INSERT INTO rooms (id,store_name,name,folder_mappings,config) VALUES (?,?,?,?,?)",
    [id, 'zzwpstore', id.replace('zzwproom_', 'zzwp '), '{}', JSON.stringify(cfg)]);
  await mkRoom(R1, cfgOf({}, {}));
  await mkRoom(R2, cfgOf({}, {}));
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

  // ── 1. 绑定编号：落库不带前缀，下发带前缀，且走轻量 update_windows ──
  let res = await put(R1, cfgOf({ '01': 3, '02': 7 }, {}));
  check('bind panel_no -> 200', res.code === 200, res.code + ' ' + res.buf);
  let c1 = await readCfg(R1);
  check('DB keeps the unprefixed keys', JSON.stringify(c1.scenes.A.panel_no) === '{"01":3,"02":7}', JSON.stringify(c1.scenes.A.panel_no));
  await sleep(700);
  check('panel_no change -> update_windows only', countOf('update_windows') === 1 && countOf('sync_room_materials') === 0, JSON.stringify(cmds().map(x => x.action)));
  let uw = lastOf('update_windows');
  check('device sees prefixed panel_no on the same keys as folder_mappings', !!uw && JSON.stringify(uw.scenes.A.panel_no) === '{"A01":3,"A02":7}', uw ? JSON.stringify(uw.scenes.A) : 'none');
  check('update_windows still carries a 12-char rev', !!uw && typeof uw.rev === 'string' && uw.rev.length === 12, uw ? String(uw.rev) : 'none');
  const revWithPanel = uw && uw.rev;

  // ── 2. 幂等：同一份 config 再 PUT 一次，一条命令都不该再发 ──
  captured.length = 0;
  res = await put(R1, c1);
  await sleep(700);
  check('idempotent re-PUT sends nothing', res.code === 200 && cmds().length === 0, JSON.stringify(cmds().map(x => x.action)));

  // ── 3. 脏值：越界/小数/非法键/数组一律丢弃（不入库也不报错） ──
  res = await put(R2, cfgOf({ '01': 99, '02': 2.5, '../x': 4, '03': 'abc', '04': [5], '05': true }, {}));
  c1 = await readCfg(R2);
  check('dirty panel_no dropped', res.code === 200 && JSON.stringify(c1.scenes.A.panel_no) === '{}', JSON.stringify(c1.scenes.A.panel_no));
  res = await put(R2, cfgOf({ '01': '12' }, {}));
  c1 = await readCfg(R2);
  check('numeric string stored as integer', res.code === 200 && c1.scenes.A.panel_no['01'] === 12, JSON.stringify(c1.scenes.A.panel_no));

  // ── 4. 一键一文件夹：同幕重复 400 且不落库；A/B 复用同一编号合法 ──
  res = await put(R2, cfgOf({ '01': 8, '02': 8 }, {}));
  check('duplicate inside one act -> 400', res.code === 400, res.code + ' ' + res.buf);
  c1 = await readCfg(R2);
  check('rejected write left the old binding intact', JSON.stringify(c1.scenes.A.panel_no) === '{"01":12}', JSON.stringify(c1.scenes.A.panel_no));
  res = await put(R2, cfgOf({ '01': 1 }, { '01': 1 }));
  c1 = await readCfg(R2);
  check('same number in A and B is legal', res.code === 200 && c1.scenes.A.panel_no['01'] === 1 && c1.scenes.B.panel_no['01'] === 1, res.code + ' ' + res.buf);

  // ── 5. 解绑：显式空表必须清空，不能被 DB 旧值继承回来 ──
  res = await put(R2, cfgOf({}, {}));
  c1 = await readCfg(R2);
  check('panel_no:{} clears the binding', res.code === 200 && JSON.stringify(c1.scenes.A.panel_no) === '{}', JSON.stringify(c1.scenes.A.panel_no));

  // ── 6. 没带 panel_no 键：继承 DB（前端只改别的字段时不能抹掉绑定） ──
  await put(R2, cfgOf({ '01': 6 }, {}));
  const noKey = JSON.parse(JSON.stringify(await readCfg(R2)));
  delete noKey.scenes.A.panel_no;
  res = await put(R2, noKey);
  c1 = await readCfg(R2);
  check('omitting panel_no inherits it', res.code === 200 && JSON.stringify(c1.scenes.A.panel_no) === '{"01":6}', JSON.stringify(c1.scenes.A.panel_no));

  // ── 7. 房间级开关：只发一条 set_wallpanel，不动素材、不改 rev ──
  c1 = await readCfg(R1);
  captured.length = 0;
  res = await put(R1, Object.assign({}, c1, { wallpanel_enabled: true, wallpanel_default_no: 5 }));
  check('wallpanel_enabled -> 200', res.code === 200, res.code + ' ' + res.buf);
  await sleep(700);
  let sw = lastOf('set_wallpanel');
  check('switch-only change -> exactly one set_wallpanel', cmds().length === 1 && sw && sw.wallpanel_enabled === true && sw.wallpanel_default_no === 5, JSON.stringify(cmds().map(x => x.action)) + ' ' + JSON.stringify(sw));
  c1 = await readCfg(R1);
  captured.length = 0;
  res = await put(R1, Object.assign({}, c1, { wallpanel_enabled: false }));
  await sleep(700);
  sw = lastOf('set_wallpanel');
  check('turning off re-sends the whole field pair', cmds().length === 1 && sw && sw.wallpanel_enabled === false && sw.wallpanel_default_no === 5, JSON.stringify(sw));

  // ── 8. 手工同步：载荷带上墙板字段（掉了那一跳的命令靠重连/同步自愈） ──
  c1 = await readCfg(R1);
  captured.length = 0;
  await put(R1, Object.assign({}, c1, { wallpanel_enabled: true }));
  await sleep(700);
  res = await req('POST', '/api/rooms/' + R1 + '/sync', {});
  await sleep(900);
  const sy = lastOf('sync_room_materials');
  check('manual sync 200 + payload carries the fields', res.code === 200 && !!sy && sy.wallpanel_enabled === true && sy.wallpanel_default_no === 5 && sy.debug === false, res.code + ' ' + JSON.stringify(sy && { w: sy.wallpanel_enabled, d: sy.wallpanel_default_no, dbg: sy.debug }));
  check('sync scenes carry panel_no', !!sy && JSON.stringify(sy.scenes.A.panel_no) === '{"A01":3,"A02":7}', JSON.stringify(sy && sy.scenes.A && sy.scenes.A.panel_no));
  check('sync rev unchanged by the wallpanel switch', !!sy && sy.rev === revWithPanel, String(sy && sy.rev) + ' vs ' + String(revWithPanel));

  // ── 9. 部分 PUT 不带墙板键：继承（口径同 debug），且不再补发命令 ──
  c1 = await readCfg(R1);
  captured.length = 0;
  const partial = Object.assign({}, c1);
  delete partial.wallpanel_enabled;
  delete partial.wallpanel_default_no;
  delete partial.debug;
  res = await put(R1, partial);
  c1 = await readCfg(R1);
  check('omitting the wallpanel keys inherits them', res.code === 200 && c1.wallpanel_enabled === true && c1.wallpanel_default_no === 5 && c1.debug === false, res.code + ' ' + JSON.stringify(c1 && { w: c1.wallpanel_enabled, d: c1.wallpanel_default_no, dbg: c1.debug }));
  check('inheriting them sends no command', cmds().length === 0, JSON.stringify(cmds().map(x => x.action)));

  // ── 10. 手工命令口：新 action 在白名单里，乱写的仍然 400 ──
  res = await req('POST', '/api/devices/' + D1 + '/command', { command: { action: 'set_wallpanel', wallpanel_enabled: false } });
  check('command route allows set_wallpanel', res.code === 200, res.code + ' ' + res.buf);
  res = await req('POST', '/api/devices/' + D1 + '/command', { command: { action: 'set_wallpanel_x' } });
  check('unknown action still 400', res.code === 400, res.code + ' ' + res.buf);

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
