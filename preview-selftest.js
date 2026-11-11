// One-shot probe for the 大屏试播 (preview) feature. ASCII-only payloads; comments may be Chinese.
// Run from /var/www/xvj:  node probe-preview.js
// Creates throwaway rooms/devices/material rows (all ids prefixed zzpv), drives the HTTP routes on
// localhost, captures what actually lands on MQTT, then deletes every row it created.
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
const isErr = (name, r, code, needle) => {
  const msg = (r.j && r.j.error) || r.buf || '';
  check(name + ' -> ' + code, r.code === code && msg.indexOf(needle) >= 0, 'got ' + r.code + ' ' + JSON.stringify(r.j));
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

const VID = 'zzpvvid0000000000000000000001';
const IMG = 'zzpvidx0000000000000000000001';
const OTHER = 'zzpvoth0000000000000000000001';
const RM = 'zzpvroom_main';       // windowed + device  -> success path, top window wins
const RD = 'zzpvroom_default';    // no windows + device -> default win_1
const RN = 'zzpvroom_nodev';      // no windows, no device
const RX = 'zzpvroom_nodebug';    // debug off + device -> 照样能播（2026-11-08 起试播不挂 debug）
const RW = 'zzpvroom_wrongwin';   // every window binds 02, mapping is 01
const RF = 'zzpvroom_follow';      // 一扇跟随窗 + 一扇固定绑 01 —— 现场主屏那种形态
const DEV1 = 'zzpvdev1', FP1 = 'zzpvfp1';
const DEV2 = 'zzpvdev2', FP2 = 'zzpvfp2';
const DEV3 = 'zzpvdev3', FP3 = 'zzpvfp3';   // RX 必须有设备，否则测到的是"没有已授权设备"那道 409，不是 debug
const DEV4 = 'zzpvdev4', FP4 = 'zzpvfp4';   // RF 同上，只为让试播能落到设备上

// 三种窗口形态：不配窗口 / 一层绑 01、一层自动、一层禁用但 z 最高 / 只绑 02
function cfgOf(kind, debug) {
  const windows = kind === 'none' ? [] : kind === 'wrong'
    ? [{ id: 'win_9', name: 'Only02', enabled: true, zIndex: 5, content: { type: 'SCENE_A', folderId: '02' } }]
    : kind === 'follow'
    ? [
      { id: 'win_fl', name: 'FollowWall', enabled: true, zIndex: 1, content: { type: 'SCENE_A', follow: true } },
      { id: 'win_fx', name: 'Fixed01', enabled: true, zIndex: 2, content: { type: 'SCENE_A', folderId: '01' } }
    ]
    : [
      { id: 'win_1', name: 'Bottom', enabled: true, zIndex: 1, content: { type: 'SCENE_A', folderId: '01' } },
      { id: 'win_2', name: 'TopLayer', enabled: true, zIndex: 9, content: { type: 'SCENE_A', folderId: '' } },
      { id: 'win_3', name: 'DisabledTop', enabled: false, zIndex: 99, content: { type: 'SCENE_A', folderId: '01' } }
    ];
  return { debug: debug !== false, scenes: {
    A: { name: 'A', folder_mappings: { '01': [VID, IMG] }, windows: windows, master: { brightness: 1 } },
    B: { name: 'B', folder_mappings: {}, windows: [], master: {} }
  } };
}

const captured = [];

async function main() {
  await q("DELETE FROM rooms WHERE id LIKE 'zzpvroom%'");
  await q("DELETE FROM devices WHERE id LIKE 'zzpvdev%'");
  await q("DELETE FROM materials WHERE id LIKE 'zzpv%'");
  const mat = (id, fn, type) => q("INSERT INTO materials (id,name,filename,url,type,folder) VALUES (?,?,?,?,?,?)",
    [id, 'Probe ' + fn, fn, '/uploads/01/' + fn, type, '01']);
  await mat(VID, 'probe-video.mp4', 'video');
  await mat(IMG, 'probe-img.png', 'image');
  await mat(OTHER, 'probe-other.mp4', 'video');

  const mkRoom = (id, cfg) => q("INSERT INTO rooms (id,store_name,name,folder_mappings,config) VALUES (?,?,?,?,?)",
    [id, 'zzpvstore', id.replace('zzpvroom_', 'zzpv '), '{}', JSON.stringify(cfg)]);
  await mkRoom(RM, cfgOf('mixed'));
  await mkRoom(RD, cfgOf('none'));
  await mkRoom(RN, cfgOf('none'));
  await mkRoom(RX, cfgOf('none', false));
  await mkRoom(RW, cfgOf('wrong'));
  await mkRoom(RF, cfgOf('follow'));

  const mkDev = (id, fp, room) => q("INSERT INTO devices (id,name,fingerprint,mqtt_id,model,authorized,room_id,store,status) VALUES (?,?,?,?,?,?,?,?,?)",
    [id, 'zzpv dev', fp, id, 'probe', 1, room, 'zzpvstore', 'offline']);
  await mkDev(DEV1, FP1, RM);
  await mkDev(DEV2, FP2, RD);
  await mkDev(DEV3, FP3, RX);
  await mkDev(DEV4, FP4, RF);

  const client = mqtt.connect('mqtt://' + config.mqtt.host + ':' + config.mqtt.port,
    { username: config.mqtt.username || undefined, password: config.mqtt.password || undefined });
  await new Promise((res, rej) => { client.on('connect', res); client.on('error', rej); setTimeout(() => rej(new Error('mqtt timeout')), 8000); });
  client.subscribe([DEV1, FP1, DEV2, FP2, DEV3, FP3, DEV4, FP4].map(t => 'xvj/device/' + t + '/command'));
  client.on('message', (t, m) => captured.push({ topic: t, text: m.toString() }));
  console.log('SETUP OK');
  // 其余房间（含现场那间 201）的配置必须一字不动 —— 试播不该在任何地方留下配置痕迹
  const roomsBefore = (await q("SELECT id, MD5(config) m FROM rooms WHERE id NOT LIKE 'zzpv%' ORDER BY id"))
    .map(r => r.id + '=' + r.m).join('|');

  const P = (room, body) => req('POST', '/api/rooms/' + room + '/preview', body);
  const beforeCfg = (await q("SELECT config FROM rooms WHERE id=?", [RM]))[0].config;

  // 入参校验
  isErr('scene invalid', await P(RM, { scene: 'C', folder: '01', material_id: VID }), 400, 'scene');
  isErr('folder unsafe', await P(RM, { scene: 'A', folder: '../x', material_id: VID }), 400, '不合法');
  isErr('no material_id', await P(RM, { scene: 'A', folder: '01' }), 400, 'material_id');
  isErr('room missing', await P('zzpvroom_none', { scene: 'A', folder: '01', material_id: VID }), 404, '房间不存在');

  // 闸门（debug 不在其中：2026-11-08 起试播是内容操作，debug 关着的房间走下面的成功用例）
  isErr('windows bind another folder', await P(RW, { scene: 'A', folder: '01', material_id: VID }), 409, '没有可试播的视频窗口');
  isErr('scene B has nothing', await P(RM, { scene: 'B', folder: '01', material_id: VID }), 409, '没有可试播的视频窗口');
  isErr('image rejected', await P(RM, { scene: 'A', folder: '01', material_id: IMG }), 400, '只支持视频');
  isErr('material not in mapping', await P(RM, { scene: 'A', folder: '01', material_id: OTHER }), 400, '不在本房间');
  isErr('no authorized device', await P(RN, { scene: 'A', folder: '01', material_id: VID }), 409, '已授权设备');

  // 成功：配了窗口的房间 —— 命中这一格的每一扇窗都要进名单（win_1 绑 01、win_2 自动落 01；win_3 禁用不算）
  captured.length = 0;
  let r = await P(RM, { scene: 'A', folder: '01', material_id: VID });
  check('windowed 200', r.code === 200 && r.j && r.j.success === true, JSON.stringify(r.j));
  check('group = both windows bound to this cell, zIndex desc',
    r.j && r.j.target && Array.isArray(r.j.target.winIds) && r.j.target.winIds.join(',') === 'win_2,win_1'
    && r.j.target.winId === 'win_2' && r.j.target.winName === 'TopLayer 等 2 扇窗', JSON.stringify(r.j && r.j.target));
  check('physical folder prefixed A01', r.j && r.j.target && r.j.target.physicalFolder === 'A01', JSON.stringify(r.j && r.j.target));
  check('filename = manifest name', r.j && r.j.filename === 'probe-video.mp4', JSON.stringify(r.j));
  check('devices counted', r.j && r.j.devices === 1, JSON.stringify(r.j));
  await sleep(600);
  let msgs = captured.map(c => { try { return JSON.parse(c.text); } catch (e) { return {}; } }).filter(p => p.action === 'preview_material');
  check('MQTT carried preview_material x2 topics', msgs.length === 2, 'captured=' + captured.length);
  if (msgs.length) {
    const m = msgs[0];
    check('payload shape', m.win_ids && m.win_ids.join(',') === 'win_2,win_1'
      && m.win_id === 'win_2'   // 旧包兜底字段仍在，指向 z 最高那扇
      && m.folder_id === 'A01' && m.filename === 'probe-video.mp4'
      && m.max_ms === 300000 && m.room_id === RM && typeof m.timestamp === 'number', JSON.stringify(m));
  }

  // 成功：一窗未配的房间走 APK 自建默认窗 win_1
  captured.length = 0;
  r = await P(RD, { scene: 'A', folder: '01', material_id: VID });
  check('default-window room 200 win_1', r.code === 200 && r.j && r.j.target && r.j.target.winId === 'win_1', JSON.stringify(r.j));
  await sleep(500);
  check('published to id + fingerprint topics', captured.length === 2 && captured.every(c => c.text.indexOf('preview_material') >= 0),
    JSON.stringify(captured.map(c => c.topic)));

  // 成功：debug 关着的房间照样播 —— 试播是内容操作，不挂调试模式（RX 配了 DEV3，排除"没有设备"那道 409）
  captured.length = 0;
  r = await P(RX, { scene: 'A', folder: '01', material_id: VID });
  check('debug-off room 200', r.code === 200 && r.j && r.j.success === true, JSON.stringify(r.j));
  check('debug-off room still resolves win_1', r.j && r.j.target && r.j.target.winId === 'win_1', JSON.stringify(r.j && r.j.target));
  await sleep(500);
  check('debug-off published to device', captured.length === 2 && captured.every(c => c.text.indexOf('preview_material') >= 0),
    JSON.stringify(captured.map(c => c.topic)));
  const rxCfg = (await q("SELECT config FROM rooms WHERE id=?", [RX]))[0].config;
  check('debug-off room config still debug=false', JSON.parse(rxCfg).debug === false, rxCfg);

  // 成功：跟随窗也算命中 —— 现场主屏常常就是那扇 follow 窗，漏了它等于"屏上播得动，试播报没有窗口"
  captured.length = 0;
  r = await P(RF, { scene: 'A', folder: '01', material_id: VID });
  check('follow window joins the group', r.code === 200 && r.j && r.j.target
    && r.j.target.winIds.join(',') === 'win_fx,win_fl', JSON.stringify(r.j && r.j.target));
  await sleep(500);
  check('follow-group payload carries both win_ids',
    captured.map(c => { try { return JSON.parse(c.text); } catch (e) { return {}; } })
      .filter(p => p.action === 'preview_material' && p.win_ids && p.win_ids.join(',') === 'win_fx,win_fl').length === 2,
    JSON.stringify(captured.map(c => c.topic)));

  // 停止：定向 + 兜底全停
  captured.length = 0;
  r = await req('POST', '/api/rooms/' + RM + '/preview/stop', { scene: 'A', folder: '01' });
  check('stop targeted 200 win_2', r.code === 200 && r.j && r.j.win_id === 'win_2', JSON.stringify(r.j));
  r = await req('POST', '/api/rooms/' + RD + '/preview/stop', {});
  check('stop all 200 ALL', r.code === 200 && r.j && r.j.win_id === 'ALL', JSON.stringify(r.j));
  r = await req('POST', '/api/rooms/' + RX + '/preview/stop', { scene: 'A', folder: '01' });
  check('stop debug-off room 200', r.code === 200 && r.j && r.j.success === true, JSON.stringify(r.j));
  r = await req('POST', '/api/rooms/' + RW + '/preview/stop', { scene: 'A', folder: '01' });
  isErr('stop unparsable window -> ALL fallback refused', r, 409, '全部停止');
  await sleep(500);
  const stops = captured.map(c => { try { return JSON.parse(c.text); } catch (e) { return {}; } }).filter(p => p.action === 'preview_stop');
  check('stop payload: group win_ids + folder_id / bare ALL fallback', stops.length >= 6
    && stops.some(p => p.win_ids && p.win_ids.join(',') === 'win_2,win_1' && p.folder_id === 'A01')
    && stops.some(p => p.win_id === undefined), JSON.stringify(stops));

  // 裸发命令通道必须拒掉这几条（路由体形状是 { command: {...} }）
  for (const a of ['preview_material', 'preview_stop', 'update_windows', 'delete_material']) {
    isErr('command route blocks ' + a, await req('POST', '/api/devices/' + DEV1 + '/command', { command: { action: a } }), 400, '需由服务端');
  }
  check('stop action still allowed on command route',
    (await req('POST', '/api/devices/' + DEV1 + '/command', { command: { action: 'stop' } })).code === 200, 'blocked too?');

  // 不留痕：配置与 rev 都不该被动过
  const afterCfg = (await q("SELECT config FROM rooms WHERE id=?", [RM]))[0].config;
  check('rooms.config untouched', beforeCfg === afterCfg, 'config changed');
  const roomsAfter = (await q("SELECT id, MD5(config) m FROM rooms WHERE id NOT LIKE 'zzpv%' ORDER BY id"))
    .map(r => r.id + '=' + r.m).join('|');
  check('other rooms untouched (incl. live 201)', roomsBefore === roomsAfter, 'config digest differs');
  const logs = await q("SELECT action,details FROM operation_logs WHERE action LIKE 'preview%' ORDER BY id DESC LIMIT 10");
  check('audit rows written', logs.length >= 3, 'rows=' + logs.length);
  const parsed = logs.map(l => ({ a: l.action, d: JSON.parse(l.details) }));
  const pv = parsed.find(x => x.a === 'preview' && x.d.room_id === RM);   // 取本次那间房的，不是"最新一条"（那可能是默认窗那间）
  if (pv) {
    const d = pv.d;
    check('audit details useful', d.room_id === RM && d.room === 'zzpv main' && d.win_name === 'TopLayer 等 2 扇窗' && d.devices === 1 && d.filename === 'probe-video.mp4', JSON.stringify(d));
  } else { check('audit details useful', false, 'no preview row for ' + RM); }
  // 停止那条也要带人话房间名：只留 room_id 的话，操作记录里这一行显示成一串机器 id，现场对不上是哪间包厢
  const stp = parsed.find(x => x.a === 'preview_stop' && x.d.room_id === RM);
  check('stop audit has room name', !!stp && stp.d.room === 'zzpv main', stp ? JSON.stringify(stp.d) : 'no preview_stop row for ' + RM);
  client.end(true);
}

main().then(() => { }).catch(e => console.log('THROWN ' + e.stack)).then(async () => {
  await q("DELETE FROM rooms WHERE id LIKE 'zzpvroom%'");
  await q("DELETE FROM devices WHERE id LIKE 'zzpvdev%'");
  await q("DELETE FROM materials WHERE id LIKE 'zzpv%'");
  const left = await q("SELECT (SELECT COUNT(*) FROM rooms WHERE id LIKE 'zzpv%') r," +
    "(SELECT COUNT(*) FROM devices WHERE id LIKE 'zzpv%') d," +
    "(SELECT COUNT(*) FROM materials WHERE id LIKE 'zzpv%') m," +
    "(SELECT COUNT(*) FROM preset_materials WHERE id LIKE 'zzpv%') p," +
    "(SELECT COUNT(*) FROM preset_folders WHERE id LIKE 'zzpv%') f");
  console.log('TEARDOWN leftovers ' + JSON.stringify(left[0]));
  console.log('== pass=' + pass + ' fail=' + fail);
  process.exit(fail ? 1 : 0);
});
