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
const src = fs.readFileSync('server.js', 'utf8').replace(/\r\n/g, '\n');
function grab(name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('未找到函数 ' + name);
  // 单行函数按行取，否则会吞到下一个多行函数的结尾（同 config-funnel-selftest）
  const nl = src.indexOf('\n', i);
  if (src.slice(i, nl).indexOf('}') >= 0) return src.slice(i, nl) + '\n';
  const j = src.indexOf('\n}\n', i);
  if (j < 0) throw new Error('未找到函数结尾 ' + name);
  return src.slice(i, j + 2);
}
const depNames = ['prefixedFolderKey', 'panelCellKey', 'normalizeMaterialIds', 'isSceneKey', 'isPlainObject',
  'normalizeFolderMappings', 'isSafeFolderName',
  'playSettingsValue', 'normalizePlaySettings',
  'buildPrefixedScenes', 'mergePrefixedMappings', 'outputPx', 'roomOutputField', 'roomSceneDigest', 'parseRoomConfig'];
const consts = src.match(/^const (PLAY_ORDERS|OUTPUT_MIN_PX).*$/gm).join('\n');
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
      A: { play_settings: { '01': { order: 'shuffle' },
                            '02': { order: 'seq' },
                            'A03': { order: 'shuffle' },
                            '99': { order: 'shuffle' } } },
      B: { play_settings: { '05': { order: 'shuffle' } } }
    }
  });
  let db = await cfgOf();
  // 落库形状的唯一入口是 playSettingsValue：随机格只留 { order: 'shuffle' }，顺序格整格不落
  check('A 幕：随机格落库、默认格(02)丢掉、带前缀键(A03)折回格名',
    canon(db.scenes.A.play_settings) === canon({ '01': { order: 'shuffle' }, '03': { order: 'shuffle' }, '99': { order: 'shuffle' } }),
    canon(db.scenes.A.play_settings));
  // 键闸与 folder_mappings 同一把（isSafeFolderName），不是 01-30；前端表格只渲染 01-30，
  // 所以 31+ 这种键只有手写 config 才会出现 —— 它照样生效，这是刻意保持的口径一致
  check('两位数以外的文件夹键按 isSafeFolderName 收下（与映射同闸，不另设区间）',
    db.scenes.A.play_settings['99'] !== undefined, JSON.stringify(db.scenes.A.play_settings));
  check('B 幕随机格只带 order 一个键',
    JSON.stringify(db.scenes.B.play_settings) === JSON.stringify({ '05': { order: 'shuffle' } }),
    JSON.stringify(db.scenes.B.play_settings));

  // 存量 DB 里可能还留着叠化时代的脏键：写侧归一必须把它们抹掉，且"只有叠化没随机"的格子整格不落
  await putCfg({ scenes: { A: { play_settings: { '07': { dissolve: true, dissolve_ms: '1200' },
                                                 '08': { dissolve: true, dissolve_ms: 600, order: 'shuffle' } } } } });
  db = await cfgOf();
  check('incoming 只带 A 幕时 B 幕从 DB 继承', JSON.stringify(db.scenes.B.play_settings) === JSON.stringify({ '05': { order: 'shuffle' } }), JSON.stringify(db.scenes.B.play_settings));
  check('残留叠化脏键写入时一并丢掉：只剩真正随机的那一格',
    canon(db.scenes.A.play_settings) === canon({ '08': { order: 'shuffle' } }),
    canon(db.scenes.A.play_settings));

  // 点歌屏开关（hdmi）：true 落键，缺省/false 不落键 —— 与 order 同一套"默认不写"，
  // 2026-11-18 用户定调点歌屏默认全关（只有开才落键），存量房间形状不变，部署 rev 不漂移
  await putCfg({ scenes: { A: { play_settings: { '08': { order: 'shuffle', hdmi: true },
                                                 '09': { hdmi: false },
                                                 '10': { hdmi: true } } } } });
  db = await cfgOf();
  check('hdmi:true 落键、hdmi:false 当默认丢掉、两个键可共存',
    canon(db.scenes.A.play_settings) === canon({ '08': { order: 'shuffle', hdmi: true }, '10': { hdmi: true } }),
    canon(db.scenes.A.play_settings));
  r = await putCfg({ scenes: { A: { play_settings: { '01': { hdmi: 'off' } } } } });
  check('hdmi 传字符串 → 400（不静默当关）', r.code === 400, r.code + ' ' + r.buf);

  // DMX512 开关（dmx）：与 hdmi 同一套「true 落键、缺省/false 不落键」，默认全关
  await putCfg({ scenes: { A: { play_settings: { '11': { dmx: true },
                                                 '12': { dmx: false },
                                                 '13': { order: 'shuffle', hdmi: true, dmx: true } } } } });
  db = await cfgOf();
  check('dmx:true 落键、dmx:false 当默认丢掉、三个键可共存',
    canon(db.scenes.A.play_settings) === canon({ '11': { dmx: true },
      '13': { order: 'shuffle', hdmi: true, dmx: true } }),
    canon(db.scenes.A.play_settings));
  r = await putCfg({ scenes: { A: { play_settings: { '01': { dmx: 'on' } } } } });
  check('dmx 传字符串 → 400（不静默当关）', r.code === 400, r.code + ' ' + r.buf);

  // 显式空表 = 关掉，不能被 DB 旧值继承回来
  await putCfg({ scenes: { A: { play_settings: {} } } });
  db = await cfgOf();
  check('显式 play_settings:{} = 整幕关回默认（不是继承）',
    db.scenes.A.play_settings === undefined || Object.keys(db.scenes.A.play_settings).length === 0,
    JSON.stringify(db.scenes.A.play_settings));

  // ===== 4. 非法值写库前拦住，不静默回落 =====
  r = await putCfg({ scenes: { A: { play_settings: { '01': { order: 'loop' } } } } });
  check('非法 order → 400', r.code === 400, r.code + ' ' + r.buf);
  r = await putCfg({ scenes: { B: { play_settings: { '05': { order: 2 } } } } });
  check('order 传数字 → 400（不静默当 seq）', r.code === 400, r.code + ' ' + r.buf);
  r = await putCfg({ scenes: { A: { play_settings: { '01': 'shuffle' } } } });
  check('整格不是对象 → 不报错，按脏形状丢弃（与 folder_mappings 同口径）', r.code === 200, r.code + ' ' + r.buf);
  r = await putCfg({ scenes: { A: { play_settings: { '01': { dissolve: true, dissolve_ms: 600 } } } } });
  check('残留叠化键（没带 order）→ 不报错，归一后整格不落', r.code === 200, r.code + ' ' + r.buf);
  db = await cfgOf();
  check('被拦的写法没有落库', canon(db.scenes.A.play_settings || {}) === canon({}) && canon(db.scenes.B.play_settings || {}) === canon({ '05': { order: 'shuffle' } }),
    canon(db.scenes.A.play_settings) + ' | ' + canon(db.scenes.B.play_settings));

  // ===== 5. 下发侧：设备拿到的键带幕前缀，且 rev 随之变化 =====
  const DEV = 'zzpsdev' + ts;
  await q("INSERT INTO devices (id,name,authorized,status) VALUES (?,?,0,'offline')", [DEV, 'zzpsprobe']);
  await q('UPDATE devices SET room_id=? WHERE id=?', [roomId, DEV]);
  // B 幕显式清空：不然它会从 DB 继承上一节的 05，"没设置的幕不落键"就测不到本来想测的东西
  await putCfg({ scenes: { A: { play_settings: { '01': { dissolve: true, dissolve_ms: 600, order: 'shuffle' } } },
                           B: { play_settings: {} } } });
  r = await req('POST', '/api/devices/' + DEV + '/command', { command: { action: 'sync_room_materials' } });
  const sc = r.j && r.j.command && r.j.command.scenes;
  // 下发只带 order：叠化下线后，脏键既不落库也不下发，设备端拿到的一定是它认得的形状
  check('sync 载荷带 A01 = { order: shuffle }（物理目录 id，设备端就按这把键查）',
    canon(sc && sc.A && sc.A.play_settings && sc.A.play_settings.A01) === canon({ order: 'shuffle' }),
    JSON.stringify(sc && sc.A && sc.A.play_settings));
  check('没设置的 B 幕不落 play_settings 键', !(sc && sc.B && sc.B.play_settings), JSON.stringify(sc && sc.B));
  const revWith = r.j && r.j.command && r.j.command.rev;
  check('带设置时的 rev 与空配置不同', typeof revWith === 'string' && revWith !== revEmpty, revWith + ' vs ' + revEmpty);

  await putCfg({ scenes: { A: { play_settings: {} }, B: { play_settings: {} } } });
  r = await req('POST', '/api/devices/' + DEV + '/command', { command: { action: 'sync_room_materials' } });
  const revBack = r.j && r.j.command && r.j.command.rev;
  check('关回默认后 rev 回到原值（不会虚报一次变更）', revBack === revEmpty, revBack + ' vs ' + revEmpty);
  check('关回默认后下发里再没有 play_settings',
    !(r.j.command.scenes.A && r.j.command.scenes.A.play_settings), JSON.stringify(r.j.command.scenes.A));

  // ===== 6. 随机单开关独立成立：APK 只认 order，再没有第二个字段 =====
  await putCfg({ scenes: { A: { play_settings: { '02': { order: 'shuffle' }, '03': { order: 'seq' } } } } });
  r = await req('POST', '/api/devices/' + DEV + '/command', { command: { action: 'sync_room_materials' } });
  check('随机循环单开关下发、顺序格不落键',
    canon(r.j.command.scenes.A.play_settings) === canon({ A02: { order: 'shuffle' } }),
    JSON.stringify(r.j.command.scenes.A.play_settings));

  // ===== 7. 点歌屏开关随下发到位，翻转进出 rev =====
  const revBeforeHdmi = r.j.command.rev;
  await putCfg({ scenes: { A: { play_settings: { '04': { hdmi: true } } } } });
  r = await req('POST', '/api/devices/' + DEV + '/command', { command: { action: 'sync_room_materials' } });
  check('点歌屏开下发成 A04 = { hdmi: true }',
    canon(r.j.command.scenes.A.play_settings) === canon({ A04: { hdmi: true } }),
    JSON.stringify(r.j.command.scenes.A.play_settings));
  check('点歌屏翻转动 rev', typeof r.j.command.rev === 'string' && r.j.command.rev !== revBeforeHdmi,
    r.j.command.rev + ' vs ' + revBeforeHdmi);
  await putCfg({ scenes: { A: { play_settings: {} } } });
  r = await req('POST', '/api/devices/' + DEV + '/command', { command: { action: 'sync_room_materials' } });
  check('点歌屏关回默认后 rev 回到原值（不虚报变更）', r.j.command.rev === revEmpty,
    r.j.command.rev + ' vs ' + revEmpty);

  // ===== 8. DMX512 控制随下发到位，翻转进出 rev =====
  await putCfg({ scenes: { A: { play_settings: { '06': { dmx: true } } } } });
  r = await req('POST', '/api/devices/' + DEV + '/command', { command: { action: 'sync_room_materials' } });
  check('DMX512 开下发成 A06 = { dmx: true }',
    canon(r.j.command.scenes.A.play_settings) === canon({ A06: { dmx: true } }),
    JSON.stringify(r.j.command.scenes.A.play_settings));
  check('DMX512 翻转动 rev', typeof r.j.command.rev === 'string' && r.j.command.rev !== revEmpty,
    r.j.command.rev + ' vs ' + revEmpty);
  await putCfg({ scenes: { A: { play_settings: { '06': { dmx: false } } } } });
  r = await req('POST', '/api/devices/' + DEV + '/command', { command: { action: 'sync_room_materials' } });
  check('DMX512 关回默认后不下发、rev 回到原值（不虚报变更）',
    !(r.j.command.scenes.A && r.j.command.scenes.A.play_settings) && r.j.command.rev === revEmpty,
    JSON.stringify(r.j.command.scenes.A) + ' ' + r.j.command.rev + ' vs ' + revEmpty);

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
