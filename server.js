/**
 * XVJ 云控系统 - 服务端
 * ========================
 * 架构：Node.js + Express + MySQL + MQTT
 * 端口：3000
 *
 * 【代码索引】编辑时搜索 "【S-XX】" 快速定位
 * ─────────────────────────────────────────────
 * 【S-01】数据库初始化 & MySQL 连接池
 * 【S-02】素材管理 API（GET /api/materials、DELETE /api/materials/:id、POST /api/upload）
 *         注意：没有 POST /api/materials，入库只走 /api/upload
 * 【S-03】预设素材 API（/api/preset/materials*）
 * 【S-04】房间 CRUD API（/api/rooms*，含 PUT /api/rooms/:id/windows）
 * 【S-05】授权 & 设备管理 API（/api/devices*）
 * 【S-06】MQTT 消息处理 & 发送（mqttClient / publishToDeviceCommand / 载荷组装与变更收敛：
 *         roomSceneDigest / roomSyncFields / syncCommandPayload / notifyRoomConfigChanged / reconcileDeviceRev）
 * 【S-07】素材同步 & 删除（POST /api/rooms/:id/sync、DELETE /api/rooms/:roomId/materials/:materialId）
 * 【S-08】日志 & 操作记录（logAction、/api/logs、/api/device_logs）
 * 【S-09】静态文件 & 前端页面
 * 【S-10】文件夹管理 API（/api/folders、/api/folders/note、/api/folders/notes）
 * 【S-11】店铺管理 API（/api/stores*）
 * 【S-12】版本管理 API（/api/versions*、/api/device/version*、push-update）
 * 【S-13】配置 & 默认素材 & 未注册设备（/api/config*、/api/default-materials*、/api/unregistered）
 * ─────────────────────────────────────────────
 *
 * 核心表：
 *   materials          - 素材库（原始视频文件，上传时重封装为 faststart，md5 存的是重封装后的字节）
 *   preset_materials   - 预设素材（从素材库复制，可跨房间复用）
 *   rooms              - 房间配置中心。真相在 config 这个 JSON 列
 *                        （config.scenes.A/B.folder_mappings 才是设备同步依据）；
 *                        表上的 folder_mappings 列是建表遗留，只在 INSERT 时写 '{}'，读侧无人使用
 *   devices            - 设备注册表
 *   operation_logs     - 前端操作日志（logAction 写入，每小时清理 30 天前）
 *   device_logs        - 设备日志（APP MQTT log 主题上报）
 *
 * MQTT 主题（服务端 subscribe('xvj/device/#') + subscribe('xvj/auth/response')）：
 *   入站  xvj/device/register       - 注册（deviceId 在 payload，无第二段，走 lastSlash===-1 分支）
 *   入站  xvj/device/{id}/status    - 心跳/状态，顺带上报 version、model、mac；
 *                                    带 rev（已应用配置指纹）时服务端做对账补发，见 reconcileDeviceRev
 *   入站  xvj/device/{id}/request   - 设备主动请求配置
 *   入站  xvj/device/{id}/log       - 设备日志上报（远程 DEBUG 通道）
 *   入站  xvj/auth/response         - 设备回复 deauthorize
 *   出站  xvj/device/{id}/command   - 服务端命令下发（对 {id, fingerprint} 去重双发，见 publishToDeviceCommand）
 *   出站  xvj/device/{id}/config    - 只有 POST /api/config/:deviceId 会发；该接口与这条主题目前
 *                                    都没有任何调用方（前端和 APK 都不碰），实际处于停用状态
 *   出站  xvj/auth/response         - ⚠️ 全设备共享广播（P1-4 已知：载荷含完整 scenes/folder_mappings）
 *
 * 素材三层架构：
 *   素材库 [M] ──cp2p──→ 预设素材 [P] ──mapPreset──→ 房间 [D]
 *
 * ==========================================================
 * 场景系统（多窗口）
 * ==========================================================
 * 场景数据结构（存储在 rooms.config.scenes，每幕一份）：
 *   {
 *     A: { name: '第一幕',
 *          folder_mappings: { "01": [presetMaterialId, ...], "02": [...] },   // 键是未加前缀的两位编号
 *          windows: [WinConfig, ...],
 *          master: { brightness: Number } },   // 场景总亮度 0..1，服务端在 PUT windows 时夹取
 *     B: { ... }
 *   }
 *   ⚠️ 出口一致性：DB 里存未加前缀的 "01"，凡经 buildPrefixedScenes 下发给设备的
 *   folder_mappings 键一律变成 "A01"/"B01"（避免 A/B 共用物理目录名）。
 *   但 windows 是原样透传的（content.folderId 仍是 "01"），由 APK 端按 A01/01 双键回退查表。
 *
 * WinConfig（窗口配置）：服务端整体透传，不解析下列渲染字段，新增字段无需改代码
 *   {
 *     id: String,        // 窗口唯一ID，如 "win_1"
 *     name: String,       // 显示名称，如 "主屏"
 *     x: Number,          // 左上角 X 坐标（px）
 *     y: Number,          // 左上角 Y 坐标（px）
 *     width: Number,      // 宽度（px）
 *     height: Number,     // 高度（px）
 *     zIndex: Number,    // 层级（越大越上层）
 *     aspectRatio: String | null,  // 如 "16:9"，可选
 *     opacity: Number,    // 0..1 窗口透明度
 *     brightness: Number, // 0..1 窗口亮度（与所在幕 master.brightness 相乘）
 *     enabled: Boolean,   // 窗口显隐，false 时设备不创建播放器
 *     flip: 'none'|'h'|'v',        // 内容镜像
 *     rotation: 0|90|180|270,      // 内容在窗口框内旋转
 *     crop: { x: Number, y: Number, w: Number, h: Number },
 *                         // 输入截取（对标 Arena Slice InputRect）：素材画面内归一化 0..1 的取景区，
 *                         // 设备把该区域拉伸填满窗口框；缺省即全画面 {x:0,y:0,w:1,h:1}
 *     content: {                    // 窗口内容。取值以前端 saveWindows() 实际写入的为准
 *       type: 'SCENE_A' | 'SCENE_B' | 'HDMI' | 'color',
 *                         // SCENE_A/SCENE_B = 播该幕对应文件夹的素材；color 是小写（测试背景）
 *                         // 没有 IMAGE 分支，旧文档里的 'COLOR'/'VIDEO'/'IMAGE' 大写取值都不存在
 *       // type=HDMI 时：
 *       inputIndex?: Number,        // HDMI 输入索引（0-based）
 *       // type=color 时：
 *       color?: String,             // 背景色，如 "#000000"
 *       // type=SCENE_A|SCENE_B 时：
 *       folderId?: String           // 对应素材文件夹 ID，如 "01"（未加场景前缀）
 *     }
 *   }
 *
 * 设备开机流程（详见 MainActivity.kt）：
 *   1. APP 启动 → loadConfig() 读 SharedPreferences 的 scenes_json 缓存 → applySceneConfigs 恢复窗口
 *   2. MQTT 连上 → 发 register → 服务端回 xvj/auth/response（带 scenes）→ 缓存并再次 applySceneConfigs
 *   3. 收到 sync_room_materials / update_windows 等 command → 同步素材或只重排窗口
 *   4. 拿不到 scenes（未授权或离线）→ 停在欢迎视频 / 用 scenes_json 缓存
 *
 * 重要约定：
 *   - 房间是配置中心，设备只是执行器；窗口数据必须按房间隔离（见记忆 xvj-room-isolation）
 *   - 设备身份 = deviceId：APK 首启拿 fingerprint 播种后写进 SharedPreferences，之后不再变
 *     （服务端 sendAuthResponse 只是原样回显 topic 里的 id，不会改派 uuid）；
 *     因历史版本指纹算法不同会漂移，定向下发对 {id, fingerprint} 去重双发兜底
 *   - APK filepath 统一存 /apk/xxx.apk（带前导斜杠），下发 URL = APK_DOWNLOAD_BASE + filepath；
 *     落盘路径才用 path.join(__dirname,'public',filepath)
 *   - 第二幕（场景B）默认窗口为空，由用户手动配置
 *   - 【同步触发口径】房间 config 落库后一律只经 notifyRoomConfigChanged 决定是否打扰设备：
 *     映射变了→sync_room_materials，仅窗口/总亮度变了→update_windows，仅 debug 变了→set_debug，
 *     没变→一条不发。前端不再自己补 POST /sync（手工点「同步当前房间」按钮除外）。
 *     兜底是 rev 对账：命令里带 rev=roomSceneDigest(config)，设备心跳回传已应用的 rev，
 *     服务端发现落后就补发一次（3 分钟/台节流），所以设备离线期间的变更会在上线后收敛。
 */


const express = require('express');
const mysql = require('mysql2');
const mqtt = require('mqtt');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

// 故障记录文件路径
// ⚠️ /workspace/... 是早先容器环境的遗留绝对路径；现在服务跑在裸机上，若该目录不存在，
//    下面的 fs.appendFile 会静默失败（回调 () => {} 没判 err），崩溃信息只剩 journalctl。
//    排障时先确认这个文件到底有没有在长，再看里面有没有内容。
const FAULT_LOG = '/workspace/xvj-backup/故障记录.md';

/**
 * 记录故障信息到文件和 console.error
 * @param {string} type - 故障类型（如 '进程崩溃'）
 * @param {string} msg - 简短消息
 * @param {object} detail - 详细信息
 */
function writeFault(type, msg, detail) {
  const ts = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const entry = `## [${ts}] ${type}\n\n**消息**: ${msg}\n\n**详情**: \`${JSON.stringify(detail)}\`\n\n---\n`;
  fs.appendFile(FAULT_LOG, entry, () => {});
  console.error('[故障记录]', type, msg, detail);
}

// 进程级崩溃捕获
process.on('uncaughtException', (err) => {
  writeFault('进程崩溃 (uncaughtException)', err.message, { stack: err.stack });
});
process.on('unhandledRejection', (reason) => {
  writeFault('Promise拒绝 (unhandledRejection)', String(reason), {});
});
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const config = require('./config');

/**
 * 记录操作日志（异步写入 operation_logs 表）
 * @param {string} action - 操作类型（如 'upload'/'delete'/'authorize'）
 * @param {string} target - 操作对象（如 'material'/'device'/'room'）
 * @param {object} details - 详细信息（JSON 序列化后存储）
 */
function logAction(action, target, details) {
  db.query("INSERT INTO operation_logs (action, target, details) VALUES (?, ?, ?)",
    [action, target, JSON.stringify(details)],
    (err) => { if (err) console.error('日志记录失败:', err.message); }
  );
}

// operation_logs 保留策略：每小时清一次 30 天前的记录（分批防大事务）
setInterval(function() {
  db.query("DELETE FROM operation_logs WHERE created_at < NOW() - INTERVAL 30 DAY LIMIT 20000", function(err) {
    if (err) console.error('operation_logs 清理失败:', err.message);
  });
}, 3600000);

/**
 * 房间映射里的文件夹键 → 带幕前缀的物理键："01" → "A01"。
 * 已带前缀的（"A01" 混在 scenes.A 里）原样返回，绝不产出 "AA01"：
 * 设备会按 AA01 建目录、窗口按 A01 找 → 判空，表现为"同步不完"。
 */
function prefixedFolderKey(sceneKey, folderId) {
  return (folderId.length === 3 && folderId[0] === sceneKey) ? folderId : sceneKey + folderId;
}

/**
 * folder_mappings 的单个值 → 素材 id 字符串数组（唯一入口，读写两侧都过它）。
 * 只认数组：数字/对象是脏数据，直接当空；字符串按"单个 id"收下（历史上真出现过
 * `{"01":"pm_xxx"}`，被下游的 [...v] 炸成字符数组，日志里成过 {"A01":["m","a",…]}）。
 * 数组元素只保留非空字符串，顺带去重 —— rev 才不会因重复项/类型抖动而虚报"配置变了"。
 */
function normalizeMaterialIds(v) {
  if (typeof v === 'string') return v ? [v] : [];
  if (!Array.isArray(v)) return [];
  const seen = new Set();
  const out = [];
  v.forEach(id => {
    if (typeof id === 'string' && id && !seen.has(id)) { seen.add(id); out.push(id); }
  });
  return out;
}

/** 场景键白名单：本模型只有 A/B 两幕。scenes[target] 的 target 来自请求体，
 *  `scenes['__proto__']` 是真值且赋值会写穿 Object.prototype（全进程共享），必须挡。 */
function isSceneKey(k) { return k === 'A' || k === 'B'; }

/** 是不是"普通对象"（排掉 null / 数组 / 字符串数字这些 typeof 也骗人的形状） */
function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

/**
 * 整份 folder_mappings 规范化（写库入口用）：键必须是合法文件夹名（会拼进设备端磁盘路径），
 * 值过 normalizeMaterialIds；空数组的键直接丢弃 —— 与"该文件夹没映射素材"等价，config 更小、rev 更稳。
 */
function normalizeFolderMappings(fm) {
  const out = {};
  if (!isPlainObject(fm)) return out;
  Object.keys(fm).forEach(fid => {
    if (!isSafeFolderName(fid)) return;
    const ids = normalizeMaterialIds(fm[fid]);
    if (ids.length > 0) out[fid] = ids;
  });
  return out;
}

/**
 * 单幕合并：incoming（PUT 整份 config 时带的那一幕）× existing（DB 里的那一幕）→ 落库形状。
 * 三个字段三种"没传"的口径，各自都不能猜：
 *   - folder_mappings：只要带了这个键（含 {} / null / 脏形状）就按传入的规范化结果落库，
 *     完全没带才继承 DB —— 否则映射永远无法清空
 *   - windows：只有非空数组才覆盖。清空窗口走 PUT /rooms/:id/windows —— 那里 windows 是必填
 *     数组，空数组表示"真的一个都不留"，不会和"调用方顺手带了个空 config"混淆
 *   - master：带 brightness 才生效，并 clamp 到 [0,1]
 */
function mergeSceneConfig(incoming, existing, defaultName) {
  var src = isPlainObject(incoming) ? incoming : {};
  var ex = isPlainObject(existing) ? existing : {};
  var mappings = (src.folder_mappings === undefined)
    ? (ex.folder_mappings || {})
    : normalizeFolderMappings(src.folder_mappings);
  var master;
  if (src.master && src.master.brightness != null) {
    var b = parseFloat(src.master.brightness);
    master = { brightness: Math.min(1, Math.max(0, isNaN(b) ? 0 : b)) };
  } else {
    master = ex.master || { brightness: 1 };
  }
  return {
    name: src.name || ex.name || defaultName,
    folder_mappings: mappings,
    windows: (Array.isArray(src.windows) && src.windows.length > 0) ? src.windows : (ex.windows || []),
    master: master
  };
}

/**
 * 将 scenes 对象中的 folder_mappings 键名前缀 scene 标识（A01, B01...）
 * @param {object} scenes - { A: { folder_mappings: { "01": [...] } }, B: { ... } }
 * @returns {object} - { A: { folder_mappings: { "A01": [...] } }, B: { "B01": [...] } }
 * 用途：MQTT 发送时统一格式，避免 A/B 场景共用 "01" 导致物理文件夹冲突
 * 三处归一化（为了让"配置有没有变"可判定，见 roomSceneDigest）：
 *   - 只取 A/B 两幕（见 isSceneKey；DB 里的脏键不会跟着下发，也不会污染返回值原型）
 *   - 文件夹键排序后再生成，DB 里键顺序变了不算内容变了
 *   - 已带幕前缀的键不二次加前缀（见 prefixedFolderKey）；映射值过 normalizeMaterialIds
 */
function buildPrefixedScenes(scenes) {
  var result = {};
  ['A', 'B'].forEach(function(key) {
    var sceneData = (scenes || {})[key];
    if (!sceneData || typeof sceneData !== 'object') return;
    var rawMappings = normalizeFolderMappings(sceneData.folder_mappings);
    var prefixedMappings = {};
    Object.keys(rawMappings).sort().forEach(function(folderId) {
      prefixedMappings[prefixedFolderKey(key, folderId)] = rawMappings[folderId];
    });
    result[key] = {
      name: sceneData.name,
      folder_mappings: prefixedMappings,
      windows: Array.isArray(sceneData.windows) ? sceneData.windows : []
    };
    if (sceneData.master) result[key].master = sceneData.master;
  });
  return result;
}

/**
 * 合并 prefixedScenes 的 A+B folder_mappings 为一个对象（键 A01/B01）
 * sync 命令的 folder_mappings 字段统一用这个（A+B 全量），
 * 消除各发送方语义不一致（曾出现 A-only / curScene-only 导致 APK 误清另一幕文件）
 */
function mergePrefixedMappings(prefixedScenes) {
  const src = prefixedScenes || {};
  const fmA = (src.A && src.A.folder_mappings) || {};
  const fmB = (src.B && src.B.folder_mappings) || {};
  const merged = {};
  Object.keys(fmA).forEach(k => { merged[k] = normalizeMaterialIds(fmA[k]); });
  Object.keys(fmB).forEach(k => {
    const b = normalizeMaterialIds(fmB[k]);
    if (merged[k]) {
      b.forEach(id => { if (!merged[k].includes(id)) merged[k].push(id); });
    } else {
      merged[k] = b;
    }
  });
  return merged;
}

/**
 * 房间配置的"内容指纹"（rev）：只覆盖会影响设备播放的字段（A/B 两幕的映射+窗口+总亮度）。
 * 用途有两处：① 写接口落库后比对新旧，配置真变了才打扰设备；② 随命令下发给设备，
 * 设备心跳回传，服务端发现不一致就补发一次同步（对账，替代"每个入口都记得补一枪"）。
 * 键序已由 buildPrefixedScenes 归一化；A/B 显式定序，避免 DB 里键顺序变了被当成内容变了。
 * ⚠️ 指纹只算 scenes，不含 debug —— debug 走轻量的 set_debug，不该触发素材同步。
 */
function roomSceneDigest(cfg) {
  const p = buildPrefixedScenes((cfg && cfg.scenes) || {});
  return crypto.createHash('sha1').update(JSON.stringify([p.A || null, p.B || null])).digest('hex').slice(0, 12);
}

/**
 * 素材映射指纹：只覆盖 folder_mappings（决定"设备上该有哪些文件"）。
 * 用来区分"要重新对账素材"和"只是窗口位置/亮度变了"，后者发轻量 update_windows 就够了。
 */
function roomMappingDigest(cfg) {
  const p = buildPrefixedScenes((cfg && cfg.scenes) || {});
  const m = p.A ? p.A.folder_mappings : {}, n = p.B ? p.B.folder_mappings : {};
  return crypto.createHash('sha1').update(JSON.stringify([m, n])).digest('hex').slice(0, 12);
}

/** 组装 update_windows 载荷（轻量：APK 原地改视图，结构变化时自行回退全量重建；不触碰素材） */
function windowCommandPayload(roomId, cfg) {
  return {
    action: 'update_windows',
    room_id: roomId,
    scenes: buildPrefixedScenes((cfg && cfg.scenes) || {}),
    rev: roomSceneDigest(cfg),
    timestamp: Date.now()
  };
}

/** 房间的调试模式标志（config.debug 严格 true 才算开，与所有下发口径一致） */
function roomDebugFlag(cfg) { return !!(cfg && cfg.debug === true); }

/**
 * MQTT topic 里解出的设备 ID 白名单：字母数字/-/_ ，1~64 位（真实 ID 是 64 位十六进制 UUID）。
 * 这个值会进 `UPDATE devices ... WHERE id LIKE ?` 的 LIKE 模式：不带 % 转义时，
 * 一个发布到 xvj/device/%/status 的 "%" 就能改掉全库所有非 blocked 设备的状态。
 * topic 是任何能连上 broker 的客户端都能自由填的，所以入口先卡形状。
 */
function isSafeDeviceId(s) { return typeof s === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(s); }

/**
 * 安全解析 rooms.config：脏数据按空配置处理，绝不让一次解析异常把通知链路带崩。
 * 一律返回"普通对象"：数组/字符串/数字这类合法 JSON 但不是配置形状的值，也当空配置，
 * 否则调用方 cfg.scenes 拿到 undefined 还算好事，拿到 "abc".scenes 就是另一个故事了。
 */
function parseRoomConfig(s) {
  if (isPlainObject(s)) return s;
  if (typeof s !== 'string') return {};
  var parsed;
  try { parsed = JSON.parse(s); } catch (e) { return {}; }
  return isPlainObject(parsed) ? parsed : {};
}

/**
 * 一份房间 config → 设备"按这份配置播"所需的全部字段。
 * auth_result 与 sync_room_materials 共用，两条链路的口径不会再各写各的漏字段。
 */
function roomSyncFields(cfg) {
  const prefixedScenes = buildPrefixedScenes((cfg && cfg.scenes) || {});
  return {
    scenes: prefixedScenes,                                    // folder_mappings 键已带幕前缀（A01/B01）
    folder_mappings: mergePrefixedMappings(prefixedScenes),     // A+B 全量，与 HTTP 清单接口同形
    debug: roomDebugFlag(cfg),
    rev: roomSceneDigest(cfg)
  };
}

/** 组装 sync_room_materials 载荷（各发送方共用一份，不再各写各的字段） */
function syncCommandPayload(roomId, cfg) {
  return Object.assign(
    { action: 'sync_room_materials', room_id: roomId },
    roomSyncFields(cfg),
    { timestamp: Date.now() }
  );
}

/**
 * 【同步时机的唯一收敛点】房间 config 落库后调用：真变了才打扰设备，且按变化性质选最轻的那条命令。
 * - folder_mappings 变了   → sync_room_materials（全量对账，可能要下载，会重建窗口）
 * - 只有窗口/总亮度变了    → update_windows（APK 原地改视图，不碰素材；结构变化时自行回退重建）
 * - 只有 debug 变了        → set_debug（轻量，不动素材、不重建，见 APK setDebugMode）
 * - 都没变                 → 一条都不发：前端补写、脚本幂等写、重复 PUT 都不再产生第二次重建
 * 这条规则替代了原先"每个写接口各自记得通知 / 前端各自补一枪"的分散时机，
 * 因此 rmRoomMat、doPushToRoom 这类"先 PUT 再 DELETE 再 sync"的连写会自然收敛成一次下发。
 * @param {string} roomId
 * @param {string|object} oldCfgStr - 落库前的 rooms.config
 * @param {string|object} newCfgStr - 落库后的 rooms.config
 * @param {string} reason - 日志里标明是哪个入口触发的
 * @param {(n:number)=>void} [cb] - 回调收到实际通知的设备数
 */
function notifyRoomConfigChanged(roomId, oldCfgStr, newCfgStr, reason, cb) {
  const oldCfg = parseRoomConfig(oldCfgStr);
  const newCfg = parseRoomConfig(newCfgStr);
  let payload = null;
  let label = '';
  if (roomMappingDigest(oldCfg) !== roomMappingDigest(newCfg)) {
    payload = syncCommandPayload(roomId, newCfg);
    label = '素材映射';
  } else if (roomSceneDigest(oldCfg) !== roomSceneDigest(newCfg)) {
    payload = windowCommandPayload(roomId, newCfg);
    label = '窗口';
  } else if (roomDebugFlag(oldCfg) !== roomDebugFlag(newCfg)) {
    payload = { action: 'set_debug', debug: roomDebugFlag(newCfg), timestamp: Date.now() };
    label = '调试模式';
  }
  if (!payload) { if (cb) cb(0); return; }

  db.query(
    'SELECT id, fingerprint FROM devices WHERE room_id = ? AND authorized = 1',
    [roomId],
    (err, devices) => {
      if (err || !devices || devices.length === 0) { if (cb) cb(0); return; }
      devices.forEach(d => publishToDeviceCommand(d, payload));
      console.log(`🔔 [${reason}] 房间 ${roomId} ${label}变更 → 已通知 ${devices.length} 台设备 (${payload.action})`);
      if (cb) cb(devices.length);
    }
  );
}

const app = express();
const PORT = config.port;

/**
 * API 认证中间件（验证 x-api-key 头或 ?apiKey= 查询参数，值取 config.apiKey）
 * ⚠️ 密钥目前内嵌在前端 index.html 里，公开可提取 —— 写接口等于无鉴权（P3-10，待登录态改造）
 * @param {object} req - Express 请求对象
 * @param {object} res - Express 响应对象
 * @param {function} next - 下一个中间件
 */
function requireAuth(req, res, next) {
  const apiKey = req.headers['x-api-key'] || req.query.apiKey;
  if (!apiKey || apiKey !== config.apiKey) {
    return res.status(401).json({ error: '未授权', message: '无效的 API 密钥' });
  }
  next();
}

// Middleware
app.use(cors());
app.use(express.json());

// 写操作统一要求 API 密钥；GET/OPTIONS/HEAD 全开放。
// 设备侧确实只做 GET（/api/config、/api/room-materials-v2），其余通信全走 MQTT；
// 但 POST /api/device/version 与 POST /api/log 也是写接口，同样要带 key —— 现有 APK 不调它们
// （版本上报走 status 心跳字段，日志走 xvj/device/{id}/log），这两个 HTTP 口是给脚本/旧版留的。
app.use('/api', (req, res, next) => {
  if (req.method === 'GET' || req.method === 'OPTIONS' || req.method === 'HEAD') return next();
  requireAuth(req, res, next);
});

// 【S-09】 静态页面入口。
// ⚠️ 浏览器实际访问的是 80 端口的 nginx（root=/var/www/xvj/public，index.html 由 nginx 直出并带
//    Cache-Control: no-cache），这条 :3000 路由只在 curl 直连本机时命中，改这里不会改变用户看到的内容。
app.get('/', (req, res) => {
  res.sendFile('/var/www/xvj/index.html');
});

// mqtt.js 浏览器端库
app.get('/mqtt.min.js', (req, res) => {
  res.sendFile(__dirname + '/public/mqtt.min.js');
});

// 静态文件服务：素材文件（视频、图片、缩略图）
// 文件名由服务端生成（时间戳+uuid+ASCII 基名），不会复用同名 → 可安全强缓存，重复预览直接命中。
// ⚠️ 浏览器实际走 80 端口、由 nginx 直出该目录（root=/var/www/xvj/public），
//    所以 /etc/nginx/conf.d/xvj.conf 的 location /uploads/ 必须配同样的头，两处要一起改。
app.use('/uploads', express.static(__dirname + '/public/uploads', {
  maxAge: '1d',
  setHeaders: (res) => res.setHeader('Cache-Control', 'public, max-age=86400')
}));

// 【S-09a】 获取服务器配置（供设备使用，返回 serverUrl / mqttHost / mqttPort）
app.get('/api/config', (req, res) => {
  res.json({
    serverUrl: config.serverUrl,
    mqttHost: config.mqtt.host,
    mqttPort: config.mqtt.port
  });
});

// ============================================================================
// 📦 【S-01】数据库连接池（真正的建表/迁移在文件末尾的 initDatabase 里）
// ============================================================================
// MySQL 连接配置
const db = mysql.createPool({
  host: config.database.host,
  user: config.database.user,
  password: config.database.password,
  database: config.database.name,
  charset: 'utf8mb4',
  waitForConnections: true,
  connectionLimit: 10
});

// ============================================================================
// 📡 【S-06】MQTT 配置与消息处理
//    订阅：xvj/device/#（register|status|request|log|command 五种尾段）+ xvj/auth/response
//    发布：xvj/device/{id}/command（指令）、xvj/device/{id}/config（配置回写）、
//          xvj/auth/response（授权响应，⚠️ 广播，所有设备都订阅同一条）
//    主题明细见文件头 "MQTT 主题" 段
// ============================================================================
const mqttBroker = `mqtt://${config.mqtt.host}:${config.mqtt.port}`;

// 服务端凭据只从 config.mqtt 读（broker 鉴权三阶段见记忆 xvj-server-access）
const mqttOptions = {
  clientId: 'xvj_server_' + Math.random().toString(16).substr(2, 8),
  cleanSession: true
};
if (config.mqtt.username) {
  mqttOptions.username = config.mqtt.username;
  mqttOptions.password = config.mqtt.password;
}

const mqttClient = mqtt.connect(mqttBroker, mqttOptions);

mqttClient.on('connect', () => {
  console.log('✅ MQTT 连接成功');
  mqttClient.subscribe('xvj/device/#');
  mqttClient.subscribe('xvj/auth/response');
});

mqttClient.on('message', (topic, message) => {
  const msg = message.toString();
  console.log(`收到消息 [${topic}]: ${msg}`);
  // 打印所有消息类型帮助debug
  if (topic.includes('/status')) {
    console.log('📡 心跳消息收到！');
  }
  handleMqttMessage(topic, msg);
});

// ============================================================================
// 🔐 设备消息处理 — handleMqttMessage
//    接收设备状态/注册消息，更新数据库，发授权响应
// ============================================================================

/**
 * MQTT 消息分发处理器
 * @param {string} topic - MQTT 主题（如 xvj/device/{id}/status）
 * @param {string} message - 消息体（JSON 字符串）
 * 处理：register/status/request/log/command 等消息类型
 */
function handleMqttMessage(topic, message) {
  // xvj/auth/response - 设备回复授权状态（如 deauthorize）
  if (topic === 'xvj/auth/response') {
    try {
      const data = JSON.parse(message);
      if (data.action === 'deauthorize') {
        console.log('📩 收到设备主动 deauthorize: ' + data.device_id);
        // blocked（屏蔽）设备不被降级，防止 block 接口自己的 MQTT 通知回环覆盖屏蔽状态
        db.query('UPDATE devices SET authorized=0, status="deauthorized" WHERE id=? AND status<>"blocked"', [data.device_id]);
      }
    } catch(e) {}
    return;
  }
  
  // 固定前缀: xvj/device/
  const PREFIX = 'xvj/device/';
  if (!topic.startsWith(PREFIX)) {
    return;
  }
  
  const afterPrefix = topic.substring(PREFIX.length);
  const lastSlash = afterPrefix.lastIndexOf('/');
  
  if (lastSlash === -1) {
    // 格式: xvj/device/register （设备发的注册消息，deviceId在payload里）
    console.log('⚠️ topic格式异常（尝试从payload提取deviceId）: ' + topic);
    try {
      const data = JSON.parse(message);
      if (data.device_id && isSafeDeviceId(data.device_id)) {
        // 手动路由到 register 处理
        handleDeviceRegister(data.device_id, data);
      }
    } catch(e) {}
    return;
  }
  
  const deviceId = afterPrefix.substring(0, lastSlash);
  const msgType = afterPrefix.substring(lastSlash + 1);
  // ID 形状先卡死（见 isSafeDeviceId）：status 分支拿它拼 SQL 的 LIKE，通配符会让一发心跳改全库
  if (!isSafeDeviceId(deviceId)) {
    console.warn('⚠️ 设备 ID 形状非法，消息已丢弃: ' + topic);
    return;
  }
  
  try {
    let data = null;
    try { data = JSON.parse(message); } catch(e) { /* 非JSON消息 */ }
    
    // debug: parse
    switch (msgType) {
      case 'register':
        if (!data) break;
        handleDeviceRegister(deviceId, data);
        break;
      case 'status': {
        if (!data) break;
        const isOnline = data.status === 'online';
        const fingerprint = data.fingerprint || deviceId;
        const searchId = deviceId.substring(0, 32);
        db.query(
          "UPDATE devices SET status = ?, status_data = ?, online_time = NOW() WHERE (id = ? OR fingerprint = ? OR id LIKE ? OR id LIKE ?) AND status <> 'blocked'",
          [isOnline ? 'online' : 'offline', message, deviceId, fingerprint, deviceId + '%', searchId + '%'],
          (err, result) => {
            if (err) console.error('更新设备状态失败:', err.message);
            if (result && result.affectedRows > 0) {
              // 心跳不写 operation_logs：30s/台的频率会无界膨胀该表，在线状态由 devices.status/online_time 表达
              console.log((isOnline ? '✅ 心跳(online): ' : '⚪ 心跳(offline): ') + deviceId);
            }
            if (result && result.affectedRows === 0 && isOnline) {
              console.log('📱 创建新设备记录: ' + deviceId);
              db.query(
                `INSERT INTO devices (id, name, fingerprint, model, hardware, mac, status, authorized, online_time, first_seen) 
                 VALUES (?, ?, ?, ?, ?, ?, 'online', 0, NOW(), NOW())
                 ON DUPLICATE KEY UPDATE status=IF(status<>'blocked','online',status), online_time=IF(status<>'blocked',NOW(),online_time), fingerprint=COALESCE(fingerprint, VALUES(fingerprint))`,
                [deviceId, '未命名设备', fingerprint, data.model || '', data.hardware || '', data.mac || '']
              );
            } else if (result && result.affectedRows > 0) {
              console.log('✅ 设备状态已更新: ' + deviceId);
            }
            // 设备版本上报：status 消息携带 version/version_code 时同步 device_versions
            if (data.version || data.version_code) {
              const vCode = parseInt(data.version_code, 10) || 0;
              db.query(
                'INSERT INTO device_versions (device_id, version, version_code) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE version = ?, version_code = ?',
                [deviceId, data.version || '', vCode, data.version || '', vCode],
                (verr) => { if (verr) console.error('同步设备版本失败:', verr.message); }
              );
            }
            // 配置对账：心跳带回 rev 且不在下载中时，比一比房间真值，落后了就补发同步
            if (isOnline && data.rev && data.syncing !== true) {
              reconcileDeviceRev(deviceId, data.rev);
            }
          }
        );
        break;
      }
      case 'request':
        console.log('🔐 设备请求授权状态: ' + deviceId);
        db.query('SELECT authorized, room_id FROM devices WHERE id = ?', [deviceId], (err, rows) => {
          if (err || !rows || rows.length === 0) {
            sendAuthResponse(deviceId, false, '设备未注册', '');
          } else {
            const authorized = rows[0].authorized === 1;
            sendAuthResponse(deviceId, authorized, authorized ? '已授权' : '未授权', rows[0].room_id);
          }
        });
        break;
      case 'log': {
        const payload = message.toString();
        const spaceIdx = payload.indexOf(' ');
        const logTime = spaceIdx > 0 ? payload.substring(0, spaceIdx) : payload;
        // APK payload 格式: "time LEVEL module action msg..."，time 已剥离，首段为级别
        let logMsg = spaceIdx > 0 ? payload.substring(spaceIdx + 1) : payload;
        let level = 'info';
        const lvSeg = logMsg.split(' ')[0];
        if (['ERROR', 'WARN', 'INFO', 'DEBUG'].includes(lvSeg)) {
          level = lvSeg.toLowerCase();
        }
        console.log('📝 写日志: deviceId=' + deviceId + ' time=' + logTime + ' level=' + level + ' msg=' + logMsg.substring(0, 60));
        db.query(
          'INSERT INTO device_logs (device_id, log_time, level, message) VALUES (?, ?, ?, ?)',
          [deviceId, logTime, level, logMsg],
          (err) => {
            if (err) return console.error('写device_logs失败:', err.message);
            // 防膨胀：约2%概率触发，按设备分区各保留最新 2000 条（全局上限会被多台设备分摊掉排障窗口）
            if (Math.random() < 0.02) {
              db.query('DELETE FROM device_logs WHERE id IN (SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY device_id ORDER BY id DESC) rn FROM device_logs) t WHERE rn > 2000)');
            }
          }
        );
        break;
      }
      case 'command':
        if (!data) break;
        console.log('📨 设备命令: ' + deviceId + ' -> ' + JSON.stringify(data));
        break;
    }
  } catch (e) {
    console.error('消息解析失败:', e);
  }
}

/**
 * 设备注册处理（MQTT register 消息入口）
 * @param {string} deviceId - 设备 ID
 * @param {object} data - 设备注册数据（fingerprint/model/hardware/mac 等）
 * 流程：查询 devices 表 → 新设备待审核 / 未授权拒绝 / 已授权发送响应
 */
function handleDeviceRegister(deviceId, data) {
  // debug: handleDeviceRegister
  const fingerprint = data.fingerprint || deviceId;
  
  // 查询设备是否已授权
  console.log(`🔎 开始查询设备: ${deviceId}, 指纹: ${fingerprint}`);
  db.query(
    'SELECT * FROM devices WHERE id = ? OR fingerprint = ?',
    [deviceId, fingerprint],
    (err, results) => {
      console.log(`🔎 SELECT callback: err=${err ? err.message : 'null'}, results.length=${results ? results.length : 'undefined'}`);
      if (err) {
        console.error('❌ 查询设备失败:', err.message);
        return;
      }
      
      if (results.length === 0) {
        // 新设备 - 默认不自动授权，需要后台手动审核
        console.log(`⚠️ 新设备尝试注册: ${deviceId}, 指纹: ${fingerprint}`);
        db.query(
          `INSERT INTO devices (id, name, fingerprint, model, hardware, mac, status, authorized, online_time, first_seen)
           VALUES (?, ?, ?, ?, ?, ?, 'online', 0, NOW(), NOW())
           ON DUPLICATE KEY UPDATE status=IF(status<>'blocked','online',status), online_time=IF(status<>'blocked',NOW(),online_time)`,
          [deviceId, data.device_id || deviceId, fingerprint, data.model, data.hardware, data.mac]
        );
        sendAuthResponse(deviceId, false, '等待审核授权', '');
      } else {
        const device = results[0];

        // 屏蔽（忽略）设备：拒绝注册且不更新状态，防止删除后重新注册复活
        if (device.status === 'blocked') {
          console.log(`⛔ 屏蔽设备尝试上线: ${deviceId}`);
          sendAuthResponse(deviceId, false, '设备已被屏蔽，请联系管理员', '');
          return;
        }

        if (device.authorized === 0 || device.authorized === false) {
          // 设备未授权
          console.log(`❌ 设备被拒绝: ${deviceId}, 原因: 未授权`);
          sendAuthResponse(deviceId, false, '设备未授权，请联系管理员', '');
        } else {
          // 已授权设备
          console.log(`✅ 设备授权通过: ${deviceId}`);
          console.log(`🔧 准备更新设备信息并发送授权响应...`);

          // 更新设备信息
          db.query(
            `UPDATE devices SET status='online', online_time=NOW(), 
             fingerprint=?, model=?, hardware=?, mac=? 
             WHERE id = ?`,
            [fingerprint, data.model, data.hardware, data.mac, deviceId]
          );
          
          sendAuthResponse(deviceId, true, '欢迎回来', device.room_id || '');
        }
      }
    }
  );
}

// ============================================================================
// 📤 发送授权响应 — sendAuthResponse
//    设备上线时调用，发 MQTT 给设备，告知授权结果和播放配置（含 rev）
//    授权响应自带全套同步字段，设备端收到即自行同步，无需再补发 sync 命令
// ============================================================================

// 发送授权响应
function sendAuthResponse(deviceId, authorized, message, roomId) {
  // debug: sendAuthResponse
  // FIX: 改为 xvj/auth/response，与 APP 订阅的 AUTH_TOPIC 对应
  const topic = `xvj/auth/response`;

  // 如果授权成功，获取房间的素材配置
  if (authorized && roomId) {
    // 同步获取房间素材配置
    const roomQuery = `SELECT config FROM rooms WHERE id = ?`;
    db.query(roomQuery, [roomId], (err, results) => {
      if (!err && results.length > 0) {
        try {
          const roomConfig = parseRoomConfig(results[0].config);

          // 授权响应本身就带全套播放字段（scenes/folder_mappings/debug/rev），
          // 设备端 handleAuthResponse 收到即自行同步 —— 所以这里**不再**补发 sync_room_materials。
          // 以前两者都发：一次授权/重连 = 两轮并发全量对账 + 最多 4 次 applySceneConfigs 全量重建
          // （视频从头播 4 遍），且两轮会把同一只缺失素材同时写进同一个文件。
          const payload = Object.assign({
            action: 'auth_result',
            device_id: deviceId,
            authorized: true,
            message: message,
            room_id: roomId || ''
          }, roomSyncFields(roomConfig), { timestamp: Date.now() });

          mqttClient.publish(topic, JSON.stringify(payload), { qos: 1 });
          console.log(`📤 已推送授权+播放配置到设备 ${deviceId}, 房间: ${roomId}, rev=${payload.rev}`);

        } catch (e) {
          console.error('解析room config失败:', e);
          // 即使解析失败也发送授权响应
          const payload = JSON.stringify({
            action: 'auth_result',
            device_id: deviceId,
            authorized: true,
            message: message,
            room_id: roomId || '',
            folder_mappings: {},
            debug: false,
            timestamp: Date.now()
          });
          mqttClient.publish(topic, payload);
        }
      } else {
        // 查不到房间配置，也发送授权响应
        const payload = JSON.stringify({
          action: 'auth_result',
          device_id: deviceId,
          authorized: true,
          message: message,
          room_id: roomId || '',
          folder_mappings: {},
          debug: false,
          timestamp: Date.now()
        });
        mqttClient.publish(topic, payload);
      }
    });
  } else {
    // 未授权
    const payload = JSON.stringify({
      action: 'auth_result',
      device_id: deviceId,
      authorized: authorized,
      message: message,
      room_id: roomId || '',
      folder_mappings: {},
      timestamp: Date.now()
    });
    mqttClient.publish(topic, payload);
  }
}

/**
 * 【审查修复 2026-09-11】统一定向设备下发。
 * APK 订阅的 command topic 用本机 deviceId（存 SharedPreferences，跨 OTA 不变），
 * 而 devices.fingerprint 列在设备升级后可能重算漂移（旧版指纹含版本号）。
 * 单按 fingerprint 或单按 id 定向都存在 OTA 后"发给没人订阅的 topic"的窗口，
 * 故对 {id, fingerprint} 去重后双发，确保任何阶段设备都能收到。
 * @param {{id:string, fingerprint:?string}} device
 * @param {object} payloadObj - 命令对象
 */
function publishToDeviceCommand(device, payloadObj) {
  var targets = [];
  if (device && device.id) targets.push(device.id);
  if (device && device.fingerprint && targets.indexOf(device.fingerprint) === -1) targets.push(device.fingerprint);
  if (targets.length === 0) return 0;
  var buf = JSON.stringify(payloadObj);
  targets.forEach(function(t) {
    mqttClient.publish('xvj/device/' + t + '/command', buf, { qos: 1 });
  });
  return targets.length;
}

/**
 * 向指定房间的所有在线授权设备推送**全量** sync_room_materials（不判变更，手工同步/批量推送用）。
 * 载荷一律由 syncCommandPayload 生成，与授权响应、自动通知三者同构，避免各处字段口径漂移。
 * @param {string} roomId - 房间ID
 * @param {(n:number)=>void} [cb] - 回调实际通知的设备数
 */
function notifyRoomDevicesOfSync(roomId, cb) {
  db.query('SELECT config FROM rooms WHERE id = ?', [roomId], (err, rows) => {
    if (err || !rows || rows.length === 0) { if (cb) cb(0); return; }
    const payload = syncCommandPayload(roomId, parseRoomConfig(rows[0].config));
    db.query(
      'SELECT id, fingerprint FROM devices WHERE room_id = ? AND authorized = 1',
      [roomId],
      (err2, devices) => {
        if (err2 || !devices || devices.length === 0) { if (cb) cb(0); return; }
        devices.forEach(d => publishToDeviceCommand(d, payload));
        console.log(`📦 [notify] 房间 ${roomId} 全量同步 → ${devices.length} 台设备 (rev=${payload.rev})`);
        if (cb) cb(devices.length);
      }
    );
  });
}

/**
 * 给单台设备推指定房间的全量播放配置（绑定房间这类"点对点"场景）。
 * 载荷同 syncCommandPayload，与房间广播完全同构。
 * @param {{id:string, fingerprint:?string}} device
 * @param {string} roomId
 * @param {string|object} roomCfg - rooms.config 原文或已解析对象
 * @param {string} reason - 日志里标明触发入口
 */
function notifyDeviceRoomConfig(device, roomId, roomCfg, reason) {
  const payload = syncCommandPayload(roomId, parseRoomConfig(roomCfg));
  publishToDeviceCommand(device, payload);
  console.log(`🔔 [${reason}] 设备 ${device.id} ← 房间 ${roomId} 全量配置 (rev=${payload.rev})`);
}

/**
 * 【配置对账】心跳带回 rev（设备已应用的房间配置指纹）时，服务端拿房间真值比一比。
 * 不一致就补发一次全量同步，覆盖三类"通知发过但没落地"：推送时设备正好离线、
 * MQTT 实际是 QoS0（APK 以 0 订阅，服务端 QoS1 会被降级）、命令发出后设备崩溃重启。
 * 有了这条，写接口就不必再"每个入口都记得补一枪"，离线期间的变更最迟一个心跳周期收敛。
 * 节流：心跳 30s/台，同一设备 3 分钟内最多补发一次；设备上报 syncing=true（正在下载素材）
 * 时直接跳过，避免长下载被反复打断 —— 下载完成后下一次心跳会再来对账。
 * 老版本 APK 心跳不带 rev → 整条路径跳过，不影响现有在网设备。
 * @param {string} mqttId - 心跳 topic 里解出的设备 ID
 * @param {string} reportedRev - 设备已应用的配置指纹
 */
const REV_RECONCILE_MIN_INTERVAL = 180000;
const revReconcileAt = new Map();   // deviceId -> 上次补发时间戳（补发过才记账）

function reconcileDeviceRev(mqttId, reportedRev) {
  const now = Date.now();
  if (now - (revReconcileAt.get(mqttId) || 0) < REV_RECONCILE_MIN_INTERVAL) return;
  db.query(
    'SELECT id, fingerprint, room_id, authorized FROM devices WHERE id = ? OR fingerprint = ?',
    [mqttId, mqttId],
    (err, rows) => {
      if (err || !rows || rows.length === 0) return;
      const d = rows[0];
      if (d.authorized !== 1 || !d.room_id) return;
      db.query('SELECT config FROM rooms WHERE id = ?', [d.room_id], (e2, rr) => {
        if (e2 || !rr || rr.length === 0) return;
        const cfg = parseRoomConfig(rr[0].config);
        const want = roomSceneDigest(cfg);
        if (want === reportedRev) return;
        // 记账：读的是 mqttId，写也必须写 mqttId —— 之前写的是 d.id，按指纹上报的设备
        // （OTA 后 mqttId ≠ 库 id）节流键永远对不上，等于每次心跳都补发一轮全量同步
        revReconcileAt.set(mqttId, now);
        if (d.id !== mqttId) revReconcileAt.set(d.id, now);
        if (revReconcileAt.size > 500) {
          revReconcileAt.forEach((t, k) => { if (now - t > REV_RECONCILE_MIN_INTERVAL * 10) revReconcileAt.delete(k); });
        }
        const payload = syncCommandPayload(d.room_id, cfg);
        publishToDeviceCommand(d, payload);
        console.log(`🩺 [对账] 设备 ${d.id} rev=${reportedRev} ≠ 房间 ${d.room_id} rev=${want} → 补发同步`);
      });
    }
  );
}

// ==================== API 接口 ====================

// 【S-05a】 获取设备列表（支持按 room_id 筛选）
app.get('/api/devices', (req, res) => {
  const roomId = req.query.room_id;
  let sql = 'SELECT * FROM devices ORDER BY online_time DESC';
  let params = [];
  if (roomId) {
    sql = 'SELECT * FROM devices WHERE room_id = ? ORDER BY online_time DESC';
    params = [roomId];
  }
  db.query(sql, params, (err, results) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(results);
  });
});

// 【S-05c】 手工添加设备接口已移除：绕过审核直接 authorized=1 与注册审批流程矛盾，且前端无入口

// 授权失效广播（删记录 / 屏蔽 / 废止 三处共用）。
// ⚠️ 仍是全设备可见的广播（P1-4 延后项：改定向得先让 APK 双订阅新旧两个主题），
//    设备端按 payload 里的 device_id 自己比对认领，不匹配就忽略。
function publishAuthRevoked(deviceId, reason) {
  mqttClient.publish('xvj/auth/response',
    JSON.stringify({ action: 'deauthorize', device_id: deviceId, message: reason }));
}

// 【S-05d】 删除设备记录 — 仅限未授权设备；级联清理版本/日志，通知设备端授权失效
// 注意：设备若仍在线会重新注册再次出现，要永久屏蔽请用「忽略」（POST /api/devices/:id/block）
app.delete('/api/devices/:id', (req, res) => {
  const did = req.params.id;
  db.query('SELECT authorized FROM devices WHERE id = ?', [did], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!rows || rows.length === 0) return res.status(404).json({ error: '设备不存在' });
    if (rows[0].authorized === 1) return res.status(409).json({ error: '设备已授权，请先解绑或废止后再删除' });
    publishAuthRevoked(did, '设备记录已被删除');
    db.query('DELETE FROM device_versions WHERE device_id = ?', [did], () => {
      db.query('DELETE FROM device_logs WHERE device_id = ?', [did], () => {
        db.query('DELETE FROM devices WHERE id = ?', [did], (err2) => {
          if (err2) return res.status(500).json({ error: err2.message });
          logAction('delete', 'device', { id: did });
          res.json({ success: true });
        });
      });
    });
  });
});

// 【S-05g】 屏蔽（忽略）设备 — status='blocked'，保留行作黑名单；
// register/status 上线消息不再使其复活，也不出现在未注册列表
app.post('/api/devices/:id/block', (req, res) => {
  const deviceId = req.params.id;
  db.query('SELECT authorized FROM devices WHERE id = ?', [deviceId], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!rows || rows.length === 0) return res.status(404).json({ error: '设备不存在' });
    if (rows[0].authorized === 1) return res.status(409).json({ error: '设备已授权，不能屏蔽运行中的设备' });
    db.query("UPDATE devices SET status = 'blocked', authorized = 0, room_id = NULL WHERE id = ?", [deviceId], (err2) => {
      if (err2) return res.status(500).json({ error: err2.message });
      publishAuthRevoked(deviceId, '设备已被屏蔽');
      logAction('block', 'device', { device_id: deviceId });
      res.json({ success: true });
    });
  });
});

// 【S-05e】 发送指令到设备（MQTT command 主题下发）
// action 必须落在 DEVICE_ACTIONS 白名单里（= APK handleCommand 的 when 分支 + 服务端会改写的 'sync'）；
// 未知 action 一律 400，不透传 —— command 主题上的指令设备是照单执行的，不能靠前端自觉。
// 老 APK(167) 里那条 preset_sync 分支只是留着没人调用，服务端先收掉入口即可，不需要设备升级。
const DEVICE_ACTIONS = ['sync', 'stop', 'config', 'sync_room_materials',
                        'update_windows', 'delete_material', 'update', 'set_debug'];
app.post('/api/devices/:id/command', (req, res) => {
  const { command } = req.body;
  const deviceId = req.params.id;

  if (!command || typeof command !== 'object' || typeof command.action !== 'string') {
    return res.status(400).json({ error: 'command 必须是带字符串 action 的对象' });
  }
  if (DEVICE_ACTIONS.indexOf(command.action) === -1) {
    return res.status(400).json({ error: '不支持的 action: ' + command.action });
  }

  // 转换相对URL为完整URL（与版本推送共用 APK_DOWNLOAD_BASE，换域名/上 HTTPS 只改一处）
  let cmd = { ...command };
  if (cmd.url && cmd.url.startsWith('/')) {
    cmd.url = APK_DOWNLOAD_BASE + cmd.url;
  }

  // sync 命令需要补全 room_id + folder_mappings（服务器查数据库，APK 不需要重复传）
  if (cmd.action === 'sync') {
    db.query(
      'SELECT d.room_id, d.fingerprint, r.config FROM devices d LEFT JOIN rooms r ON d.room_id = r.id WHERE d.id = ?',
      [deviceId],
      (err, rows) => {
        if (err || !rows || rows.length === 0) {
          return res.status(404).json({ error: '设备未找到' });
        }
        const { room_id, fingerprint, config } = rows[0];
        if (!room_id) {
          return res.status(400).json({ error: '设备未绑定房间' });
        }
        const roomConfig = parseRoomConfig(config);
        // 与授权响应 / 房间同步 / 自动通知同构的一套载荷（A01/B01 scene-prefixed + rev）
        const syncCmd = syncCommandPayload(room_id, roomConfig);
        publishToDeviceCommand({ id: deviceId, fingerprint }, syncCmd);
        logAction('sync', 'device', { device_id: deviceId, command: syncCmd });
        res.json({ success: true, command: syncCmd });
      }
    );
    return;
  }

  // 查询设备的 id+fingerprint 用于 MQTT topic（双发防 OTA 后指纹漂移失联）
  db.query('SELECT id, fingerprint FROM devices WHERE id = ?', [deviceId], (err, rows) => {
    if (err || rows.length === 0) return res.status(404).json({ error: '设备未找到' });
    publishToDeviceCommand(rows[0], cmd);
    logAction('sync', 'device', { device_id: deviceId, command: cmd });
    res.json({ success: true, command: cmd });
  });
});

// 【S-07f】 房间同步（手工「🔄 同步当前房间」/ 批量推送的显式入口）：
// 强制全量下发，不判 rev 是否变化 —— 运维按这个按钮就是要设备重新对账一遍。
app.post('/api/rooms/:id/sync', (req, res) => {
  const roomId = req.params.id;

  db.query('SELECT config FROM rooms WHERE id = ?', [roomId], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!rows || rows.length === 0) return res.status(404).json({ error: '房间不存在' });

    // scene-prefixed 统一格式（与授权响应 / notifyRoomDevicesOfSync 一致；
    // APK 落盘目录与播放解析均以 A01/B01 形态为准，无前缀格式会导致播放指向根目录 01）
    const syncCmd = syncCommandPayload(roomId, parseRoomConfig(rows[0].config));

    db.query(
      'SELECT id, fingerprint FROM devices WHERE room_id = ? AND authorized = 1',
      [roomId],
      (err2, devices) => {
        if (err2) return res.status(500).json({ error: err2.message });

        const list = devices || [];
        list.forEach(d => publishToDeviceCommand(d, syncCmd));
        logAction('room_sync', 'room', { room_id: roomId, devices: list.length });
        res.json({
          success: true,
          sent: list.length,
          message: list.length ? undefined : '房间无授权设备',
          command: syncCmd
        });
      }
    );
  });
});

// 【S-07d】从房间删除素材：A/B 两幕同编号文件夹一起清（与添加时写双幕对称）
// 流程：清理 scenes A/B folder_mappings → UPDATE DB → 每台设备发 delete_material（立即删本地文件）
//      → 清单对账由 notifyRoomConfigChanged 收敛点决定（真删掉了才 sync，否则一条不发）
// ?scene= 只决定 delete_material 的 folder 前缀（= 立即删哪个物理目录）；另一幕那份由随后的
// sync 对账按孤儿清掉。不传则默认 A。
app.delete('/api/rooms/:roomId/materials/:materialId', (req, res) => {
  const { roomId, materialId } = req.params;
  // ?folder= 与 ?scene= 会拼成 delete_material 的 folder 字段下发，APK 按它解析磁盘目录
  // （"A01" → scenea/01）：不卡形状就等于把 "../../etc" 交给设备端去删。两个都走白名单。
  const folder = req.query.folder || '01';
  const curScene = req.query.scene || 'A';   // 明确指定场景，默认 A
  if (!isSafeFolderName(folder)) return res.status(400).json({ error: 'invalid folder name' });
  if (!isSceneKey(curScene)) return res.status(400).json({ error: 'scene 只能是 A 或 B' });

  // 1. 查出文件名（查 materials 和 preset_materials 两个表）
  db.query(
    'SELECT filename, name FROM materials WHERE id = ? UNION SELECT filename, name FROM preset_materials WHERE id = ?',
    [materialId, materialId],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      const filename = (rows && rows[0]?.filename) || (rows && rows[0]?.name) || null;

      // 2. 从 A/B 两幕的 folder_mappings 中移除该素材 ID（与添加时写双幕对称）
      db.query('SELECT config FROM rooms WHERE id = ?', [roomId], (err2, roomRows) => {
        if (err2 || !roomRows || roomRows.length === 0) {
          return res.status(404).json({ error: '房间不存在' });
        }

        let config = parseRoomConfig(roomRows[0].config);

        // 从 folder_mappings 移除该素材：A/B 两幕同编号文件夹一起清（与添加素材到房间时写双幕对称，
        // 否则会出现"B 幕删了 A 幕还有"的幻影素材）
        let removed = false;
        if (config.scenes) {
          ['A', 'B'].forEach(scene => {
            const sc = config.scenes[scene];
            if (sc && sc.folder_mappings && typeof sc.folder_mappings === 'object') {
              Object.keys(sc.folder_mappings).forEach(fid => {
                // 值可能已是脏形状（非数组）：arr.filter 抛在 MySQL 回调里 = 这次请求挂死不返回
                const arr = normalizeMaterialIds(sc.folder_mappings[fid]);
                const kept = arr.filter(id => id !== materialId);
                if (kept.length !== arr.length) removed = true;
                sc.folder_mappings[fid] = kept;
              });
            }
          });
        }

        // 写回 DB
        const newCfgStr = JSON.stringify(config);
        db.query(
          'UPDATE rooms SET config = ? WHERE id = ?',
          [newCfgStr, roomId],
          (err3) => {
            // 映射没落到库里就不能再往下发删除命令、更不能回 success：
            // 那样前端以为删干净了，下次同步素材又回来（幻影素材）
            if (err3) {
              console.error('删除素材更新 room config 失败:', err3.message);
              return res.status(500).json({ error: err3.message });
            }
            console.log('🗑 房间', roomId, 'A/B 两幕 folder', folder, '移除素材', materialId, removed ? '✓' : '(未找到)');

            // 3. 查房间下所有已授权设备
            db.query(
              'SELECT id, fingerprint FROM devices WHERE room_id = ? AND authorized = 1',
              [roomId],
              (err4, devices) => {
                if (err4) return res.status(500).json({ error: err4.message });
                const list = devices || [];

                // 3a. delete_material：让 APK 立即删本地文件（尽力发，不依赖清单对账）。
                // folder 带场景前缀（"A01"），APK deleteMaterialFile 按前缀解析物理目录 scenea/01
                list.forEach(d => publishToDeviceCommand(d, {
                  action: 'delete_material',
                  material_id: materialId,
                  folder: curScene + folder,
                  filename: filename
                }));

                // 3b. 清单对账走收敛点：真的从本房间映射里删掉了才发 sync；
                //     removed=false（该素材本就不在此房间）时指纹未变，一条都不发。
                notifyRoomConfigChanged(roomId, roomRows[0].config, newCfgStr, 'DELETE /rooms/materials', (synced) => {
                  logAction('material_delete', 'room', {
                    room_id: roomId, material_id: materialId,
                    folder, filename, scene: curScene,
                    removed, devices: list.length, synced
                  });
                  res.json({
                    success: true,
                    sent: list.length,
                    synced,
                    removed_scene: curScene,
                    was_removed: removed
                  });
                });
              }
            );
          }
        );
      });
    }
  );
});

// 【S-05b】 废止设备（远程禁用）
app.post('/api/devices/:id/deauthorize', (req, res) => {
  const deviceId = req.params.id;

  // 与 block 对齐：先确认设备存在。否则对一个不存在的 id 也会回 success，
  // 还顺带往 xvj/auth/response 广播一发 nobody 的 deauthorize（日志里看不出是打空的）
  db.query('SELECT id FROM devices WHERE id = ?', [deviceId], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!rows || rows.length === 0) return res.status(404).json({ error: '设备不存在' });

    // 操作数据库：更新 devices 表，将授权状态设为 0（与 block 对齐清 room_id，废止后不再挂在房间上）
    db.query(
      'UPDATE devices SET authorized = 0, status = "deauthorized", room_id = NULL WHERE id = ?',
      [deviceId],
      (err2) => {
        if (err2) return res.status(500).json({ error: err2.message });
        publishAuthRevoked(deviceId, '设备已被废止');
        logAction('deauthorize', 'device', { device_id: deviceId });
        res.json({ success: true, message: '设备已废止' });
      }
    );
  });
});

// 【S-05f】 重新授权设备 — 更新 devices.authorized=1，MQTT 推送授权响应
// Bug修复：MQTT topic必须使用DB中设备的真实id字段（64-char UUID），
// 避免APK订阅的topic永远不匹配
app.post('/api/devices/:id/authorize', (req, res) => {
  const deviceId = req.params.id;
  const store = decodeURIComponent(req.query.store || req.body.store || '默认店');
  const roomId = req.query.room_id || req.body.room_id || null;

  // 先查设备，用DB中的id字段作为MQTT topic ID（APK订阅用的是这个）
  // 与 deauthorize/block 对齐：不存在直接 404。以前这里对不存在的 id 也回 success，
  // 还往 xvj/auth/response 广播一发 nobody 的授权 —— 界面显示"已授权"，其实一台都没动
  db.query('SELECT id FROM devices WHERE id = ?', [deviceId], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!rows || rows.length === 0) return res.status(404).json({ error: '设备不存在' });
    const mqttId = rows[0].id;
    // 日志放在存在性校验之后：打在前面时，探测/打空的请求也会在 journal 里留下
    // "授权到店铺"，排查时看不出是真授权还是空跑
    console.log('授权到店铺:', deviceId, '->', store, '房间:', roomId);

    // 更新授权状态
    db.query(
      'UPDATE devices SET authorized = 1, status = "online", store = ?, room_id = ? WHERE id = ?',
      [store, roomId, mqttId],
      (err2) => {
        if (err2) return res.status(500).json({ error: err2.message });

        // 发送授权消息给设备（MQTT topic使用DB中的真实id）
        sendAuthResponse(mqttId, true, '已授权', roomId || '');
        logAction('authorize', 'device', { device_id: mqttId, store, room_id: roomId });
        res.json({ success: true, message: '设备已授权到: ' + store + (roomId ? '，房间: ' + roomId : '') });
      }
    );
  });
});

// ============================================================================
// 📦 素材管理 API — 【S-02】
//    GET    /api/materials        查素材库（支持 ?folder= 参数）
//    DELETE /api/materials/:id    删除素材（同时删物理文件 + 写日志）
//    POST   /api/upload           入库唯一入口（multipart 文件 → 重封装 → 建 DB 行）
//    ⚠️ 没有 POST /api/materials，历史注释里的"手动新增素材（少用）"早已不存在
// ============================================================================

// 【S-02】 素材列表（可按 ?folder= 筛选）// GET /api/materials
app.get('/api/materials', (req, res) => {
  const { folder } = req.query;
  let sql = 'SELECT * FROM materials';
  let params = [];
  
  if (folder) {
    // 根据文件夹筛选
    sql = 'SELECT * FROM materials WHERE folder = ?';
    params = [folder];
  }
  
  db.query(sql, params, (err, results) => {
    if (err) return res.status(500).json({ error: err.message });
    
    // 格式化返回
    const formatted = results.map(m => ({
      id: m.id,
      filename: m.name,
      url: m.url,
      md5: m.md5 || '',
      folder: m.folder,
      thumbnail: m.thumbnail || null,
      type: m.type || 'video'
    }));
    
    res.json(formatted);
  });
});

// 【S-13d】 读写"设备级自由配置"（devices.config 列，与房间配置无关）
// ⚠️ 目前无调用方：APK 从不请求 /api/config/:deviceId，前端也没有入口。
//    GET  读 devices.config；POST 覆盖写库并把同一份 JSON 发到该设备的 xvj/device/{id}/config（QoS 0，不保留）
app.get('/api/config/:deviceId', (req, res) => {
  db.query('SELECT config FROM devices WHERE id = ?', [req.params.deviceId], (err, results) => {
    if (err) return res.status(500).json({ error: err.message });
    if (results.length === 0) return res.status(404).json({ error: '设备不存在' });
    res.json(parseRoomConfig(results[0].config));   // devices.config 是自由 JSON，脏数据同样按空处理
  });
});

// 【S-13e】 设置设备配置（同上，停用中）
app.post('/api/config/:deviceId', (req, res) => {
  const config = JSON.stringify(req.body);
  db.query('UPDATE devices SET config = ? WHERE id = ?', [config, req.params.deviceId], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    
    const topic = `xvj/device/${req.params.deviceId}/config`;
    mqttClient.publish(topic, config);
    res.json({ success: true });
  });
});

// ==================== 素材引用清理 ====================

/**
 * 从所有房间的 config.scenes.A/B.folder_mappings 中移除指定素材 ID（数组或单个）
 * 有变更的房间写回 DB 并收集其 ID，全部写完后回调 done(affectedRoomIds)
 */
function removeMaterialIdsFromAllRooms(ids, done) {
  const killIds = Array.isArray(ids) ? ids : [ids];
  db.query('SELECT id, config FROM rooms', [], (err, rooms) => {
    const affected = [];
    // done 只会有一次调用：pending 计数依赖"所有 UPDATE 回调都晚于同步的 forEach"，
    // 这不变量将来可能被换成同步回调的实现破坏，用 finished 显式兜住。
    let finished = false;
    const finish = () => { if (finished) return; finished = true; done(affected); };
    if (err || !rooms || rooms.length === 0) return finish();
    let pending = 0;
    rooms.forEach(room => {
      let cfg = {};
      try { cfg = room.config ? JSON.parse(room.config) : {}; } catch (e) { return; }
      let changed = false;
      ['A', 'B'].forEach(sc => {
        const fm = cfg.scenes && cfg.scenes[sc] && cfg.scenes[sc].folder_mappings;
        if (!fm) return;
        Object.keys(fm).forEach(k => {
          const arr = fm[k];
          if (!Array.isArray(arr)) return;
          const filtered = arr.filter(x => !killIds.includes(x));
          if (filtered.length !== arr.length) { fm[k] = filtered; changed = true; }
        });
      });
      if (!changed) return;
      affected.push(room.id);
      pending++;
      db.query('UPDATE rooms SET config=? WHERE id=?', [JSON.stringify(cfg), room.id], () => {
        pending--;
        if (pending === 0) finish();
      });
    });
    if (pending === 0) finish();
  });
}

// ==================== 预设素材 API ====================
// 前端模型：预设"文件夹"即 01-30 数字编号（folder_id），与素材库文件夹编号对齐

// 【S-03】 获取预设素材列表
app.get('/api/preset/materials', (req, res) => {
  db.query('SELECT * FROM preset_materials ORDER BY folder_id, filename', (err, results) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(results || []);
  });
});

// 【S-03f】 添加预设素材（复制素材库条目的引用，共享同一物理文件）
app.post('/api/preset/materials', (req, res) => {
  const { folder_id, filename, url, type, thumbnail, md5 } = req.body;
  if (!folder_id || !url) return res.status(400).json({ error: 'need folder_id and url' });
  // 这条 url 会被前端当播放地址、也会被删素材时当磁盘路径用，只允许指向 uploads 根内
  if (!resolveUploadPath(url)) return res.status(400).json({ error: 'invalid url' });
  if (thumbnail && !resolveUploadPath(thumbnail)) return res.status(400).json({ error: 'invalid thumbnail' });
  const id = 'pm_' + Date.now();
  const safeName = filename || url.split('/').pop() || '未知文件';
  const fileType = type || (safeName.endsWith('.mp4') || safeName.endsWith('.avi') ? 'video' : 'image');
  db.query(
    'INSERT INTO preset_materials (id, folder_id, filename, url, type, thumbnail, md5) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [id, folder_id, safeName, url, fileType, thumbnail || null, md5 || null],
    (err) => {
      if (err) return res.status(500).json({ error: err.message });
      logAction('create', 'preset_material', { id, folder_id, filename: safeName, url });
      res.json({ id, folder_id, filename: safeName, url, type: fileType, thumbnail: thumbnail || null, md5: md5 || null });
    }
  );
});

// 删除预设素材（级联清理所有房间的 scenes A/B 映射并通知设备同步）
app.delete('/api/preset/materials/:id', (req, res) => {
  const mid = req.params.id;
  db.query('SELECT * FROM preset_materials WHERE id = ?', [mid], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!rows || !rows[0]) return res.status(404).json({ error: '预设素材不存在' });
    logAction('delete', 'preset_material', rows[0]);
    removeMaterialIdsFromAllRooms(mid, (affected) => {
      db.query('DELETE FROM preset_materials WHERE id = ?', [mid], (err3) => {
        if (err3) return res.status(500).json({ error: err3.message });
        affected.forEach(rid => notifyRoomDevicesOfSync(rid));
        res.json({ success: true, rooms_notified: affected.length });
      });
    });
  });
});


// 【S-10a】 列出素材文件夹 — 取并集：materials.folder 出现过的值 ∪ /public/uploads 下的实际目录。
// 只建了空目录（POST /api/folders）也能列出来，上传过才会进 DB。
app.get("/api/folders", (req, res) => {
  db.query("SELECT DISTINCT folder FROM materials", (err, rows) => {
    let folders = [];
    if (!err && rows) folders = rows.map(r => r.folder).filter(Boolean);
    try {
      const dirs = require('fs').readdirSync(__dirname + "/public/uploads").filter(f => {
        try { return require('fs').statSync(__dirname + "/public/uploads/"+f).isDirectory(); } catch(e) { return false; }
      });
      folders = [...new Set([...folders, ...dirs])];
    } catch(e) {}
    res.json(folders);
  });
});

// 【S-10b】 创建素材文件夹 — 只 mkdirSync 物理目录，不写任何表；
// 关联是后续 /api/upload?folder= 落库时才建立的。重名幂等（已存在直接返回成功）。
app.post("/api/folders", (req, res) => {
  const name = req.body.name;
  if (!name) return res.status(400).json({error:"need name"});
  if (!isSafeFolderName(name)) return res.status(400).json({error:"invalid folder name"});
  const dir = __dirname + "/public/uploads/"+name;
  if (!require('fs').existsSync(dir)) require('fs').mkdirSync(dir, {recursive:true});
  res.json({success:true, name:name});
});

// 【S-10c】 删除素材文件夹（级联：物理目录 + materials + 同 URL 预设 + 房间映射清理 + 设备同步）
app.delete("/api/folders/:name", (req, res) => {
  const name = req.params.name;
  if (!name || name==="default") return res.status(400).json({error:"cannot delete"});
  // 下面要 rmSync(recursive)，名字必须先过白名单：编码斜杠可以穿过 :name 路由
  if (!isSafeFolderName(name)) return res.status(400).json({error:"invalid folder name"});
  db.query("SELECT id, url FROM materials WHERE folder=?", [name], (err, mats) => {
    // 这里查不到就不往下删：下面紧跟 rmSync(recursive)，
    // 按"查失败 = 没有素材"走下去会把目录删了、materials 行却留着（孤儿引用）
    if (err) return res.status(500).json({ error: err.message });
    const list = mats || [];
    const ids = list.map(m => m.id);
    const urls = list.map(m => m.url).filter(Boolean);
    removeMaterialIdsFromAllRooms(ids, (affected) => {
      const dir = __dirname + "/public/uploads/"+name;
      if (require('fs').existsSync(dir)) require('fs').rmSync(dir, {recursive:true});
      db.query("DELETE FROM materials WHERE folder=?", [name], ()=>{});
      if (urls.length > 0) {
        const ph = urls.map(() => '?').join(',');
        db.query(`DELETE FROM preset_materials WHERE url IN (${ph})`, urls, ()=>{});
      }
      affected.forEach(rid => notifyRoomDevicesOfSync(rid));
      logAction('delete', 'folder', { folder: name, materials: ids.length, rooms_notified: affected.length });
      res.json({success:true, removed_materials: ids.length, rooms_notified: affected.length});
    });
  });
});


// 【S-02c】 删除素材库条目：素材 + 同 URL 的全部预设一起删（它们共享同一物理文件）
// 时序：查记录 → 清所有房间映射（回调里才继续，防孤儿引用）→ 删物理文件 → 删 materials/preset 行
//       → 通知受影响房间设备同步 → res.json
app.delete("/api/materials/:id", (req, res) => {
  const id = req.params.id;
  const fs = require('fs');

  // 步骤1：查素材记录
  db.query("SELECT * FROM materials WHERE id=?", [id], (err, rows) => {
    if (err || !rows || !rows[0]) {
      return res.status(404).json({ error: '素材不存在' });
    }
    const mat = rows[0];
    logAction('delete', 'material', mat);

    // 步骤2：房间映射按「素材ID + 同URL预设ID」级联清理（映射里存的是 pm_* 预设ID）
    db.query("SELECT id FROM preset_materials WHERE url=?", [mat.url], (err1, presets) => {
      const presetIds = (presets || []).map(p => p.id);
      const killIds = [id, ...presetIds];
      removeMaterialIdsFromAllRooms(killIds, (affected) => {
        // 步骤3：删物理文件（预设与素材库共享同一文件，级联后一起删）
        for (const f of [mat.url, mat.thumbnail]) {
          const abs = f ? resolveUploadPath(f) : null;
          if (!abs) continue;   // 空值或越出 uploads 根的路径一律不动磁盘
          try { fs.unlinkSync(abs); } catch (e) { /* ignore */ }
        }
        // 步骤4：删表记录，通知受影响房间的设备同步
        const ph = killIds.map(() => '?').join(',');
        db.query(`DELETE FROM materials WHERE id IN (${ph})`, killIds, (errDel) => {
          if (errDel) return res.status(500).json({ error: '删除素材失败' });
          db.query(`DELETE FROM preset_materials WHERE id IN (${ph})`, killIds, () => {});
          affected.forEach(rid => notifyRoomDevicesOfSync(rid));
          res.json({ success: true, removed_presets: presetIds.length, rooms_notified: affected.length });
        });
      });
    });
  });
});

const multer = require('multer');

// 【S-02b】 上传素材文件（POST /api/upload）
// 安全约定：磁盘文件名服务端生成（时间戳+uuid+清洗后的 ASCII 基名），原始文件名只存 DB
const UPLOAD_VIDEO_EXT = ['.mp4', '.webm', '.mov', '.avi', '.mkv'];
const UPLOAD_IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
const UPLOAD_MAX_SIZE = 500 * 1024 * 1024;

function uploadFolderOf(req) {
  const folder = req.query.folder || req.body.folder || 'default';
  return isSafeFolderName(folder) ? folder : null;
}

// 素材目录名白名单：/api/folders 的创建与删除、以及 /api/upload 的 destination（uploadFolderOf）
// 都把它直接拼进文件路径，未校验时 `..%2f..%2f...` 能解到 uploads 之外，而删除用的是 rmSync(recursive)。
// 长度上限 10 = materials.folder / folder_notes.folder 的 VARCHAR(10)：曾经这里是 20，
// 11~20 字符的目录名能建目录能上传、落库却被截断，DB 值不再等于磁盘目录名。
// 生产现存目录名全是 2 字符（01…30），收紧不会打到存量数据。
function isSafeFolderName(name) {
  return typeof name === 'string' && /^[A-Za-z0-9_-]{1,10}$/.test(name);
}

// 把 "/uploads/xx/yy.mp4" 解成磁盘路径，并强制结果仍落在 uploads 根内。
// 用于 preset_materials 的增删（url 是客户端任意传入的）与 materials 的物理文件清理，
// 不过这一道就等于按请求删盘。
// ⚠️ 目前没有任何调用方覆盖 default_materials —— 那张表只写/查/删行，服务端从不按它的 url 碰磁盘，
//    所以缺校验不会删文件；但【S-13b】已把 url 收紧成"站内相对路径"，防止将来被照抄进 <video src>。
function resolveUploadPath(url) {
  if (typeof url !== 'string' || url.indexOf('/uploads/') !== 0) return null;
  const root = path.resolve(__dirname + '/public/uploads');
  const abs = path.resolve(__dirname + '/public' + url);
  return (abs === root || abs.startsWith(root + path.sep)) ? abs : null;
}

// 素材磁盘体积（字节），现算不入库：给设备端下载进度条当分母权重。
// 拿不到（url 不是 /uploads/ 下、文件被手工删了）就返回 0，设备端会回落到按文件数计。
function uploadSizeBytes(url) {
  const p = resolveUploadPath(url);
  if (!p) return 0;
  try { return fs.statSync(p).size; } catch (e) { return 0; }
}

function buildSafeUploadName(originalname) {
  const extMatch = originalname.match(/\.[A-Za-z0-9]+$/);
  const ext = extMatch ? extMatch[0].toLowerCase() : '';
  const base = originalname.replace(/\.[^.]*$/, '').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
  return Date.now() + '_' + uuidv4().slice(0, 8) + '_' + (base || 'file') + ext;
}

// 流式计算 MD5（避免大视频整体读入内存）
function md5FileStream(filePath) {
  return new Promise((resolve, reject) => {
    const hash = require('crypto').createHash('md5');
    require('fs').createReadStream(filePath)
      .on('data', d => hash.update(d))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}

// ffmpeg/ffprobe 异步包装：上传后处理绝不能用 execFileSync——它会阻塞整个
// event loop（大文件可达十几秒），期间预览请求、30s 设备轮询、MQTT 回调一起停摆。
function execFileAsync(cmd, args) {
  return new Promise((resolve, reject) => {
    require('child_process').execFile(cmd, args,
      { timeout: 120000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => err ? reject(err) : resolve(stdout));
  });
}

// moov 在文件尾的 mp4/mov（相机与多数压制工具的默认）要播放器多发一次 Range 请求取尾部索引才能起播。
// 只做容器重排（-c copy，不重编码）；不适用或失败就原样返回，不影响上传结果。
async function remuxFaststart(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (['.mp4', '.mov', '.m4v'].indexOf(ext) === -1) return filePath;
  // 临时名必须保留可识别的扩展名：ffmpeg 按后缀选封装器，写成 *.tmp 会 "Unable to find a suitable output format"
  const tmp = filePath.slice(0, -ext.length) + '.faststart' + ext;
  try {
    await execFileAsync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', filePath,
      '-c', 'copy', '-movflags', '+faststart', tmp]);
    if (fs.statSync(tmp).size > 0) fs.renameSync(tmp, filePath);
    else throw new Error('empty remux output');
  } catch (e) {
    console.warn('⚠️ faststart 重封装失败（播放仍可用，只是首帧多一次 Range 请求）:', filePath, e.message);
    try { fs.unlinkSync(tmp); } catch (e2) {}
  }
  return filePath;
}

// multer 实例全局单例（destination 从 req.query.folder 读取）
const uploadMiddleware = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const folder = uploadFolderOf(req);
      if (!folder) return cb(new Error('invalid folder'));
      const dir = __dirname + "/public/uploads/" + folder;
      if (!require('fs').existsSync(dir)) require('fs').mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => cb(null, buildSafeUploadName(file.originalname))
  }),
  limits: { fileSize: UPLOAD_MAX_SIZE }
}).single("file");

app.post("/api/upload", (req, res) => {
  const folder = uploadFolderOf(req);
  if (!folder) return res.status(400).json({ error: "invalid folder" });
  uploadMiddleware(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: "no file" });

    const originalName = req.file.originalname || 'file';
    const extMatch = originalName.match(/\.[A-Za-z0-9]+$/);
    const ext = extMatch ? extMatch[0].toLowerCase() : '';
    let type = null;
    if (UPLOAD_VIDEO_EXT.includes(ext) || req.file.mimetype.startsWith("video")) type = "video";
    else if (UPLOAD_IMAGE_EXT.includes(ext) || req.file.mimetype.startsWith("image")) type = "image";
    if (!type) {
      try { require('fs').unlinkSync(req.file.path); } catch (e) {}
      return res.status(400).json({ error: "unsupported file type: " + ext });
    }

    const displayName = originalName.replace(/\.[^.]+$/, '');
    const url = "/uploads/" + folder + "/" + req.file.filename;
    let thumbnail = null;
    let resolution = null;

    const finish = (md5) => {
      const id = uuidv4();
      db.query("INSERT INTO materials (id,name,filename,url,type,folder,thumbnail,resolution,md5) VALUES (?,?,?,?,?,?,?,?,?)",
        [id, displayName, originalName, url, type, folder, thumbnail, resolution, md5 || null],
        (e) => {
          if (e) {
            try { require('fs').unlinkSync(req.file.path); } catch (e2) {}
            if (thumbnail) { try { require('fs').unlinkSync(__dirname + thumbnail); } catch (e2) {} }
            return res.status(500).json({ error: e.message });
          }
          logAction('upload', 'material', { id, name: displayName, folder, type, md5 });
          res.json({ id, name: displayName, url, type, folder, thumbnail, resolution, md5: md5 || null });
        }
      );
    };

    if (type === "video") {
      (async () => {
        await remuxFaststart(req.file.path);
        try {
          const thumbFile = req.file.filename.replace(/\.[^.]+$/, '') + '.jpg';
          const thumbPath = __dirname + "/public/uploads/" + folder + "/" + thumbFile;
          await execFileAsync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error',
            '-i', req.file.path, '-ss', '00:00:01', '-vframes', '1', '-q:v', '2', thumbPath]);
          thumbnail = "/uploads/" + folder + "/" + thumbFile;
          const probe = await execFileAsync('ffprobe',
            ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', req.file.path]);
          resolution = probe.trim();
        } catch (e) { /* 缩略图/分辨率失败不阻断上传 */ }
        md5FileStream(req.file.path).then(finish).catch(() => finish(null));
      })();
    } else {
      finish(null);
    }
  });
});

// 【S-10e】 保存文件夹备注（写入 folder_notes 表）
// folder 是主键且列宽 VARCHAR(10)、note VARCHAR(255)：超限/非法名在严格模式下会 500，
// 非严格模式则静默截断 —— 库里存的备注就不再是用户写的那句话了。所以入参先按列宽校验。
app.post("/api/folders/note", (req, res) => {
    const { folder, note } = req.body;
    if (!folder) return res.status(400).json({error:"need folder"});
    if (!isSafeFolderName(folder)) return res.status(400).json({error:"invalid folder name"});
    if (note !== undefined && note !== null && typeof note !== 'string') {
      return res.status(400).json({error:"note 必须是字符串"});
    }
    if (typeof note === 'string' && note.length > 255) {
      return res.status(400).json({error:"备注最长 255 字"});
    }

    // 保存到数据库
    db.query("INSERT INTO folder_notes (folder, note) VALUES (?, ?) ON DUPLICATE KEY UPDATE note = ?",
      [folder, note || '', note || ''],
      (err) => {
        if (err) return res.status(500).json({error:err.message});
        logAction('update', 'folder_note', {folder, note});
        res.json({success:true});
      }
    );
});

// 【S-08a】 查询操作日志（从 operation_logs 表读取）
app.get('/api/logs', (req, res) => {
  const limit = parseInt(req.query.limit) || 20;
  db.query("SELECT * FROM operation_logs ORDER BY id DESC LIMIT ?", [limit], (err, rows) => {
    if (err) return res.status(500).json({error:err.message});
    res.json(rows);
  });
});

// 【S-10f】 获取所有文件夹备注（从 folder_notes 表读取）
app.get("/api/folders/notes", (req, res) => {
    db.query("SELECT folder, note FROM folder_notes", (err, rows) => {
        if (err) return res.status(500).json({error:err.message});
        const notes = {};
        rows.forEach(r => notes[r.folder] = r.note);
        res.json(notes);
    });
});

// ==================== 素材同步 v2：同时查 materials + preset_materials ====================
// 修复: 房间 folder_mappings 存的是 preset_materials ID，但旧 API 只查 materials 表，导致 APK 拿到空列表

// 【S-04a】 房间素材列表v2（当前正式版）// GET /api/room-materials-v2/:roomId
app.get('/api/room-materials-v2/:roomId', (req, res) => {
  const roomId = req.params.roomId;

  db.query('SELECT config FROM rooms WHERE id = ?', [roomId], (err, rows) => {
    if (err || !rows || rows.length === 0) {
      return res.status(404).json({ error: '房间不存在' });
    }

    // 分别读取 Scene A 和 B 的 folder_mappings，返回 scene-prefixed keys 供 APK 正确 lookup
    // APK syncRoomMaterials 用 scenePrefix + folderNum 构建 "A01" / "B01" key 来查 HTTP API
    // ⚠️ 这份清单是设备"该有哪些文件"的唯一真值来源，必须和 MQTT 下发同口径：
    //    parseRoomConfig（脏 config 不抛异常）+ normalizeFolderMappings（值统一成 id 数组、非法文件夹键丢弃）
    const manifestConfig = parseRoomConfig(rows[0].config);
    const manifestScenes = (manifestConfig && manifestConfig.scenes) || {};
    const folderMappingsA = normalizeFolderMappings(manifestScenes.A && manifestScenes.A.folder_mappings);
    const folderMappingsB = normalizeFolderMappings(manifestScenes.B && manifestScenes.B.folder_mappings);

    // 收集所有需要的 material IDs（来自 A 和 B）
    const allIds = new Set();
    Object.values(folderMappingsA).forEach(ids => { if (Array.isArray(ids)) ids.forEach(id => { if (id) allIds.add(id); }); });
    Object.values(folderMappingsB).forEach(ids => { if (Array.isArray(ids)) ids.forEach(id => { if (id) allIds.add(id); }); });

    const result = {}; // { "A01": [...], "A02": [...], "B01": [...], "B02": [...] } — scene-prefixed keys

    if (allIds.size === 0) {
      return res.json(result);
    }

    const idList = Array.from(allIds);
    const placeholders = idList.map(() => '?').join(',');
    // 两次查询是串行的（第二条在第一条回调里），不是并行 —— 表小，先不优化
    db.query(
      `SELECT * FROM materials WHERE id IN (${placeholders})`,
      idList,
      (err2, materialsRows) => {
        if (err2) {
          // ⚠️ 素材查询出错绝不能退化成"这个房间没有素材"：清单会整份变成空数组，
          // 设备按"云端说没有"把本地素材全删（一次 DB 抖动 = 现场素材被清空）。
          // 回 500 让设备那侧 fetchRoomMaterials 判定为失败、中止本轮，保持本地现状。
          console.error('room-materials-v2 查询 materials 失败:', err2.message);
          return res.status(500).json({ error: '素材清单查询失败' });
        }
        db.query(
          `SELECT * FROM preset_materials WHERE id IN (${placeholders})`,
          idList,
          (err3, presetRows) => {
            if (err3) {
              console.error('room-materials-v2 查询 preset_materials 失败:', err3.message);
              return res.status(500).json({ error: '素材清单查询失败' });
            }
            // 合并去重（materials 优先）
            const merged = {};
            [...materialsRows, ...presetRows].forEach(row => {
              if (!merged[row.id]) {
                merged[row.id] = {
                  id: row.id,
                  filename: row.filename || row.name || row.fullFilename || row.fname || row.id,
                  url: row.url,
                  md5: row.md5 || '',
                  folder: row.folder || row.folder_id || '',   // 预设素材的文件夹列叫 folder_id，不能漏成空串
                  type: row.type || 'video',
                  // 字节数：设备端下载进度条的分母权重。statSync 现算，不在表里存；
                  // url 不是站内 /uploads/ 或文件已丢 → 0，设备端会回落到"按文件数"计进度
                  size: uploadSizeBytes(row.url)
                };
              }
            });

            // 按 scene-prefixed folder 分组（"A01", "B01"），与 APK syncRoomMaterials 的 lookup 格式对齐
            // 键归一化走 prefixedFolderKey：DB 里万一是 "A01"（前端某条路径写过带前缀的键），
            // 直接 'A'+folderNum 会产出 "AA01"，设备按 A01 查不到 → 该文件夹永远"同步不完"
            // ⚠️ 只有非空数组的文件夹才会出现在结果里：空映射的键整个缺失（不是 []）。
            //    设备端（APK syncFolderWithIds）的口径是：
            //      键存在且为 []      = 云端按这些 id 查过、一只素材都不存在 → 明确指令，本地该目录清空
            //      键存在且有元素     = 该目录应有的素材，多删少补
            //      映射里有 id 但键缺失 = 信息缺失（两份视图对不上），本轮跳过该目录，不删也不下
            //    所以这里不能图省事把出错的查询退化成空结果 —— 那等于让设备把现场素材删干净，
            //    上面两处 err2/err3 回 500 就是为了让它整轮中止。
            Object.entries(folderMappingsA).forEach(([folderNum, ids]) => {
              if (Array.isArray(ids) && ids.length > 0) {
                result[prefixedFolderKey('A', folderNum)] = ids.map(id => merged[id]).filter(Boolean);
              }
            });
            Object.entries(folderMappingsB).forEach(([folderNum, ids]) => {
              if (Array.isArray(ids) && ids.length > 0) {
                result[prefixedFolderKey('B', folderNum)] = ids.map(id => merged[id]).filter(Boolean);
              }
            });

            res.json(result);
          }
        );
      }
    );
  });
});

// ==================== 设备日志 API（远程 DEBUG） ====================
// 【S-08b】 查询设备日志（从 device_logs 表读取，支持按 device_id / level 筛选）
app.get('/api/device_logs', (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  const deviceId = req.query.device_id;
  const level = (req.query.level || '').toUpperCase();
  let sql = "SELECT * FROM device_logs";
  let params = [];
  const conds = [];
  if (deviceId) { conds.push("device_id = ?"); params.push(deviceId); }
  if (level && ['ERROR', 'WARN', 'INFO', 'DEBUG'].includes(level)) { conds.push("level = ?"); params.push(level); }
  if (conds.length) sql += " WHERE " + conds.join(' AND ');
  sql += " ORDER BY id DESC LIMIT ?";
  params.push(limit);
  db.query(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// 【S-11a】 店铺列表（含房间/设备计数；设备数按 设备→房间→店铺 链路 JOIN，不依赖 devices.store 冗余字段）
app.get('/api/stores', (req, res) => {
  db.query(`
    SELECT s.name,
      (SELECT COUNT(*) FROM rooms r WHERE r.store_name = s.name) AS room_count,
      (SELECT COUNT(*) FROM devices d JOIN rooms r2 ON d.room_id = r2.id
        WHERE r2.store_name = s.name AND d.authorized = 1) AS device_count
    FROM stores s ORDER BY s.id`, (err, results) => {
    if (err) return res.status(500).json({ error: err.message });
    var stores = (results || []).map(r => ({ name: r.name, room_count: r.room_count, device_count: r.device_count }));
    if (stores.length === 0) stores.push({ name: '默认店', room_count: 0, device_count: 0 });
    res.json(stores);
  });
});

// 【S-11b】 创建店铺（重名幂等，existed=true 表示已存在未新建）
app.post('/api/stores', (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: '店铺名称不能为空' });
  const n = name.trim();
  db.query('SELECT id FROM stores WHERE name = ?', [n], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    if (rows && rows.length > 0) return res.json({ success: true, name: n, existed: true });
    db.query('INSERT INTO stores (name) VALUES (?)', [n], (err2) => {
      if (err2) return res.status(500).json({ error: err2.message });
      logAction('create', 'store', { name: n });
      res.json({ success: true, name: n, existed: false });
    });
  });
});

// 【S-11c】 店铺重命名（级联同步 rooms.store_name 与 devices.store，防止产生孤儿房间）
app.put('/api/stores/:name', (req, res) => {
  const oldName = decodeURIComponent(req.params.name);
  const { newName } = req.body;
  if (!newName || !newName.trim()) return res.status(400).json({ error: '新名称不能为空' });
  const target = newName.trim();
  if (oldName === target) return res.json({ success: true, rooms_updated: 0 });
  db.query('SELECT id FROM stores WHERE name = ?', [target], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    if (rows.length > 0) return res.status(409).json({ error: '店铺名称已存在' });
    // 存在 store_name 已是目标名的房间时，改名会触发 rooms(store_name,name) 唯一键冲突，提前拦截
    db.query('SELECT id FROM rooms WHERE store_name = ? LIMIT 1', [target], (errR, rowsR) => {
      if (errR) return res.status(500).json({ error: errR.message });
      if (rowsR && rowsR.length > 0) return res.status(409).json({ error: '已存在归属于「' + target + '」的房间，无法重命名到该名称' });
      db.query('UPDATE rooms SET store_name = ? WHERE store_name = ?', [target, oldName], (err1, r1) => {
        if (err1) return res.status(500).json({ error: err1.message });
        db.query('UPDATE stores SET name = ? WHERE name = ?', [target, oldName], (err2) => {
          if (err2) return res.status(500).json({ error: err2.message });
          db.query('UPDATE devices SET store = ? WHERE store = ?', [target, oldName], (err3) => {
            if (err3) return res.status(500).json({ error: err3.message });
            logAction('rename', 'store', { oldName, newName: target });
            res.json({ success: true, newName: target, rooms_updated: r1.affectedRows });
          });
        });
      });
    });
  });
});

// 【S-11d】 删除店铺（名下还有房间时拒绝，防止产生孤儿房间）
app.delete('/api/stores/:name', (req, res) => {
  const storeName = decodeURIComponent(req.params.name);
  db.query('SELECT COUNT(*) AS c FROM rooms WHERE store_name = ?', [storeName], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    if (rows[0].c > 0) return res.status(409).json({ error: '该客户下还有 ' + rows[0].c + ' 个房间，请先在设备管理页删除这些房间（房间不支持跨客户移动）' });
    db.query('DELETE FROM stores WHERE name = ?', [storeName], (err2) => {
      if (err2) return res.status(500).json({ error: err2.message });
      logAction('delete', 'store', { name: storeName });
      res.json({ success: true });
    });
  });
});

db.query(`CREATE TABLE IF NOT EXISTS stores (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL UNIQUE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);



// ==================== 房间管理 API ====================
db.query(`CREATE TABLE IF NOT EXISTS rooms (
  id INT AUTO_INCREMENT PRIMARY KEY,
  store_name VARCHAR(100) NOT NULL,
  name VARCHAR(100) NOT NULL,
  folder_mappings TEXT DEFAULT '{}',
  config TEXT DEFAULT '{}',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY unique_store_room (store_name, name)
)`);

// 【S-04f】 获取房间列表
app.get('/api/rooms', (req, res) => {
  const store = req.query.store;
  let sql = 'SELECT * FROM rooms';
  let params = [];
  if (store) { sql += ' WHERE store_name = ?'; params.push(store); }
  db.query(sql, params, (err, results) => {
    if (err) return res.status(500).json({error:err.message});
    res.json(results);
  });
});

// 【S-04g】 获取单个房间详情
app.get('/api/rooms/:id', (req, res) => {
  const id = req.params.id;
  db.query('SELECT * FROM rooms WHERE id = ?', [id], (err, results) => {
    if (err) return res.status(500).json({error:err.message});
    if (results.length === 0) return res.status(404).json({error:'Room not found'});
    res.json(results[0]);
  });
});

// 【S-04h】 创建房间（插入 rooms 表；客户名自动落库，防孤儿房间）
app.post('/api/rooms', (req, res) => {
  const { store_name, name, config } = req.body;
  if (!store_name || !name) return res.status(400).json({error:'store_name and name required'});
  const id = 'room_' + Date.now();
  db.query('INSERT INTO stores (name) VALUES (?) ON DUPLICATE KEY UPDATE name=name', [store_name], (errStore) => {
    if (errStore) return res.status(500).json({error:errStore.message});
    db.query('INSERT INTO rooms (id, store_name, name, folder_mappings, config) VALUES (?, ?, ?, ?, ?)',
      [id, store_name, name, '{}', config || '{}'], (err, result) => {
      if (err) {
        if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({error:'该客户下已存在同名房间'});
        return res.status(500).json({error:err.message});
      }
      logAction('create', 'room', { id, store_name, name });
      res.json({success:true, id});
    });
  });
});

// 【S-04i】 更新房间（PUT /api/rooms/:id，支持 scenes 合并保护）
app.put('/api/rooms/:id', (req, res) => {
  const { name, config } = req.body;
  const id = req.params.id;
  var updates = [];
  var values = [];

  // 【Bug Fix】当 config 包含 scenes 时，先读取 DB 中现有 config，合并后再保存
  // 避免 windows 字段被 incoming config 中的空数组覆盖
  if (config !== undefined) {
    db.query('SELECT config, name FROM rooms WHERE id=?', [id], (errDb, rowsDb) => {
      if (errDb) return res.status(500).json({ error: errDb.message });
      if (!rowsDb || rowsDb.length === 0) return res.status(404).json({ error: '房间不存在' });

      var existingConfig = parseRoomConfig(rowsDb[0].config);
      var roomName = rowsDb[0].name;
      var targetName = (name !== undefined && name !== roomName) ? name : null;

      // config 允许字符串（前端就是这么发的）或对象。解析失败/类型不对一律 400：
      // 抛在 MySQL 回调里会被顶层 uncaughtException 吞掉，那次请求永远挂着不返回，
      // 前端只看到"保存中…"转圈，且这个房间每次保存都稳定复现。
      var cfg;
      try { cfg = typeof config === 'string' ? JSON.parse(config) : config; }
      catch (e) { return res.status(400).json({ error: 'config 不是合法 JSON 字符串' }); }
      if (!isPlainObject(cfg)) {
        return res.status(400).json({ error: 'config 必须是对象' });
      }
      if (cfg.scenes === undefined || cfg.scenes === null) {
        cfg.scenes = {};
      } else if (!isPlainObject(cfg.scenes)) {
        return res.status(400).json({ error: 'config.scenes 必须是对象' });
      } else {
        // 只认 A/B 两幕。脏键（典型是 "__proto__"）留在 config 里会被存库，
        // 下次按 scenes[key] 取值时就把内容挂到了 Object.prototype 上（全进程、跨房间泄漏）
        Object.keys(cfg.scenes).forEach(function(k) { if (!isSceneKey(k)) delete cfg.scenes[k]; });
      }

      // 逐幕合并：incoming 没带的那一幕、以及 windows/master 这些不归本接口管的字段，
      // 一律从 DB 继承 —— 前端有多处会 PUT 整份 config，任何一处少填都不该抹掉房间配置
      var existingScenes = existingConfig.scenes || {};
      ['A', 'B'].forEach(function(key) {
        cfg.scenes[key] = mergeSceneConfig(cfg.scenes[key], existingScenes[key], key === 'A' ? '第一幕' : '第二幕');
      });

      var newCfgStr = JSON.stringify(cfg);
      if (targetName) { updates.push('name=?'); values.push(targetName); }
      updates.push('config=?'); values.push(newCfgStr);
      values.push(id);
      db.query('UPDATE rooms SET ' + updates.join(',') + ' WHERE id=?', values, (err) => {
        if (err) {
          if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: '该客户下已存在同名房间' });
          return res.status(500).json({ error: err.message });
        }
        logAction('update', 'room', { id, name: targetName || roomName });
        // 落库后由收敛点判定"是否真变了 / 该发哪条命令"，前端不再补 sync（见 notifyRoomConfigChanged）
        notifyRoomConfigChanged(id, rowsDb[0].config, newCfgStr, 'PUT /rooms');
        res.json({ success: true });
      });
    });
    return;
  }

  if (name !== undefined) { updates.push('name=?'); values.push(name); }
  if (updates.length === 0) return res.json({success: true});

  values.push(id);
  db.query('UPDATE rooms SET ' + updates.join(',') + ' WHERE id=?', values, (err) => {
    if (err) {
      if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: '该客户下已存在同名房间' });
      return res.status(500).json({error: err.message});
    }
    logAction('update', 'room', { id, name });
    res.json({success: true});
  });
});
// 【S-04b】 更新房间窗口配置（快捷接口，按幕保存）
// PUT /api/rooms/:id/windows  body: { windows, sceneId:'A'|'B', master?:{brightness}, live?:true }
//   写入 rooms.config.scenes[sceneId].windows（整幕覆盖），master 传了就 clamp 到 [0,1]。
//   推送分两条路：live=true（编辑器拖动中）只发轻量 update_windows，不记操作日志；
//   非 live（保存/增删窗口/改总亮度）走 notifyRoomConfigChanged 收敛点 —— 同样发 update_windows，
//   但若映射也变了则升级为 sync_room_materials，且指纹没变时一条都不发。
app.put('/api/rooms/:id/windows', (req, res) => {
  const { windows, sceneId, master, live } = req.body;   // sceneId: 'A' 或 'B'; master: { brightness } 场景总亮度; live: true=编辑器实时预览轻推
  const id = req.params.id;

  if (!Array.isArray(windows)) {
    return res.status(400).json({ error: 'windows 必须是数组' });
  }
  // 校验每个元素
  for (const w of windows) {
    if (!w || typeof w !== 'object' || !w.id || !w.name) {
      return res.status(400).json({ error: 'windows 数组元素必须是对象，且必须包含 id 和 name 字段' });
    }
  }
  db.query('SELECT config FROM rooms WHERE id = ?', [id], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!rows || rows.length === 0) return res.status(404).json({ error: '房间不存在' });
    const existingConfig = parseRoomConfig(rows[0].config);
    if (!isPlainObject(existingConfig.scenes)) {
      // 旧数据：初始化 scenes 结构
      existingConfig.scenes = {
        A: { name: '第一幕', folder_mappings: {}, windows: [] },
        B: { name: '第二幕', folder_mappings: {}, windows: [] }
      };
    }
    const targetScene = sceneId || 'A';
    // sceneId 直接当键去赋值，必须先过白名单：'__proto__' 在 scenes['__proto__'] 上是真值
    // （继承自 Object.prototype），赋值会把 windows/master 挂到全进程原型上 —— 跨房间泄漏、
    // 所有 rev 一起漂移，且不重启清不掉
    if (!isSceneKey(targetScene)) {
      return res.status(400).json({ error: 'sceneId 只能是 A 或 B' });
    }
    if (!existingConfig.scenes[targetScene]) {
      // 该幕还没建过（旧数据只存了单幕）：按标准形状补上，与上面 scenes 缺失时的初始化同构
      existingConfig.scenes[targetScene] = mergeSceneConfig(null, null, targetScene === 'A' ? '第一幕' : '第二幕');
    }
    existingConfig.scenes[targetScene].windows = windows;
    // 场景总亮度（Arena 屏级总控对标）：传入则 clamp 到 [0,1] 后保存
    if (master && master.brightness != null) {
      const mb = parseFloat(master.brightness);
      if (!isNaN(mb)) existingConfig.scenes[targetScene].master = { brightness: Math.min(1, Math.max(0, mb)) };
    }
    db.query('UPDATE rooms SET config=? WHERE id=?', [JSON.stringify(existingConfig), id], (err2) => {
      if (err2) return res.status(500).json({ error: err2.message });
      // live 轻推不记操作日志（拖动期间每350ms一次，避免刷屏）
      if (!live) logAction('update_windows', 'room', { id, scene: targetScene, windows });

      // 下发。两条路都只发 authorized=1 的设备（【修复 20260911】房间会残留历次卸载重装的
      // authorized=0 历史记录，此前无过滤且只取第一行，update_windows 全发给了幽灵设备，真机收不到）
      if (live) {
        // 【实时预览】轻量 update_windows：只带 scenes，APK 免重建原地更新视图，不触发素材同步；
        // 结构变化时 APK 内部自动回退全量重建。拖动期间直发，350ms 节流由前端负责。
        db.query('SELECT id, fingerprint FROM devices WHERE room_id = ? AND authorized = 1', [id], (err4, rows4) => {
          if (err4 || !rows4 || rows4.length === 0) return;
          var _livePayload = windowCommandPayload(id, existingConfig);
          rows4.forEach((d) => publishToDeviceCommand(d, _livePayload));
        });
      } else {
        // 保存/增删/总亮度这类非 live 写入交给收敛点：只改了窗口布局 → 一条 update_windows 就够，
        // 不再由前端补一枪 POST /sync（那会让设备多跑一轮素材对账 + 全量重建、视频从头播）
        notifyRoomConfigChanged(id, rows[0].config, existingConfig, 'PUT /windows');
      }

      res.json({ success: true, scene: targetScene, windows });
    });
  });
});

// 【S-04j】 删除房间（DELETE rooms 表记录）
app.delete('/api/rooms/:id', (req, res) => {
  const id = req.params.id;
  db.query('SELECT name, store_name FROM rooms WHERE id = ?', [id], (err, rows) => {
    if (err) return res.status(500).json({error: err.message});
    const room = rows[0];
    // 解绑前通知房间内设备停止播放（设备只认 fingerprint，缺省回退设备 id，与 push-update 一致）
    // action:'stop' 在 APK 侧 = stopPlayback + releaseAllWindows（168 起），多窗口画面会真黑下去；
    //   更早的在网设备（≤167）只停单播放器，删房间后画面仍在播 —— 见 MainActivity.kt handleCommand。
    // 另外这里 publish 完就继续删行了，没有等设备的 status 回执 —— 通知是"尽力而为"。
    db.query('SELECT id, fingerprint FROM devices WHERE room_id = ?', [id], (errD, devs) => {
      if (errD) return res.status(500).json({error: errD.message});
      var bound = devs || [];
      bound.forEach(d => {
        publishToDeviceCommand(d, { action: 'stop' });
      });
      db.query('UPDATE devices SET room_id = NULL WHERE room_id = ?', [id], (errU) => {
        if (errU) return res.status(500).json({error: errU.message});
        db.query('DELETE FROM rooms WHERE id = ?', [id], (err2) => {
          if (err2) return res.status(500).json({error: err2.message});
          logAction('delete', 'room', { id, name: room ? room.name : null, store_name: room ? room.store_name : null, devices_unbound: bound.length });
          res.json({success:true, devices_unbound: bound.length});
        });
      });
    });
  });
});

// 【S-05h】 绑定设备到房间（更新 devices.room_id）+ 立刻把新房子的播放配置推给它
// 不推的话设备要等到下次重启/重新注册才拿到素材，界面上看就是"绑了没反应"
app.post('/api/devices/:id/bind-room', (req, res) => {
  const { room_id } = req.body;
  const id = req.params.id;
  db.query('UPDATE devices SET room_id = ? WHERE id = ?', [room_id, id], (err) => {
    if (err) return res.status(500).json({error:err.message});
    // 查房间名称用于日志 + 房间 config 用于下发
    db.query('SELECT r.name as room_name, r.config as room_config, d.name as device_name, d.fingerprint, d.authorized FROM devices d LEFT JOIN rooms r ON r.id = ? WHERE d.id = ?', [room_id, id], (err2, rows) => {
      const room = rows && rows[0];
      logAction('bind_room', 'device', {
        device_id: id,
        device_name: room ? room.device_name : null,
        room_id: room_id,
        room_name: room ? room.room_name : null
      });
      // 只有已授权的设备才推配置（未授权的真机收到也不会播，且不该绕过授权流程）
      if (room && room.authorized === 1 && room_id && room.room_config !== null && room.room_config !== undefined) {
        notifyDeviceRoomConfig({ id: id, fingerprint: room.fingerprint }, room_id, room.room_config, 'bind-room');
      }
      res.json({success:true});
    });
  });
});

// 【S-05i】 获取未注册/未授权设备列表（devices.authorized=0，排除已屏蔽；在线优先 + 最近上线排序）
app.get('/api/unregistered', (req, res) => {
  db.query("SELECT id, name, fingerprint, model, hardware, mac, location, status, first_seen, online_time FROM devices WHERE authorized = 0 AND status <> 'blocked' ORDER BY (status = 'online') DESC, online_time DESC", (err, results) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(results || []);
  });
});


// ==================== 默认素材 API（default_materials 表）====================
// 【S-13a】 获取默认素材列表（从 default_materials 表读取）
// ⚠️ 全孤儿接口：前端 index.html 与 APK 都没有任何调用点，服务端同步链路（folder_mappings /
//    room-materials-v2）也从不消费这张表。留着只是因为表还在库里。动它之前先确认真的不要了。
app.get('/api/default-materials', (req, res) => {
  db.query('SELECT * FROM default_materials ORDER BY id DESC', (err, results) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(results || []);
  });
});

// 【S-13b】 添加默认素材（写入 default_materials 表）
// 长度上限与下面的 DDL 对齐（MySQL 非严格模式下超长会静默截断，所以在这里挡）；
// type 只允许 video/image —— 前端与 APK 的类型判定只有这两种分支。
app.post('/api/default-materials', (req, res) => {
  const { name, url, type, thumbnail } = req.body;
  if (typeof name !== 'string' || !name.trim() || name.length > 255) {
    return res.status(400).json({ error: 'name 必填且不超过 255 字符' });
  }
  if (typeof url !== 'string' || !url.trim() || url.length > 512) {
    return res.status(400).json({ error: 'url 必填且不超过 512 字符' });
  }
  // 只收站内相对路径：这张表的 url 将来若被前端照抄进 <video src>/<a href>，
  // 允许 http(s) 绝对址 = 任意外链注入；'//' 开头则是协议相对（换 host）。
  if (!url.startsWith('/') || url.startsWith('//')) {
    return res.status(400).json({ error: "url 必须是站内相对路径（以 '/' 开头，不能 '//'" });
  }
  if (type !== 'video' && type !== 'image') {
    return res.status(400).json({ error: "type 只能是 'video' 或 'image'" });
  }
  if (thumbnail != null && (typeof thumbnail !== 'string' || thumbnail.length > 512)) {
    return res.status(400).json({ error: 'thumbnail 需为不超过 512 字符的字符串' });
  }
  const id = 'def_' + Date.now();
  db.query(
    'INSERT INTO default_materials (id, name, url, type, thumbnail) VALUES (?, ?, ?, ?, ?)',
    [id, name, url, type, thumbnail || null],
    (err) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ id, name, url, type, thumbnail });
    }
  );
});

// 【S-13c】 删除默认素材（从 default_materials 表删除）
app.delete('/api/default-materials/:id', (req, res) => {
  db.query('DELETE FROM default_materials WHERE id = ?', [req.params.id], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

db.query(`CREATE TABLE IF NOT EXISTS stores (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL UNIQUE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

db.query(`CREATE TABLE IF NOT EXISTS default_materials (
  id VARCHAR(64) PRIMARY KEY,
  name VARCHAR(255),
  url VARCHAR(512),
  type VARCHAR(50),
  thumbnail VARCHAR(512),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

// 设备心跳超时检测（默认 60 秒）
const DEVICE_TIMEOUT_SECONDS = process.env.DEVICE_TIMEOUT || 60;

// 定期检查设备在线状态
setInterval(() => {
  db.query(
    `UPDATE devices SET status = 'offline' 
     WHERE status = 'online' 
     AND online_time < DATE_SUB(NOW(), INTERVAL ? SECOND)`,
    [DEVICE_TIMEOUT_SECONDS],
    (err, result) => {
      if (err) {
        console.error('检查设备在线状态失败:', err.message);
      } else if (result.affectedRows > 0) {
        console.log(`📴 ${result.affectedRows} 个设备已离线`);
      }
    }
  );
}, 10000); // 每 10 秒检查一次

app.listen(PORT, () => {
  console.log(`🚀 XVJ 云后台服务启动: http://localhost:${PORT}`);
  initDatabase();
});

/**
 * 【S-01】数据库初始化 —— app.listen 之后才调用，建 7 张表：
 *   devices / materials / preset_materials / folder_notes / operation_logs / apk_versions / device_versions
 * 幂等性说明：
 *   - CREATE TABLE IF NOT EXISTS 对"表已存在、但缺新列"毫无作用，所以加列一律靠显式
 *     ALTER TABLE ... ADD COLUMN，靠 catch 掉 ER_DUP_FIELDNAME 来幂等（见下面 apk_versions.md5）。
 *   - 另有 3 张表不在此函数内，是模块加载时裸 db.query 建的（stores×2、rooms、default_materials），
 *     它们先于连接池就绪执行，失败只会打日志，不会挡住启动。
 *   - devices.authorized 的列默认值是 1，但所有 INSERT 都显式传 0，所以不影响"新设备待审核"。
 */
function initDatabase() {
  // 列结构对齐生产库（SHOW CREATE TABLE devices，2026-09-18）：mqtt_id / first_seen / store / room_id
  // 这四列当年是手工 ALTER 上去的，DDL 里漏了会让全新 MySQL 冷启动时缺列直接报错（register 的
  // INSERT first_seen、按 room_id 定向发送都依赖它们）。表已存在时 IF NOT EXISTS 什么都不做。
  // 注：fingerprint 生产是 VARCHAR(64)，这里保持 VARCHAR(255) —— 只影响新建库，且更宽松不会截断。
  db.query(`
    CREATE TABLE IF NOT EXISTS devices (
      id VARCHAR(64) PRIMARY KEY,
      name VARCHAR(255),
      location VARCHAR(255),
      fingerprint VARCHAR(255),
      mqtt_id VARCHAR(64),
      model VARCHAR(100),
      hardware VARCHAR(100),
      mac VARCHAR(50),
      status VARCHAR(50) DEFAULT 'offline',
      authorized TINYINT(1) DEFAULT 1,
      config TEXT,
      status_data TEXT,
      online_time DATETIME,
      first_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
      store VARCHAR(100) DEFAULT '默认店',
      room_id VARCHAR(36)
    )
  `);
  
  db.query(`
    CREATE TABLE IF NOT EXISTS materials (
      id VARCHAR(36) PRIMARY KEY,
      name VARCHAR(255),
      filename VARCHAR(255),
      url VARCHAR(512),
      type VARCHAR(50),
      folder VARCHAR(10),
      thumbnail VARCHAR(512),
      resolution VARCHAR(50),
      md5 VARCHAR(32),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 预设素材表（前端"复制到预设"的目标，folder_id 为 01-30 数字编号）
  db.query(`
    CREATE TABLE IF NOT EXISTS preset_materials (
      id VARCHAR(36) PRIMARY KEY,
      folder_id VARCHAR(50) NOT NULL,
      folder_name VARCHAR(100),
      filename VARCHAR(255) NOT NULL,
      url VARCHAR(512) NOT NULL,
      type VARCHAR(20) DEFAULT 'video',
      thumbnail VARCHAR(512),
      md5 VARCHAR(32),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_folder_id (folder_id)
    )
  `);

  // 文件夹备注表
  db.query(`
    CREATE TABLE IF NOT EXISTS folder_notes (
      folder VARCHAR(10) PRIMARY KEY,
      note VARCHAR(255)
    )
  `);

  // 操作日志表
  db.query(`
    CREATE TABLE IF NOT EXISTS operation_logs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      action VARCHAR(50),
      target VARCHAR(50),
      details TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // APK版本表
  db.query(`
    CREATE TABLE IF NOT EXISTS apk_versions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      version VARCHAR(50) NOT NULL,
      version_code INT NOT NULL,
      filename VARCHAR(255) NOT NULL,
      filepath VARCHAR(512) NOT NULL,
      size INT DEFAULT 0,
      md5 VARCHAR(32) DEFAULT NULL,
      changelog TEXT,
      is_latest TINYINT(1) DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  // 旧库补列（MySQL 8 无 ADD COLUMN IF NOT EXISTS，靠 1060 错误码幂等）
  db.query("ALTER TABLE apk_versions ADD COLUMN md5 VARCHAR(32) DEFAULT NULL", (e) => {
    if (e && e.code !== 'ER_DUP_FIELDNAME') console.error('apk_versions 加 md5 列失败:', e.message);
  });

  // 设备版本记录表
  db.query(`
    CREATE TABLE IF NOT EXISTS device_versions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      device_id VARCHAR(64) NOT NULL,
      version VARCHAR(50) DEFAULT '',
      version_code INT DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY unique_device (device_id)
    )
  `);
  
  console.log('✅ 数据库初始化完成');
}

// ==================== 版本管理 API ====================

// APK 下载地址（nginx 80 端口直出 public/apk）
// 基址跟随 config.serverUrl（env SERVER_URL 可覆盖），换域名/上 HTTPS 改环境变量即可，
// 【S-05e】的相对 URL 补全也共用它。
// ⚠️ 但 APK 侧 isTrustedApkUrl 是硬编码精确匹配 47.102.106.237：换成域名后设备会拒下 OTA，
//    必须连 APK 一起改并发版，不能只改这里。
const APK_DOWNLOAD_BASE = String(config.serverUrl || 'http://47.102.106.237').replace(/\/+$/, '');

// 流式计算文件 MD5（避免大文件整读进内存）
function fileMd5(fullPath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('md5');
    fs.createReadStream(fullPath)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}

// 【S-12a】 获取版本列表（从 apk_versions 表读取）
app.get('/api/versions', (req, res) => {
  db.query('SELECT * FROM apk_versions ORDER BY version_code DESC', (err, results) => {
    if (err) return res.status(500).json({error:err.message});
    res.json(results || []);
  });
});

// 【S-12b】 获取最新版本（优先读库中 MD5，旧记录懒计算并回填）
app.get('/api/version/latest', (req, res) => {
  db.query('SELECT * FROM apk_versions WHERE is_latest = 1 ORDER BY version_code DESC LIMIT 1', async (err, results) => {
    if (err) return res.status(500).json({error:err.message});
    if (results.length === 0) return res.json({});

    const apk = results[0];
    const fullPath = path.join(__dirname, 'public', apk.filepath);
    if (fs.existsSync(fullPath)) {
      if (!apk.md5) {
        try {
          apk.md5 = await fileMd5(fullPath);
          db.query('UPDATE apk_versions SET md5 = ? WHERE id = ?', [apk.md5, apk.id]);
        } catch (e) { console.error('计算 APK MD5 失败:', e.message); }
      }
    }

    res.json(apk);
  });
});

// 上传APK
const uploadDir = path.join(__dirname, 'public/apk');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, {recursive:true});

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, 'xvj-' + Date.now() + '.apk')
});
const upload = multer({storage, limits:{fileSize:200*1024*1024}});

// 【S-12c】 上传 APK 新版本（写入 apk_versions 表，标记 is_latest=1，落库 MD5）
app.post('/api/versions/upload', upload.single('apk'), async (req, res) => {
  if (!req.file) return res.status(400).json({error:'No file uploaded'});

  const {version, version_code, changelog} = req.body;
  if (!version || !version_code) return res.status(400).json({error:'version and version_code required'});
  const code = parseInt(version_code, 10);
  if (isNaN(code) || code <= 0) { fs.unlinkSync(req.file.path); return res.status(400).json({error:'version_code 必须是正整数'}); }

  // 查重：同一 version_code 不允许重复上传
  db.query('SELECT id, version FROM apk_versions WHERE version_code = ?', [code], async (err, dups) => {
    if (err) return res.status(500).json({error:err.message});
    if (dups && dups.length > 0) {
      fs.unlinkSync(req.file.path);
      return res.status(409).json({error:'版本号 ' + code + ' 已存在（v' + dups[0].version + '），请使用新的版本号'});
    }

    let md5 = null;
    try { md5 = await fileMd5(req.file.path); } catch (e) { console.error('上传 APK 算 MD5 失败:', e.message); }

    // 取消之前的latest标记（失败必须停手：留着两个 is_latest=1 时，取最新的 SELECT ... LIMIT 1
    // 会随机挑一行，推送/轮询可能把旧版本当最新版发给设备）
    db.query('UPDATE apk_versions SET is_latest = 0', (err) => {
      if (err) return res.status(500).json({ error: err.message });
      const filepath = '/apk/' + req.file.filename;
      db.query(
        'INSERT INTO apk_versions (version, version_code, filename, filepath, size, md5, changelog, is_latest) VALUES (?, ?, ?, ?, ?, ?, ?, 1)',
        [version, code, req.file.filename, filepath, req.file.size, md5, changelog || ''],
        (err2, result) => {
          if (err2) return res.status(500).json({error:err2.message});
          res.json({success:true, id:result.insertId, filepath, md5});
        }
      );
    });
  });
});

// 【S-12d】 删除 APK 版本（物理文件 + apk_versions 表记录）
app.delete('/api/versions/:id', (req, res) => {
  const id = req.params.id;
  db.query('SELECT filepath FROM apk_versions WHERE id = ?', [id], (err, results) => {
    if (err) return res.status(500).json({error:err.message});
    if (results.length > 0) {
      const fullPath = path.join(__dirname, 'public', results[0].filepath);
      if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
    }
    db.query('DELETE FROM apk_versions WHERE id = ?', [id], (err2) => {
      if (err2) return res.status(500).json({error:err2.message});
      res.json({success:true});
    });
  });
});

// 【S-12e】 设备上报版本（写入 device_versions 表）
// 走 HTTP 的这条口目前没有任何客户端调用（APK 不发，前端只读 /api/device/versions）。
// 在用的版本上报路径是 MQTT status 心跳 —— 见入站 status 分支里"设备版本上报"那段，它同样写 device_versions。
app.post('/api/device/version', (req, res) => {
  const {device_id, version, version_code} = req.body;
  if (!device_id) return res.status(400).json({error:'device_id required'});
  
  db.query(
    'INSERT INTO device_versions (device_id, version, version_code) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE version = ?, version_code = ?',
    [device_id, version || '', version_code || 0, version || '', version_code || 0],
    (err) => {
      if (err) return res.status(500).json({error:err.message});
      res.json({success:true});
    }
  );
});

// 【S-12f】 获取设备版本列表（JOIN devices + device_versions 表）
app.get('/api/device/versions', (req, res) => {
  db.query(`
    SELECT d.id, d.name, r.store_name AS store, d.room_id, d.status, dv.version, dv.version_code, dv.updated_at
    FROM devices d
    LEFT JOIN rooms r ON d.room_id = r.id
    LEFT JOIN device_versions dv ON d.id = dv.device_id
    WHERE d.status <> 'blocked'
    ORDER BY dv.updated_at DESC
  `, (err, results) => {
    if (err) return res.status(500).json({error:err.message});
    res.json(results || []);
  });
});

// 【S-12g】 推送更新到指定设备（MQTT command 主题下发 APK 下载链接）
app.post('/api/devices/:id/push-update', (req, res) => {
  const deviceId = req.params.id;
  
  db.query('SELECT * FROM apk_versions WHERE is_latest = 1 ORDER BY version_code DESC LIMIT 1', (err, versions) => {
    if (err) return res.status(500).json({error:err.message});
    if (versions.length === 0) return res.status(404).json({error:'No APK available'});
    
    const apk = versions[0];
    // 查设备 id+fingerprint（双发防 OTA 后指纹漂移失联）
    db.query('SELECT id, fingerprint FROM devices WHERE id = ?', [deviceId], (err2, devs) => {
      if (err2 || devs.length === 0) return res.status(404).json({ error: '设备未找到' });
      const cmd = {
        action: 'update',
        version: apk.version,
        version_code: apk.version_code,
        md5: apk.md5 || '',
        url: APK_DOWNLOAD_BASE + apk.filepath
      };
      publishToDeviceCommand(devs[0], cmd);
      logAction('push_update', 'device', { device_id: deviceId, version: apk.version, version_code: apk.version_code });
      res.json({success:true, message:'Update pushed'});
    });
  });
});

// 【S-12h】 推送指定版本到所有已授权设备（MQTT 批量下发）
app.post('/api/versions/:id/push-to-all', (req, res) => {
  const versionId = req.params.id;
  db.query('SELECT * FROM apk_versions WHERE id = ?', [versionId], (err, versions) => {
    if (err) return res.status(500).json({error: err.message});
    if (versions.length === 0) return res.status(404).json({error: '版本不存在'});
    const apk = versions[0];
    db.query('SELECT id, fingerprint FROM devices WHERE authorized = 1', (err2, devices) => {
      if (err2) return res.status(500).json({error: err2.message});
      let pushed = 0;
      devices.forEach(device => {
        const cmd = {
          action: 'update',
          version: apk.version,
          version_code: apk.version_code,
          md5: apk.md5 || '',
          url: APK_DOWNLOAD_BASE + apk.filepath
        };
        publishToDeviceCommand(device, cmd);
        pushed++;
      });
      logAction('push_update_all', 'device', { version_id: versionId, version: apk.version, version_code: apk.version_code, devices: pushed });
      res.json({success: true, pushed, version: apk.version});
    });
  });
});

// 操作日志接口
app.post('/api/log', (req, res) => {
  const { action, type, detail } = req.body;
  logAction(action, type, detail);

// 【S-08】 操作日志 // POST /api/log
  res.json({ success: true });
});

// 全局错误日志中间件
app.use((err, req, res, next) => {
  console.error('API Error:', err.message, req.method, req.path);
  writeFault('API错误', err.message, { method: req.method, path: req.path });
  logAction('error', 'api', { method: req.method, path: req.path, error: err.message });
  res.status(500).json({ error: err.message });
});