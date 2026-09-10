/**
 * XVJ 云控系统 - 服务端
 * ========================
 * 架构：Node.js + Express + MySQL + MQTT
 * 端口：3000
 *
 * 【代码索引】编辑时搜索 "【S-XX】" 快速定位
 * ─────────────────────────────────────────────
 * 【S-01】数据库初始化 & MySQL 连接池
 * 【S-02】素材管理 API（/api/materials）
 * 【S-03】预设素材 API（/api/preset/*）
 * 【S-04】房间 CRUD API（/api/rooms*）
 * 【S-05】授权 & 设备管理 API（/api/devices*）
 * 【S-06】MQTT 消息处理 & 发送（mqttClient）
 * 【S-07】素材同步 & 删除（DELETE /api/rooms/:roomId/materials/:materialId）
 * 【S-08】日志 & 操作记录（logAction）
 * 【S-09】静态文件 & 前端页面
 * 【S-10】文件夹管理 API（/api/folders*）
 * 【S-11】店铺管理 API（/api/stores*）
 * 【S-12】版本管理 API（/api/versions*、/api/device/versions*）
 * ─────────────────────────────────────────────
 *
 * 核心表：
 *   materials          - 素材库（原始视频文件）
 *   preset_materials   - 预设素材（从素材库复制，可跨房间复用）
 *   rooms              - 房间配置中心（folder_mappings 是设备同步唯一真相）
 *   devices            - 设备注册表
 *   operation_logs      - 前端操作日志（logAction 写入）
 *   device_logs        - 设备日志（APP MQTT log 主题上报）
 *
 * MQTT 主题：
 *   xvj/device/{id}/status  - 设备状态上报
 *   xvj/device/{id}/command  - 服务端命令下发
 *   xvj/device/{id}/log     - 设备日志上报（远程 DEBUG 通道）
 *
 * 素材三层架构：
 *   素材库 [M] ──cp2p──→ 预设素材 [P] ──mapPreset──→ 房间 [D]
 *
 * ==========================================================
 * 场景系统（多窗口）
 * ==========================================================
 * 场景数据结构（存储在 rooms.config.scenes）：
 *   {
 *     A: { name: '第一幕', folder_mappings: {...}, windows: [WinConfig, ...] },
 *     B: { name: '第二幕', folder_mappings: {...}, windows: [WinConfig, ...] }
 *   }
 *
 * WinConfig（窗口配置）：
 *   {
 *     id: String,        // 窗口唯一ID，如 "win_1"
 *     name: String,       // 显示名称，如 "主屏"
 *     x: Number,          // 左上角 X 坐标（px）
 *     y: Number,          // 左上角 Y 坐标（px）
 *     width: Number,      // 宽度（px）
 *     height: Number,     // 高度（px）
 *     zIndex: Number,    // 层级（越大越上层）
 *     aspectRatio: String | null,  // 如 "16:9"，可选
 *     content: {                    // 窗口内容
 *       type: 'COLOR' | 'VIDEO' | 'HDMI' | 'IMAGE',
 *       // type=HDMI 时：
 *       inputIndex?: Number,        // HDMI 输入索引（0-based）
 *       // type=COLOR 时：
 *       color?: String,             // 背景色，如 "#000000"
 *       // type=VIDEO 时：
 *       folderId?: String           // 对应素材文件夹 ID，如 "01"
 *     }
 *   }
 *
 * 设备开机流程：
 *   1. APP 启动 → loadConfig() → 从 scenes_json 缓存恢复 → 窗口1播放文件夹01
 *   2. MQTT 连接成功 → 收到 sync_room_materials → applySceneConfigs(scenes)
 *   3. scenes 为空 → 离线模式，使用 scenes_json 缓存恢复
 *
 * 重要约定：
 *   - 房间是配置中心，设备只是执行器
 *   - 设备授权前用 fingerprint，注册后用 uuid
 *   - APK filepath 统一存在 /apk/xxx.apk，URL 用 path.basename 构造
 *   - 第二幕（场景B）默认窗口为空，由用户手动配置
 */


const express = require('express');
const mysql = require('mysql2');
const mqtt = require('mqtt');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

// 故障记录文件路径
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

/**
 * 将 scenes 对象中的 folder_mappings 键名前缀 scene 标识（A01, B01...）
 * @param {object} scenes - { A: { folder_mappings: { "01": [...] } }, B: { ... } }
 * @returns {object} - { A: { folder_mappings: { "A01": [...] } }, B: { "B01": [...] } }
 * 用途：MQTT 发送时统一格式，避免 A/B 场景共用 "01" 导致物理文件夹冲突
 */
function buildPrefixedScenes(scenes) {
  var result = {};
  Object.keys(scenes || {}).forEach(function(key) {
    var sceneData = scenes[key];
    var prefixedMappings = {};
    Object.keys(sceneData.folder_mappings || {}).forEach(function(folderId) {
      prefixedMappings[key + folderId] = sceneData.folder_mappings[folderId];
    });
    result[key] = {
      name: sceneData.name,
      folder_mappings: prefixedMappings,
      windows: sceneData.windows || []
    };
    if (sceneData.master) result[key].master = sceneData.master;
  });
  console.log('[DEBUG buildPrefixedScenes] 输入 scenes keys:', JSON.stringify(Object.keys(scenes || {})), '输出 folder_mappings:', JSON.stringify(result['A'] ? result['A'].folder_mappings : {}));
  return result;
}

/**
 * 合并 prefixedScenes 的 A+B folder_mappings 为一个对象（键 A01/B01）
 * sync 命令的 folder_mappings 字段统一用这个（A+B 全量），
 * 消除各发送方语义不一致（曾出现 A-only / curScene-only 导致 APK 误清另一幕文件）
 */
function mergePrefixedMappings(prefixedScenes) {
  const fmA = prefixedScenes.A ? prefixedScenes.A.folder_mappings : {};
  const fmB = prefixedScenes.B ? prefixedScenes.B.folder_mappings : {};
  const merged = {};
  Object.keys(fmA).forEach(k => { merged[k] = [...(fmA[k] || [])]; });
  Object.keys(fmB).forEach(k => {
    if (merged[k]) {
      [...(fmB[k] || [])].forEach(id => { if (!merged[k].includes(id)) merged[k].push(id); });
    } else {
      merged[k] = [...(fmB[k] || [])];
    }
  });
  return merged;
}

const app = express();
const PORT = config.port;

/**
 * API 认证中间件（验证 x-api-key 或 query.apiKey）
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

// 写操作统一要求 API 密钥（GET 保持开放：设备端/APK 只做 GET）
app.use('/api', (req, res, next) => {
  if (req.method === 'GET' || req.method === 'OPTIONS' || req.method === 'HEAD') return next();
  requireAuth(req, res, next);
});

// Serve static files (index.html)
app.get('/', (req, res) => {
  res.sendFile('/var/www/xvj/index.html');
});

// mqtt.js 浏览器端库
app.get('/mqtt.min.js', (req, res) => {
  res.sendFile(__dirname + '/public/mqtt.min.js');
});

// 静态文件服务：素材文件（视频、图片、缩略图）
app.use('/uploads', express.static(__dirname + '/public/uploads'));

// 【S-09a】 获取服务器配置（供设备使用，返回 serverUrl / mqttHost / mqttPort）
app.get('/api/config', (req, res) => {
  res.json({
    serverUrl: config.serverUrl,
    mqttHost: config.mqtt.host,
    mqttPort: config.mqtt.port
  });
});

// ============================================================================
// 📦 数据库连接配置
// ============================================================================
// ============================================================================
// 📦 数据库连接配置
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
// 📡 MQTT 配置与消息处理
//    主题：xvj/device/{id}/status（设备状态）、
//          xvj/device/{id}/register（设备注册）、
//          xvj/auth/response（授权响应）、
//          xvj/device/{id}/command（服务器→设备指令）
// ============================================================================
const mqttBroker = `mqtt://${config.mqtt.host}:${config.mqtt.port}`;
const mqttPassword = process.env.MQTT_PASSWORD || '';

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
  mqttClient.subscribe('xvj/auth/request');
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
      if (data.device_id) {
        // 手动路由到 register 处理
        handleDeviceRegister(data.device_id, data);
      }
    } catch(e) {}
    return;
  }
  
  const deviceId = afterPrefix.substring(0, lastSlash);
  const msgType = afterPrefix.substring(lastSlash + 1);
  
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
              logAction(isOnline ? 'online' : 'offline', 'device', { device_id: deviceId, fingerprint: fingerprint });
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
            // 防膨胀：约2%概率触发，保留最新 5000 条
            if (Math.random() < 0.02) {
              db.query('DELETE FROM device_logs WHERE id < (SELECT * FROM (SELECT id FROM device_logs ORDER BY id DESC LIMIT 1 OFFSET 4999) t)');
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
           ON DUPLICATE KEY UPDATE status=IF(status<>'blocked','online',status), online_time=IF(status<>'blocked',NOW(),online_time), authorized=IF(status<>'blocked',0,authorized)`,
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
// 📤 发送授权响应 — sendAuthResponse / sendSyncCommandToDevice
//    设备上线时调用，发 MQTT 给设备，告知授权结果和 folder_mappings
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
          const roomConfig = JSON.parse(results[0].config || '{}');
          const debugFlag = roomConfig.debug === true;

          // 给 scenes 的 folder_mappings 键名加 scene 前缀（A01, B01），避免物理文件夹冲突
          var prefixedScenes = buildPrefixedScenes(roomConfig.scenes || {});

          // 构建完整的推送数据
          const payload = {
            action: 'auth_result',
            device_id: deviceId,
            authorized: true,
            message: message,
            room_id: roomId || '',
            scenes: prefixedScenes,
            folder_mappings: mergePrefixedMappings(prefixedScenes),
            debug: debugFlag,
            timestamp: Date.now()
          };

          mqttClient.publish(topic, JSON.stringify(payload), { qos: 1 });
          console.log(`📤 已推送授权+素材配置到设备 ${deviceId}, 房间: ${roomId}, 文件夹: ${JSON.stringify(prefixedScenes.A ? prefixedScenes.A.folder_mappings : {})}`);

          // 触发设备同步素材
          sendSyncCommandToDevice(deviceId, roomId, roomConfig);

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

// 发送同步命令到设备，触发素材下载
// sendSyncCommandToDevice: mqttId = fingerprint（APK 订阅的 topic），若没有则 fallback 到 deviceId
function sendSyncCommandToDevice(mqttId, roomId, config) {
  var scenes = (config && config.scenes) || {};

  // 给 scenes 里的 folder_mappings 键名前缀 scene 标识，避免 A/B 共用 "01" 导致物理文件夹冲突
  var prefixedScenes = buildPrefixedScenes(scenes);

  const topic = `xvj/device/${mqttId}/command`;
  const payload = {
    action: 'sync_room_materials',
    room_id: roomId,
    scenes: prefixedScenes,   // folder_mappings 键名已加 scene 前缀
    folder_mappings: mergePrefixedMappings(prefixedScenes), // A+B 全量（A01/B01 键），各发送方统一
    debug: config && config.debug === true,
    timestamp: Date.now()
  };
  mqttClient.publish(topic, JSON.stringify(payload), { qos: 1 });
  console.log(`📦 已发送同步命令到设备 ${mqttId}, scenes=A/B (scene-prefixed), debug=${payload.debug}`);
}

/**
 * 向指定房间的所有在线授权设备推送 sync_room_materials 命令
 * @param {string} roomId - 房间ID
 */
function notifyRoomDevicesOfSync(roomId) {
  db.query(
    'SELECT id, fingerprint FROM devices WHERE room_id = ? AND authorized = 1',
    [roomId],
    (err, devices) => {
      if (err || !devices || devices.length === 0) return;
      db.query('SELECT config FROM rooms WHERE id = ?', [roomId], (err2, rows) => {
        if (err2 || !rows || rows.length === 0) return;
        const { config } = rows[0];
        const cfg = config ? JSON.parse(config) : {};
        // scene-prefixed 格式（与 sendSyncCommandToDevice / buildPrefixedScenes 一致）
        // cfg.scenes 的 folder_mappings 键是未加前缀的（"01", "02"...），需要用 buildPrefixedScenes 转换
        const prefixedScenes = buildPrefixedScenes(cfg.scenes || {});
        const allFolderMappings = mergePrefixedMappings(prefixedScenes);
        devices.forEach(({ id: deviceId, fingerprint }) => {
          try {
            const mqttId = fingerprint || deviceId;
            const topic = `xvj/device/${mqttId}/command`;
            const payload = {
              action: 'sync_room_materials',
              room_id: roomId,
              scenes: prefixedScenes,  // buildPrefixedScenes 输出：A01/B01 keys
              folder_mappings: allFolderMappings,  // A01, B01 keys，与 HTTP API 一致
              debug: cfg.debug === true,
              timestamp: Date.now()
            };
            mqttClient.publish(topic, JSON.stringify(payload), { qos: 1 });
            console.log(`📦 [notify] 已推送 sync 到设备 ${deviceId} (房间 ${roomId})`);
          } catch (e) {
            console.error(`[notify] MQTT 发布失败，设备 ${deviceId}: ${e.message}`);
          }
        });
      });
    }
  );
}

/**
 * 远程废止设备（MQTT 推送 deauthorize 命令，数据库 authorized=0）
 * @param {string} deviceId - 设备 ID
 * @returns {boolean} 是否成功（异步操作，实际返回无意义）
 */
function deauthorizeDevice(deviceId) {
  db.query(
    'UPDATE devices SET authorized = 0 WHERE id = ?',
    [deviceId],
    (err) => {
      if (err) {
        console.error('废止设备失败:', err);
        return false;
      }
      
      // 发送废止命令到设备
      const topic = 'xvj/auth/response';
      const payload = JSON.stringify({
        action: 'deauthorize',
        device_id: deviceId,
        message: '设备已被废止',
        timestamp: Date.now()
      });
      mqttClient.publish(topic, payload);
      
      // 同时通过设备特定主题发送
      mqttClient.publish(`xvj/device/${deviceId}/command`, JSON.stringify({
        action: 'stop',
        reason: 'device_deauthorized'
      }));
      
      console.log(`🚫 设备已废止: ${deviceId}`);
      return true;
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

// 【S-05d】 删除设备记录 — 仅限未授权设备；级联清理版本/日志，通知设备端授权失效
// 注意：设备若仍在线会重新注册再次出现，要永久屏蔽请用「忽略」（POST /api/devices/:id/block）
app.delete('/api/devices/:id', (req, res) => {
  const did = req.params.id;
  db.query('SELECT authorized FROM devices WHERE id = ?', [did], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!rows || rows.length === 0) return res.status(404).json({ error: '设备不存在' });
    if (rows[0].authorized === 1) return res.status(409).json({ error: '设备已授权，请先解绑或废止后再删除' });
    mqttClient.publish('xvj/auth/response', JSON.stringify({ action: 'deauthorize', device_id: did, message: '设备记录已被删除' }));
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
      mqttClient.publish('xvj/auth/response', JSON.stringify({ action: 'deauthorize', device_id: deviceId, message: '设备已被屏蔽' }));
      logAction('block', 'device', { device_id: deviceId });
      res.json({ success: true });
    });
  });
});

// 【S-05e】 发送指令到设备（MQTT command 主题下发）
app.post('/api/devices/:id/command', (req, res) => {
  const { command } = req.body;
  const deviceId = req.params.id;

  // 转换相对URL为完整URL
  let cmd = { ...command };
  if (cmd.url && cmd.url.startsWith('/')) {
    cmd.url = 'http://47.102.106.237' + cmd.url;
  }

  // sync 命令需要补全 room_id + folder_mappings（服务器查数据库，APK 不需要重复传）
  if (cmd.action === 'sync') {
    db.query(
      'SELECT d.room_id, d.fingerprint, r.folder_mappings, r.config FROM devices d LEFT JOIN rooms r ON d.room_id = r.id WHERE d.id = ?',
      [deviceId],
      (err, rows) => {
        if (err || !rows || rows.length === 0) {
          return res.status(404).json({ error: '设备未找到' });
        }
        const { room_id, fingerprint, folder_mappings, config } = rows[0];
        if (!room_id) {
          return res.status(400).json({ error: '设备未绑定房间' });
        }
        const roomConfig = config ? JSON.parse(config) : {};
        const devFingerprint = fingerprint || deviceId;
        const topic = `xvj/device/${devFingerprint}/command`;

        // scene-prefixed scenes + folder_mappings（与 sendSyncCommandToDevice 完全一致）
        var prefixedScenes = buildPrefixedScenes(roomConfig.scenes);
        const curScene = roomConfig.current_scene || 'A';
        const syncCmd = {
          action: 'sync_room_materials',
          room_id: room_id,
          scenes: prefixedScenes,
          folder_mappings: prefixedScenes[curScene] ? prefixedScenes[curScene].folder_mappings : {},
          debug: roomConfig.debug === true
        };
        mqttClient.publish(topic, JSON.stringify(syncCmd));
        logAction('sync', 'device', { device_id: deviceId, command: syncCmd });
        res.json({ success: true, command: syncCmd });
      }
    );
    return;
  }

  // 查询设备的 fingerprint 用于 MQTT topic
  db.query('SELECT fingerprint FROM devices WHERE id = ?', [deviceId], (err, rows) => {
    if (err || rows.length === 0) return res.status(404).json({ error: '设备未找到' });
    const devFingerprint = rows[0].fingerprint || deviceId;
    const topic = `xvj/device/${devFingerprint}/command`;
    mqttClient.publish(topic, JSON.stringify(cmd));
    logAction('sync', 'device', { device_id: deviceId, command: cmd });
    res.json({ success: true, command: cmd });
  });
});

// 房间同步：向指定房间的所有授权设备发送 sync_room_materials

// 【S-07f】 房间同步：同步 scenes A+B 的完整 folder_mappings（外部信号决定播放哪个文件夹，设备必须同时有A和B的数据）
app.post('/api/rooms/:id/sync', (req, res) => {
  const roomId = req.params.id;

  // 查房间的 folder_mappings 和 config
  db.query('SELECT config FROM rooms WHERE id = ?', [roomId], (err, rows) => {
    if (err || !rows || rows.length === 0) {
      return res.status(404).json({ error: '房间不存在' });
    }
    const config = rows[0].config ? JSON.parse(rows[0].config) : {};

    // scene-prefixed 统一格式（与 sendSyncCommandToDevice / notifyRoomDevicesOfSync 一致；
    // APK 落盘目录与播放解析均以 A01/B01 形态为准，无前缀格式会导致播放指向根目录 01）
    const prefixedScenes = buildPrefixedScenes(config.scenes);
    const allFolderMappings = mergePrefixedMappings(prefixedScenes);

    // 查房间下所有已授权的设备
    db.query(
      'SELECT id, fingerprint FROM devices WHERE room_id = ? AND authorized = 1',
      [roomId],
      (err2, devices) => {
        if (err2) return res.status(500).json({ error: err2.message });

        if (!devices || devices.length === 0) {
          return res.json({ success: true, sent: 0, message: '房间无授权设备' });
        }

        let sent = 0;
        devices.forEach((d) => { const mqttId = d.fingerprint || d.id;
          const topic = `xvj/device/${mqttId}/command`;
          const syncCmd = {
            action: 'sync_room_materials',
            room_id: roomId,
            scenes: prefixedScenes,          // 完整两套场景，folder_mappings 键已带场景前缀（APK 渲染窗口用）
            folder_mappings: allFolderMappings, // A01/B01 键，与 HTTP API 返回格式一致
            debug: config.debug === true
          };
          mqttClient.publish(topic, JSON.stringify(syncCmd), { qos: 1 });
          sent++;
        });

        logAction('room_sync', 'room', { room_id: roomId, devices: sent });
        res.json({ success: true, sent, command: { action: 'sync_room_materials', room_id: roomId, scenes: config.scenes } });
      }
    );
  });
});

// 【S-07d】从房间删除素材：A/B 两幕同编号文件夹一起清（与添加时写双幕对称）
// 流程：清理 scenes A/B folder_mappings → UPDATE DB → 发 delete_material + sync_room_materials
app.delete('/api/rooms/:roomId/materials/:materialId', (req, res) => {
  const { roomId, materialId } = req.params;
  const folder = req.query.folder || '01';
  const curScene = req.query.scene || 'A';   // 明确指定场景，默认 A

  // 1. 查出文件名（查 materials 和 preset_materials 两个表）
  db.query(
    'SELECT filename, name FROM materials WHERE id = ? UNION SELECT filename, name FROM preset_materials WHERE id = ?',
    [materialId, materialId],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      const filename = (rows && rows[0]?.filename) || (rows && rows[0]?.name) || null;

      // 2. 只从 curScene 的 folder_mappings 中移除该素材 ID（不动其他场景）
      db.query('SELECT config FROM rooms WHERE id = ?', [roomId], (err2, roomRows) => {
        if (err2 || !roomRows || roomRows.length === 0) {
          return res.status(404).json({ error: '房间不存在' });
        }

        let config = {};
        try { config = roomRows[0].config ? JSON.parse(roomRows[0].config) : {}; } catch(e) {}

        // 从 folder_mappings 移除该素材：A/B 两幕同编号文件夹一起清（与添加素材到房间时写双幕对称，
        // 否则会出现"B 幕删了 A 幕还有"的幻影素材）
        let removed = false;
        if (config.scenes) {
          ['A', 'B'].forEach(scene => {
            if (config.scenes[scene] && config.scenes[scene].folder_mappings) {
              Object.keys(config.scenes[scene].folder_mappings).forEach(fid => {
                const arr = config.scenes[scene].folder_mappings[fid] || [];
                const before = arr.length;
                config.scenes[scene].folder_mappings[fid] = arr.filter(id => id !== materialId);
                if (arr.length !== before) removed = true;
              });
            }
          });
        }

        // 写回 DB
        db.query(
          'UPDATE rooms SET config = ? WHERE id = ?',
          [JSON.stringify(config), roomId],
          (err3) => {
            if (err3) console.error('删除素材更新 room config 失败:', err3);
            else console.log('🗑 房间', roomId, 'Scene', curScene, 'folder', folder, '移除素材', materialId, removed ? '✓' : '(未找到)');

            // 3. 查房间下所有已授权设备
            db.query(
              'SELECT id, fingerprint FROM devices WHERE room_id = ? AND authorized = 1',
              [roomId],
              (err4, devices) => {
                if (err4) return res.status(500).json({ error: err4.message });

                let sentDel = 0, sentSync = 0;
                (devices || []).forEach(d => {
                  const mqttId = d.fingerprint || d.id;
                  const topic = `xvj/device/${mqttId}/command`;

                  // 3a. delete_material：让 APK 立即删本地文件（尽力发）。
                  // folder 带场景前缀（"A01"），APK deleteMaterialFile 按前缀解析物理目录 scenea/01
                  mqttClient.publish(topic, JSON.stringify({
                    action: 'delete_material',
                    material_id: materialId,
                    folder: curScene + folder,
                    filename: filename
                  }), { qos: 1 });
                  sentDel++;

                  // 3b. sync_room_materials：folder_mappings 统一 A+B 全量（mergePrefixedMappings）
                  var prefixedScenes = buildPrefixedScenes(config.scenes);
                  mqttClient.publish(topic, JSON.stringify({
                    action: 'sync_room_materials',
                    room_id: roomId,
                    scenes: prefixedScenes,
                    folder_mappings: mergePrefixedMappings(prefixedScenes),
                    debug: config.debug === true
                  }), { qos: 1 });
                  sentSync++;
                });

                logAction('material_delete', 'room', {
                  room_id: roomId, material_id: materialId,
                  folder, filename, scene: curScene,
                  removed, devices: sentDel, synced: sentSync
                });

                res.json({
                  success: true,
                  sent: sentDel,
                  synced: sentSync,
                  removed_scene: curScene,
                  was_removed: removed
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

  // 操作数据库：更新 devices 表，将授权状态设为 0
  db.query(
    'UPDATE devices SET authorized = 0, status = "deauthorized" WHERE id = ?',
    [deviceId],
    (err) => {
      if (err) return res.status(500).json({ error: err.message });
      
      // 发送废止命令
      const topic = 'xvj/auth/response';
      const payload = JSON.stringify({
        action: 'deauthorize',
        device_id: deviceId,
        message: '设备已被废止'
      });
      mqttClient.publish(topic, payload);
      logAction('deauthorize', 'device', { device_id: deviceId });
      res.json({ success: true, message: '设备已废止' });
    }
  );
});

// 【S-05f】 重新授权设备 — 更新 devices.authorized=1，MQTT 推送授权响应
// Bug修复：MQTT topic必须使用DB中设备的真实id字段（64-char UUID），
// 避免APK订阅的topic永远不匹配
app.post('/api/devices/:id/authorize', (req, res) => {
  const deviceId = req.params.id;
  const store = decodeURIComponent(req.query.store || req.body.store || '默认店');
  const roomId = req.query.room_id || req.body.room_id || null;
  console.log('授权到店铺:', store, '房间:', roomId);

  // 先查设备，用DB中的id字段作为MQTT topic ID（APK订阅用的是这个）
  db.query('SELECT id FROM devices WHERE id = ?', [deviceId], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });

    let mqttId = deviceId;
    // 如果DB id与传入的不完全匹配（可能是别名），确保使用DB中的真实id
    if (rows && rows.length > 0) {
      mqttId = rows[0].id;
    }

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
// 📁 素材管理 API — /api/materials
//    GET    查素材库（支持 ?folder= 参数）
//    POST   手动新增素材（少用）
//    DELETE 删除素材（同时删物理文件 + 写日志）
// ============================================================================

// 7. 获取素材列表

// 【S-02】 素材管理 API：GET|POST /api/materials | DELETE /api/materials/:id（清理时序已修复：Promise.all 等候后 res.json）
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

// 9. 获取配置
app.get('/api/config/:deviceId', (req, res) => {
  db.query('SELECT config FROM devices WHERE id = ?', [req.params.deviceId], (err, results) => {
    if (err) return res.status(500).json({ error: err.message });
    if (results.length === 0) return res.status(404).json({ error: '设备不存在' });
    res.json(JSON.parse(results[0].config || '{}'));
  });
});

// 10. 设置设备配置
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
    if (err || !rooms || rooms.length === 0) return done(affected);
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
        if (pending === 0) done(affected);
      });
    });
    if (pending === 0) done(affected);
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


// 【S-10a】 文件夹管理 — 列出 /public/uploads 下所有目录
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

// 【S-10b】 创建素材文件夹（物理目录 + materials 表关联）
app.post("/api/folders", (req, res) => {
  const name = req.body.name;
  if (!name) return res.status(400).json({error:"need name"});
  const dir = __dirname + "/public/uploads/"+name;
  if (!require('fs').existsSync(dir)) require('fs').mkdirSync(dir, {recursive:true});
  res.json({success:true, name:name});
});

// 【S-10c】 删除素材文件夹（级联：物理目录 + materials + 同 URL 预设 + 房间映射清理 + 设备同步）
app.delete("/api/folders/:name", (req, res) => {
  const name = req.params.name;
  if (!name || name==="default") return res.status(400).json({error:"cannot delete"});
  db.query("SELECT id, url FROM materials WHERE folder=?", [name], (err, mats) => {
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
        const base = __dirname + '/public';
        for (const f of [mat.url, mat.thumbnail]) {
          if (f) { try { fs.unlinkSync(base + f); } catch (e) { /* ignore */ } }
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
  return /^[A-Za-z0-9_-]{1,20}$/.test(folder) ? folder : null;
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
      try {
        const thumbFile = req.file.filename.replace(/\.[^.]+$/, '') + '.jpg';
        const thumbPath = __dirname + "/public/uploads/" + folder + "/" + thumbFile;
        require('child_process').execFileSync('ffmpeg',
          ['-i', req.file.path, '-ss', '00:00:01', '-vframes', '1', '-q:v', '2', '-y', thumbPath],
          { stdio: 'ignore' });
        thumbnail = "/uploads/" + folder + "/" + thumbFile;
        const ffprobe = require('child_process').execFileSync('ffprobe',
          ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', req.file.path],
          { encoding: 'utf8' });
        resolution = ffprobe.trim();
      } catch (e) { /* 缩略图/分辨率失败不阻断上传 */ }
      md5FileStream(req.file.path).then(finish).catch(() => finish(null));
    } else {
      finish(null);
    }
  });
});

// 【S-10e】 保存文件夹备注（写入 folder_notes 表）
app.post("/api/folders/note", (req, res) => {
    const { folder, note } = req.body;
    if (!folder) return res.status(400).json({error:"need folder"});
    
    // 保存到数据库
    db.query("INSERT INTO folder_notes (folder, note) VALUES (?, ?) ON DUPLICATE KEY UPDATE note = ?",
      [folder, note, note],
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
    let folderMappingsA = {};
    let folderMappingsB = {};
    try {
      const config = JSON.parse(rows[0].config || '{}');
      folderMappingsA = config.scenes?.A?.folder_mappings || {};
      folderMappingsB = config.scenes?.B?.folder_mappings || {};
    } catch(e) {}

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
    // 并行查询 materials 和 preset_materials
    db.query(
      `SELECT * FROM materials WHERE id IN (${placeholders})`,
      idList,
      (err2, materialsRows) => {
        if (err2) materialsRows = [];
        db.query(
          `SELECT * FROM preset_materials WHERE id IN (${placeholders})`,
          idList,
          (err3, presetRows) => {
            if (err3) presetRows = [];
            // 合并去重（materials 优先）
            const merged = {};
            [...materialsRows, ...presetRows].forEach(row => {
              if (!merged[row.id]) {
                merged[row.id] = {
                  id: row.id,
                  filename: row.filename || row.name || row.fullFilename || row.fname || row.id,
                  url: row.url,
                  md5: row.md5 || '',
                  folder: row.folder || '',
                  type: row.type || 'video'
                };
              }
            });

            // 按 scene-prefixed folder 分组（"A01", "B01"），与 APK syncRoomMaterials 的 lookup 格式对齐
            Object.entries(folderMappingsA).forEach(([folderNum, ids]) => {
              if (Array.isArray(ids) && ids.length > 0) {
                result['A' + folderNum] = ids.map(id => merged[id]).filter(Boolean);
              }
            });
            Object.entries(folderMappingsB).forEach(([folderNum, ids]) => {
              if (Array.isArray(ids) && ids.length > 0) {
                result['B' + folderNum] = ids.map(id => merged[id]).filter(Boolean);
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
    if (rows[0].c > 0) return res.status(409).json({ error: '该客户下还有 ' + rows[0].c + ' 个房间，请先删除或移动房间' });
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

      var existingConfig = {};
      try { existingConfig = rowsDb[0].config ? JSON.parse(rowsDb[0].config) : {}; } catch(e) {}
      var roomName = rowsDb[0].name;
      var targetName = (name !== undefined && name !== roomName) ? name : null;

      var cfg = typeof config === 'string' ? JSON.parse(config) : config;

      if (!cfg.scenes) {
        // incoming config 未带 scenes → 完整继承 DB 中的 scenes
        cfg.scenes = existingConfig.scenes || {
          A: { name: '第一幕', folder_mappings: {}, windows: [] },
          B: { name: '第二幕', folder_mappings: {}, windows: [] }
        };
      } else {
        // 合并：保留 DB 中 scenes 的 windows，只更新传入的 folder_mappings
        // 【Bug Fix】incoming config 中未包含的 scene（如只修改 Scene A 时 B 未传入）必须保留 DB 中原有数据
        // folder_mappings 区分「未提供」与「显式空对象」：传 {} 表示清空该场景映射（否则永远无法清空）
        var existingScenes = existingConfig.scenes || {};
        var incomingA = cfg.scenes.A;
        cfg.scenes.A = {
          name: incomingA ? (incomingA.name || '第一幕') : (existingScenes.A?.name || '第一幕'),
          folder_mappings: (incomingA && incomingA.folder_mappings && typeof incomingA.folder_mappings === 'object')
            ? incomingA.folder_mappings
            : (incomingA && incomingA.folder_mappings === null ? {} : (existingScenes.A?.folder_mappings || {})),
          windows: (incomingA?.windows && incomingA.windows.length > 0)
            ? incomingA.windows
            : (existingScenes.A?.windows || []),
          master: (incomingA?.master && incomingA.master.brightness != null)
            ? { brightness: Math.min(1, Math.max(0, parseFloat(incomingA.master.brightness) || 0)) }
            : (existingScenes.A?.master || { brightness: 1 })
        };
        // Scene B：未传入时保留 DB 完整数据（不被空对象覆盖）
        if (cfg.scenes.B) {
          cfg.scenes.B = {
            name: cfg.scenes.B.name || '第二幕',
            folder_mappings: (cfg.scenes.B.folder_mappings && typeof cfg.scenes.B.folder_mappings === 'object')
              ? cfg.scenes.B.folder_mappings
              : (cfg.scenes.B.folder_mappings === null ? {} : (existingScenes.B?.folder_mappings || {})),
            windows: (cfg.scenes.B.windows && cfg.scenes.B.windows.length > 0)
              ? cfg.scenes.B.windows
              : (existingScenes.B?.windows || []),
            master: (cfg.scenes.B.master && cfg.scenes.B.master.brightness != null)
              ? { brightness: Math.min(1, Math.max(0, parseFloat(cfg.scenes.B.master.brightness) || 0)) }
              : (existingScenes.B?.master || { brightness: 1 })
          };
        } else {
          // B 未在 incoming config 中 → 完整保留 DB 中的 B
          cfg.scenes.B = existingScenes.B || { name: '第二幕', folder_mappings: {}, windows: [] };
        }
      }

      var proceedConfigUpdate = () => {
        if (targetName) { updates.push('name=?'); values.push(targetName); }
        updates.push('config=?'); values.push(JSON.stringify(cfg));
        values.push(id);
        db.query('UPDATE rooms SET ' + updates.join(',') + ' WHERE id=?', values, (err) => {
          if (err) {
            if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: '该客户下已存在同名房间' });
            return res.status(500).json({ error: err.message });
          }
          logAction('update', 'room', { id, name: targetName || roomName });
          res.json({ success: true });
        });
      };
      proceedConfigUpdate();
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
// 更新房间的窗口配置（快捷接口，支持指定场景）
// PUT /api/rooms/:id/windows  body: { windows, sceneId }
// 【窗口配置系统】sceneId 指定保存到 scenes.A.windows 还是 scenes.B.windows
// 保存后立即调用 sendSyncCommandToDevice() 推送 MQTT，让设备实时更新窗口
app.put('/api/rooms/:id/windows', (req, res) => {
  const { windows, sceneId, master, live } = req.body;   // sceneId: 'A' 或 'B'; master: { brightness } 场景总亮度; live: true=编辑器实时预览轻推
  const id = req.params.id;

// 【S-04b】 窗口配置 // PUT /api/rooms/:id/windows
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
    const existingConfig = rows[0].config ? JSON.parse(rows[0].config) : {};
    if (!existingConfig.scenes) {
      // 旧数据：初始化 scenes 结构
      existingConfig.scenes = {
        A: { name: '第一幕', folder_mappings: {}, windows: [] },
        B: { name: '第二幕', folder_mappings: {}, windows: [] }
      };
    }
    const targetScene = sceneId || 'A';
    if (!existingConfig.scenes[targetScene]) {
      return res.status(400).json({ error: '无效的场景ID' });
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

      // 查找绑定到此房间的设备（APK MQTT clientId = fingerprint）
      db.query('SELECT id, fingerprint FROM devices WHERE room_id = ?', [id], (err4, rows4) => {
        if (!err4 && rows4 && rows4.length > 0) {
          const mqttId = rows4[0].fingerprint || rows4[0].id;
          if (live) {
            // 【实时预览】轻量 update_windows：只带 scenes，APK 免重建原地更新视图，
            // 不触发素材同步；结构变化时 APK 内部自动回退全量重建
            mqttClient.publish(`xvj/device/${mqttId}/command`, JSON.stringify({
              action: 'update_windows',
              room_id: id,
              scenes: buildPrefixedScenes(existingConfig.scenes || {}),
              timestamp: Date.now()
            }));
          } else {
            // 【S-04b-Fix】完整同步：触发素材检查与全量下发
            sendSyncCommandToDevice(mqttId, id, existingConfig);
          }
        }
      });

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
    db.query('SELECT id, fingerprint FROM devices WHERE room_id = ?', [id], (errD, devs) => {
      if (errD) return res.status(500).json({error: errD.message});
      var bound = devs || [];
      bound.forEach(d => {
        var fp = d.fingerprint || d.id;
        mqttClient.publish(`xvj/device/${fp}/command`, JSON.stringify({ action: 'stop' }), { qos: 1 });
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

// 【S-05h】 绑定设备到房间（更新 devices.room_id）
app.post('/api/devices/:id/bind-room', (req, res) => {
  const { room_id } = req.body;
  const id = req.params.id;
  db.query('UPDATE devices SET room_id = ? WHERE id = ?', [room_id, id], (err) => {
    if (err) return res.status(500).json({error:err.message});
    // 查房间名称用于日志
    db.query('SELECT r.name as room_name, d.name as device_name FROM devices d LEFT JOIN rooms r ON r.id = ? WHERE d.id = ?', [room_id, id], (err2, rows) => {
      const room = rows && rows[0];
      logAction('bind_room', 'device', {
        device_id: id,
        device_name: room ? room.device_name : null,
        room_id: room_id,
        room_name: room ? room.room_name : null
      });
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
app.get('/api/default-materials', (req, res) => {
  db.query('SELECT * FROM default_materials ORDER BY id DESC', (err, results) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(results || []);
  });
});

// 【S-13b】 添加默认素材（写入 default_materials 表）
app.post('/api/default-materials', (req, res) => {
  const { name, url, type, thumbnail } = req.body;
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
 * 数据库初始化 — 建表（devices / materials / operation_logs / folder_notes / apk_versions / device_versions）
 * 全部使用 CREATE TABLE IF NOT EXISTS，安全幂等
 */
function initDatabase() {
  db.query(`
    CREATE TABLE IF NOT EXISTS devices (
      id VARCHAR(64) PRIMARY KEY,
      name VARCHAR(255),
      location VARCHAR(255),
      fingerprint VARCHAR(255),
      model VARCHAR(100),
      hardware VARCHAR(100),
      mac VARCHAR(50),
      status VARCHAR(50) DEFAULT 'offline',
      authorized TINYINT(1) DEFAULT 1,
      config TEXT,
      status_data TEXT,
      online_time DATETIME
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
      changelog TEXT,
      is_latest TINYINT(1) DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

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

// 【S-12a】 获取版本列表（从 apk_versions 表读取）
app.get('/api/versions', (req, res) => {
  db.query('SELECT * FROM apk_versions ORDER BY version_code DESC', (err, results) => {
    if (err) return res.status(500).json({error:err.message});
    res.json(results || []);
  });
});

// 【S-12b】 获取最新版本（is_latest=1，计算文件 MD5 校验）
app.get('/api/version/latest', (req, res) => {
  db.query('SELECT * FROM apk_versions WHERE is_latest = 1 ORDER BY version_code DESC LIMIT 1', (err, results) => {
    if (err) return res.status(500).json({error:err.message});
    if (results.length === 0) return res.json({});
    
    const apk = results[0];
    // 计算MD5
    const fullPath = path.join(__dirname, 'public', apk.filepath);
    if (fs.existsSync(fullPath)) {
      const fileBuffer = fs.readFileSync(fullPath);
      const md5Hash = crypto.createHash('md5').update(fileBuffer).digest('hex');
      apk.md5 = md5Hash;
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

// 【S-12c】 上传 APK 新版本（写入 apk_versions 表，标记 is_latest=1）
app.post('/api/versions/upload', upload.single('apk'), (req, res) => {
  if (!req.file) return res.status(400).json({error:'No file uploaded'});
  
  const {version, version_code, changelog} = req.body;
  if (!version || !version_code) return res.status(400).json({error:'version and version_code required'});
  
  // 取消之前的latest标记
  db.query('UPDATE apk_versions SET is_latest = 0', (err) => {
    const filepath = '/apk/' + req.file.filename;
    db.query(
      'INSERT INTO apk_versions (version, version_code, filename, filepath, size, changelog, is_latest) VALUES (?, ?, ?, ?, ?, ?, 1)',
      [version, parseInt(version_code), req.file.filename, filepath, req.file.size, changelog || ''],
      (err2, result) => {
        if (err2) return res.status(500).json({error:err2.message});
        res.json({success:true, id:result.insertId, filepath});
      }
    );
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
    // 先查设备 fingerprint
    db.query('SELECT fingerprint FROM devices WHERE id = ?', [deviceId], (err2, devs) => {
      if (err2 || devs.length === 0) return res.status(404).json({ error: '设备未找到' });
      const devFingerprint = devs[0].fingerprint || deviceId;
      const topic = `xvj/device/${devFingerprint}/command`;

      const cmd = {
        action: 'update',
        version: apk.version,
        version_code: apk.version_code,
        url: 'http://47.102.106.237/apk/' + path.basename(apk.filepath)
      };

      mqttClient.publish(topic, JSON.stringify(cmd), {qos:1}, (err3) => {
        if (err3) return res.status(500).json({error:err3.message});
        logAction('push_update', 'device', { device_id: deviceId, version: apk.version, version_code: apk.version_code });
        res.json({success:true, message:'Update pushed'});
      });
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
    db.query('SELECT id FROM devices WHERE authorized = 1', (err2, devices) => {
      if (err2) return res.status(500).json({error: err2.message});
      let pushed = 0;
      devices.forEach(device => {
        const topic = `xvj/device/${device.id}/command`;
        const cmd = {
          action: 'update',
          version: apk.version,
          version_code: apk.version_code,
          url: 'http://47.102.106.237/apk/' + path.basename(apk.filepath)
        };
        mqttClient.publish(topic, JSON.stringify(cmd), {qos: 1});
        pushed++;
      });
      logAction('push_update_all', 'device', { version_id: versionId, version: apk.version, version_code: apk.version_code, devices: pushed });
      res.json({success: true, pushed, version: apk.version});
    });
  });
});

// 【S-12i】 推送最新版本到所有已授权设备（MQTT 批量下发）
app.post('/api/devices/push-update-all', (req, res) => {
  db.query('SELECT * FROM apk_versions WHERE is_latest = 1 ORDER BY version_code DESC LIMIT 1', (err, versions) => {
    if (err) return res.status(500).json({error:err.message});
    if (versions.length === 0) return res.status(404).json({error:'No APK available'});
    
    const apk = versions[0];
    
    db.query("SELECT id FROM devices WHERE authorized = 1", (err2, devices) => {
      if (err2) return res.status(500).json({error:err2.message});
      
      let pushed = 0;
      devices.forEach(device => {
        const topic = `xvj/device/${device.id}/command`;
        const cmd = {
          action: 'update',
          version: apk.version,
          version_code: apk.version_code,
          url: 'http://47.102.106.237/apk/' + path.basename(apk.filepath)
        };
        mqttClient.publish(topic, JSON.stringify(cmd), {qos:1});
        pushed++;
      });
      logAction('push_update_all', 'device', { version: apk.version, version_code: apk.version_code, devices: pushed });
      res.json({success:true, pushed});
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