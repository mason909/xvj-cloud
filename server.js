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

// 故障记录
const FAULT_LOG = '/workspace/xvj-backup/故障记录.md';
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

// 记录操作日志
function logAction(action, target, details) {
  db.query("INSERT INTO operation_logs (action, target, details) VALUES (?, ?, ?)",
    [action, target, JSON.stringify(details)],
    (err) => { if (err) console.error('日志记录失败:', err.message); }
  );
}

// 将 scenes 对象中的 folder_mappings 键名前缀 scene 标识（A01, B01...）
// 用于 MQTT 发送时统一格式，避免 A/B 场景共用 "01" 导致物理文件夹冲突
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
  });
  return result;
}

const app = express();
const PORT = config.port;

// API 认证中间件
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

// Serve static files (index.html)
app.get('/', (req, res) => {
  res.sendFile('/var/www/xvj/index.html');
});

// 静态文件服务：素材文件（视频、图片、缩略图）
app.use('/uploads', express.static(__dirname + '/public/uploads'));

// 获取服务器配置 (供设备使用)
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

// 处理 MQTT 消息
function handleMqttMessage(topic, message) {
  // xvj/auth/response - 设备回复授权状态（如 deauthorize）
  if (topic === 'xvj/auth/response') {
    try {
      const data = JSON.parse(message);
      if (data.action === 'deauthorize') {
        console.log('📩 收到设备主动 deauthorize: ' + data.device_id);
        db.query('UPDATE devices SET authorized=0, status="deauthorized" WHERE id=?', [data.device_id]);
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
          'UPDATE devices SET status = ?, status_data = ?, online_time = NOW() WHERE id = ? OR fingerprint = ? OR id LIKE ? OR id LIKE ?',
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
                 ON DUPLICATE KEY UPDATE status='online', online_time=NOW(), fingerprint=COALESCE(fingerprint, VALUES(fingerprint))`,
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
        const logMsg = spaceIdx > 0 ? payload.substring(spaceIdx + 1) : payload;
        console.log('📝 写日志: deviceId=' + deviceId + ' time=' + logTime + ' msg=' + logMsg.substring(0, 60));
        db.query(
          'INSERT INTO device_logs (device_id, log_time, level, message) VALUES (?, ?, ?, ?)',
          [deviceId, logTime, 'info', logMsg],
          (err) => { if (err) console.error('写device_logs失败:', err.message); else console.log('✅ 日志写入成功 id=' + deviceId); }
        );
        break;
      }
      case 'command':
        if (!data) break;
        console.log('📨 设备命令: ' + deviceId + ' -> ' + JSON.stringify(data));
        if (data.action === 'sync') {
          db.query(
            'SELECT d.room_id, r.folder_mappings FROM devices d LEFT JOIN rooms r ON d.room_id = r.id WHERE d.id = ?',
            [deviceId],
            (err, rows) => {
              if (err || !rows || rows.length === 0) {
                console.log('⚠️ sync 命令找不到设备: ' + deviceId);
                return;
              }
              const { room_id, folder_mappings } = rows[0];
              if (!room_id) {
                console.log('⚠️ sync 命令设备未绑定房间: ' + deviceId);
                return;
              }
              const syncCmd = {
                action: 'sync_room_materials',
                room_id: room_id,
                folder_mappings: folder_mappings ? JSON.parse(folder_mappings) : {}
              };
              const topic = `xvj/device/${deviceId}/command`;
              mqttClient.publish(topic, JSON.stringify(syncCmd));
              console.log('📤 发送 sync_room_materials 到设备: ' + deviceId);
              logAction('sync', 'device', { device_id: deviceId, command: syncCmd });
            }
          );
        }
        break;
    }
  } catch (e) {
    console.error('消息解析失败:', e);
  }
}

// 设备注册处理 - 带授权检查
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
          `INSERT INTO devices (id, name, fingerprint, model, hardware, mac, status, authorized, online_time) 
           VALUES (?, ?, ?, ?, ?, ?, 'online', 0, NOW()) 
           ON DUPLICATE KEY UPDATE status='online', online_time=NOW(), authorized=0`,
          [deviceId, data.device_id || deviceId, fingerprint, data.model, data.hardware, data.mac]
        );
        sendAuthResponse(deviceId, false, '等待审核授权', '');
      } else {
        const device = results[0];
        
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
          
          // 已授权设备上线，推送预设素材
          sendPresetMaterialsToDevice(deviceId);
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
  let folderMappings = {};
  if (authorized && roomId) {
    // 同步获取房间素材配置
    const roomQuery = `SELECT folder_mappings, config FROM rooms WHERE id = ?`;
    db.query(roomQuery, [roomId], (err, results) => {
      if (!err && results.length > 0) {
        try {
          folderMappings = JSON.parse(results[0].folder_mappings || '{}');
          const roomConfig = results[0].config ? JSON.parse(results[0].config) : {};
          const debugFlag = roomConfig.debug === true;

          // 迁移旧数据到 scenes 结构
          if (!roomConfig.scenes) {
            roomConfig.scenes = {
              A: { name: '第一幕', folder_mappings: folderMappings, windows: roomConfig.windows || [] },
              B: { name: '第二幕', folder_mappings: {}, windows: [] }
            };
            delete roomConfig.windows;
          }

          // 给 scenes 的 folder_mappings 键名加 scene 前缀（A01, B01），避免物理文件夹冲突
          var prefixedScenes = buildPrefixedScenes(roomConfig.scenes);

          // 构建完整的推送数据
          const payload = {
            action: 'auth_result',
            device_id: deviceId,
            authorized: true,
            message: message,
            room_id: roomId || '',
            scenes: prefixedScenes,
            folder_mappings: prefixedScenes.A ? prefixedScenes.A.folder_mappings : {},
            debug: debugFlag,
            timestamp: Date.now()
          };
          
          mqttClient.publish(topic, JSON.stringify(payload));
          console.log(`📤 已推送授权+素材配置到设备 ${deviceId}, 房间: ${roomId}, 文件夹: ${JSON.stringify(folderMappings)}`);
          
          // 触发设备同步素材
          sendSyncCommandToDevice(deviceId, roomId, folderMappings, roomConfig);
          
        } catch (e) {
          console.error('解析folder_mappings失败:', e);
          // 即使解析失败也发送授权响应
          const payload = JSON.stringify({
            action: 'auth_result',
            device_id: deviceId,
            authorized: true,
            message: message,
            room_id: roomId || '',
            folder_mappings: {},
            windows: [],   // fallback：解析失败时也返回空窗口
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
      windows: [],   // fallback：未授权时也返回空窗口
      timestamp: Date.now()
    });
    mqttClient.publish(topic, payload);
  }
}

// 发送同步命令到设备，触发素材下载
// sendSyncCommandToDevice: mqttId = fingerprint（APK 订阅的 topic），若没有则 fallback 到 deviceId
function sendSyncCommandToDevice(mqttId, roomId, folderMappings, config) {
  // scenes 结构迁移
  var scenes = {};
  if (config && config.scenes) {
    scenes = config.scenes;
  } else {
    // 旧兼容
    scenes = {
      A: { name: '第一幕', folder_mappings: folderMappings, windows: (config && config.windows) || [] },
      B: { name: '第二幕', folder_mappings: {}, windows: [] }
    };
  }

  // 给 scenes 里的 folder_mappings 键名前缀 scene 标识，避免 A/B 共用 "01" 导致物理文件夹冲突
  var prefixedScenes = buildPrefixedScenes(scenes);

  const topic = `xvj/device/${mqttId}/command`;
  const payload = {
    action: 'sync_room_materials',
    room_id: roomId,
    scenes: prefixedScenes,   // folder_mappings 键名已加 scene 前缀
    folder_mappings: prefixedScenes.A ? prefixedScenes.A.folder_mappings : {}, // APK 用这个触发 HTTP 同步
    debug: config && config.debug === true,
    timestamp: Date.now()
  };
  mqttClient.publish(topic, JSON.stringify(payload));
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
        const prefixedScenes = buildPrefixedScenes(cfg.scenes || {});
        const currentSceneFm = prefixedScenes.A ? prefixedScenes.A.folder_mappings : {};
        devices.forEach(({ id: deviceId, fingerprint }) => {
          try {
            const mqttId = fingerprint || deviceId;
            const topic = `xvj/device/${mqttId}/command`;
            const payload = {
              action: 'sync_room_materials',
              room_id: roomId,
              scenes: prefixedScenes,
              folder_mappings: currentSceneFm,
              debug: cfg.debug === true,
              timestamp: Date.now()
            };
            mqttClient.publish(topic, JSON.stringify(payload));
            console.log(`📦 [notify] 已推送 sync 到设备 ${deviceId} (房间 ${roomId})`);
          } catch (e) {
            console.error(`[notify] MQTT 发布失败，设备 ${deviceId}: ${e.message}`);
          }
        });
      });
    }
  );
}

// 远程废止设备
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

// 1. 获取设备列表
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

// 2. 添加设备（白名单）
app.post('/api/devices', (req, res) => {
  const { name, location, fingerprint, model, mac } = req.body;
  const id = uuidv4();
  db.query(
    'INSERT INTO devices (id, name, location, fingerprint, model, mac, status, authorized) VALUES (?, ?, ?, ?, ?, ?, ?, 1)',
    [id, name, location || '', fingerprint || '', model || '', mac || '', 'offline'],
    (err, result) => {
      if (err) return res.status(500).json({ error: err.message });
      logAction('add', 'device', { id, name, location, fingerprint, model });
      res.json({ id, name, location, status: 'offline', authorized: true });
    }
  );
});

// 3. 删除设备
app.delete('/api/devices/:id', (req, res) => {
  const did = req.params.id;
  db.query('DELETE FROM devices WHERE id = ?', [did], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    logAction('delete', 'device', { id: did });
    res.json({ success: true });
  });
});

// 4. 发送指令到设备
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
  db.query('SELECT folder_mappings, config FROM rooms WHERE id = ?', [roomId], (err, rows) => {
    if (err || !rows || rows.length === 0) {
      return res.status(404).json({ error: '房间不存在' });
    }
    const config = rows[0].config ? JSON.parse(rows[0].config) : {};
    let folderMappings = config.scenes?.A?.folder_mappings || {};
    // fallback 到根级 folder_mappings（兼容旧数据）
    if (Object.keys(folderMappings).length === 0 && rows[0].folder_mappings) {
      try { folderMappings = JSON.parse(rows[0].folder_mappings); } catch(e) {}
    }

    // 迁移旧数据到 scenes 结构
    if (!config.scenes) {
      config.scenes = {
        A: { name: '第一幕', folder_mappings: folderMappings, windows: config.windows || [] },
        B: { name: '第二幕', folder_mappings: {}, windows: [] }
      };
      delete config.windows;
    }

    // 合并 Scene A 和 Scene B 的 folder_mappings（外部信号决定播放哪个文件夹，设备必须同时有A和B的数据）
    const fmA = config.scenes?.A?.folder_mappings || {};
    const fmB = config.scenes?.B?.folder_mappings || {};
    const allFolderMappings = {};
    Object.keys(fmA).forEach(k => { allFolderMappings[k] = [...(fmA[k] || [])]; });
    Object.keys(fmB).forEach(k => {
      if (allFolderMappings[k]) {
        [...(fmB[k] || [])].forEach(id => { if (!allFolderMappings[k].includes(id)) allFolderMappings[k].push(id); });
      } else {
        allFolderMappings[k] = [...(fmB[k] || [])];
      }
    });

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
            scenes: config.scenes,           // 完整两套场景（APK 渲染窗口用）
            folder_mappings: allFolderMappings, // 合并后的完整列表（设备根据外部信号从A和B中各取对应文件夹）
            debug: config.debug === true
          };
          mqttClient.publish(topic, JSON.stringify(syncCmd));
          sent++;
        });

        logAction('room_sync', 'room', { room_id: roomId, devices: sent });
        res.json({ success: true, sent, command: { action: 'sync_room_materials', room_id: roomId, scenes: config.scenes } });
      }
    );
  });
});

// 【S-07d】从房间删除素材，只从当前操作的那个场景删除（两幕完全独立）
// 流程：清理 scene[curScene].folder_mappings → UPDATE DB → 发 MQTT → 发 sync_room_materials
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

        // 从指定场景的 folder_mappings 移除（只删当前场景，不动其他场景）
        let removed = false;
        if (config.scenes && config.scenes[curScene] && config.scenes[curScene].folder_mappings) {
          Object.keys(config.scenes[curScene].folder_mappings).forEach(fid => {
            const arr = config.scenes[curScene].folder_mappings[fid] || [];
            const before = arr.length;
            config.scenes[curScene].folder_mappings[fid] = arr.filter(id => id !== materialId);
            if (arr.length !== before) removed = true;
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

                  // 3a. delete_material：让 APK 立即删本地文件（尽力发）
                  mqttClient.publish(topic, JSON.stringify({
                    action: 'delete_material',
                    material_id: materialId,
                    folder: folder,
                    filename: filename
                  }));
                  sentDel++;

                  // 3b. sync_room_materials：scene-prefixed 格式，保持和 sendSyncCommandToDevice 一致
                  var prefixedScenes = buildPrefixedScenes(config.scenes);
                  const curFmDelete = prefixedScenes[curScene]?.folder_mappings || {};
                  mqttClient.publish(topic, JSON.stringify({
                    action: 'sync_room_materials',
                    room_id: roomId,
                    scenes: prefixedScenes,
                    folder_mappings: curFmDelete,    // scene-prefixed
                    debug: config.debug === true
                  }));
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

// 5. 废止设备（远程禁用）
app.post('/api/devices/:id/deauthorize', (req, res) => {
  const deviceId = req.params.id;

  db.query(
    'UPDATE devices SET authorized = 0, status = "deauthorized" WHERE id = ?',
    [deviceId],
    (err) => {

// 【S-06】 授权 & 设备管理 // POST /api/devices/:id/authorize | /deauthorize
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

// 6. 重新授权设备
// Bug修复：MQTT topic必须使用DB中设备的真实id字段（64-char UUID），
// 而非前端传入的格式化MAC或其他标识符，否则APK订阅的topic永远不匹配
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

// 【S-02】 素材管理 API // GET|POST /api/materials | DELETE /api/materials/:id
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

// 8. 上传素材（简化版）
app.post('/api/materials', (req, res) => {
  const { name, url, type } = req.body;
  const id = uuidv4();
  db.query(
    'INSERT INTO materials (id, name, url, type) VALUES (?, ?, ?, ?)',
    [id, name, url, type || 'video'],
    (err, result) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ id, name, url, type });
    }
  );
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

// ==================== 预设素材管理 ====================

// 预设素材文件夹配置（等用户发送具体文件夹后修改）
const PRESET_FOLDERS = [
  { id: 'ad', name: '广告', path: '/storage/emulated/0/videos/ad' },
  { id: 'intro', name: '开场', path: '/storage/emulated/0/videos/intro' },
  { id: 'loop', name: '循环', path: '/storage/emulated/0/videos/loop' }
  // TODO: 等用户发送文件夹列表后补充
];

// 初始化预设素材表
function initPresetMaterialsTable() {
  db.query(`
    CREATE TABLE IF NOT EXISTS preset_materials (
      id VARCHAR(36) PRIMARY KEY,
      folder_id VARCHAR(50) NOT NULL,
      folder_name VARCHAR(100),
      filename VARCHAR(255) NOT NULL,
      url VARCHAR(512) NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_folder_id (folder_id)
    )
  `);
  
  // 初始化预设素材文件夹配置表
  db.query(`
    CREATE TABLE IF NOT EXISTS preset_folders (
      id VARCHAR(50) PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      path VARCHAR(255) NOT NULL,
      sort_order INT DEFAULT 0,
      enabled TINYINT(1) DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  // 如果配置表为空，插入默认配置
  db.query('SELECT COUNT(*) as cnt FROM preset_folders', (err, results) => {
    if (results[0].cnt === 0) {
      PRESET_FOLDERS.forEach((folder, index) => {
        db.query(
          'INSERT INTO preset_folders (id, name, path, sort_order) VALUES (?, ?, ?, ?)',
          [folder.id, folder.name, folder.path, index]
        );
      });
      console.log('✅ 预设素材文件夹已初始化');
    }
  });
}

// 获取预设素材列表（按文件夹分组）
function getPresetMaterials(callback) {
  db.query('SELECT * FROM preset_folders WHERE enabled = 1 ORDER BY sort_order', (err, folders) => {
    if (err) return callback(err, null);
    
    db.query('SELECT * FROM preset_materials ORDER BY folder_id, filename', (err, materials) => {
      if (err) return callback(err, null);
      
      // 按文件夹分组
      const result = folders.map(folder => ({
        id: folder.id,
        name: folder.name,
        path: folder.path,
        materials: materials.filter(m => m.folder_id === folder.id).map(m => ({
          id: m.id,
          filename: m.filename,
          url: m.url
        }))
      }));
      
      callback(null, result);
    });
  });
}

// 设备注册成功后，推送预设素材
function sendPresetMaterialsToDevice(deviceId) {
  getPresetMaterials((err, folders) => {
    if (err) {
      console.error('获取预设素材失败:', err);
      return;
    }
    
    // 通过 MQTT 推送预设素材列表
    const topic = `xvj/device/${deviceId}/preset`;
    const payload = JSON.stringify({
      action: 'preset_sync',
      folders: folders,
      timestamp: Date.now()
    });
    
    mqttClient.publish(topic, payload);
    console.log(`📦 已推送预设素材到设备 ${deviceId}, ${folders.length} 个文件夹`);
  });
}

// ==================== 预设素材 API ====================

// 获取预设素材列表
app.get('/api/preset/folders', (req, res) => {
  getPresetMaterials((err, folders) => {
    if (err) return res.status(500).json({ error: err.message });

// 【S-03】 预设素材 API // GET|POST /api/preset/* | DELETE /api/preset/materials/:id
    res.json(folders);
  });
});

// 添加预设素材文件夹
app.post('/api/preset/folders', (req, res) => {
  const { id, name, path } = req.body;
  db.query(
    'INSERT INTO preset_folders (id, name, path) VALUES (?, ?, ?)',
    [id, name, path],
    (err) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, id, name, path });
    }
  );
});

// 删除预设素材文件夹
app.delete('/api/preset/folders/:id', (req, res) => {
  const folderId = req.params.id;
  db.query('DELETE FROM preset_materials WHERE folder_id = ?', [folderId], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    db.query('DELETE FROM preset_folders WHERE id = ?', [folderId], (err) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true });
    });
  });
});

// 添加预设素材
// 删除预设素材（级联清理所有房间的 folder_mappings，含根级和 scenes A/B）
app.delete('/api/preset/materials/:id', (req, res) => {
  const mid = req.params.id;
  db.query('SELECT * FROM preset_materials WHERE id = ?', [mid], (err, rows) => {
    if (rows && rows[0]) logAction('delete', 'preset_material', rows[0]);
    // 级联：同时查询 folder_mappings 和 config，用于清理根级和 scenes A/B
    db.query('SELECT id, folder_mappings, config FROM rooms', [], (err2, rooms) => {
      if (!err2 && rooms) {
        rooms.forEach((room) => {

          // 2. 清理 config.scenes.A/B.folder_mappings
          if (room.config) {
            try {
              const cfg = typeof room.config === 'string' ? JSON.parse(room.config) : { ...room.config };
              if (cfg.scenes && cfg.scenes.A && cfg.scenes.A.folder_mappings) {
                Object.values(cfg.scenes.A.folder_mappings).forEach(arr => {
                  const idx = arr.indexOf(mid);
                  if (idx > -1) { arr.splice(idx, 1); sceneAChanged = true; }
                });
              }
              if (cfg.scenes && cfg.scenes.B && cfg.scenes.B.folder_mappings) {
                Object.values(cfg.scenes.B.folder_mappings).forEach(arr => {
                  const idx = arr.indexOf(mid);
                  if (idx > -1) { arr.splice(idx, 1); sceneBChanged = true; }
                });
              }
              if (sceneAChanged || sceneBChanged) {
                db.query('UPDATE rooms SET config=? WHERE id=?', [JSON.stringify(cfg), room.id]);
                console.log(`🗑 从房间 ${room.id} scenes 移除预设素材 ${mid} (A:${sceneAChanged} B:${sceneBChanged})`);
              }
            } catch (e) {}
          }
        });
      }
      db.query('DELETE FROM preset_materials WHERE id = ?', [mid], (err3) => {
        if (err3) return res.status(500).json({ error: err3.message });
        // 通知所有 scenes A/B 使用了该素材的房间
        db.query("SELECT id, config FROM rooms", [], (err, rooms) => {
          if (!err && rooms) {
            rooms.forEach(room => {
              try {
                const cfg = room.config ? JSON.parse(room.config) : {};
                const fmA = cfg.scenes && cfg.scenes.A && cfg.scenes.A.folder_mappings ? cfg.scenes.A.folder_mappings : null;
                const fmB = cfg.scenes && cfg.scenes.B && cfg.scenes.B.folder_mappings ? cfg.scenes.B.folder_mappings : null;
                const inA = fmA && Object.values(fmA).flat().includes(mid);
                const inB = fmB && Object.values(fmB).flat().includes(mid);
                if (inA || inB) {
                  notifyRoomDevicesOfSync(room.id);
                }
              } catch (e) { /* ignore */ }
            });
          }
          res.json({ success: true });
        });
      });
    });
  });
});

// 手动触发推送到设备
app.post('/api/preset/push/:deviceId', (req, res) => {
  sendPresetMaterialsToDevice(req.params.deviceId);
  res.json({ success: true, message: '推送已发送' });
});


// 素材管理API
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

app.post("/api/folders", (req, res) => {
  const name = req.body.name;
  if (!name) return res.status(400).json({error:"need name"});
  const dir = __dirname + "/public/uploads/"+name;
  if (!require('fs').existsSync(dir)) require('fs').mkdirSync(dir, {recursive:true});
  res.json({success:true, name:name});
});

app.delete("/api/folders/:name", (req, res) => {
  const name = req.params.name;
  if (!name || name==="default") return res.status(400).json({error:"cannot delete"});
  const dir = __dirname + "/public/uploads/"+name;
  if (require('fs').existsSync(dir)) require('fs').rmSync(dir, {recursive:true});
  db.query("DELETE FROM materials WHERE folder=?", [name], ()=>{});
  res.json({success:true});
});


// 【S-02b】 素材查询别名 // GET /api/materials（重复路由）
app.get("/api/materials", (req, res) => {
  db.query("SELECT * FROM materials", (err, rows) => res.json(err ? [] : rows));
});

// 从指定 folder_mappings 对象中移除素材 ID，返回是否改变
function removeFromMappings(mappings, id) {
  let changed = false;
  for (const folder of Object.keys(mappings)) {
    const before = mappings[folder].length;
    mappings[folder] = (mappings[folder] || []).filter(item => item !== id);
    if (mappings[folder].length !== before) changed = true;
  }
  return changed;
}

app.delete("/api/materials/:id", (req, res) => {
  const id = req.params.id;
  const fs = require('fs');
  db.query("SELECT * FROM materials WHERE id=?", [id], (err, rows) => {
    if (rows && rows[0]) {

// 【S-02c】 删除素材 // DELETE /api/materials/:id
      const mat = rows[0];
      logAction('delete', 'material', mat);
      // 删除物理文件（视频 + 缩略图）
      const base = __dirname + '/public';
      for (const f of [mat.url, mat.thumbnail]) {
        if (f) {
          try { fs.unlinkSync(base + f); } catch (e) { /* ignore */ }
        }
      }
      // 从所有房间的 folder_mappings（根级 + scenes A/B）中移除该素材 ID
      db.query("SELECT id, folder_mappings, config FROM rooms", (err2, rooms) => {
        if (!err2 && rooms) {
          for (const room of rooms) {
            let rootChanged = false, sceneAChanged = false, sceneBChanged = false;

            // 2. 清理 config.scenes.A/B.folder_mappings
            if (room.config) {
              try {
                const cfg = typeof room.config === 'string' ? JSON.parse(room.config) : { ...room.config };
                if (cfg.scenes && cfg.scenes.A && cfg.scenes.A.folder_mappings) {
                  sceneAChanged = removeFromMappings(cfg.scenes.A.folder_mappings, id);
                }
                if (cfg.scenes && cfg.scenes.B && cfg.scenes.B.folder_mappings) {
                  sceneBChanged = removeFromMappings(cfg.scenes.B.folder_mappings, id);
                }
                if (sceneAChanged || sceneBChanged) {
                  db.query("UPDATE rooms SET config=? WHERE id=?", [JSON.stringify(cfg), room.id]);
                  console.log('🗑 从房间 ' + room.id + ' scenes 移除素材 ' + id + ' (A:' + sceneAChanged + ', B:' + sceneBChanged + ')');
                }
              } catch (e) { console.error("清理 scenes folder_mappings 失败，房间 " + room.id + ": " + e.message); }
            }
          }
        }
      });
    }
    db.query("DELETE FROM materials WHERE id=?", [id], (errDel) => {
      if (errDel) {
        console.error('删除素材记录失败: ' + errDel.message);
        return res.status(500).json({ error: '删除素材失败' });
      }
      // 找出所有 scenes.A 或 scenes.B 使用了该素材的房间，向其设备推送 sync
      db.query("SELECT id, config FROM rooms", [], (err, rooms) => {
        if (!err && rooms) {
          rooms.forEach(room => {
            try {
              const cfg = room.config ? JSON.parse(room.config) : {};
              const inSceneA = cfg.scenes && cfg.scenes.A && cfg.scenes.A.folder_mappings &&
                Object.values(cfg.scenes.A.folder_mappings).flat().includes(id);
              const inSceneB = cfg.scenes && cfg.scenes.B && cfg.scenes.B.folder_mappings &&
                Object.values(cfg.scenes.B.folder_mappings).flat().includes(id);
              if (inSceneA || inSceneB) {
                notifyRoomDevicesOfSync(room.id);
              }
            } catch (e) { /* ignore parse errors */ }
          });
        }
        res.json({success: true});
      });
    });
  });
});

const multer = require('multer');
app.post("/api/upload", (req, res) => {
  const folder = req.query.folder || req.body.folder || "default";
  // 确保文件夹存在
  const fs = require("fs");
  const uploadDir = __dirname + "/public/uploads/" + folder;
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }
  const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, __dirname + "/public/uploads/" + folder),
    filename: (req, file, cb) => {
      // 直接使用原始文件名，不做编码转换（浏览器已发送UTF-8编码）
      cb(null, file.originalname);
    }
  });
  const upload = multer({storage}).single("file");
  upload(req, res, (err) => {
    if (err) return res.status(500).json({error:err.message});
    if (!req.file) return res.status(400).json({error:"no file"});
    const id = uuidv4();
    // multer 直接存储原始文件名（UTF-8 不需要额外编码处理）
    const fullFilename = req.file.originalname || 'file_' + Date.now();
    const displayName = fullFilename.replace(/\.[^.]+$/, ''); // 去扩展名后的纯文件名
    const type = fullFilename.endsWith(".mp4") || req.file.mimetype.startsWith("video") ? "video" :
                 fullFilename.endsWith(".gif") ? "gif" :
                 req.file.mimetype.startsWith("image") ? "image" : "other";
    let thumbnail = null;
    let resolution = null;
    let md5 = null;
    if (type === "video") {
      const thumbPath = __dirname + "/public/uploads/" + folder + "/" + fullFilename.replace(".mp4",".jpg");
      try {
        require('child_process').execSync("ffmpeg -i '" + __dirname + "/public/uploads/"+folder+"/"+fullFilename + "' -ss 00:00:01 -vframes 1 -q:v 2 -y '" + thumbPath + "'", {stdio:"ignore"});
        thumbnail = "/uploads/"+folder+"/"+fullFilename.replace(".mp4",".jpg");
        const ffprobe = require('child_process').execSync("ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 '" + __dirname + "/public/uploads/"+folder+"/"+fullFilename + "'", {encoding:"utf8"});
        resolution = ffprobe.trim();
      } catch(e) {}

      // 计算MD5
      try {
        const fs = require('fs');
        const fileBuffer = fs.readFileSync(__dirname + "/public/uploads/" + folder + "/" + fullFilename);
        const crypto = require('crypto');
        md5 = crypto.createHash('md5').update(fileBuffer).digest('hex');
      } catch(e) {}
    }
    const url = "/uploads/" + folder + "/" + fullFilename;
    db.query("INSERT INTO materials (id,name,url,type,folder,thumbnail,resolution,filename) VALUES (?,?,?,?,?,?,?,?)",
      [id, displayName, url, type, folder, thumbnail, resolution, fullFilename],
      e => {
        if (e) return res.status(500).json({error:e.message});
        logAction('upload', 'material', {id, name: displayName, folder, type, md5});
        res.json({id, name: displayName, url, type, folder, thumbnail, resolution, md5});
      }
    );
  });
});

// 临时修复：修正 materials 表中的乱码记录 + 补全空 name
app.get("/api/admin/fix-garbled", (req, res) => {
  const fs = require('fs');
  const { execSync } = require('child_process');
  const uploadDir = __dirname + '/public/uploads/01/';
  let fixed = 0, nameFixed = 0;
  db.query('SELECT id, name, url, thumbnail FROM materials', (err, rows) => {
    if (err) return res.json({error: err.message});
    const files = fs.readdirSync(uploadDir).filter(f => f.endsWith('.mp4'));

    // 1. 修复乱码 URL/Name（双重编码的记录）
    const garbled = rows.filter(r => r.url && (r.url.includes('%3') || r.name.includes('%3')));
    garbled.forEach(r => {
      const match = files.find(f => {
        const base = f.replace('.mp4', '');
        return base.startsWith('3') && base.includes('月');
      });
      if (match) {
        const correctUrl = '/uploads/01/' + match;
        const correctName = match.replace(/\.[^.]+$/, '');
        const correctThumb = '/uploads/01/' + match.replace('.mp4', '.jpg');
        try { execSync(`ffmpeg -i '${uploadDir}${match}' -ss 00:00:01 -vframes 1 -q:v 2 -y '${uploadDir}${match.replace('.mp4','.jpg')}'`, {stdio:'ignore'}); } catch(e) {}
        db.query('UPDATE materials SET name=?, url=?, thumbnail=? WHERE id=?',
          [correctName, correctUrl, correctThumb, r.id], (e2) => { if (!e2) fixed++; });
      }
    });

    // 2. 补全空 name（从 URL 提取文件名）
    rows.forEach(r => {
      if ((!r.name || r.name === '') && r.url) {
        const fname = decodeURIComponent(r.url.split('/').pop().replace(/\.[^.]+$/, ''));
        if (fname && fname.length > 0) {
          db.query('UPDATE materials SET name=? WHERE id=?', [fname, r.id], (e2) => {
            if (!e2) nameFixed++;
          });
        }
      }
    });

    setTimeout(() => res.json({fixed, nameFixed, garbled: garbled.length}), 2000);
  });
});


// 重命名文件夹
app.post("/api/folders/rename", (req, res) => {
    const { oldName, newName } = req.body;
    if (!oldName || !newName) return res.status(400).json({error: "need oldName and newName"});
    
    const fs = require("fs");
    const oldDir = __dirname + "/public/uploads/" + oldName;
    const newDir = __dirname + "/public/uploads/" + newName;
    
    // 重命名文件夹
    if (fs.existsSync(oldDir)) {
        fs.renameSync(oldDir, newDir);
    }
    
    // 更新数据库
    db.query("UPDATE materials SET folder=? WHERE folder=?", [newName, oldName], (err) => {
        if (err) return res.status(500).json({error: err.message});
        res.json({success: true});
    });
});


// 保存文件夹备注
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

// 获取文件夹备注
app.get("/api/folders/notes", (req, res) => {
    db.query("SELECT folder, note FROM folder_notes", (err, rows) => {
        if (err) return res.status(500).json({error:err.message});
        const notes = {};
        rows.forEach(r => notes[r.folder] = r.note);
        res.json(notes);
    });
});



// ==================== 操作日志 API ====================


app.post("/api/folders/notes", (req, res) => {
    const { folder, note } = req.body;
    if (!folder) return res.status(400).json({error:'folder required'});
    db.query("INSERT INTO folder_notes (folder, note) VALUES (?, ?) ON DUPLICATE KEY UPDATE note = ?", [folder, note, note], (err) => {
        if (err) return res.status(500).json({error:err.message});
        res.json({success:true});
    });
});

app.get('/api/logs', (req, res) => {
  const limit = parseInt(req.query.limit) || 20;
  db.query("SELECT * FROM operation_logs ORDER BY id DESC LIMIT ?", [limit], (err, rows) => {
    if (err) return res.status(500).json({error:err.message});
    res.json(rows);
  });
});

// ==================== 素材同步 v2：同时查 materials + preset_materials ====================
// 修复: 房间 folder_mappings 存的是 preset_materials ID，但旧 API 只查 materials 表，导致 APK 拿到空列表

// 【S-04a】 房间素材列表v2（当前正式版）// GET /api/room-materials-v2/:roomId
app.get('/api/room-materials-v2/:roomId', (req, res) => {
  const roomId = req.params.roomId;

  db.query('SELECT folder_mappings, config FROM rooms WHERE id = ?', [roomId], (err, rows) => {
    if (err || !rows || rows.length === 0) {
      return res.status(404).json({ error: '房间不存在' });
    }

    // 合并 Scene A 和 Scene B 的 folder_mappings（确保两幕素材都能被同步）
    let folderMappings = {};
    try {
      const config = JSON.parse(rows[0].config || '{}');
      const fmA = config.scenes?.A?.folder_mappings || {};
      const fmB = config.scenes?.B?.folder_mappings || {};
      // 合并，A 有则用 A，B 有则追加（不去重，保持原语义）
      Object.keys(fmA).forEach(k => { folderMappings[k] = [...(fmA[k] || [])]; });
      Object.keys(fmB).forEach(k => {
        if (folderMappings[k]) { [...(fmB[k] || [])].forEach(id => { if (!folderMappings[k].includes(id)) folderMappings[k].push(id); }); }
        else { folderMappings[k] = [...(fmB[k] || [])]; }
      });
      // fallback 到根级（兼容旧数据）
      if (Object.keys(folderMappings).every(k => folderMappings[k].length === 0) && rows[0].folder_mappings) {
        try { folderMappings = JSON.parse(rows[0].folder_mappings); } catch(e2) {}
      }
    } catch(e) {
      if (rows[0].folder_mappings) { try { folderMappings = JSON.parse(rows[0].folder_mappings); } catch(e2) {} }
    }
    const result = {}; // { "01": [{id, filename, url, md5, type}], ... }

    // 收集所有需要查询的 material IDs
    const allIds = new Set();
    Object.values(folderMappings).forEach(ids => {
      if (Array.isArray(ids)) ids.forEach(id => { if (id) allIds.add(id); });
    });

    if (allIds.size === 0) {
      console.log('[DEBUG room-materials-v2] folderMappings empty, roomId:', roomId);
      return res.json(result);
    }

    const idList = Array.from(allIds);
    const placeholders = idList.map(() => '?').join(',');
    // 并行查询 materials 和 preset_materials
    db.query(
      `SELECT * FROM materials WHERE id IN (${placeholders})`,
      idList,
      (err2, materialsRows) => {
        console.log('[DEBUG] materialsRows count:', materialsRows?.length, 'err:', err2?.message);
        if (err2) { console.error('[DEBUG] materials query error:', err2.message); materialsRows = []; }
        console.log('[DEBUG] materialsRows:', JSON.stringify(materialsRows?.slice(0,2)));
        db.query(
          `SELECT * FROM preset_materials WHERE id IN (${placeholders})`,
          idList,
          (err3, presetRows) => {
            if (err3) { console.error('[DEBUG] preset query error:', err3.message); presetRows = []; }
            console.log('[DEBUG] presetRows count:', presetRows?.length);
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

            // 按 folder 分组
            Object.entries(folderMappings).forEach(([folderId, ids]) => {
              if (Array.isArray(ids) && ids.length > 0) {
                result[folderId] = ids
                  .map(id => merged[id])
                  .filter(Boolean);
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
app.get('/api/device_logs', (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  const deviceId = req.query.device_id;
  let sql = "SELECT * FROM device_logs";
  let params = [];
  if (deviceId) {
    sql += " WHERE device_id = ?";
    params.push(deviceId);
  }
  sql += " ORDER BY id DESC LIMIT ?";
  params.push(limit);
  db.query(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// ==================== 店铺管理 API ====================
app.get('/api/stores', (req, res) => {
  db.query('SELECT name FROM stores ORDER BY id', (err, results) => {
    if (err) return res.status(500).json({ error: err.message });
    const stores = results.map(r => r.name);
    if (stores.length === 0) stores.push('默认店');
    res.json(stores);
  });
});

app.post('/api/stores', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: '店铺名称不能为空' });
  db.query('INSERT INTO stores (name) VALUES (?) ON DUPLICATE KEY UPDATE name=name', [name], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    logAction('create', 'store', { name });
    res.json({ success: true, name });
  });
});

app.delete('/api/stores/:name', (req, res) => {
  const storeName = decodeURIComponent(req.params.name);
  logAction('delete', 'store', { name: storeName });
  db.query('DELETE FROM stores WHERE name = ?', [storeName], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
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

// 获取房间列表（Plan A: 内存迁移，不写DB）
app.get('/api/rooms', (req, res) => {
  const store = req.query.store;
  let sql = 'SELECT * FROM rooms';
  let params = [];
  if (store) { sql += ' WHERE store_name = ?'; params.push(store); }
  db.query(sql, params, (err, results) => {
    if (err) return res.status(500).json({error:err.message});
    // 内存迁移：为每个房间构造 scenes 结构（不写 DB）
    results.forEach(function(room) {
      try {
        const config = room.config ? JSON.parse(room.config) : {};
        if (!config.scenes) {
          config.scenes = {
            A: { name: '第一幕', folder_mappings: room.folder_mappings ? JSON.parse(room.folder_mappings) : {}, windows: config.windows || [] },
            B: { name: '第二幕', folder_mappings: {}, windows: [] }
          };
          delete config.windows;
          room.config = JSON.stringify(config);
        }
      } catch(e) {}
    });
    res.json(results);
  });
});

// 获取单个房间（Plan A: 内存迁移，不写DB）
app.get('/api/rooms/:id', (req, res) => {
  const id = req.params.id;
  db.query('SELECT * FROM rooms WHERE id = ?', [id], (err, results) => {
    if (err) return res.status(500).json({error:err.message});
    if (results.length === 0) return res.status(404).json({error:'Room not found'});
    const room = results[0];
    // 内存迁移：为前端响应构造 scenes 结构（不写 DB）
    try {
      const config = room.config ? JSON.parse(room.config) : {};
      if (!config.scenes) {
        config.scenes = {
          A: { name: '第一幕', folder_mappings: room.folder_mappings ? JSON.parse(room.folder_mappings) : {}, windows: config.windows || [] },
          B: { name: '第二幕', folder_mappings: {}, windows: [] }
        };
        delete config.windows;
        room.config = JSON.stringify(config);
      }
    } catch(e) {}
    res.json(room);
  });
});

// 创建房间
app.post('/api/rooms', (req, res) => {
  const { store_name, name, folder_mappings, config } = req.body;
  if (!store_name || !name) return res.status(400).json({error:'store_name and name required'});
  const id = 'room_' + Date.now();
  db.query('INSERT INTO rooms (id, store_name, name, folder_mappings, config) VALUES (?, ?, ?, ?, ?)', 
    [id, store_name, name, folder_mappings || '{}', config || '{}'], (err, result) => {
    if (err) return res.status(500).json({error:err.message});
    logAction('create', 'room', { id, store_name, name });
    res.json({success:true, id});
  });
});

// 更新房间
app.put('/api/rooms/:id', (req, res) => {
  const { name, folder_mappings, config } = req.body;
  const id = req.params.id;
  var updates = [];
  var values = [];

  // 【Bug Fix】当 config 包含 scenes 时，先读取 DB 中现有 config，合并后再保存
  // 避免 windows 字段被 incoming config 中的空数组覆盖
  if (config !== undefined) {
    db.query('SELECT config FROM rooms WHERE id=?', [id], (errDb, rowsDb) => {
      if (errDb) return res.status(500).json({ error: errDb.message });
      if (!rowsDb || rowsDb.length === 0) return res.status(404).json({ error: '房间不存在' });

      var existingConfig = {};
      try { existingConfig = rowsDb[0].config ? JSON.parse(rowsDb[0].config) : {}; } catch(e) {}

      var cfg = typeof config === 'string' ? JSON.parse(config) : config;
      var rootFm = folder_mappings ? (typeof folder_mappings === 'string' ? JSON.parse(folder_mappings) : folder_mappings) : {};

      if (!cfg.scenes) {
        cfg.scenes = {
          A: { name: '第一幕', folder_mappings: rootFm, windows: cfg.windows || [] },
          B: { name: '第二幕', folder_mappings: {}, windows: [] }
        };
        delete cfg.windows;
      } else {
        // 合并：保留 DB 中 scenes 的 windows（来自 /windows 接口的保存），只更新 folder_mappings
        var existingScenes = existingConfig.scenes || {};
        cfg.scenes.A = cfg.scenes.A || { name: '第一幕', folder_mappings: {}, windows: [] };
        cfg.scenes.B = cfg.scenes.B || { name: '第二幕', folder_mappings: {}, windows: [] };
        // 保留已有 windows（不被 incoming config 的空 windows 覆盖）
        if (existingScenes.A && existingScenes.A.windows && existingScenes.A.windows.length > 0) {
          cfg.scenes.A.windows = existingScenes.A.windows;
        }
        if (existingScenes.B && existingScenes.B.windows && existingScenes.B.windows.length > 0) {
          cfg.scenes.B.windows = existingScenes.B.windows;
        }
        // 更新 folder_mappings
        if (rootFm && Object.keys(rootFm).length > 0) {
          cfg.scenes.A.folder_mappings = rootFm;
        }
      }

      if (folder_mappings !== undefined) {
        var fm = typeof folder_mappings === 'string' ? JSON.parse(folder_mappings) : folder_mappings;
        updates.push('folder_mappings=?'); values.push(typeof folder_mappings === 'string' ? folder_mappings : JSON.stringify(fm));
      }
      updates.push('config=?'); values.push(JSON.stringify(cfg));
      values.push(id);

      if (updates.length === 0) return res.json({ success: true });
      db.query('UPDATE rooms SET ' + updates.join(',') + ' WHERE id=?', values, (err) => {
        if (err) return res.status(500).json({ error: err.message });
        logAction('update', 'room', { id, name, folder_mappings: folder_mappings ? JSON.parse(folder_mappings) : undefined });
        res.json({ success: true });
      });
    });
    return;
  }

  if (name !== undefined) { updates.push('name=?'); values.push(name); }
  // folder_mappings-only 分支：直接更新 scenes.A.folder_mappings（根级已废止）
  if (folder_mappings !== undefined && config === undefined) {
    var newFm = typeof folder_mappings === 'string' ? JSON.parse(folder_mappings) : folder_mappings;
    db.query('SELECT config FROM rooms WHERE id=?', [id], (err, rows) => {
      if (err) return res.status(500).json({error: err.message});
      var cfg2 = {};
      if (rows && rows[0] && rows[0].config) {
        try { cfg2 = typeof rows[0].config === 'string' ? JSON.parse(rows[0].config) : rows[0].config; } catch(e) {}
      }
      cfg2.scenes = cfg2.scenes || {};
      cfg2.scenes.A = cfg2.scenes.A || { name: '第一幕', folder_mappings: {}, windows: [] };
      cfg2.scenes.B = cfg2.scenes.B || { name: '第二幕', folder_mappings: {}, windows: [] };
      cfg2.scenes.A.folder_mappings = newFm;
      cfg2.scenes.B.folder_mappings = {};
      db.query('UPDATE rooms SET config=? WHERE id=?',
        [JSON.stringify(cfg2), id],
        function(err2) {
          if (err2) return res.status(500).json({error: err2.message});
          logAction('update', 'room', { id, folder_mappings: newFm, changedScene: 'A' });
          res.json({success: true});
        });
    });
    return;
  }
  if (updates.length === 0) return res.json({success: true});
  values.push(id);
  db.query('UPDATE rooms SET ' + updates.join(',') + ' WHERE id=?', values, (err) => {
    if (err) return res.status(500).json({error: err.message});
    logAction('update', 'room', { id, name, folder_mappings: folder_mappings ? JSON.parse(folder_mappings) : undefined });
    res.json({success: true});
  });
});
// 更新房间的窗口配置（快捷接口，支持指定场景）
// PUT /api/rooms/:id/windows  body: { windows, sceneId }
app.put('/api/rooms/:id/windows', (req, res) => {
  const { windows, sceneId } = req.body;   // sceneId: 'A' 或 'B'
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
    db.query('UPDATE rooms SET config=? WHERE id=?', [JSON.stringify(existingConfig), id], (err2) => {
      if (err2) return res.status(500).json({ error: err2.message });
      logAction('update_windows', 'room', { id, scene: targetScene, windows });

      // 【S-04b-Fix】立即推送 MQTT，让 APP 立即应用新窗口配置
      db.query('SELECT id, folder_mappings FROM rooms WHERE id = ?', [id], (err3, rows3) => {
        if (!err3 && rows3 && rows3.length > 0) {
          const roomFolderMappings = rows3[0].folder_mappings ? JSON.parse(rows3[0].folder_mappings) : {};
          // 查找绑定到此房间的设备（APK MQTT clientId = fingerprint）
          db.query('SELECT id, fingerprint FROM devices WHERE room_id = ?', [id], (err4, rows4) => {
            if (!err4 && rows4 && rows4.length > 0) {
              const mqttId = rows4[0].fingerprint || rows4[0].id;
              sendSyncCommandToDevice(mqttId, id, roomFolderMappings, existingConfig);
            }
          });
        }
      });

      res.json({ success: true, scene: targetScene, windows });
    });
  });
});

// 删除房间
app.delete('/api/rooms/:id', (req, res) => {
  const id = req.params.id;
  db.query('SELECT name, store_name FROM rooms WHERE id = ?', [id], (err, rows) => {
    if (err) return res.status(500).json({error: err.message});
    const room = rows[0];
    db.query('DELETE FROM rooms WHERE id = ?', [id], (err2) => {
      if (err2) return res.status(500).json({error: err2.message});
      logAction('delete', 'room', { id, name: room ? room.name : null, store_name: room ? room.store_name : null });
      res.json({success:true});
    });
  });
});

// 获取房间素材
// APK syncRoomMaterials调用的API（与/api/rooms/:id/materials等价）
// APK syncRoomMaterials 调用的 API（带 /list 后缀）
app.get('/api/room-materials/:roomId/list', (req, res) => {
  const roomId = req.params.roomId;
  db.query('SELECT folder_mappings, config FROM rooms WHERE id = ?', [roomId], (err, rooms) => {
    if (err) return res.status(500).json({error: err.message});
    if (!rooms[0]) return res.status(404).json({error: 'room not found'});
    const room = rooms[0];
    let roomConfig = { scenes: {} };
    try { if (room.config) roomConfig = JSON.parse(room.config); } catch(e) {}
    // scenes.A.folder_mappings 是唯一来源（根级已废止）
    let folderMappings = (roomConfig.scenes && roomConfig.scenes.A && roomConfig.scenes.A.folder_mappings)
      ? roomConfig.scenes.A.folder_mappings : {};

    const allIds = [...new Set(Object.values(folderMappings).flat().filter(Boolean))];
    const result = {};
    if (allIds.length === 0) { res.json(result); return; }

    const inClause = allIds.map(() => '?').join(',');
    db.query(`SELECT id, name AS filename, url, md5, type, folder FROM materials WHERE id IN (${inClause})`, allIds, (err2, materialsRows) => {
      materialsRows = materialsRows || [];
      db.query(`SELECT id, filename, url, md5, 'preset' AS type, folder_id AS folder FROM preset_materials WHERE id IN (${inClause})`, allIds, (err3, presetRows) => {
        presetRows = presetRows || [];
        const merged = {};
        [...materialsRows, ...presetRows].forEach(row => {
          if (!merged[row.id]) {
            merged[row.id] = {
              id: row.id,
              filename: row.filename || row.name || '',
              url: row.url || '',
              md5: row.md5 || '',
              type: row.type || 'video',
              folder: row.folder || ''
            };
          }
        });
        Object.entries(folderMappings).forEach(([folder, ids]) => {
          if (Array.isArray(ids)) {
            result[folder] = ids.map(id => merged[id]).filter(Boolean);
          }
        });
        res.json(result);
      });
    });
  });
});

// 房间素材API（/api/rooms/:id/materials的内部包装）
app.get('/api/rooms/:id/materials', (req, res) => {
  const id = req.params.id;
  db.query('SELECT folder_mappings FROM rooms WHERE id = ?', [id], (err, results) => {
    if (err) return res.status(500).json({error:err.message});
    if (!results[0]) return res.status(404).json({error:'room not found'});
    const mappings = JSON.parse(results[0].folder_mappings || '{}');
    res.json(mappings);
  });
});

// 添加素材到房间
app.post('/api/rooms/:id/folder/:folder', (req, res) => {
  const { id } = req.params;
  const { folder } = req.params;
  const { material_ids } = req.body;
  db.query('SELECT folder_mappings, config FROM rooms WHERE id = ?', [id], (err, results) => {
    if (err) return res.status(500).json({error:err.message});
    if (!results || results.length === 0) return res.status(404).json({error:'Room not found'});

    let mappings = results[0].folder_mappings ? JSON.parse(results[0].folder_mappings) : {};
    mappings[folder] = material_ids || [];

    // 同时更新 scenes A/B 的 folder_mappings（独立场景模式）
    let cfg = results[0].config ? JSON.parse(results[0].config) : {};
    if (!cfg.scenes) {
      cfg.scenes = {
        A: { name: '第一幕', folder_mappings: {}, windows: [] },
        B: { name: '第二幕', folder_mappings: {}, windows: [] }
      };
    }
    if (!cfg.scenes.A.folder_mappings) cfg.scenes.A.folder_mappings = {};
    if (!cfg.scenes.B.folder_mappings) cfg.scenes.B.folder_mappings = {};
    cfg.scenes.A.folder_mappings[folder] = material_ids || [];
    cfg.scenes.B.folder_mappings[folder] = material_ids || [];

    // 只更新 config.scenes A/B（根级 folder_mappings 已废止）
    db.query('UPDATE rooms SET config=? WHERE id=?', [JSON.stringify(cfg), id], (err2) => {
      if (err2) return res.status(500).json({error:err2.message});
      logAction('push', 'room_material', { room_id: id, folder, material_ids });
      // 通知该房间的设备同步
      notifyRoomDevicesOfSync(id);
      res.json({success:true});
    });
  });
});

// ============================================================================
// 📺 房间素材同步 API — APK 专用接口
//    GET /api/room-materials/:roomId
//    合并查 materials + preset_materials，按 folder_mappings 过滤后返回
//    这是设备同步时调用的核心接口
// ============================================================================

// ============================================================================
// 📺 房间素材同步 API — APK 专用
//    GET /api/room-materials/:roomId
//    合并查 materials + preset_materials，按 folder_mappings 过滤
//    这是设备同步时调用的核心接口
// ============================================================================

// 获取房间所有素材（materials + preset_materials 合并，按文件夹分组，供APK同步使用）

// 【S-04c】 房间素材（旧版）// GET /api/room-materials/:roomId
app.get('/api/room-materials/:roomId', (req, res) => {
  const { roomId } = req.params;
  db.query('SELECT folder_mappings, config FROM rooms WHERE id = ?', [roomId], (err, results) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!results || results.length === 0) return res.json({});
    const roomConfig = results[0].config ? JSON.parse(results[0].config) : {};
    const debugFlag = roomConfig.debug === true;
    // scenes.A.folder_mappings 是唯一来源（根级已废止）
    const mappings = (roomConfig.scenes && roomConfig.scenes.A && roomConfig.scenes.A.folder_mappings)
      ? roomConfig.scenes.A.folder_mappings : {};

    // 收集所有需要的 material IDs
    const allIds = new Set();
    Object.values(mappings).forEach(ids => (ids || []).forEach(id => allIds.add(id)));

    // 同时查询两个表
    db.query('SELECT id, name AS filename, url, type, folder, thumbnail FROM materials', (err, materials) => {
      if (err) return res.status(500).json({ error: err.message });
      db.query('SELECT id, filename, url, type, thumbnail FROM preset_materials', (err, presets) => {
        if (err) return res.status(500).json({ error: err.message });
        const all = [...materials, ...presets];
        const result = { debug: debugFlag };
        Object.entries(mappings).forEach(([folder, ids]) => {
          result[folder] = (ids || []).map(id => all.find(m => m.id === id)).filter(Boolean);
        });
        res.json(result);
      });
    });
  });
});

// 获取设备的房间素材
app.get('/api/devices/:id/room-materials', (req, res) => {
  const id = req.params.id;
  db.query('SELECT room_id FROM devices WHERE id = ?', [id], (err, results) => {
    if (err) return res.status(500).json({error:err.message});
    if (!results[0] || !results[0].room_id) return res.json({});
    db.query('SELECT folder_mappings, config FROM rooms WHERE id = ?', [results[0].room_id], (err, rows) => {
      if (err) return res.status(500).json({error:err.message});
      if (!rows[0]) return res.json({});
      const roomConfig = rows[0].config ? JSON.parse(rows[0].config) : {};
      // scenes.A.folder_mappings 是唯一来源（根级已废止）
      const mappings = (roomConfig.scenes && roomConfig.scenes.A && roomConfig.scenes.A.folder_mappings)
        ? roomConfig.scenes.A.folder_mappings : {};
      res.json(mappings);
    });
  });
});

// 绑定设备到房间
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

// 获取未注册/未授权设备
app.get('/api/unregistered', (req, res) => {
  db.query('SELECT id, name, fingerprint, model, hardware, mac, location, status, first_seen, online_time FROM devices WHERE authorized = 0 ORDER BY online_time DESC', (err, results) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(results || []);
  });
});


// ==================== 默认素材 API ====================
app.get('/api/default-materials', (req, res) => {
  db.query('SELECT * FROM default_materials ORDER BY id DESC', (err, results) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(results || []);
  });
});

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




// ==================== 预设素材 API ====================
app.get('/api/preset/folders', (req, res) => {
  db.query('SELECT * FROM preset_folders ORDER BY sort_order', (err, results) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(results || []);
  });
});

app.post('/api/preset/folders', (req, res) => {
  const { name, path, sort_order } = req.body;
  const id = 'preset_' + Date.now();
  db.query(
    'INSERT INTO preset_folders (id, name, path, sort_order) VALUES (?, ?, ?, ?)',
    [id, name, path || '', sort_order || 0],
    (err) => {
      if (err) return res.status(500).json({ error: err.message });

// 【S-03b】 预设素材（重复注册）// GET|POST /api/preset/folders | /materials
      res.json({ id, name, path, sort_order });
    }
  );
});

app.delete('/api/preset/folders/:id', (req, res) => {
  db.query('DELETE FROM preset_materials WHERE folder_id = ?', [req.params.id], (err) => {
    db.query('DELETE FROM preset_folders WHERE id = ?', [req.params.id], (err) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true });
    });
  });
});

app.get('/api/preset/materials', (req, res) => {
  db.query('SELECT * FROM preset_materials ORDER BY folder_id, filename', (err, results) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(results || []);
  });
});

app.post('/api/preset/materials', (req, res) => {
  const { folder_id, filename, url, type, thumbnail } = req.body;
  const id = 'pm_' + Date.now();
  const safeName = filename || url.split('/').pop() || '未知文件';
  const fileType = type || (safeName.endsWith('.mp4') || safeName.endsWith('.avi') ? 'video' : 'image');
  db.query(
    'INSERT INTO preset_materials (id, folder_id, filename, url, type, thumbnail) VALUES (?, ?, ?, ?, ?, ?)',
    [id, folder_id, safeName, url, fileType, thumbnail || null],
    (err) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ id, folder_id, filename, url, type: fileType, thumbnail });
    }
  );
});


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
  initPresetMaterialsTable();
});

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
      url VARCHAR(512),
      type VARCHAR(50),
      folder VARCHAR(10),
      thumbnail VARCHAR(512),
      resolution VARCHAR(50),
      md5 VARCHAR(32),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
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

// 获取版本列表
app.get('/api/versions', (req, res) => {
  db.query('SELECT * FROM apk_versions ORDER BY version_code DESC', (err, results) => {
    if (err) return res.status(500).json({error:err.message});
    res.json(results || []);
  });
});

// 获取最新版本
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

// 删除版本
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

// 设备上报版本
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

// 获取设备版本列表
app.get('/api/device/versions', (req, res) => {
  db.query(`
    SELECT d.id, d.name, d.store, d.room_id, d.status, dv.version, dv.version_code, dv.updated_at
    FROM devices d 
    LEFT JOIN device_versions dv ON d.id = dv.device_id
    ORDER BY dv.updated_at DESC
  `, (err, results) => {
    if (err) return res.status(500).json({error:err.message});
    res.json(results || []);
  });
});

// 推送更新到设备
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

// 批量推送更新
// 推送指定版本到所有已授权设备
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