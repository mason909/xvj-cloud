// 一次性探针：文件夹级播放设置（scenes[X].play_settings）的写入/归一/下发/rev 四条链路。
// ASCII-only payloads（注释可中文）。在 /var/www/xvj 下跑：node ps-settings-selftest.js
// 只动 zzps 前缀的临时店/房/设备，跑完全部删除；对存量房间只做只读指纹比对。
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
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
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + ' << ' + (detail === undefined ? '' : detail)); }
};
// "99" 这类整数样的键名在 V8 里会被排到字符串键前面（index key 顺序），落库 JSON 的键序
// 因此不反映归一逻辑 —— 结构比对一律先按键名排序再比
const canon = v => JSON.stringify(v, (k, val) =>
  (val && typeof val === 'object' && !Array.isArray(val))
    ? Object.keys(val).sort().reduce((o, kk) => { o[kk] = val[kk]; return o; }, {})
    : val);

// ---- 从部署中的 server.js 抠出纯函数（与 config-funnel-selftest 同一套 grab）----
const src = fs.readFileSync('server.js', 'utf8');
function grab(name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('未找到函数 ' + name);
  const j = src.indexOf('\n}\n', i);
  if (j < 0) throw new Error('未找到函数结尾 ' + name);
  return src.slice(i, j + 2);
}
const depNames = ['prefixedFolderKey', 'panelCellKey', 'normalizeMaterialIds', 'isSceneKey', 'isPlainObject',
  'normalizeFolderMappings', 'panelNoValue', 'normalizePanelNos', 'isSafeFolderName',
  'dissolveMsValue', 'playSettingsValue', 'normalizePlaySettings',
  'buildPrefixedScenes', 'mergePrefixedMappings', 'roomSceneDigest', 'parseRoomConfig'];
const consts = src.match(/^const (PANEL_NO_MIN|PLAY_ORDERS|PLAY_DISSOLVE_MS_MIN).*$/gm).join('\n');
const sandbox = {};
new Function('exports', 'crypto', consts + '\n' + depNames.map(grab).join('\n')
  + '\nObject.assign(exports,{' + depNames.join(',') + '});')(sandbox, crypto);
const T = sandbox;

(async () => {
  const ts = Date.now();
  const STORE = 'zzps' + ts, RM = 'zzps' + ts;

  // ===== 1. 部署不抖 rev：存量房间的配置在新旧口径下指纹必须相同 =====
  const rooms = await q('SELECT id, config FROM rooms');
  let drift = [];
  rooms.forEach(rw => {
    const cfg = T.parseRoomConfig(rw.config);
    const base = T.roomSceneDigest(cfg);
    // 逐幕合并后**已存在的每一幕**都会带一个确定形状的 play_settings:{}；它若进指纹，
    // 上线瞬间全库 rev 变化。只往已有的幕补 —— 给空配置凭空造一幕本来就不是同一条路径。
    const injected = JSON.parse(JSON.stringify(cfg));
    const sc = injected.scenes || {};
    ['A', 'B'].forEach(k => {
      if (!sc[k]) return;
      sc[k].play_settings = sc[k].play_settings || {};
    });
    if (T.roomSceneDigest(injected) !== base) drift.push(rw.id);
  });
  check('存量 ' + rooms.length + ' 间房：已有各幕补上空 play_settings 后 rev 不变（部署零抖动）', drift.length === 0, drift.join(','));

  // ===== 2. 建临时店/房 =====
  let r = await req('POST', '/api/stores', { name: STORE });
  check('建临时店 ' + STORE, r.code === 200 || r.code === 201 || (r.j && r.j.success), r.buf);
  r = await req('POST', '/api/rooms', { name: RM, store_name: STORE });
  const roomId = r.j && (r.j.id || r.j.room_id);
  check('建临时房 ' + RM, !!roomId, r.buf);

  const cfgOf = async () => {
    const g = await req('GET', '/api/rooms/' + roomId);
    return T.parseRoomConfig(g.j && g.j.config);
  };
  const putCfg = async (cfg) => req('PUT', '/api/rooms/' + roomId, { config: JSON.stringify(cfg) });

  // ===== 3. 写入侧归一 =====
  await putCfg({ scenes: { A: { name: 'A', folder_mappings: {}, windows: [] }, B: { name: 'B', folder_mappings: {}, windows: [] } } });
  const revEmpty = T.roomSceneDigest(await cfgOf());

  await putCfg({
    scenes: {
      A: { play_settings: { '01': { dissolve: true, dissolve_ms: 600, order: 'shuffle' },
                            '02': { dissolve: false, order: 'seq' },
                            'A03': { dissolve: true },
                            '99': { order: 'shuffle' } } },
      B: { play_settings: { '05': { order: 'shuffle', dissolve: false } } }
    }
  });
  let db = await cfgOf();
  // 落库形状的唯一入口是 playSettingsValue：单格键序固定 dissolve → order → dissolve_ms
  check('A 幕：合法格落库、全默认格(02)丢掉、带前缀键(A03)折回格名',
    canon(db.scenes.A.play_settings) === canon({ '01': { dissolve: true, order: 'shuffle', dissolve_ms: 600 }, '03': { dissolve: true, order: 'seq', dissolve_ms: 400 }, '99': { dissolve: false, order: 'shuffle' } }),
    canon(db.scenes.A.play_settings));
  // 键闸与 folder_mappings 同一把（isSafeFolderName），不是 01-30；前端表格只渲染 01-30，
  // 所以 31+ 这种键只有手写 config 才会出现 —— 它照样生效，这是刻意保持的口径一致
  check('两位数以外的文件夹键按 isSafeFolderName 收下（与映射同闸，不另设区间）',
    db.scenes.A.play_settings['99'] !== undefined, JSON.stringify(db.scenes.A.play_settings));
  check('B 幕只改顺序 → 不落 dissolve_ms',
    JSON.stringify(db.scenes.B.play_settings) === JSON.stringify({ '05': { dissolve: false, order: 'shuffle' } }),
    JSON.stringify(db.scenes.B.play_settings));

  // 时长只字符串数字也认（表格里填的就是字符串）
  await putCfg({ scenes: { A: { play_settings: { '07': { dissolve: true, dissolve_ms: '1200' } } } } });
  db = await cfgOf();
  check('incoming 只带 A 幕时 B 幕从 DB 继承', JSON.stringify(db.scenes.B.play_settings) === JSON.stringify({ '05': { dissolve: false, order: 'shuffle' } }), JSON.stringify(db.scenes.B.play_settings));
  check('字符串时长 "1200" → 数字 1200', db.scenes.A.play_settings['07'] && db.scenes.A.play_settings['07'].dissolve_ms === 1200, JSON.stringify(db.scenes.A.play_settings['07']));

  // 显式空表 = 关掉，不能被 DB 旧值继承回来
  await putCfg({ scenes: { A: { play_settings: {} } } });
  db = await cfgOf();
  check('显式 play_settings:{} = 整幕关回默认（不是继承）',
    db.scenes.A.play_settings === undefined || Object.keys(db.scenes.A.play_settings).length === 0,
    JSON.stringify(db.scenes.A.play_settings));

  // ===== 4. 非法值写库前拦住，不静默回落 =====
  r = await putCfg({ scenes: { A: { play_settings: { '01': { order: 'loop' } } } } });
  check('非法 order → 400', r.code === 400, r.code + ' ' + r.buf);
  r = await putCfg({ scenes: { A: { play_settings: { '01': { dissolve: true, dissolve_ms: 99 } } } } });
  check('时长低于下限 → 400', r.code === 400, r.code + ' ' + r.buf);
  r = await putCfg({ scenes: { A: { play_settings: { '01': { dissolve: true, dissolve_ms: 3001 } } } } });
  check('时长超上限 → 400', r.code === 400, r.code + ' ' + r.buf);
  r = await putCfg({ scenes: { A: { play_settings: { '01': { dissolve: true, dissolve_ms: 400.5 } } } } });
  check('小数时长 → 400', r.code === 400, r.code + ' ' + r.buf);
  db = await cfgOf();
  check('被拦的写法没有落库', JSON.stringify(db.scenes.A.play_settings) === JSON.stringify({}), JSON.stringify(db.scenes.A.play_settings));

  // ===== 5. 下发侧：设备拿到的键带幕前缀，且 rev 随之变化 =====
  const DEV = 'zzpsdev' + ts;
  await q("INSERT INTO devices (id,name,authorized,status) VALUES (?,?,0,'offline')", [DEV, 'zzpsprobe']);
  await q('UPDATE devices SET room_id=? WHERE id=?', [roomId, DEV]);
  // B 幕显式清空：不然它会从 DB 继承上一节的 05，"没设置的幕不落键"就测不到本来想测的东西
  await putCfg({ scenes: { A: { play_settings: { '01': { dissolve: true, dissolve_ms: 600, order: 'shuffle' } } },
                           B: { play_settings: {} } } });
  r = await req('POST', '/api/devices/' + DEV + '/command', { command: { action: 'sync_room_materials' } });
  const sc = r.j && r.j.command && r.j.command.scenes;
  check('sync 载荷带 A01（物理目录 id，设备端就按这把键查）',
    !!(sc && sc.A && sc.A.play_settings && sc.A.play_settings.A01
      && sc.A.play_settings.A01.dissolve === true && sc.A.play_settings.A01.dissolve_ms === 600
      && sc.A.play_settings.A01.order === 'shuffle'), JSON.stringify(sc && sc.A && sc.A.play_settings));
  check('没设置的 B 幕不落 play_settings 键', !(sc && sc.B && sc.B.play_settings), JSON.stringify(sc && sc.B));
  const revWith = r.j && r.j.command && r.j.command.rev;
  check('带设置时的 rev 与空配置不同', typeof revWith === 'string' && revWith !== revEmpty, revWith + ' vs ' + revEmpty);

  await putCfg({ scenes: { A: { play_settings: {} }, B: { play_settings: {} } } });
  r = await req('POST', '/api/devices/' + DEV + '/command', { command: { action: 'sync_room_materials' } });
  const revBack = r.j && r.j.command && r.j.command.rev;
  check('关回默认后 rev 回到原值（不会虚报一次变更）', revBack === revEmpty, revBack + ' vs ' + revEmpty);
  check('关回默认后下发里再没有 play_settings',
    !(r.j.command.scenes.A && r.j.command.scenes.A.play_settings), JSON.stringify(r.j.command.scenes.A));

  // ===== 6. 只改播放顺序（不动叠化）也要能下发：APK 靠这份表判 playlist 排法和是否起第二路 =====
  await putCfg({ scenes: { A: { play_settings: { '02': { order: 'shuffle' } } } } });
  r = await req('POST', '/api/devices/' + DEV + '/command', { command: { action: 'sync_room_materials' } });
  check('随机循环单开关也能下发',
    !!(r.j.command.scenes.A.play_settings && r.j.command.scenes.A.play_settings.A02
      && r.j.command.scenes.A.play_settings.A02.order === 'shuffle'
      && r.j.command.scenes.A.play_settings.A02.dissolve === false),
    JSON.stringify(r.j.command.scenes.A.play_settings));

  // ===== 清理 =====
  await q('DELETE FROM devices WHERE id=?', [DEV]);
  r = await req('DELETE', '/api/rooms/' + roomId);
  check('删临时房', r.code === 200, r.buf);
  r = await req('DELETE', '/api/stores/' + encodeURIComponent(STORE));
  check('删临时店', r.code === 200, r.buf);
  const left = await q("SELECT COUNT(*) n FROM rooms WHERE name LIKE 'zzps%'");
  const leftD = await q("SELECT COUNT(*) n FROM devices WHERE id LIKE 'zzps%'");
  const leftS = await q("SELECT COUNT(*) n FROM stores WHERE name LIKE 'zzps%'");
  check('zzps 残留归零', left[0].n === 0 && leftD[0].n === 0 && leftS[0].n === 0,
    'rooms=' + left[0].n + ' devices=' + leftD[0].n + ' stores=' + leftS[0].n);
  const base = await q('SELECT (SELECT COUNT(*) FROM rooms) rm, (SELECT COUNT(*) FROM stores) st, (SELECT COUNT(*) FROM devices) dv, (SELECT COUNT(*) FROM devices WHERE authorized=1) a1');
  console.log('基线 rooms=' + base[0].rm + ' stores=' + base[0].st + ' devices=' + base[0].dv + ' authorized=1 → ' + base[0].a1);

  console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
  conn.end();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('探针异常: ' + e.stack); process.exit(2); });
