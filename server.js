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
 * 【S-05p】大屏试播（POST /api/rooms/:id/preview、/preview/stop + resolvePreviewTarget）
 * 【S-06】MQTT 消息处理 & 发送（mqttClient / publishToDeviceCommand / 载荷组装与变更收敛：
 *         roomSceneDigest / roomSyncFields / syncCommandPayload / notifyRoomConfigChanged /
 *         reconcileDeviceRev / resolveDeviceId（自报 id → 规范 devices.id，写 device_versions、
 *         device_logs 前先过它））
 * 【S-07】素材同步 & 删除（POST /api/rooms/:id/sync、DELETE /api/rooms/:roomId/materials/:materialId）
 * 【S-08】日志 & 操作记录（logAction、/api/logs、/api/device_logs）
 * 【S-09】静态文件 & 前端页面
 * 【S-10】文件夹管理 API（/api/folders、/api/folders/note、/api/folders/notes）
 * 【S-11】店铺管理 API（/api/stores*）
 * 【S-12】版本管理 API（/api/versions*、/api/device/version*、push-update）
 * 【S-13】配置 & 默认素材 & 未注册设备（/api/config*、/api/default-materials*、/api/unregistered）
 * 【S-14】会话鉴权（POST/GET/DELETE /api/session、makeSessionToken / sessionValid / requireAuth）
 * ─────────────────────────────────────────────
 *
 * 核心表：
 *   materials          - 素材库（视频上传时重封装为 faststart；md5 存的是落盘后字节的摘要，视频在重封装之后才算）
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
 *   入站  xvj/device/{id}/status    - 心跳/状态，顺带上报 version、model、mac、screen_w/h（本机屏幕像素，
 *                                    #177）、frames（近期收到的 485 帧去重列表，见【S-06f】）；
 *                                    带 rev（已应用配置指纹）时服务端做对账补发，见 reconcileDeviceRev
 *   入站  xvj/device/{id}/frames    - 学习窗内的帧候选快照 {learning, frames:[{hex,n,age}]}，只进内存台账（【S-06f】）
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
 *                       └──────────推送到房间──────────┘   // 旁路：素材库 id 直接进映射（线上有用到）
 *   两层目录号都是 01-30（界面签写死的）；预设那边额外用 PRESET_FOLDER_RE 挡住区间外的值。
 *   素材库 filename 在同目录内唯一（uniqueMaterialFilename 自动补 " (2)"）——
 *   设备端不按 id 而按 <目录>/<filename> 认文件，同名会互相覆盖下载与缓存。
 *
 * ==========================================================
 * 场景系统（多窗口）
 * ==========================================================
 * 场景数据结构（存储在 rooms.config.scenes，每幕一份）：
 *   {
 *     A: { name: '第一幕',
 *          folder_mappings: { "01": [materialId, ...], "02": [...] },   // 键是未加前缀的两位编号；值是素材库 id 或预设素材 id，两种都合法
 *          play_settings: { "01": { order: 'shuffle', hdmi: true, hdmi_mode: 2, dmx: true } },
 *                         // 文件夹级播放设置：order='seq' 顺序循环 | 'shuffle' 随机循环；
 *                         // hdmi=true 表示这一格在播时显示点歌屏（HDMI 采集）窗口，缺省 = 关；
 *                         // hdmi_mode ∈ {2,3} 选哪一套点歌窗（点歌窗在窗口配置里按 content.mode 分成 1~3 三套），
 *                         // 缺键 = 模式1（存量形状，只落 hdmi:true 不落这个键）；
 *                         // dmx=true 表示这一格接受 DMX512 控制，缺省 = 关。
 *                         // 素材轮播交接一律硬切（叠化已于 2026-11-12 从三端删除，载荷里残留的 dissolve /
 *                         // dissolve_ms 键写库时被丢掉，不必清库）。
 *                         // 没列出的键 = 全默认（顺序循环 + 点歌屏关 + DMX512 关）；全默认的格子不落键，
 *                         // 空表整个键都不下发，所以存量房间的 rev 不会因为新增这些字段而漂移。非法值写库前 400。
 *          windows: [WinConfig, ...],
 *          master: { brightness: Number } },   // 场景总亮度 0..1，服务端在 PUT windows 时夹取
 *     B: { ... }
 *   }
 *   ⚠️ 出口一致性：DB 里存未加前缀的 "01"，凡经 buildPrefixedScenes 下发给设备的
 *   folder_mappings / play_settings 键一律变成 "A01"/"B01"（避免 A/B 共用物理目录名）。
 *   但 windows 是原样透传的（content.folderId 仍是 "01"），由 APK 端按 A01/01 双键回退查表。
 *
 * 墙板（485 串口）房间级字段（与 debug 同级的 config 顶层键）：
 *   wallpanel_enabled: Boolean     // 串口监听总闸，严格 true 才算开
 *   wallpanel_serial_path: String  // 串口节点，isSafeSerialPath 形状闸（默认 /dev/ttyUSB0）
 *   wallpanel_baud: 档位 | null    // 见 WALLPANEL_BAUDS；不在档内 = 没配，设备保留驱动默认
 *   wallpanel_data_bits / parity / stop_bits  // 字符格式，三档白名单（默认 8 / none / 1）；
 *                                    // 设备端的空闲断帧阈值 = 2 个字符时间，由这三位数算出来，猜错就把别家帧切碎
 *   wallpanel_bindings: [{ frame: 'D3', folder: '01', source: 'panel' }, ...]
 *                                    // 学习式绑定表：帧指纹（大写 hex，1~64 字节）→ 文件夹。
 *                                    // 没有编号那层，也不分幕：一格最多三个码 —— 一路点歌机（player）、
 *                                    // 一路墙板（panel）、一路自定义（custom），谁先到都切到这一格，A/B 两幕通用。
 *                                    // 同帧只有一条、同格同一列也只有一条（后写覆盖），总条数截
 *                                    // WALLPANEL_BINDINGS_MAX，脏形状写库前 400。
 *   wallpanel_on_frame / wallpanel_off_frame: String | null
 *                                    // 一键全开/全关的两个码（墙板开关键交替发这两个帧，彼此独立）。
 *                                    // 全关 = 所有窗口盖黑布（播放不停，只在画面上盖一层）；
 *                                    // 全开 = 撤掉黑布，回到按之前那份画面继续播。
 *                                    // 两个码形状闸同绑定帧；彼此不能相同，也不能与绑定表里任何帧重复
 *                                    // （同一帧不能既是切换又是全开/全关），写库前 400。
 *   这些都进不了 rev（同 debug）：学习时"按一键记一条"绝不该引发全量素材重下/重建，
 *   单独变更走轻量 set_wallpanel；载荷在 roomWallpanelFields 一处收口。
 *   判义次序（设备端）：全开/全关码命中 → 盖/撤黑布且不再往下查 → 学习绑定表命中就切 →
 *   不中只留痕不动画面（没有编号兜底）。
 *
 * DMX512（副板串口）房间级字段（与墙板同级的 config 顶层键）：
 *   dmx_enabled: Boolean           // 副板串口监听总闸，严格 true 才算开；与墙板的门是两扇（两条物理链路）
 *   dmx_serial_path: String        // 副板在主板上挂的 UART 节点（默认 /dev/ttyS4，同小麦 x9/x10 机型）
 *   dmx_baud: 档位                // 默认 115200（厂商该机型档位）；见 DMX_BAUDS
 *   通道表现由设备端定义，不入库：设备只认第 1 个通道（副板一帧 20 路，其余 19 路不用），值 1:1 调格
 *   （值 N = 文件夹 NN，1~30 有效，0=松手，31~255 忽略），值变动即触发，只对 play_settings[NN].dmx=true 的格子生效。
 *   同样不进 rev，单独变更走轻量 set_dmx；载荷在 roomDmxFields 一处收口。
 *
 * 输出基准（与 debug 同级的 config 顶层键，任务 #177）：
 *   output: { w: Number, h: Number } | 缺省
 *     编辑器画布与设备窗口几何共用的那把尺，单位=输出屏像素。窗口 x/y/width/height 都在这个坐标系里。
 *     没设 = 历史口径（1920×1080 设计稿按轴向铺满整屏）：设备按 屏宽/1920 与 屏高/1080 各缩一次，
 *     20:9 的屏上 sx/sy=1.25，数据里的正方形落屏就是长方形。
 *     设成这台屏的真实像素（设备端就是它自己报上来的那对值）⇒ sx=sy ⇒ 编辑器里画成正方形，屏上就是正方形。
 *     设备实际像素 ≠ 基准时按轴向缩放铺满整屏 —— 换了一块不同比例的屏，版式整体跟着屏走，不会留黑边。
 *   进 rev（几何变了屏上必须重排），但只在"真设了"时才计入指纹：存量房间都没设，
 *   部署瞬间不能因为多算了一段就把全库 rev 推倒（同 play_settings「空表不落键」那条教训）。
 *   非法值写库前 400，不静默回落（同墙板字段那条纪律）。
 *
 * WinConfig（窗口配置）：服务端整体透传，不解析下列渲染字段，新增字段无需改代码
 *   {
 *     id: String,        // 窗口唯一ID，如 "win_1"
 *     name: String,       // 显示名称，如 "主屏"
 *     x: Number,          // 左上角 X 坐标（px，单位是房间输出基准 config.output 那个坐标系；没设就是 1920×1080 设计稿）
 *     y: Number,          // 左上角 Y 坐标（px，同上）
 *     width: Number,      // 宽度（px，同上 —— 设备落屏时按 屏宽/基准宽 与 屏高/基准高 轴向换算，见 output 那节）
 *     height: Number,     // 高度（px，同上）
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
 *                         // 测试背景在设备端固定显示 assets/testcard.jpg（彩条卡，拉伸铺满窗口，随窗口形状变形），
 *                         // 与云端 public/testcard.jpg 是同一张图；color 字段只在图卡读不到时兜底
 *                         // 没有 IMAGE 分支，旧文档里的 'COLOR'/'VIDEO'/'IMAGE' 大写取值都不存在
 *       // type=HDMI 时：
 *       inputIndex?: Number,        // HDMI 输入索引（0-based）
 *       mode?: Number,              // 归属模式 1~3（缺省 1）：点歌窗有三套配置，
 *                         // 播放设置 play_settings 的 hdmi_mode 选哪套，屏上就只显示哪套点歌窗
 *                         // 测试画面（window_testcard 浮层）固定网格卡 assets/testcard_hdmi.png（仅设备端打包，
 *                         // 管理台不预览）；其余窗的浮层用彩条卡 testcard.jpg
 *       // type=color 时：
 *       color?: String,             // 兜底纯色，如 "#000000"（图卡缺失时用）
 *       // type=SCENE_A|SCENE_B 时：
 *       folderId?: String           // 对应素材文件夹 ID，如 "01"（未加场景前缀）
 *       follow?: Boolean            // 墙板跟随：true = 这一幕里播哪个文件夹由墙板决定
 *                         // （设备端按 config.wallpanel_bindings 里帧命中的格子切，
 *                         //  没按过键时退 folderId → 首个有素材文件夹）。
 *                         // 只有 SCENE_* 有意义：HDMI/color 的内容不是文件夹，跟着切没东西可切。
 *                         // 与 folderId 不打架 —— folderId 是"没按过墙板时的默认那格"
 *     }
 *   }
 *
 * 设备开机流程（详见 MainActivity.kt）：
 *   1. APP 启动 → loadConfig() 读 SharedPreferences 的 scenes_json 缓存 → applySceneConfigs 恢复窗口
 *   2. MQTT 连上 → 发 register → 服务端回 xvj/auth/response（带 scenes）→ 缓存并再次 applySceneConfigs
 *   3. 收到 sync_room_materials / update_windows 等 command → 同步素材或只重排窗口
 *      （preview_material / preview_stop 也在这一条主题上，但它是"过路命令"：见下面【试播】约定）
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
 *     映射变了→sync_room_materials，窗口/总亮度/播放设置变了→update_windows，debug 变了→set_debug，
 *     墙板字段变了→set_wallpanel，DMX 字段变了→set_dmx，窗口名浮层变了→set_window_names，
 *     测试背景浮层变了→set_window_testcard，LOGO 辅助网格变了→set_logo_grid，没变→一条不发。八类是**并列判定**（同一次 PUT 既改窗口又开总闸就两条都发，
 *     命中全量同步时轻枪省掉——它的载荷已带这些字段）。前端不再自己补 POST /sync（手工点「同步当前房间」按钮除外）。
 *     兜底是 rev 对账：命令里带 rev=roomSceneDigest(config)，设备心跳回传已应用的 rev，
 *     服务端发现落后就补发一次（3 分钟/台节流），所以设备离线期间的变更会在上线后收敛。
 *     ⚠️ set_debug / set_wallpanel / set_dmx / set_window_names / set_window_testcard / set_logo_grid 是指纹之外的六个例外：debug、墙板、DMX、
 *     两个编辑器浮层与 LOGO 辅助网格都故意不进指纹（开个开关不该惊动素材同步，见 roomSceneDigest），所以它们对不上账、不会被对账补发。
 *     命令是 QoS1 非 retain，设备在线但正好掉线那一跳就会丢，靠下次重连时 auth_result
 *     （以及手工同步的 sync 载荷）里的同名字段自愈。现场口径：「云端开了开关但大屏没反应」
 *     先让设备重连一次（或点一次手工同步），别急着怀疑开关本身。
 *   - 【config 写库口径】POST /rooms 与 PUT /rooms/:id 共用一个净化入口 prepareRoomConfig：
 *     JSON 合法性 → scenes 脏键过滤 → 顶层键"incoming 覆盖、其余继承 DB" → 墙板/DMX 字段按下发口径归一 →
 *     播放设置校验 → 逐幕合并。任一步不过就 400，绝不带病入库：
 *     脏值一旦落库，后续不重填那一项的 PUT 会继承它再撞上同一道校验，这间房就再也存不进配置了。
 *   - 【试播 preview_material】唯一一条"不进 config"的命令：不落库、不带 rev、不触发对账，
 *     播完由设备自己回到原画面（见 S-05p 与 MainActivity.kt 的 armPreview / endPreview）。
 *     正因为它不改配置，rev 对账永远不会替它兜底 —— 命令丢了就是没播，所以失败原因一律回给前端
 *     （前端常驻在素材区标题行的状态条里），不做静默下发。它不挂房间 debug：单击即播是内容操作。
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
 * @param {Function} [done] - 落盘后回调（崩溃路径要先写完再 exit，所以这里用同步追加）
 */
function writeFault(type, msg, detail, done) {
  const ts = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const entry = `## [${ts}] ${type}\n\n**消息**: ${msg}\n\n**详情**: \`${JSON.stringify(detail)}\`\n\n---\n`;
  // appendFile + 空回调时，写失败（目录不存在/磁盘满）是彻底静默的 —— 崩溃现场最需要的那条记录反而没了。
  // 同步写在三个调用点（进程崩溃、Promise 拒绝、Express 错误兜底）都是低频路径，不会卡到事件循环。
  try { fs.appendFileSync(FAULT_LOG, entry); }
  catch (e) { console.error('⚠️ 故障记录写入失败（' + FAULT_LOG + '）:', e.message); }
  console.error('[故障记录]', type, msg, detail);
  if (done) done();
}

// 进程级崩溃捕获：记完就退出，交给 systemd（Restart=always）重启。
// 以前只记不退，注释里也写了"继续跑状态未知"——但 Node 的语义正是如此：抛出点之后的
// 清理不会执行，MySQL 连接池/MQTT client/正在写一半的文件全处在未知状态，进程变成
// "监听还在、事件循环还在、出事那块的逻辑已经废了"的僵尸，systemd 看它是 active 就不会重启。
// 2026-09-08 全站瘫 3 小时正是这个形状：与其带病硬撑，不如干净地重启一次（设备会自动重连重注册）。
process.on('uncaughtException', (err) => {
  writeFault('进程崩溃 (uncaughtException)', err.message, { stack: err.stack }, () => process.exit(1));
});
// unhandledRejection 与 uncaughtException 同构处理（Node 15+ 的默认行为本来就是直接崩，
// 这里只是把现场记下来再退，而不是偷偷把错误吞掉）
process.on('unhandledRejection', (reason) => {
  writeFault('Promise拒绝 (unhandledRejection)', String(reason && reason.stack || reason), {}, () => process.exit(1));
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
  // details 是 undefined 时 JSON.stringify 返回 undefined（不是字符串 "undefined"），
  // mysql2 会在"绑参阶段"同步抛 Bind parameters must not contain undefined —— 那是 throw 而不是
  // 回调里的 err，会把调用方整个请求打成 500（POST /api/log 不带 detail 就是这条路径）。
  // 已经是字符串就不要再 stringify 一遍，否则库里是双重转义的 "\"{...}\""。
  let detailJson = null;
  if (typeof details === 'string') detailJson = details;
  else if (details !== undefined && details !== null) {
    try { detailJson = JSON.stringify(details); } catch (e) { detailJson = String(details); }
  }
  db.query("INSERT INTO operation_logs (action, target, details) VALUES (?, ?, ?)",
    [action, target, detailJson],
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
 * prefixedFolderKey 的逆运算：把幕内文件夹键折回不带前缀的格名（"A01" → "01"，"01" 原样）。
 * 一幕之内 "01" 和 "A01" 指的是同一格，必须先归一再判重 —— 否则两个键各自都合法，
 * 过得了「一键一文件夹」校验，却在 buildPrefixedScenes 撞成同一个 "A01"，后写静默覆盖。
 * sceneKey 为空时原样返回（无幕上下文的调用不受影响）。
 */
function panelCellKey(sceneKey, folderId) {
  return (folderId.length === 3 && folderId[0] === sceneKey) ? folderId.slice(1) : folderId;
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

/**
 * 素材行 → 设备本机那个文件名（唯一口径）。
 * 设备不按 id 认文件、按 <目录>/<filename> 认，所以下发清单（room-materials-v2）、删本地文件、
 * 试播定位必须用同一个回退链：filename 是老数据里可能为 NULL 的列，真值在 name（素材库）或
 * 只有 filename（预设库没这列，查它时补 `NULL AS name`）。任何一处自己另写一条链，
 * 就会算出另一个文件名，设备端的表现为"素材明明在，却说没有"。
 */
function manifestFilename(row) {
  return row.filename || row.name || row.fullFilename || row.fname || row.id;
}

/**
 * 设备播放链认的视频扩展名 —— 三端唯一一份表的云端侧那份
 * （APK 侧是 listOf("mp4","mkv","avi","mov","webm")，出现在同步扫描/播放/试播三处）。
 * 上传通道、预设 type 兜底、试播闸门都从这里派生，别再各写一份正则：
 * 【S-03f】那份只列了 mp4/avi，一只 .webm 传上去不带 type 就被记成 image，
 * 而房间卡片按另一份表判类型 —— 同一个文件在三处得到两种身份，排查时谁都说不清。
 */
const VIDEO_EXT = ['mp4', 'webm', 'mov', 'avi', 'mkv'];
function hasVideoExt(name) {
  const s = String(name == null ? '' : name).toLowerCase();
  return VIDEO_EXT.some(e => s.endsWith('.' + e));
}

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

/** 墙板硬件字段的取值口径（三端共用一份，改这里要同步 APK 的 WallPanelLink 与前端配置表下拉）：
 * - 波特率只收 485 模块常见档，其它值视为"没配"→ 设备端保留驱动默认（不假装设置成功）
 * - 默认节点与 APK 的 WallPanelLink.DEFAULT_PATH 对齐；不同板子可能是 ttyS0、ttyHSL0 之类，所以做成可配
 */
const WALLPANEL_BAUDS = [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200];
const WALLPANEL_DEFAULT_PATH = '/dev/ttyUSB0';
/**
 * 字符格式三档（数据位 / 校验 / 停止位）：中控厂家固件的默认档各不相同，8N1 只是最常见那一条。
 * 这三位数还决定设备端的空闲断帧阈值（2 个字符时间），所以必须能配 —— 猜错一家就把别人家的帧切碎了。
 */
const WALLPANEL_DATA_BITS = [5, 6, 7, 8];
const WALLPANEL_PARITIES = ['none', 'odd', 'even'];
const WALLPANEL_STOP_BITS = [1, 2];
/**
 * DMX512 副板串口（与 485 墙板是两条独立链路，各有一扇门）：
 * 节点默认对齐小麦 x9/x10 机型的 ttyS4，波特率默认 115200（厂商该机型走的就是这一档）；
 * CX3588 台架与量产小板的实际挂载口若不同，在配置表里改，写错值写库前 400。
 * 字符格式固定 8N1：副板吐的是自家的二进制帧（0x5a10…头 + 20 字节通道值），不是线路上的 DMX512 电平，
 * 没有厂家会用奇偶校验去跑它，所以不像 485 那样开放三档。
 */
const DMX_BAUDS = [9600, 19200, 38400, 57600, 115200];
const DMX_DEFAULT_PATH = '/dev/ttyS4';
const DMX_DEFAULT_BAUD = 115200;
/** 帧指纹 = 1~64 字节的大写十六进制（APK 的 WallPanelHex.isValid 同一把尺）。
 *  最小 1 字节：小麦那族功能码就是单字节（D3、B5 这种），两位 hex 必须能落库、能学习。 */
const WALLPANEL_FRAME_HEX_RE = /^([0-9A-F]{2}){1,64}$/;
/**
 * 码值来源：同一个文件夹允许三个码 —— 一路点歌机、一路墙板、一路自定义，谁先到都切到这一格。
 * player = 点歌机码（中控合并进来的点歌机帧），panel = 墙板码（墙板那颗键的帧），
 * custom = 自定义码（现场想额外挂一条触发帧时用，语义与另两列完全一致）。
 * 来源只是人记账用的标签：设备端只认 frame→folder，判不出也不该判这一帧是谁发的。
 * 存量绑定没有这个键，按历史学习路径归 panel（墙板列）。
 */
const WALLPANEL_BINDING_SOURCES = ['player', 'panel', 'custom'];
/** 学习规则条数上限：30 格 × 3 列 = 90，留一点余量挡住有人拿这棵树当日志刷 */
const WALLPANEL_BINDINGS_MAX = 96;
/** 学习窗时长上限（秒），与 APK MainActivity.LEARN_MAX_S 同一把尺；窗内设备只上报候选帧，不改配置 */
const WALLPANEL_LEARN_MAX_S = 60;

/** 串口节点形状：/dev/ 下的单层设备名，只允许字母数字与 - _（挡住 '..'、空格、换行这些形状） */
function isSafeSerialPath(s) { return typeof s === 'string' && /^\/dev\/[A-Za-z0-9_-]{1,64}$/.test(s); }

/**
 * 文件夹级播放设置（scenes[X].play_settings）的取值口径 —— 三端共用一份，改这里要同步
 * 前端 _psCell/psSet* 与 APK 的 playSettingsOf：
 *   order       'seq'|'shuffle' 顺序循环（按文件名）/ 随机循环
 *   hdmi        true = 这一格在播时显示点歌屏（HDMI 采集）窗口；缺省 = 关
 *   hdmi_mode   点歌窗三套配置里选哪一套（1~3）。缺键 = 1；模式1 不落这个键（存量形状），
 *               只有 2/3 才落。设备端只显示 content.mode 与在播格模式相同的点歌窗（见 APK applyHdmiVisibility）
 *   dmx         true = 这一格接受 DMX512 控制；缺省 = 关（设备端 DMX 接收尚未实现，先按三端同一形状落设置）
 *   logo        true = 这一格在播时允许叠加 LOGO；缺省 = 关。只是"允许"：窗口还要在 config.logo.windows
 *               里被勾上，两者同时为真才显示（窗口级开关在「LOGO设置」，文件夹级开关在本表）
 * A、B 是两套独立物理目录（scenea/01 与 sceneb/01 装的不是同一批片子），所以设置按幕各存一份。
 * 全默认的格子一律不落键：给每幕挂一张 30 格默认表会让 roomSceneDigest 当场全库漂移一次，
 * 部署后每台在线设备都被对账判成"rev 落后"补发一发同步、视频从头播（与 play_settings「空表不落键」同理）。
 * 素材轮播交接一律硬切：叠化（dissolve / dissolve_ms）已于 2026-11-12 整条删除，存量格子里残留的
 * 那两个键在规范化时被丢掉 —— 谁之前开过叠化，这次部署会因该格形状变化多同步一次，仅此而已。
 */
const PLAY_ORDERS = ['seq', 'shuffle'];

/**
 * 单格播放设置 → 确定形状；等于全默认返回 null（= 这一格不落键）。
 * 只认 order / hdmi / dmx：残留的 dissolve 类键不再往下带，设备端已经不读它们，留着只会让 rev 比出假变化。
 * hdmi 默认 false（2026-11-18 用户定调：点歌屏默认全关），dmx 默认 false（同用户定调：DMX512 控制默认关），
 * 所以只有 true 才落键；存量库里残留的 false 是旧口径的"关"，现在等于默认，写库/下发时按默认丢掉。
 */
function playSettingsValue(v) {
  if (!isPlainObject(v)) return null;
  const out = {};
  if (v.order === 'shuffle') out.order = 'shuffle';
  if (v.hdmi === true) {
    out.hdmi = true;
    // 模式1 = 只落 hdmi:true（存量形状，存量房间 rev 不漂）；模式2/3 才多带 hdmi_mode
    if (v.hdmi_mode === 2 || v.hdmi_mode === 3) out.hdmi_mode = v.hdmi_mode;
  }
  if (v.dmx === true) out.dmx = true;
  if (v.logo === true) out.logo = true;
  return Object.keys(out).length ? out : null;
}

/**
 * 整张播放设置表规范化（写库与下发共用）：键必须是合法文件夹名，值全默认的丢掉，
 * 幕内键折回格名（"A01" → "01"）后排序输出 —— 同一组设置不管从哪种键顺序写进来都长同一个样，
 * rev 才不会因键序/类型抖动虚报"配置变了"。同格两种写法（"01" 与 "A01"）先到先得。
 */
function normalizePlaySettings(ps, sceneKey) {
  const kept = {};
  if (!isPlainObject(ps)) return kept;
  Object.keys(ps).sort().forEach(fid => {
    if (!isSafeFolderName(fid)) return;
    const v = playSettingsValue(ps[fid]);
    if (v === null) return;
    const cell = panelCellKey(sceneKey, fid);
    if (kept[cell] === undefined) kept[cell] = v;
  });
  const out = {};
  Object.keys(kept).sort().forEach(cell => { out[cell] = kept[cell]; });
  return out;
}

/**
 * 播放设置写入校验：非法的 order 静默回落会造成"表里填的和设备演的两回事"，
 * 所以写库前就报出去（与 findWallpanelFieldError 同一套理由）。空/没带不算错（回落默认）。
 * 入参是整份 config（两幕都查）；无错返回 null。
 */
function findPlaySettingsError(cfg) {
  const scenes = (cfg && cfg.scenes) || {};
  for (const key of ['A', 'B']) {
    const ps = scenes[key] && scenes[key].play_settings;
    if (!isPlainObject(ps)) continue;
    for (const fid of Object.keys(ps).sort()) {
      const cell = ps[fid];
      if (!isPlainObject(cell)) continue;   // 脏形状由 normalizePlaySettings 丢弃，与 folder_mappings 同口径
      const where = `场景${key} 文件夹${panelCellKey(key, fid)}`;
      if (cell.order !== undefined && cell.order !== null && cell.order !== '' && PLAY_ORDERS.indexOf(cell.order) < 0) {
        return `${where} 的播放顺序只能是 seq（顺序循环）或 shuffle（随机循环）`;
      }
      if (cell.hdmi !== undefined && cell.hdmi !== null && typeof cell.hdmi !== 'boolean') {
        return `${where} 的点歌屏开关只能是 true（显示）或 false（关闭）`;
      }
      if (cell.hdmi_mode !== undefined && cell.hdmi_mode !== null) {
        if (cell.hdmi_mode !== 1 && cell.hdmi_mode !== 2 && cell.hdmi_mode !== 3) {
          return `${where} 的点歌屏模式只能是 1、2、3（模式1/模式2/模式3）`;
        }
        // 模式挂在开关下面：只选模式不开开关是自相矛盾状态，写库前就拦下（同 order 那条理由）
        if (cell.hdmi !== true) {
          return `${where} 选了点歌屏模式${cell.hdmi_mode}，但点歌屏开关没开（hdmi 必须为 true）`;
        }
      }
      if (cell.dmx !== undefined && cell.dmx !== null && typeof cell.dmx !== 'boolean') {
        return `${where} 的 DMX512 控制开关只能是 true（接受）或 false（不接受）`;
      }
      if (cell.logo !== undefined && cell.logo !== null && typeof cell.logo !== 'boolean') {
        return `${where} 的 LOGO 开关只能是 true（显示）或 false（关闭）`;
      }
    }
  }
  return null;
}

/**
 * 单幕合并：incoming（PUT 整份 config 时带的那一幕）× existing（DB 里的那一幕）→ 落库形状。
 * 四个字段的"没传"口径，各自都不能猜：
 *   - folder_mappings：只要带了这个键（含 {} / null / 脏形状）就按传入的规范化结果落库，
 *     完全没带才继承 DB —— 否则映射永远无法清空
 *   - play_settings：带键即按传入落，没带才继承，否则把随机改回顺序后那一格
 *     会被 DB 旧值继承回来，永远改不回来
 *   - windows：只有非空数组才覆盖。清空窗口走 PUT /rooms/:id/windows —— 那里 windows 是必填
 *     数组，空数组表示"真的一个都不留"，不会和"调用方顺手带了个空 config"混淆
 *   - master：带 brightness 才生效，并 clamp 到 [0,1]
 * sceneKey（'A'/'B'）用来把 play_settings 的幕内键归一成格名，落库的表因此只有一种写法。
 */
function mergeSceneConfig(incoming, existing, defaultName, sceneKey) {
  var src = isPlainObject(incoming) ? incoming : {};
  var ex = isPlainObject(existing) ? existing : {};
  var mappings = (src.folder_mappings === undefined)
    ? (ex.folder_mappings || {})
    : normalizeFolderMappings(src.folder_mappings);
  var playSettings = (src.play_settings === undefined)
    ? normalizePlaySettings(ex.play_settings, sceneKey)
    : normalizePlaySettings(src.play_settings, sceneKey);
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
    play_settings: playSettings,
    windows: (Array.isArray(src.windows) && src.windows.length > 0) ? src.windows : (ex.windows || []),
    master: master
  };
}

/**
 * config 写库前的统一净化入口（PUT /api/rooms/:id 与 POST /api/rooms 共用）。
 * 返回 { error }（400 文案，调用方直接 res.status(400).json）或 { cfg }（可直接 stringify 落库的形状）。
 * 两个入口必须同口径：POST 过去只做"JSON 合不合法"检查，脏绑定能直接入库，
 * 之后一次不重填它的 PUT 继承这份脏值再撞上同一道校验 —— 稳定 400，这间房再也存不进去。
 * existingCfg 传 null 表示新建房间（没有可继承的旧配置）。
 */
function prepareRoomConfig(raw, existingCfg) {
  var cfg;
  try { cfg = typeof raw === 'string' ? JSON.parse(raw) : raw; }
  catch (e) { return { error: 'config 不是合法 JSON 字符串' }; }
  if (!isPlainObject(cfg)) return { error: 'config 必须是对象' };

  if (cfg.scenes === undefined || cfg.scenes === null) cfg.scenes = {};
  else if (!isPlainObject(cfg.scenes)) return { error: 'config.scenes 必须是对象' };
  else {
    // 只认 A/B 两幕。脏键（典型是 "__proto__"）留在 config 里会被存库，
    // 下次按 scenes[key] 取值时就把内容挂到了 Object.prototype 上（全进程、跨房间泄漏）
    Object.keys(cfg.scenes).forEach(function (k) { if (!isSceneKey(k)) delete cfg.scenes[k]; });
  }

  // incoming 没带的顶层键从 DB 那份继承。少带一个 debug 不只是丢个标志位：收敛点会把它判成
  // "调试模式变了"，给整间房的在线设备发 set_debug false —— 现场正在排障，大屏的运维 UI 和日志上报会自己关掉。
  // JSON.parse 出来的脏原型键是 own 属性，直接 obj[k]=v 走的是原型 setter，会把内容挂到
  // Object.prototype 上（全进程、跨房间），所以 __proto__/constructor/prototype 一律不接。
  var merged = {};
  [existingCfg || {}, cfg].forEach(function (src) {
    Object.keys(src).forEach(function (k) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') return;
      merged[k] = src[k];
    });
  });

  // 墙板字段按下发口径落库（roomWallpanelFields 算出确定形状）：存进 "true"/1 这类真值时
  // 下发判成 false，界面显示"开"而设备关着，且靠 set_wallpanel 补不回来（两边指纹都是 false）。
  // 非法的串口节点/波特率先报 400 —— 静默回落等于替运营改了硬件参数，配置表里看到的却还是自己填的。
  var wpErr = findWallpanelFieldError(merged);
  if (wpErr) return { error: wpErr };
  Object.assign(merged, roomWallpanelFields(merged));
  // DMX 副板串口同理（同一套理由：确定形状落库，非法值先 400）
  var dmxErr = findDmxFieldError(merged);
  if (dmxErr) return { error: dmxErr };
  Object.assign(merged, roomDmxFields(merged));
  // 编号/默认编号体系已删（2026-11-13）：存量 config 里残留的这个键随下一次写入清掉，
  // 免得"配置表里还挂着一个设备端根本不读的数"
  delete merged.wallpanel_default_no;
  // 窗口名浮层按严格布尔落库（同 debug 口径）：字符串 "true"/1 会让下发侧判成 false，
  // 编辑器开着、屏上却不显示名字，且靠 set_window_names 补不回来（两边都是 false）
  merged.window_names = merged.window_names === true;
  // 测试背景浮层同理（同一次 PUT 里与窗口名一起写）
  merged.window_testcard = merged.window_testcard === true;
  // LOGO 设置辅助网格同理（管理台打开「LOGO设置」时置 true，设备屏上垫一层等像素方格帮人判断 LOGO 比例）
  merged.logo_grid = merged.logo_grid === true;

  // 输出基准（编辑器画布与设备换算共用的那把尺）按下发口径落库：字符串宽高归一成整数，
  // 没设/null 就把整个键撤掉（下发 null，设备回落到 1920×1080 轴向换算）。
  // 非法值写库前 400 —— 静默回落等于替运营改了整间房的版式，而配置表里看到的还是他自己填的那串。
  var outErr = findOutputError(merged);
  if (outErr) return { error: outErr };
  var outVal = roomOutputField(merged);
  if (outVal) merged.output = outVal; else delete merged.output;

  // LOGO（房间级一份 + 相对窗口的几何 + 窗口名单）：确定形状落库，非法值先 400。
  // 不设就把整个键撤掉，存量房间的 rev 与之前逐字节一致。
  var logoErr = findLogoError(merged);
  if (logoErr) return { error: logoErr };
  var logoVal = roomLogoField(merged);
  if (logoVal) merged.logo = logoVal; else delete merged.logo;

  // 播放设置同理：非法的时长/顺序需要在写库前报出去，而不是静默回落成"表里一套、设备演另一套"。
  // 查的是逐幕合并之前的 scenes —— mergeSceneConfig 里的 normalizePlaySettings 会把脏值直接规范化掉，
  // 到那时再查就看不见 incoming 写进来的那串了（DB 里的存量都是当年校验过的，继承回来不用再查一遍）
  var psErr = findPlaySettingsError(merged);
  if (psErr) return { error: psErr };

  // 逐幕合并：incoming 没带的那一幕、以及 windows/master 这些不归本接口管的字段，
  // 一律从 DB 继承 —— 前端有多处会 PUT 整份 config，任何一处少填都不该抹掉房间配置
  var existingScenes = (existingCfg && existingCfg.scenes) || {};
  ['A', 'B'].forEach(function (key) {
    merged.scenes[key] = mergeSceneConfig(merged.scenes[key], existingScenes[key], key === 'A' ? '第一幕' : '第二幕', key);
  });

  return { cfg: merged };
}

/**
 * DB 形状的 scenes → 下发形状：幕内两张表（folder_mappings / play_settings）的文件夹键
 * 一律加幕前缀（"01" → "A01" / "B01"）；windows 原样透传，content.folderId 仍是裸 "01"。
 * @param {object} scenes - { A: { folder_mappings: { "01": [...] }, play_settings: { "01": {...} }, windows: [...] }, B: {...} }
 * @returns {object} - { A: { folder_mappings: { "A01": [...] }, play_settings: { "A01": {...} }, windows: [...] }, B: {...} }
 * 用途：MQTT 发送时统一格式，避免 A/B 两幕共用 "01" 导致物理文件夹冲突（设备按前缀落 scenea/sceneb 目录）。
 * 三处归一化（为了让"配置有没有变"可判定，见 roomSceneDigest）：
 *   - 只取 A/B 两幕（见 isSceneKey；DB 里的脏键不会跟着下发，也不会污染返回值原型）
 *   - 文件夹键排序后再生成，DB 里键顺序变了不算内容变了
 *   - 已带幕前缀的键不二次加前缀（见 prefixedFolderKey）；映射值过 normalizeMaterialIds
 * 两张表同一套前缀 + 排序口径，设备端才能用同一把键查"这一格该怎么播"。
 * 区别只在落不落键：folder_mappings 恒在（空表也是 {}），play_settings 空表不落键 —— 理由见函数内注释。
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
    // 播放设置加幕前缀 + 排序 + 空表不落键（默认值不该让全库 rev 漂移一次）。
    // 设备端按物理目录 id（"A01"）查这一格该顺序还是随机循环。
    var playSettings = normalizePlaySettings(sceneData.play_settings, key);
    var psKeys = Object.keys(playSettings).sort();
    if (psKeys.length > 0) {
      var prefixedPs = {};
      psKeys.forEach(function(folderId) { prefixedPs[prefixedFolderKey(key, folderId)] = playSettings[folderId]; });
      result[key].play_settings = prefixedPs;
    }
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
 * 房间配置的"内容指纹"（rev）：只覆盖会影响设备播放的字段（A/B 两幕的映射+窗口+总亮度+播放设置）。
 * 用途有两处：① 写接口落库后比对新旧，配置真变了才打扰设备；② 随命令下发给设备，
 * 设备心跳回传，服务端发现不一致就补发一次同步（对账，替代"每个入口都记得补一枪"）。
 * 键序已由 buildPrefixedScenes 归一化；A/B 显式定序，避免 DB 里键顺序变了被当成内容变了。
 * ⚠️ 指纹只算 scenes：config 顶层的 debug、wallpanel_*（总闸/串口节点/波特率/学习表）与 dmx_* 都不进 rev。
 * 它们各走轻量命令（set_debug / set_wallpanel / set_dmx），不该因为"开个调试"就触发一次素材全量同步；
 * 代价是掉了那一跳不会被心跳对账补回来，只能靠重连或手工同步自愈（见 notifyRoomConfigChanged）。
 */
function roomSceneDigest(cfg) {
  const p = buildPrefixedScenes((cfg && cfg.scenes) || {});
  // 输出基准决定每扇窗落屏的像素位置，属几何，进 rev（设备才知道要重排）。
  // 但只在"真设了"时才往数组里多塞那一段：存量房间全部没设，指纹必须和加这个字段之前
  // 逐字节相同，否则部署那一瞬间全库 rev 漂移，每台在线设备都被对账判成落后、补发一轮素材同步
  // （同 play_settings「空表不落键」那条教训）。
  const parts = [p.A || null, p.B || null];
  const out = roomOutputField(cfg);
  if (out) parts.push(out.w + 'x' + out.h);
  // LOGO 是叠在素材之上的画面元素：文件（url 含 md5）、几何、哪几扇窗口显示任一变化都要让设备重排。
  // 只在真设了时才塞这一段（同上：存量房间指纹不能漂）。
  const lg = roomLogoField(cfg);
  if (lg) {
    const seg = ['logo', lg.url, lg.x, lg.y, lg.w, lg.h, lg.windows.A.join(','), lg.windows.B.join(',')];
    // 逐窗几何按键名定序拼（roomLogoField 已排序），任一扇窗的数值变了都要让设备重排
    if (lg.per_win) {
      Object.keys(lg.per_win).forEach(function (id) {
        const g = lg.per_win[id];
        seg.push(id + ':' + g.x + ',' + g.y + ',' + g.w + ',' + g.h);
      });
    }
    parts.push(seg.join('|'));
  }
  return crypto.createHash('sha1').update(JSON.stringify(parts)).digest('hex').slice(0, 12);
}

/**
 * 素材映射指纹：只覆盖 folder_mappings（决定"设备上该有哪些文件"）。
 * 用来区分"要重新对账素材"和"只是窗口/总亮度/播放设置变了"，
 * 后者发轻量 update_windows 就够了（设备原地改视图，不释放播放器、视频不从头播）。
 */
function roomMappingDigest(cfg) {
  const p = buildPrefixedScenes((cfg && cfg.scenes) || {});
  const m = p.A ? p.A.folder_mappings : {}, n = p.B ? p.B.folder_mappings : {};
  return crypto.createHash('sha1').update(JSON.stringify([m, n])).digest('hex').slice(0, 12);
}

/** 组装 update_windows 载荷（轻量：APK 原地改视图，结构/播放设置变化时自行回退全量重建；不触碰素材） */
function windowCommandPayload(roomId, cfg) {
  return {
    action: 'update_windows',
    room_id: roomId,
    scenes: buildPrefixedScenes((cfg && cfg.scenes) || {}),
    // 输出基准也在这一跳带：只改基准（版式没动）就该由这条轻通道送达，设备按新分母重算每扇窗的几何。
    // 不带的话"改基准"只能等全量同步或重连，编辑器里明明已经生效，屏上却还按旧尺子摆。
    output: roomOutputField(cfg),
    // LOGO 几何/窗口名单的变化进 rev 后就走这条轻通道，设备原地重排叠加层，不重建播放器
    logo: roomLogoField(cfg),
    rev: roomSceneDigest(cfg),
    timestamp: Date.now()
  };
}

/** 房间的调试模式标志（config.debug 严格 true 才算开，与所有下发口径一致） */
function roomDebugFlag(cfg) { return !!(cfg && cfg.debug === true); }

/**
 * 窗口名浮层（config.window_names）：管理台打开「窗口配置」时为 true，让包厢屏上每扇窗正中
 * 常亮自己的名字，关掉编辑器后置回 false。同 debug 一样是"看屏辅助"，不进 rev，
 * 变化时走轻量 set_window_names；丢了那一跳靠重连/手工同步载荷里的同名字段自愈。
 */
function roomWindowNamesFlag(cfg) { return !!(cfg && cfg.window_names === true); }

/**
 * 测试背景浮层（config.window_testcard）：管理台打开「窗口配置」时为 true，包厢屏上每扇窗盖一张
 * 测试卡（点歌窗=网格卡 testcard_hdmi.png，其余=彩条卡 testcard.jpg，窗框一目了然），关掉编辑器后撤掉、继续播原素材。与 window_names 同批开关、同款轻量下发
 * （set_window_testcard），同样不进 rev。
 */
function roomWindowTestcardFlag(cfg) { return !!(cfg && cfg.window_testcard === true); }

/**
 * LOGO 设置辅助网格（config.logo_grid）：管理台打开「LOGO设置」时为 true，包厢屏垫一层等像素方格的网格，
 * 帮人肉眼判断 LOGO 在每扇窗里有没有被拉变形。与 window_names 同口径：不进 rev，
 * 变化时走轻量 set_logo_grid；丢了那一跳靠重连/手工同步载荷里的同名字段自愈。
 */
function roomLogoGridFlag(cfg) { return !!(cfg && cfg.logo_grid === true); }

/** 这个档位值合不合法：只认数字与数字字符串，且必须落在白名单里（三端同一把尺） */
function wallpanelBitOk(raw, allowed) {
  var n = (typeof raw === 'number' || typeof raw === 'string') ? Number(raw) : NaN;
  return allowed.indexOf(n) >= 0;
}

/** 档位整数 → 合法就用它，否则回落默认档 */
function wallpanelBitChoice(raw, allowed, dflt) {
  return wallpanelBitOk(raw, allowed) ? Number(raw) : dflt;
}

/**
 * 一条学习规则（帧指纹 → 切到某一格）的规范化，不合法返回 null。
 * 动作只剩一样：切到某一格。编号/默认编号那套间接动作已于 2026-11-13 删除，
 * 存量规则里残留的 type/no 键在整形时被丢掉（设备端已经不读它们）。
 * 格子号复用预设那把 01~30 的闸（PRESET_FOLDER_RE）：与素材目录同一口径。
 * source 只是给人看的分列标签（点歌机码 / 墙板码 / 自定义），不属于形状闸：没带的存量绑定归 panel。
 */
function normalizeWallpanelRule(r) {
  if (!isPlainObject(r)) return null;
  var hex = (typeof r.frame === 'string' ? r.frame.trim().toUpperCase() : '');
  if (!WALLPANEL_FRAME_HEX_RE.test(hex)) return null;
  // 带幕前缀的旧写法（A01/B01）折回裸格名：格子本身不属任何一幕
  var fid = String(r.folder === undefined || r.folder === null ? '' : r.folder).trim()
    .replace(/^[AB](?=\d{2}$)/, '');
  if (!PRESET_FOLDER_RE.test(fid)) return null;
  return { frame: hex, folder: fid, source: (r.source === 'player' || r.source === 'custom') ? r.source : 'panel' };
}

/**
 * 学习绑定表（config.wallpanel_bindings，[{ frame, folder, source }]）规范化 → 下发/指纹用的确定形状。
 * 一格最多三个码、不分幕：点歌机那一路、墙板那一路与自定义那一路，谁按到都切到这一格，A/B 两幕通用。
 * 脏规则与超上限的尾部当场丢掉 —— 这里是整形，报错归 findWallpanelBindingsError（写入侧）。
 * 按帧排序落库：同一组绑定不管什么顺序写进来，
 * roomWallpanelDigest 都不会虚报"墙板配置变了"多发一枪。
 * 同一帧先到先得、同一格同一列先到先得（后写的那条不算），真歧义在写入侧已被拦掉。
 */
function normalizeWallpanelBindings(raw) {
  var arr = Array.isArray(raw) ? raw : [];
  var seenFrame = {}, seenSlot = {}, kept = [];
  arr.forEach(function (r) {
    var rule = normalizeWallpanelRule(r);
    if (!rule) return;
    var slot = rule.folder + '|' + rule.source;
    if (seenFrame[rule.frame] || seenSlot[slot]) return;
    seenFrame[rule.frame] = true;
    seenSlot[slot] = true;
    kept.push(rule);
  });
  kept.sort(function (a, b) { return a.frame < b.frame ? -1 : (a.frame > b.frame ? 1 : 0); });
  return kept.slice(0, WALLPANEL_BINDINGS_MAX);
}

/** 来源的界面列名（报错文案用）：player = 点歌机码、panel = 墙板码、custom = 自定义码 */
function wallpanelSourceName(source) {
  return source === 'player' ? '点歌机码' : (source === 'custom' ? '自定义码' : '墙板码');
}

/**
 * 学习绑定表的写入校验：形状闸与 normalizeWallpanelRule 同一把尺，但这里不丢而是报出去 ——
 * 静默丢弃的现场表现是"按了键、点了保存，再打开什么都没有"，比一句 400 难查得多。
 * 没带 / null / 空数组不算错（= 这房间还没学过任何帧）。
 */
function findWallpanelBindingsError(raw) {
  if (raw === undefined || raw === null) return null;
  if (Array.isArray(raw)) {
    if (raw.length > WALLPANEL_BINDINGS_MAX) {
      return '墙板学习表有 ' + raw.length + ' 条规则，超出上限 ' + WALLPANEL_BINDINGS_MAX;
    }
    var problems = [], seenFrame = {}, seenSlot = {};
    raw.forEach(function (r, i) {
      var rule = normalizeWallpanelRule(r);
      if (!rule) {
        problems.push('第 ' + (i + 1) + ' 条规则形状不对（帧要是 1~64 字节的十六进制，' +
          '目标要是 01~30 的格子号）');
        return;
      }
      if (r.source !== undefined && r.source !== null && r.source !== '' &&
          WALLPANEL_BINDING_SOURCES.indexOf(r.source) < 0) {
        problems.push('第 ' + (i + 1) + ' 条规则的来源只能是点歌机（player）、墙板（panel）或自定义（custom）');
      }
      if (seenFrame[rule.frame]) problems.push('帧 ' + rule.frame + ' 绑了不止一条：一键只能对一个文件夹');
      var slot = rule.folder + '|' + rule.source;
      if (seenSlot[slot]) {
        problems.push('文件夹 ' + rule.folder + ' 的' + wallpanelSourceName(rule.source) +
          '绑了不止一个：每列只能录一个码');
      }
      seenFrame[rule.frame] = true;
      seenSlot[slot] = true;
    });
    return problems.length ? problems.join('；') : null;
  }
  // 旧形状 {A:[...],B:[...]} 的残留写回来时直接把话说明白，别让现场对着"没保存上"瞎猜
  if (isPlainObject(raw)) return '墙板学习表要写成一个数组 [{frame, folder, source}]，不再按 A/B 分幕录码';
  return '墙板学习表要写成一个数组 [{frame, folder, source}]';
}

/**
 * 房间的墙板字段（config 顶层，与 debug 同级）：串口监听总闸 + 串口节点 +
 * 波特率 + 字符格式（数据位/校验/停止位）+ 学习绑定表。
 * 一律算出确定形状（没配 = false / null / 默认节点 / 8N1 / 空表），设备端不必区分"没带"和"关着"。
 * 这里同时是「写入侧的归一」（见 prepareRoomConfig）：存进去的形状就是发出去的形状。
 * 非法值由 findWallpanelFieldError 在写库前报 400，这里只做回落，保证下发侧永远是总函数。
 * ⚠️ 这几项和 debug 一样故意不进 rev（见 roomSceneDigest）：换个串口或学一个键，
 *    都不该让整间房重新对账素材 —— 它们走 roomWallpanelDigest 那一枪轻量的 set_wallpanel。
 */
/**
 * 全开/全关码（config.wallpanel_on_frame / wallpanel_off_frame）的规范化：形状闸同绑定帧，
 * 不合法 = null（= 没配这一键），报错归 findWallpanelFieldError（写入侧）。
 */
function normalizeWallpanelCode(raw) {
  var hex = (typeof raw === 'string' ? raw.trim().toUpperCase() : '');
  return WALLPANEL_FRAME_HEX_RE.test(hex) ? hex : null;
}

function roomWallpanelFields(cfg) {
  var path = cfg && cfg.wallpanel_serial_path;
  var parity = cfg && cfg.wallpanel_parity;
  return {
    wallpanel_enabled: !!(cfg && cfg.wallpanel_enabled === true),
    wallpanel_serial_path: isSafeSerialPath(path) ? path : WALLPANEL_DEFAULT_PATH,
    wallpanel_baud: wallpanelBitChoice(cfg && cfg.wallpanel_baud, WALLPANEL_BAUDS, null),
    wallpanel_data_bits: wallpanelBitChoice(cfg && cfg.wallpanel_data_bits, WALLPANEL_DATA_BITS, 8),
    wallpanel_parity: WALLPANEL_PARITIES.indexOf(parity) >= 0 ? parity : 'none',
    wallpanel_stop_bits: wallpanelBitChoice(cfg && cfg.wallpanel_stop_bits, WALLPANEL_STOP_BITS, 1),
    wallpanel_bindings: normalizeWallpanelBindings(cfg && cfg.wallpanel_bindings),
    wallpanel_on_frame: normalizeWallpanelCode(cfg && cfg.wallpanel_on_frame),
    wallpanel_off_frame: normalizeWallpanelCode(cfg && cfg.wallpanel_off_frame)
  };
}

/** 墙板字段指纹（只用于"这一枪是不是只改了墙板"的判定，不是配置 rev） */
function roomWallpanelDigest(cfg) { return JSON.stringify(roomWallpanelFields(cfg)); }

/**
 * DMX512 副板串口字段：与墙板同构的确定形状（没配 = false / 默认节点 / 默认速率）。
 * 通道表不在这里：设备端固定"只认第 1 个通道，值 N = 文件夹 NN"（副板一帧 20 路，其余不用），
 * 要不要接这一路只由每格 play_settings.dmx 决定，服务端不存第二份映射。
 */
function roomDmxFields(cfg) {
  var path = cfg && cfg.dmx_serial_path;
  return {
    dmx_enabled: !!(cfg && cfg.dmx_enabled === true),
    dmx_serial_path: isSafeSerialPath(path) ? path : DMX_DEFAULT_PATH,
    dmx_baud: wallpanelBitChoice(cfg && cfg.dmx_baud, DMX_BAUDS, DMX_DEFAULT_BAUD)
  };
}

/** DMX 字段指纹（同墙板：只用来决定要不要补一枪 set_dmx，不是配置 rev） */
function roomDmxDigest(cfg) { return JSON.stringify(roomDmxFields(cfg)); }

/** DMX 串口字段写入校验：理由同 findWallpanelFieldError（静默回落 = 表里一套、设备演另一套） */
function findDmxFieldError(cfg) {
  var path = cfg.dmx_serial_path;
  if (path !== undefined && path !== null && path !== '' && !isSafeSerialPath(path)) {
    return 'DMX 串口节点只能是 /dev/ 下的设备名（字母、数字、-、_），例如 /dev/ttyS4';
  }
  var baud = cfg.dmx_baud;
  if (baud !== undefined && baud !== null && baud !== '' &&
      wallpanelBitChoice(baud, DMX_BAUDS, NaN) !== Number(baud)) {
    return 'DMX 波特率只能是 ' + DMX_BAUDS.join(' / ') + ' 之一';
  }
  return null;
}

/**
 * 墙板硬件字段（串口节点 / 波特率 / 字符格式 / 学习表）写入校验：非法值 roomWallpanelFields
 * 会静默回落，现场表现是"配置表里填的和自己看到的两回事，设备却按回落值开串口"，最难查，
 * 所以写库前就报出去。空/没带不算错（回落默认节点 + 驱动默认波特率 + 8N1 + 空表）。
 */
function findWallpanelFieldError(cfg) {
  var path = cfg.wallpanel_serial_path;
  if (path !== undefined && path !== null && path !== '' && !isSafeSerialPath(path)) {
    return '串口节点只能是 /dev/ 下的设备名（字母、数字、-、_），例如 /dev/ttyUSB0';
  }
  var baud = cfg.wallpanel_baud;
  if (baud !== undefined && baud !== null && baud !== '' &&
      wallpanelBitChoice(baud, WALLPANEL_BAUDS, NaN) !== Number(baud)) {
    return '波特率只能是 ' + WALLPANEL_BAUDS.join(' / ') + ' 之一，留空则用驱动默认';
  }
  var bitsErr = findBitChoiceError('数据位', cfg.wallpanel_data_bits, WALLPANEL_DATA_BITS) ||
    findBitChoiceError('停止位', cfg.wallpanel_stop_bits, WALLPANEL_STOP_BITS);
  if (bitsErr) return bitsErr;
  var parity = cfg.wallpanel_parity;
  if (parity !== undefined && parity !== null && parity !== '' && WALLPANEL_PARITIES.indexOf(parity) < 0) {
    return '校验位只能是 ' + WALLPANEL_PARITIES.join(' / ') + '，留空则用 none';
  }
  var bindsErr = findWallpanelBindingsError(cfg.wallpanel_bindings);
  if (bindsErr) return bindsErr;
  var onRaw = cfg.wallpanel_on_frame, offRaw = cfg.wallpanel_off_frame;
  var onHex = normalizeWallpanelCode(onRaw), offHex = normalizeWallpanelCode(offRaw);
  if (onRaw !== undefined && onRaw !== null && onRaw !== '' && !onHex) {
    return '全开码要是 1~64 字节的十六进制（两个字符一字节），例如 06F0';
  }
  if (offRaw !== undefined && offRaw !== null && offRaw !== '' && !offHex) {
    return '全关码要是 1~64 字节的十六进制（两个字符一字节），例如 06F1';
  }
  if (onHex && offHex && onHex === offHex) {
    return '全开码和全关码不能是同一个帧：一个键轮流发两个码，两个码要各自独立';
  }
  var binds = normalizeWallpanelBindings(cfg.wallpanel_bindings);
  var conflict = null;
  binds.some(function (r) {
    if (r.frame === onHex) conflict = '全开码 ' + onHex + ' 已经绑在文件夹 ' + r.folder + ' 上';
    if (r.frame === offHex) conflict = '全关码 ' + offHex + ' 已经绑在文件夹 ' + r.folder + ' 上';
    return conflict !== null;
  });
  if (conflict) return conflict + '：同一帧不能既是切换又是全开/全关';
  return null;
}

/** 档位类字段的写入校验公共段：没带/空算过，带了就必须在白名单内 */
function findBitChoiceError(label, raw, allowed) {
  if (raw === undefined || raw === null || raw === '') return null;
  if (wallpanelBitChoice(raw, allowed, NaN) !== Number(raw)) {
    return label + '只能是 ' + allowed.join(' / ') + ' 之一，留空则用默认档';
  }
  return null;
}

/**
 * 房间输出基准（config.output）→ 下发/指纹用的确定形状，或 null（没设）。
 * 只认 {w,h} 两个 OUTPUT_MIN_PX..OUTPUT_MAX_PX 的整数；脏类型/越界当"没设"，
 * 因为非法值在写库前已被 findOutputError 报 400，能落到这里的只剩手改库。
 * 单位=输出屏像素：它同时是编辑器画布的尺寸和设备换算窗口的分母（见 MainActivity.windowGeom）。
 */
const OUTPUT_MIN_PX = 16, OUTPUT_MAX_PX = 7680;
function outputPx(v) {
  var n = (typeof v === 'number' || typeof v === 'string') ? Number(v) : NaN;
  return Number.isInteger(n) && n >= OUTPUT_MIN_PX && n <= OUTPUT_MAX_PX ? n : null;
}
function roomOutputField(cfg) {
  var o = cfg && cfg.output;
  if (!isPlainObject(o)) return null;
  var w = outputPx(o.w), h = outputPx(o.h);
  return w !== null && h !== null ? { w: w, h: h } : null;
}

/**
 * 输出基准写入校验：宽高必须是 16~7680 的整数像素，否则 400。
 * 缺省/null 是合法值（= 没设，设备回落到 1920×1080 轴向换算），不报错。
 * 非法值不静默回落的理由同墙板字段：那等于"表里填的一套、设备演另一套"，而这里错的是一整间房的版式。
 */
function findOutputError(cfg) {
  var o = cfg && cfg.output;
  if (o === undefined || o === null) return null;
  if (!isPlainObject(o)) return '输出基准必须是 { w: 宽像素, h: 高像素 } 的对象，或整个不设';
  if (outputPx(o.w) === null || outputPx(o.h) === null) {
    return '输出基准的宽高必须是 ' + OUTPUT_MIN_PX + '~' + OUTPUT_MAX_PX + ' 之间的整数像素（例如本机屏幕 2400×1080）';
  }
  return null;
}

/**
 * LOGO 叠加（config.logo）：房间级一份视频 + 相对素材窗口的几何 + 按幕记录哪些窗口显示。
 * 三端共用的取值口径（前端 LOGO 设置页；APK 的 LogoCanvasView 后续实现）：
 *   url / thumbnail / md5 / size / width / height：上传接口返回的同名元数据；
 *     url 只认 /uploads/logos/<roomId>/logo-<md5前12>.<视频扩展>，防外链与路径穿越
 *   x / y：LOGO 中心相对「素材窗口中心」的偏移百分比（窗口宽/高为分母，向右/向下为正，默认 0）
 *   w / h：LOGO 视频宽/高占素材窗口宽/高的百分比（默认 50）
 *   per_win：{ 窗口id: {x,y,w,h} } —— 逐窗几何；各窗宽高比不同，同一套相对几何摆出来观感不一样，
 *     所以允许每扇窗单独定。缺字段跟随上面这套房间默认；不在表里的窗口一律用默认
 *   windows：{ A:[窗口id], B:[窗口id] } —— 只有列在这里的窗口才可能显示；
 *     真正出不出还要看该窗口当前文件夹的 play_settings.logo（两者同时为真，见 playSettingsValue）
 * 值域：x/y ∈ [-200,200]，w/h ∈ (0,100]；每幕最多 64 个窗口 id；per_win 最多 128 项。
 * 没设时整个键不落：存量房间的 rev 必须与加这个字段之前逐字节相同（同 output / play_settings 的教训）。
 */
const LOGO_URL_RE = /^\/uploads\/logos\/[A-Za-z0-9_-]{1,64}\/logo-[a-f0-9]{6,32}\.(?:mp4|webm|mov|avi|mkv)$/;
const LOGO_THUMB_RE = /^\/uploads\/logos\/[A-Za-z0-9_-]{1,64}\/logo-[a-f0-9]{6,32}\.jpg$/;
const LOGO_WINDOW_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const LOGO_WINDOWS_MAX = 64;
const LOGO_PER_MAX = 128;
const LOGO_PCT_MIN = 1, LOGO_PCT_MAX = 100, LOGO_OFF_MAX = 200;

function logoNum(v, dflt) {
  const n = (typeof v === 'number' || typeof v === 'string') ? Number(v) : NaN;
  return Number.isFinite(n) ? n : dflt;
}
function logoPct(v, dflt) { return Math.min(LOGO_PCT_MAX, Math.max(LOGO_PCT_MIN, logoNum(v, dflt))); }
function logoOff(v, dflt) { return Math.min(LOGO_OFF_MAX, Math.max(-LOGO_OFF_MAX, logoNum(v, dflt))); }
function logoWinIds(v) {
  const out = [];
  if (!Array.isArray(v)) return out;
  v.forEach(id => {
    if (typeof id === 'string' && LOGO_WINDOW_ID_RE.test(id) && out.indexOf(id) < 0 && out.length < LOGO_WINDOWS_MAX) out.push(id);
  });
  return out;
}
/**
 * per_win → 确定形状（按窗口 id 排序、去脏、封顶）；缺字段跟随 base（房间默认几何）。
 * 只读侧归一：手改库塞进来的坏味在这里掉，不阻断下发。
 */
function logoPerMap(v, base) {
  const out = {};
  if (!isPlainObject(v)) return out;
  const ids = Object.keys(v).sort();
  for (let i = 0; i < ids.length && Object.keys(out).length < LOGO_PER_MAX; i++) {
    const id = ids[i];
    if (!LOGO_WINDOW_ID_RE.test(id)) continue;
    const g = v[id];
    if (!isPlainObject(g)) continue;
    out[id] = {
      x: logoOff(g.x, base.x),
      y: logoOff(g.y, base.y),
      w: logoPct(g.w, base.w),
      h: logoPct(g.h, base.h)
    };
  }
  return out;
}
/** config.logo → 确定形状；没有/地址不合法当"没设"（脏值写库前已被 findLogoError 拦下，能到这的只剩手改库） */
function roomLogoField(cfg) {
  const v = cfg && cfg.logo;
  if (!isPlainObject(v)) return null;
  if (typeof v.url !== 'string' || !LOGO_URL_RE.test(v.url)) return null;
  const wins = isPlainObject(v.windows) ? v.windows : {};
  const base = { x: logoOff(v.x, 0), y: logoOff(v.y, 0), w: logoPct(v.w, 50), h: logoPct(v.h, 50) };
  const out = {
    url: v.url,
    thumbnail: (typeof v.thumbnail === 'string' && LOGO_THUMB_RE.test(v.thumbnail)) ? v.thumbnail : '',
    filename: clampStr(v.filename, 255),
    md5: typeof v.md5 === 'string' ? clampStr(v.md5, 64) : '',
    size: Math.max(0, Math.floor(logoNum(v.size, 0))),
    width: Math.max(0, Math.floor(logoNum(v.width, 0))),
    height: Math.max(0, Math.floor(logoNum(v.height, 0))),
    x: base.x,
    y: base.y,
    w: base.w,
    h: base.h,
    windows: { A: logoWinIds(wins.A), B: logoWinIds(wins.B) }
  };
  // 空表不落键：没逐窗设置时形状必须与加 per_win 之前逐字节相同（rev 不漂）
  const per = logoPerMap(v.per_win, base);
  if (Object.keys(per).length > 0) out.per_win = per;
  return out;
}
/** LOGO 写入校验：几何必须是数值且在值域内；窗口名单/逐窗表的脏元素由 roomLogoField 丢弃 */
function findLogoError(cfg) {
  const v = cfg && cfg.logo;
  if (v === undefined || v === null) return null;
  if (!isPlainObject(v)) return 'LOGO 必须是对象，或整个不设';
  if (typeof v.url !== 'string' || !LOGO_URL_RE.test(v.url)) return 'LOGO 文件地址不合法，请在「LOGO设置」里重新上传';
  const bad = (name, val, min, max) => {
    if (val === undefined || val === null || val === '') return null;
    const n = Number(val);
    return (Number.isFinite(n) && n >= min && n <= max) ? null : `LOGO 的${name}必须是 ${min}~${max} 之间的数值`;
  };
  const err = bad('X 位置', v.x, -LOGO_OFF_MAX, LOGO_OFF_MAX)
    || bad('Y 位置', v.y, -LOGO_OFF_MAX, LOGO_OFF_MAX)
    || bad('宽度', v.w, LOGO_PCT_MIN, LOGO_PCT_MAX)
    || bad('高度', v.h, LOGO_PCT_MIN, LOGO_PCT_MAX);
  if (err) return err;
  if (v.per_win === undefined || v.per_win === null) return null;
  if (!isPlainObject(v.per_win)) return 'LOGO 的逐窗几何必须是 { 窗口id: {x,y,w,h} } 的对象';
  const ids = Object.keys(v.per_win);
  if (ids.length > LOGO_PER_MAX) return `LOGO 的逐窗几何最多 ${LOGO_PER_MAX} 扇窗口`;
  for (const id of ids) {
    if (!LOGO_WINDOW_ID_RE.test(id)) return 'LOGO 的逐窗几何里有不合法的窗口 id';
    const g = v.per_win[id];
    if (!isPlainObject(g)) return `LOGO 窗口 ${id} 的逐窗几何必须是对象`;
    const sub = bad(`窗口 ${id} 的 X 位置`, g.x, -LOGO_OFF_MAX, LOGO_OFF_MAX)
      || bad(`窗口 ${id} 的 Y 位置`, g.y, -LOGO_OFF_MAX, LOGO_OFF_MAX)
      || bad(`窗口 ${id} 的宽度`, g.w, LOGO_PCT_MIN, LOGO_PCT_MAX)
      || bad(`窗口 ${id} 的高度`, g.h, LOGO_PCT_MIN, LOGO_PCT_MAX);
    if (sub) return sub;
  }
  return null;
}

/**
 * 设备自报的屏幕像素（心跳 screen_w/screen_h）：内存缓存 → GET /api/devices 的 d.screen，
 * 供编辑器一键"取本机分辨率"。只放内存不落库，
 * 30s 一跳的瞬时状态没必要为它走 DDL，也没必要把心跳变成写放大；
 * 超过三个心跳周期没刷新就当未知（换了一块屏、盒子重插 HDMI，界面上不该还留着上一块的尺寸）。
 */
const DEVICE_SCREEN_TTL = 90000;
const deviceScreenAt = new Map();   // 规范 devices.id -> { size: {w,h}, at }

/**
 * 副屏（1080/eDP）运行时开关状态（心跳 secondary_display）→ GET /api/devices 的 d.secondary_display。
 * 与 screen 同一套口径：只放内存、90s 过期、这一跳没带就是"不知道"，重启后由设备自己重新上报。
 * null 有两种可能，前端都当"暂不支持"：老版本 APK 不上报，或本机没有这条显示链（没有 eDP 口）。
 */
const deviceAuxAt = new Map();   // 规范 devices.id -> { on, at }

function rememberDeviceAux(id, rawOn, isOnline) {
  if (!isOnline || typeof rawOn !== 'boolean') deviceAuxAt.delete(id);
  else deviceAuxAt.set(id, { on: rawOn, at: Date.now() });
}

function deviceAux(id) {
  const hit = deviceAuxAt.get(id);
  if (!hit) return null;
  if (Date.now() - hit.at > DEVICE_SCREEN_TTL) {
    deviceAuxAt.delete(id);
    return null;
  }
  return hit.on;
}

function rememberDeviceScreen(id, rawW, rawH, isOnline) {
  var w = isOnline ? outputPx(rawW) : null;
  var h = isOnline ? outputPx(rawH) : null;
  if (w === null || h === null) deviceScreenAt.delete(id);
  else deviceScreenAt.set(id, { size: { w: w, h: h }, at: Date.now() });
}

function deviceScreen(id) {
  const hit = deviceScreenAt.get(id);
  if (!hit) return null;
  if (Date.now() - hit.at > DEVICE_SCREEN_TTL) {
    deviceScreenAt.delete(id);
    return null;
  }
  return hit.size;
}

/**
 * MQTT topic 里解出的设备 ID 白名单：字母数字/-/_ ，1~64 位（真实 ID 是 64 位十六进制 UUID）。
 * 这个值会进 `UPDATE devices ... WHERE id LIKE ?` 的 LIKE 模式：不带 % 转义时，
 * 一个发布到 xvj/device/%/status 的 "%" 就能改掉全库所有非 blocked 设备的状态。
 * topic 是任何能连上 broker 的客户端都能自由填的，所以入口先卡形状。
 */
function isSafeDeviceId(s) { return typeof s === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(s); }

/**
 * 设备自报字段（model/hardware/mac/version/log_time…）的统一收口：只接受字符串并按列宽截断，
 * 非字符串（数字/对象/null，JSON 里随便就能写）一律当"没报"处理成空串。
 * 为什么是截断而不是照抄：生产 MySQL 带 STRICT_TRANS_TABLES，超长值不是被裁掉而是整条语句报错 ——
 * 心跳里一个 120 字符的 model 就能让新设备永远进不了 devices 表，而那条 INSERT 没有回调，
 * 现场表现就是"设备明明在线，后台列表里查无此机"，日志里一个字都不留。
 * 真实数据都在个位长度（model=23116PN5BC / hardware=qcom / mac=17 位 / 指纹 64 位十六进制），
 * 按列宽给的上限对正常设备恒为无操作。
 */
function clampStr(v, max) {
  if (typeof v !== 'string') return '';
  return v.length > max ? v.substring(0, max) : v;
}

/**
 * 列表条数入参：只收 1..max 的整数，其它（缺省、0、负数、'abc'、超大）一律回落默认值。
 * 以前是 `parseInt(q) || 默认`，`?limit=-1` 会原样进 `LIMIT -1` 让 MySQL 抛语法错误 ——
 * 手滑改一下地址栏就能把日志页打成 500。
 */
function clampLimit(v, dflt, max) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n < 1) return dflt;
  return Math.min(n, max);
}

/**
 * 删单个文件，失败只记日志。
 * 文件末尾的 uncaughtException 处理器现在会 exit(1)（僵尸进程比重启更糟），而这些
 * "清垃圾"的 unlinkSync 恰恰最容易抛 ENOENT/EBUSY（客户端断流后 multer 已自行回收、
 * 杀毒/IO 占用）。在 MySQL 回调里抛出来 = 整站重启，所以删除一律走这里。
 * @returns {boolean} 是否真的删掉了（不存在也算干净）
 */
function safeUnlink(p) {
  try {
    if (p && fs.existsSync(p)) fs.unlinkSync(p);
    return true;
  } catch (e) {
    console.error('🗑 删除文件失败:', p, e.message);
    return false;
  }
}

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
 * 墙板字段带在这里（设备端 set_wallpanel 之外的自愈通道）：开关/串口/学习表没进 rev，
 * 掉了那一跳的命令靠下一次重连或手工同步补回来，口径同 debug；
 * window_names（窗口名浮层）同理 —— 编辑器还开着时设备重连，名字要跟着回来；logo_grid 同款。
 */
function roomSyncFields(cfg) {
  const prefixedScenes = buildPrefixedScenes((cfg && cfg.scenes) || {});
  return Object.assign({
    scenes: prefixedScenes,                                    // folder_mappings / play_settings 键已带幕前缀（A01/B01）
    folder_mappings: mergePrefixedMappings(prefixedScenes),     // A+B 全量，与 HTTP 清单接口同形
    debug: roomDebugFlag(cfg),
    window_names: roomWindowNamesFlag(cfg),                     // 窗口名浮层（编辑器开着时各窗正中常亮名字）
    window_testcard: roomWindowTestcardFlag(cfg),               // 测试背景浮层（编辑器开着时各窗盖测试图卡）
    logo_grid: roomLogoGridFlag(cfg),                           // LOGO 设置辅助网格（LOGO 页开着时整屏垫方格）
    // null = 房间没设输出基准，设备按 1920×1080 设计稿轴向换算（历史口径）
    output: roomOutputField(cfg),
    // null = 没配 LOGO；非空时设备按 url 下载，按 windows/几何叠在素材窗口之上
    logo: roomLogoField(cfg)
  }, roomWallpanelFields(cfg), roomDmxFields(cfg), {
    rev: roomSceneDigest(cfg)
  });
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
 * 【同步时机的唯一收敛点】房间 config 落库后调用：真变了才打扰设备，按变化性质发**最轻的那几条**。
 * - folder_mappings 变了   → sync_room_materials（全量对账，可能要下载，会重建窗口；载荷已含 debug/墙板，不再补轻枪）
 * - 只有窗口/总亮度/播放设置/输出基准变了 → update_windows（APK 原地改视图，不碰素材；结构或播放设置变化时自行回退重建）
 * - debug 变了             → set_debug（轻量，不动素材、不重建，见 APK setDebugMode）
 * - 墙板字段变了           → set_wallpanel（同上轻量，见 APK applyWallPanelEnabled；含开关/节点/波特率/学习表）
 * - DMX 字段变了           → set_dmx（同上轻量，见 APK applyDmxEnabled；含开关/节点/波特率）
 * - 窗口名浮层变了         → set_window_names（同上轻量，见 APK setWindowNames；编辑器开着时置 true）
 * - 测试背景浮层变了       → set_window_testcard（同上轻量，见 APK setWindowTestcard；与窗口名同开同关）
 * - LOGO 辅助网格变了      → set_logo_grid（同上轻量，见 APK setLogoGrid；LOGO 页开着时整屏垫方格）
 * - 后六类与前两类是并列判定：同一次 PUT 既改窗口又开总闸，就 update_windows + set_wallpanel 两条都发
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
  // 并列收集，不是 else-if 链：一次 PUT 经常同时改好几类（墙板表保存就是「学习表 + 总闸」一把写），
  // 链式判定只发最重的那条，轻量的 set_wallpanel / set_debug 会被静默吞掉 —— 而这两项都故意不进 rev，
  // 心跳对账只比 roomSceneDigest，永远补不回来，设备得等下次重连才自愈。
  const commands = [];
  // 全量同步的载荷由 roomSyncFields 一处收口，debug / 窗口名 / 墙板 / DMX 字段都在里面，命中它就不必再补轻量枪
  let heavyCarriesFlags = false;
  if (roomMappingDigest(oldCfg) !== roomMappingDigest(newCfg)) {
    commands.push(['素材映射', syncCommandPayload(roomId, newCfg)]);
    heavyCarriesFlags = true;
  } else if (roomSceneDigest(oldCfg) !== roomSceneDigest(newCfg)) {
    commands.push(['窗口', windowCommandPayload(roomId, newCfg)]);
  }
  if (!heavyCarriesFlags && roomDebugFlag(oldCfg) !== roomDebugFlag(newCfg)) {
    commands.push(['调试模式', { action: 'set_debug', debug: roomDebugFlag(newCfg), timestamp: Date.now() }]);
  }
  if (!heavyCarriesFlags && roomWallpanelDigest(oldCfg) !== roomWallpanelDigest(newCfg)) {
    commands.push(['墙板', Object.assign({ action: 'set_wallpanel' }, roomWallpanelFields(newCfg), { timestamp: Date.now() })]);
  }
  if (!heavyCarriesFlags && roomDmxDigest(oldCfg) !== roomDmxDigest(newCfg)) {
    commands.push(['DMX', Object.assign({ action: 'set_dmx' }, roomDmxFields(newCfg), { timestamp: Date.now() })]);
  }
  if (!heavyCarriesFlags && roomWindowNamesFlag(oldCfg) !== roomWindowNamesFlag(newCfg)) {
    commands.push(['窗口名', { action: 'set_window_names', window_names: roomWindowNamesFlag(newCfg), timestamp: Date.now() }]);
  }
  if (!heavyCarriesFlags && roomWindowTestcardFlag(oldCfg) !== roomWindowTestcardFlag(newCfg)) {
    commands.push(['测试背景', { action: 'set_window_testcard', window_testcard: roomWindowTestcardFlag(newCfg), timestamp: Date.now() }]);
  }
  if (!heavyCarriesFlags && roomLogoGridFlag(oldCfg) !== roomLogoGridFlag(newCfg)) {
    commands.push(['LOGO网格', { action: 'set_logo_grid', logo_grid: roomLogoGridFlag(newCfg), timestamp: Date.now() }]);
  }
  if (commands.length === 0) { if (cb) cb(0); return; }

  db.query(
    'SELECT id, fingerprint FROM devices WHERE room_id = ? AND authorized = 1',
    [roomId],
    (err, devices) => {
      if (err || !devices || devices.length === 0) {
        // 配置确实变了但没人可发：房间没绑设备/设备未授权时现场点墙板是没反应的，这行是唯一线索
        if (devices && devices.length === 0) console.log(`🔔 [${reason}] 房间 ${roomId} ${commands.map(c => c[0]).join('+')}变更，但无已授权设备`);
        if (cb) cb(0); return;
      }
      devices.forEach(d => commands.forEach(cmd => publishToDeviceCommand(d, cmd[1])));
      console.log(`🔔 [${reason}] 房间 ${roomId} ${commands.map(c => c[0]).join('+')}变更 → 已通知 ${devices.length} 台设备 (${commands.map(c => c[1].action).join(',')})`);
      if (cb) cb(devices.length);
    }
  );
}

/**
 * 【S-14】会话鉴权：口令 → 短时效签名 cookie（无状态，不落库）。
 * ─────────────────────────────────────────────────────────────
 * cookie 值 = `base64url(过期毫秒.口令摘要).HMAC-SHA256(前一段, key 由 API_KEY+口令 派生)`：
 *   - 没有 session 表 ⇒ 服务重启不会把所有人踢下线，也没有内存增长；
 *   - 摘要进载荷 ⇒ 换 ADMIN_PASSWORD 的同一瞬间，线上所有会话一起作废（不用逐个登出）；
 *   - 签名密钥也含 API_KEY ⇒ 换 key 同样整体失效。
 * 口令与 key 都只从 env 来（config.js 读 /etc/xvj/web.env），仓库与公开页面里都不再有明文。
 */
const SESSION_COOKIE = 'xvj_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;   // 一个班次内免登，隔天重来
const LOGIN_MAX_FAILS = 8;                     // 同一来源连错 8 次锁 5 分钟：只当刹车，防不住定向猜测，真正靠口令本身
const LOGIN_LOCK_MS = 5 * 60 * 1000;
const loginFails = new Map();                  // 来源 -> { n, at }

/** 等长摘要比较：直接比原始口令的 buffer 会因为长度不同早停，先各自 sha256 再 timingSafeEqual */
function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function sha256(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }

/** 会话签名密钥：换口令或换 API_KEY 都会让旧 cookie 验不过 */
function _sessionKey() {
  return crypto.createHash('sha256').update('xvj-session|' + (config.apiKey || '') + '|' + (config.adminPassword || '')).digest();
}
function _sessionBody() { return Buffer.from(Date.now() + SESSION_TTL_MS + '.' + sha256(config.adminPassword).slice(0, 16)).toString('base64url'); }
function sessionToken() {
  const body = _sessionBody();
  return body + '.' + crypto.createHmac('sha256', _sessionKey()).update(body).digest('base64url');
}
function readCookie(req, name) {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of String(raw).split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}
/** cookie 解码成 {exp, pwHash}，验签/过期/换口令任一不过都回 null */
function sessionPayload(req) {
  if (!config.adminPassword) return null;   // 没配口令 = 这道门根本没装，cookie 一律不认（fail closed）
  const tok = readCookie(req, SESSION_COOKIE);
  if (!tok || tok.indexOf('.') <= 0) return null;
  const dot = tok.indexOf('.'), body = tok.slice(0, dot);
  const want = crypto.createHmac('sha256', _sessionKey()).update(body).digest('base64url');
  if (!safeEqual(tok.slice(dot + 1), want)) return null;
  let txt;
  try { txt = Buffer.from(body, 'base64url').toString(); } catch (e) { return null; }
  const parts = txt.split('.');
  const exp = Number(parts[0]);
  if (!Number.isFinite(exp) || exp <= Date.now()) return null;
  if (parts[1] !== sha256(config.adminPassword).slice(0, 16)) return null;
  return { exp };
}
function sessionValid(req) { return sessionPayload(req) !== null; }
function sessionExpireAt(req) {
  const p = sessionPayload(req);
  return p ? new Date(p.exp).toISOString() : null;
}
function sessionCookie(tok, maxAgeSec) {
  // 生产仍是 http://IP，没有 TLS 就不能声明 Secure（带了浏览器直接丢 cookie = 全站登不上）。
  // 上域名 + HTTPS 之后在这里补 Secure。SameSite=Lax：书签/外链直接打开仍带 cookie，跨站 POST 不带。
  return SESSION_COOKIE + '=' + tok + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + maxAgeSec;
}
/** 来源只用于登录失败节流：反代后 req.ip 恒为 127.0.0.1，所以取 XFF 第一段（可伪造，但节流只是刹车不是墙） */
function loginSource(req) {
  const xff = req.headers['x-forwarded-for'];
  const first = Array.isArray(xff) ? xff[0] : xff;
  return String(first || '').split(',')[0].trim() || (req.socket && req.socket.remoteAddress) || 'unknown';
}
function loginHandler(req, res) {
  if (!config.adminPassword) {
    return res.status(503).json({ error: '服务端未配置管理口令：在 /etc/xvj/web.env 写 ADMIN_PASSWORD 后 systemctl restart xvj' });
  }
  const src = loginSource(req), now = Date.now(), rec = loginFails.get(src);
  if (rec && now - rec.at > LOGIN_LOCK_MS) loginFails.delete(src);
  else if (rec && rec.n >= LOGIN_MAX_FAILS) {
    return res.status(429).json({ error: '口令连续错误过多，' + Math.ceil((LOGIN_LOCK_MS - (now - rec.at)) / 1000) + ' 秒后再试' });
  }
  const pw = req.body ? req.body.password : undefined;
  if (typeof pw !== 'string' || pw.length === 0 || pw.length > 256) return res.status(400).json({ error: '请输入管理口令' });
  if (!safeEqual(sha256(pw), sha256(config.adminPassword))) {
    const n = (rec && now - rec.at <= LOGIN_LOCK_MS ? rec.n : 0) + 1;
    if (loginFails.size > 1000) loginFails.clear();   // 节流表不需要精确历史，长了就重开
    loginFails.set(src, { n, at: now });
    console.warn('🔐 登录失败 第' + n + '次 来自 ' + src);
    return res.status(401).json({ error: '口令不对' });
  }
  loginFails.delete(src);
  res.setHeader('Set-Cookie', sessionCookie(sessionToken(), SESSION_TTL_MS / 1000));
  console.log('🔐 管理台登录成功（来源 ' + src + '）');
  logAction('login', 'session', { source: src });
  res.json({ success: true, expires_at: new Date(Date.now() + SESSION_TTL_MS).toISOString() });
}

const app = express();
const PORT = config.port;

/**
 * 写接口鉴权：浏览器带【会话 cookie】（口令在 /api/session 换），脚本与机器客户端带 x-api-key。
 * 2026-11-12 之前只认 x-api-key，而那把 key 就写在公开页面的 index.html 里（P3-10），等于写接口无鉴权；
 * 现在 key 只存在于服务端 env（API_KEY），浏览器改走短时效、可因改口令而整体失效的签名 cookie。
 * @param {object} req - Express 请求对象
 * @param {object} res - Express 响应对象
 * @param {function} next - 下一个中间件
 */
function requireAuth(req, res, next) {
  const apiKey = req.headers['x-api-key'] || req.query.apiKey;
  if (apiKey && config.apiKey && safeEqual(String(apiKey), String(config.apiKey))) return next();
  if (sessionValid(req)) return next();
  // LOGIN_REQUIRED 是给前端看的：fetch 补丁据此弹口令框（没有它就只能把 401 原样抛给用户）
  res.status(401).json({ error: '未授权', code: 'LOGIN_REQUIRED', message: '需要登录或有效的 API 密钥' });
}

// Middleware
app.use(cors());
app.use(express.json());

// 【S-14】会话路由必须在写接口闸门之前注册：登录本身不是"已鉴权的写操作"，
// 放在闸门之后会变成"要登录才能拿到登录接口"。
app.post('/api/session', loginHandler);
app.get('/api/session', (req, res) => res.json({ authed: sessionValid(req), expires_at: sessionExpireAt(req) }));
app.delete('/api/session', (req, res) => {
  res.setHeader('Set-Cookie', sessionCookie('', 0));
  res.json({ success: true });
});

// ========== 【S-15】设备实时截图 ==========
// 链路：管理台点「实时截图」→ 服务端发一条**带一次性上传令牌**的 MQTT 命令 → 设备截屏并把 JPEG
// POST 回来 → 管理台轮询到 ts 变了就把图显示出来。
// 为什么要令牌：设备上只有 MQTT 凭据，没有管理台 API key，而这条口是写接口。令牌只出现在发给
// 那一台设备的私有 command 主题里，用过即废、60 秒过期 —— 别人既猜不到也没法重放。
// 图只在内存里活两分钟，不落盘：这是"看一眼现场"，不是监控录像，存下来既没用处又把屏上内容
// 留在了服务器磁盘上。要再看就再点一次。
const SHOT_MAX_BYTES = 2 * 1024 * 1024;      // 设备侧压到 ≤1280 宽 q55，正常几十~一百多 KB；留足余量防编码退化
const SHOT_TOKEN_TTL_MS = 60 * 1000;
const SHOT_KEEP_MS = 120 * 1000;              // 阅后即焚的"即焚"时长：够管理台看图并重看一次
const SHOT_MIN_BYTES = 512;                   // 比这还小不可能是张图，直接当垃圾丢掉
const SHOT_ID_RE = /^[0-9a-fA-F]{8,128}$/;   // 设备 id 是十六进制指纹且当 Map 的键用，先挡住乱七八糟的入参
const shotTokens = new Map();                // 规范 devices.id → { token, exp }
const shotStore = new Map();                 // 规范 devices.id → { buf, ts, exp }（图本体就在这，重启即清）

/** 过期就删：签发/收图/读图时各顺手扫一遍，不另起定时器 */
function pruneShots(now) {
  shotTokens.forEach(function (v, k) { if (v.exp < now) shotTokens.delete(k); });
  shotStore.forEach(function (v, k) { if (v.exp < now) shotStore.delete(k); });
}

/**
 * 发 screenshot 命令时配一张一次性上传令牌，顺带清掉过期与从未用过的旧令牌
 * （管理台点了但设备没回图的情况很常见，不清会无界攒着）。
 */
function issueShotToken(deviceId) {
  const now = Date.now();
  pruneShots(now);
  const token = crypto.randomBytes(12).toString('hex');
  shotTokens.set(deviceId, { token: token, exp: now + SHOT_TOKEN_TTL_MS });
  return token;
}

// 设备回传口：必须注册在下面那道写接口闸门之前（设备没有 API key，靠令牌认），
// 也和【S-14】的会话路由同一个道理 —— 闸门在先会把这条口变成"要登录才能给登录喂数据"。
const shotUploadBody = express.raw({ type: function () { return true; }, limit: SHOT_MAX_BYTES });
app.post('/api/device/:id/screenshot', shotUploadBody, (req, res) => {
  const id = String(req.params.id || '');
  const rec = shotTokens.get(id);
  if (!SHOT_ID_RE.test(id) || !rec || rec.exp < Date.now()) {
    return res.status(403).json({ error: '截图令牌不存在或已过期（请从管理台重新点一次）' });
  }
  // 常量时间比：这条口是公开的，别把令牌比对的耗时差异暴露出去
  if (!safeEqual(String(req.headers['x-shot-token'] || ''), rec.token)) {
    return res.status(403).json({ error: '截图令牌不匹配' });
  }
  const buf = Buffer.isBuffer(req.body) ? req.body : null;
  if (!buf || buf.length < SHOT_MIN_BYTES) {
    return res.status(400).json({ error: '截图数据太小，不像一张图' });
  }
  // JPEG 魔数：FFD8FF 开头。设备截图失败时可能把错误文本当 body 发来，不能当图收下
  if (!(buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF)) {
    return res.status(400).json({ error: '截图数据不是 JPEG' });
  }
  // 令牌到这里才算用掉：前面任何一步失败都留在窗口内，设备可以重试同一张令牌
  shotTokens.delete(id);
  const ts = Date.now();
  pruneShots(ts);
  shotStore.set(id, { buf: buf, ts: ts, exp: ts + SHOT_KEEP_MS });
  logAction('screenshot', 'device', { device_id: id, bytes: buf.length });
  res.json({ success: true, bytes: buf.length, ts: ts });
});

// 写操作统一要求凭据（会话 cookie 或 x-api-key）；GET/OPTIONS/HEAD 全开放。
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

// 连接级错误必须有人听：EventEmitter 上 'error' 无监听者时会把异常抛给 uncaughtException，
// 而那个处理器现在的行为是记一条就 exit(1) —— broker 抖一下就能让整个后台反复重启。
// 有了这个监听，掉线/鉴权被拒至少会以一行明确的原因留在 journal 里。
mqttClient.on('error', (err) => console.error('❌ MQTT 客户端错误:', err.message));

/**
 * 统一发布出口：每次 publish 都带错误回调。
 * mqtt.js 在客户端处于 connecting/offline（重连窗口）时不 throw，只把错误交给回调；
 * 没有回调就是静默丢弃 —— 命令没送到设备，HTTP 侧照样回 success:true，界面上"已推送"。
 */
function pubMqtt(topic, payload, opts) {
  mqttClient.publish(topic, payload, opts || {}, (err) => {
    if (err) console.error('❌ MQTT 发布失败:', topic, err.message);
  });
}

mqttClient.on('connect', () => {
  console.log('✅ MQTT 连接成功');
  // subscribe 同样要回调：broker 侧 ACL 收紧后订阅会静默失败，那样所有设备心跳都收不到，
  // 而日志里只有"MQTT 连接成功"这一句，排查时会以为链路是通的。
  ['xvj/device/#', 'xvj/auth/response'].forEach(function(t) {
    mqttClient.subscribe(t, (err) => {
      if (err) console.error('❌ MQTT 订阅失败:', t, err.message);
    });
  });
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
        // 回退到 fingerprint：装机漂移后设备自报的是指纹，只按 id 匹配会静默改成"没人掉线"
        db.query('UPDATE devices SET authorized=0, status="deauthorized" WHERE (id=? OR fingerprint=?) AND status<>"blocked"', [data.device_id, data.device_id]);
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
        // 自报指纹必须过和 topic 同一道形状闸（64 位十六进制），否则它会把任意串带进
        // "WHERE id = ? OR fingerprint = ?" 的匹配；不合格就退回 deviceId，别拿脏值当身份
        const fingerprint = (isSafeDeviceId(data.fingerprint) && data.fingerprint) || deviceId;
        const searchId = deviceId.substring(0, 32);
        // 心跳原文整条进 status_data：设备哪天多报几段堆栈就会超 TEXT 的 64KB，
        // STRICT_TRANS_TABLES 下是整条 UPDATE 失败（带回调，日志有痕迹，但后果是
        // 这台设备的 status/online_time 永远刷不动 —— 后台看起来一直离线）。
        // 状态文本是给人看的，截一份足够，不值得让它拖垮在线判定。
        const statusData = clampStr(message, 4000);
        db.query(
          "UPDATE devices SET status = ?, status_data = ?, online_time = NOW() WHERE (id = ? OR fingerprint = ? OR id LIKE ? OR id LIKE ?) AND status <> 'blocked'",
          [isOnline ? 'online' : 'offline', statusData, deviceId, fingerprint, deviceId + '%', searchId + '%'],
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
                [deviceId, '未命名设备', fingerprint, clampStr(data.model, 100), clampStr(data.hardware, 100), clampStr(data.mac, 50)],
                (nerr) => { if (nerr) console.error('❌ 心跳建新设备失败:', deviceId, nerr.message); }
              );
            } else if (result && result.affectedRows > 0) {
              console.log('✅ 设备状态已更新: ' + deviceId);
            }
            // 设备版本上报：status 消息携带 version/version_code 时同步 device_versions
            if (data.version || data.version_code) {
              const vCode = parseInt(data.version_code, 10) || 0;
              const vName = clampStr(data.version, 50);   // device_versions.version 是 VARCHAR(50)
              reportDeviceVersion(deviceId, vName, vCode);
            }
            // 配置对账：心跳带回 rev 且不在下载中时，比一比房间真值，落后了就补发同步
            if (isOnline && data.rev && data.syncing !== true) {
              reconcileDeviceRev(deviceId, data.rev);
            }
            // 墙板与屏幕的瞬时状态：归到规范 id 再记账（【S-06i】）。这一跳没带的字段就是"清掉显示"，
            // 不是"保持原样"—— 设备把墙板关了、或本机换了块屏，界面不能再留着旧值。
            resolveDeviceId(deviceId, function (canonId) {
              // 本机屏幕像素：编辑器"输出基准"那一栏拿它一键填（#177）。瞬时状态，
              // 这一跳没带就是"不知道"，界面上不该留着上一块屏的尺寸。
              rememberDeviceScreen(canonId, data.screen_w, data.screen_h, isOnline);
              // 副屏（1080/eDP）此刻通着没有：设备卡上的「副屏」开关按它渲染，开关动作后设备会补一跳。
              // 不带这个字段 = 老 APK 或没有 eDP 链，界面上显示"不支持"，不要沿用上一台的值。
              rememberDeviceAux(canonId, data.secondary_display, isOnline);
              // 近期收到的帧（【S-06f】）：心跳顺带带一份，学习窗之外的时间也能看见总线上在跑什么。
              // 同样遵循"这一跳没带 = 不知道"，不让设备熄了或换了场景后界面上还挂着旧帧。
              rememberDeviceFrames(canonId, data.frames, isOnline);
            });
          }
        );
        break;
      }
      case 'request':
        console.log('🔐 设备请求授权状态: ' + deviceId);
        // 与心跳同一道回退：装机漂移后自报的是指纹，只按 id 查会答成"设备未注册"
        db.query('SELECT authorized, room_id FROM devices WHERE id = ? OR fingerprint = ?', [deviceId, deviceId], (err, rows) => {
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
        // device_logs.log_time 是 VARCHAR(32)：超长（设备时钟/格式异常，或有人刷 topic）时
        // STRICT 模式下整条 INSERT 会失败，日志一条都落不了库，所以按列宽截
        const logTime = clampStr(spaceIdx > 0 ? payload.substring(0, spaceIdx) : payload, 32);
        // APK payload 格式: "time LEVEL module action msg..."，time 已剥离，首段为级别
        let logMsg = spaceIdx > 0 ? payload.substring(spaceIdx + 1) : payload;
        let level = 'info';
        const lvSeg = logMsg.split(' ')[0];
        if (['ERROR', 'WARN', 'INFO', 'DEBUG'].includes(lvSeg)) {
          level = lvSeg.toLowerCase();
        }
        // 单条上限 4000 字符：正常运维日志几十~几百字符，够排障用；
        // 少了这道闸，一条 topic 就能往 device_logs 塞 64KB 的 TEXT 行，把保留 2000 条的清理撑爆
        if (logMsg.length > 4000) logMsg = logMsg.substring(0, 4000) + '…(截断)';
        console.log('📝 写日志: deviceId=' + deviceId + ' time=' + logTime + ' level=' + level + ' msg=' + logMsg.substring(0, 60));
        // 归属按规范 devices.id 落：日志页的下拉框给的是 devices.id，装机漂移后设备自报的是指纹，
        // 不解析的话这台机器的日志在界面上永远查不到（见 resolveDeviceId）
        resolveDeviceId(deviceId, (id) => {
          db.query(
            'INSERT INTO device_logs (device_id, log_time, level, message) VALUES (?, ?, ?, ?)',
            [id, logTime, level, logMsg],
            (err) => {
              if (err) return console.error('写device_logs失败:', err.message);
              // 防膨胀：约2%概率触发，按设备分区各保留最新 2000 条（全局上限会被多台设备分摊掉排障窗口）
              if (Math.random() < 0.02) {
                db.query('DELETE FROM device_logs WHERE id IN (SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY device_id ORDER BY id DESC) rn FROM device_logs) t WHERE rn > 2000)');
              }
            }
          );
        });
        break;
      }
      case 'frames': {
        if (!data) break;
        // 学习窗内的帧快照（【S-06f】）：设备按下"开始学习"后每收到新帧就发一份候选列表。
        // 只记账不落库 —— 这是给操作员当场看的实时状态，绑定表要等他选了哪一条才写。
        resolveDeviceId(deviceId, function (canonId) {
          rememberDeviceFrames(canonId, data.frames, true);
        });
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
  // 与 status 分支同闸：自报指纹形状不合格就当没报，退回 deviceId（见 isSafeDeviceId）
  const fingerprint = (isSafeDeviceId(data.fingerprint) && data.fingerprint) || deviceId;
  
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
          [deviceId, clampStr(data.device_id, 64) || deviceId, fingerprint, clampStr(data.model, 100), clampStr(data.hardware, 100), clampStr(data.mac, 50)],
          // 这条以前没有回调：注册入库一旦失败（旧库列宽不匹配、设备刷超长字段），
          // 现象只是"后台查无此机"，journal 里一个字都不留。至少把错误留在日志里。
          (rerr) => { if (rerr) console.error('❌ 新设备注册入库失败:', deviceId, rerr.message); }
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
            [fingerprint, clampStr(data.model, 100), clampStr(data.hardware, 100), clampStr(data.mac, 50), deviceId],
            (uerr) => { if (uerr) console.error('❌ 设备信息更新失败:', deviceId, uerr.message); }
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

          pubMqtt(topic, JSON.stringify(payload), { qos: 1 });
          console.log(`📤 已推送授权+播放配置到设备 ${deviceId}, 房间: ${roomId}, rev=${payload.rev}`);

        } catch (e) {
          console.error('解析room config失败:', e);
          // 即使解析失败也发送授权响应。载荷刻意不带 scenes/rev：与"查不到房间"那两条退路同口径
          //（见下面的 else 分支），让设备保持上一轮画面，而不是拿一份空 scenes 骨架去拆掉在播的窗口；
          // 不带 rev 就不会 markAppliedRev，配置修好后心跳对账会自己补发一轮。
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
          pubMqtt(topic, payload);
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
        pubMqtt(topic, payload);
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
    pubMqtt(topic, payload);   // 未授权分支同样要带错误回调：这台设备在等审批，通知丢了界面却显示"已发送"
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
    pubMqtt('xvj/device/' + t + '/command', buf, { qos: 1 });
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

/**
 * 【S-06g】设备自报 ID → 规范 devices.id（写入归属解析，全库共用见 resolveDeviceId）。
 * @param {string} vName - 版本名（已 clampStr 到 50）
 * @param {number} vCode - 版本号
 */
function reportDeviceVersion(deviceId, vName, vCode) {
  resolveDeviceId(deviceId, (id) => {
    db.query(
      'INSERT INTO device_versions (device_id, version, version_code) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE version = ?, version_code = ?',
      [id, vName, vCode, vName, vCode],
      (verr) => { if (verr) console.error('同步设备版本失败:', id, verr.message); }
    );
  });
}

/**
 * 【S-06h】把设备自报的 ID 解析成库里的规范 devices.id。
 * 背景：装 APK（OTA 或手动）会清掉应用数据 → prefs.device_id 丢失 → 首启拿指纹当身份
 * （MainActivity 的 `deviceId = prefs.device_id ?: deviceFingerprint`；168 装机实测漂移），
 * 此后自报值与 devices.id 分叉。devices 表自己的读写靠 `id = ? OR fingerprint = ?` 回退，
 * 认得住；出问题的是"按自报 id 存、按 devices.id 读"的旁表 ——
 *   device_versions：键对不上 → 版本页永远显示旧版 → 运营以为没装上再推一次 OTA（现场大屏白重启）；
 *   device_logs：键对不上 → 日志页选这台筛不出任何一行（远程排障瞎掉），删设备时孤儿行也清不掉。
 * WHERE 与心跳的 UPDATE 同形状（含 32 位截断搜索），UPDATE 认得到的这里必然也认得到；
 * 精确命中优先于 LIKE 命中，避免多行时挑到别人的设备。
 * 映射由服务端建行决定、基本不变，故缓存 10 分钟（删档重建最多错 10 分钟，且只影响日志归属），
 * 删设备时按 id 清一次缓存（见 DELETE /api/devices/:id）。
 * @param {string} reportedId - MQTT topic / payload 里解出的自报 ID（已过 isSafeDeviceId 闸）
 * @param {(id: string) => void} cb - 拿到规范 id；解析失败或查不到（全新设备，行还在异步 INSERT 中）
 *                                    时回落到自报值 —— 那条路 devices.id 本来就等于它，不会更错
 */
const DEVICE_ID_CACHE_TTL = 600000;
const deviceIdCache = new Map();   // 自报 id -> { id, at }

function resolveDeviceId(reportedId, cb) {
  const hit = deviceIdCache.get(reportedId);
  const now = Date.now();
  if (hit && now - hit.at < DEVICE_ID_CACHE_TTL) return cb(hit.id);
  const searchId = reportedId.substring(0, 32);
  db.query(
    `SELECT id FROM devices
     WHERE id = ? OR fingerprint = ? OR id LIKE ? OR id LIKE ?
     ORDER BY (id = ?) DESC LIMIT 1`,
    [reportedId, reportedId, reportedId + '%', searchId + '%', reportedId],
    (err, rows) => {
      const id = (!err && rows && rows.length > 0 && rows[0].id) || reportedId;
      // 只写不删的 Map 会随设备数无界增长，超阈值时顺带清过期项（同一手法见 revReconcileAt）
      if (deviceIdCache.size > 500) {
        deviceIdCache.forEach((v, k) => { if (now - v.at > DEVICE_ID_CACHE_TTL) deviceIdCache.delete(k); });
      }
      deviceIdCache.set(reportedId, { id, at: now });
      cb(id);
    }
  );
}

// 【S-06f】 设备最近收到的 485 帧（心跳的 frames 段 + 学习期的 xvj/device/{id}/frames 快照）
// → 内存缓存 → GET /api/devices 的 d.frames。
// 为什么只放内存：这是总线流量的瞬时快照，落库等于让点歌机每次状态广播都写一行 —— 那台机
// 本来就在同一根 485 上连发，几小时就能把库刷爆。它只服务"看一眼分帧对不对"和学习时的候选帧。
// TTL 取 120s：学习窗里操作员低头按键的这几秒，候选列表不能半路消失。
// 每一项都重新过形状闸：topic 和 payload 都是任何能连上 broker 的客户端能填的，hex/计数不照抄。
const DEVICE_FRAMES_TTL = 120000;
const DEVICE_FRAMES_MAX = 8;
const deviceFramesAt = new Map();   // 规范 devices.id -> { frames: [{hex,n,age}], at }

/** 设备报来的帧数组 → 合法形状（脏项丢掉、按次数多寡排序、截到上限）；不是数组或全脏 = null */
function normalizeDeviceFrames(raw) {
  if (!Array.isArray(raw)) return null;
  var kept = [];
  raw.forEach(function (f) {
    if (!isPlainObject(f)) return;
    var hex = (typeof f.hex === 'string' ? f.hex.trim().toUpperCase() : '');
    if (!WALLPANEL_FRAME_HEX_RE.test(hex)) return;
    var n = Number(f.n);
    var age = Number(f.age);
    kept.push({
      hex: hex,
      n: Number.isInteger(n) && n > 0 ? Math.min(n, 999999) : 1,
      age: Number.isFinite(age) && age >= 0 ? Math.min(Math.round(age), DEVICE_FRAMES_TTL) : 0
    });
  });
  if (!kept.length) return null;
  // 按"出现次数"降序：学习时操作员按的那一键通常也是这一段里最多的一种，先看见它
  kept.sort(function (a, b) { return b.n - a.n || (a.hex < b.hex ? -1 : 1); });
  return kept.slice(0, DEVICE_FRAMES_MAX);
}

function rememberDeviceFrames(id, raw, isOnline) {
  const frames = isOnline ? normalizeDeviceFrames(raw) : null;
  if (!frames) deviceFramesAt.delete(id);
  else deviceFramesAt.set(id, { frames: frames, at: Date.now() });
}

function deviceFrames(id) {
  const hit = deviceFramesAt.get(id);
  if (!hit) return null;
  if (Date.now() - hit.at > DEVICE_FRAMES_TTL) {
    deviceFramesAt.delete(id);
    return null;
  }
  return hit.frames;
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
    (results || []).forEach(function (d) {
      d.screen = deviceScreen(d.id);
      d.frames = deviceFrames(d.id);   // 最近收到的 485 帧（【S-06f】），没收到过 = null
      d.secondary_display = deviceAux(d.id);   // 副屏（eDP）开/关/未知(null)，见 deviceAux
    });
    res.json(results);
  });
});

// 【S-05c】 手工添加设备接口已移除：绕过审核直接 authorized=1 与注册审批流程矛盾，且前端无入口

// 授权失效广播（删记录 / 屏蔽 / 废止 三处共用）。
// ⚠️ 仍是全设备可见的广播（P1-4 延后项：改定向得先让 APK 双订阅新旧两个主题），
//    设备端按 payload 里的 device_id 自己比对认领，不匹配就忽略。
function publishAuthRevoked(deviceId, reason) {
  pubMqtt('xvj/auth/response',
    JSON.stringify({ action: 'deauthorize', device_id: deviceId, message: reason }), { qos: 1 });
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
    // 清身份映射缓存：行都删了还留着"自报 id → 已删 id"，会把后续日志挂到不存在的设备上
    deviceIdCache.forEach((v, k) => { if (v.id === did) deviceIdCache.delete(k); });
    deviceScreenAt.delete(did);    // 自报屏幕像素同理（#177）
    deviceFramesAt.delete(did);    // 近期帧台账同理（【S-06f】）——删了设备，它那条总线记录不该还浮在列表上
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
// action 必须落在 DEVICE_ACTIONS 白名单里（= APK handleCommand 的 when 分支 + 服务端会补载荷的
// 'sync' / 'sync_room_materials' / 'screenshot'）；
// 未知 action 一律 400，不透传 —— command 主题上的指令设备是照单执行的，不能靠前端自觉。
// 老 APK(167) 里那条 preset_sync 分支只是留着没人调用，服务端先收掉入口即可，不需要设备升级。
const DEVICE_ACTIONS = ['sync', 'stop', 'config', 'sync_room_materials',
                        'update_windows', 'delete_material', 'update', 'set_debug', 'set_wallpanel', 'set_dmx',
                        // 窗口名浮层：编辑器开着 = true（各窗正中常亮名字），关掉 = false。载荷只有布尔 window_names
                        'set_window_names',
                        // 测试背景浮层：编辑器开着 = true（各窗盖测试图卡），关掉 = false。载荷只有布尔 window_testcard
                        'set_window_testcard',
                        // LOGO 设置辅助网格：LOGO 页开着 = true（整屏垫等像素方格），关掉 = false。载荷只有布尔 logo_grid
                        'set_logo_grid',
                        'preview_material', 'preview_stop', 'wallpanel_learn',
                        // 退出到桌面/唤回：释放画面并把原厂桌面顶到身前，进程与 MQTT 不动，
                        // 设备侧只吃 action（APK【A-15】）；唤回靠设备上的 root am start，服务端不补载荷
                        'exit_desktop', 'reopen_desktop',
                        // 远程重启整台设备（设备卡「重启设备」）：设备侧 root reboot，服务端不补载荷。
                        // 这条会让设备下线几十秒，前端弹确认后才发（见 index.html rebootDevice）
                        'reboot',
                        // 实时截图：服务端补一次性上传令牌 + 回传地址（见【S-15】），设备截完把 JPEG 发回来
                        'screenshot',
                        // 副屏（1080/eDP）运行时开关：载荷只有布尔 on，设备侧 root 写 DRM 状态（APK【A-18】），
                        // 实际状态随心跳 secondary_display 回传。开机默认关由设备上的 vendor init rc 保证
                        'secondary_display'];
app.post('/api/devices/:id/command', (req, res) => {
  const { command } = req.body;
  const deviceId = req.params.id;

  if (!command || typeof command !== 'object' || typeof command.action !== 'string') {
    return res.status(400).json({ error: 'command 必须是带字符串 action 的对象' });
  }
  if (DEVICE_ACTIONS.indexOf(command.action) === -1) {
    return res.status(400).json({ error: '不支持的 action: ' + command.action });
  }
  // 这几条的载荷必须由服务端按房间当前配置生成：裸发 update_windows 会让 APK 收到一份没有 scenes
  // 的窗口更新；裸发 delete_material 会照调用方随口给的 folder 前缀去删设备磁盘目录；
  // 裸发 preview_* 则等于让任何人指定"占掉现场哪扇窗、播哪个文件"。
  // 正确入口是 PUT /api/rooms/:id/windows 与 DELETE /api/rooms/:roomId/materials/:materialId，
  // 它们落库后自己会走通知漏斗（notifyRoomConfigChanged），不需要从这里补一发。
  // 【S-05p】试播同理：目标窗口和物理目录都要按房间当前配置算，裸发等于让调用方指定"占哪扇窗"
  if (command.action === 'update_windows' || command.action === 'delete_material'
      || command.action === 'preview_material' || command.action === 'preview_stop') {
    return res.status(400).json({
      error: command.action + ' 的载荷需由服务端按房间配置生成，请走对应的房间接口'
        + '（窗口：PUT /api/rooms/:id/windows；删素材：DELETE /api/rooms/:roomId/materials/:materialId；'
        + '试播：POST /api/rooms/:roomId/preview）'
    });
  }

  // 转换相对URL为完整URL（与版本推送共用 APK_DOWNLOAD_BASE，换域名/上 HTTPS 只改一处）
  let cmd = { ...command };
  if (cmd.url && cmd.url.startsWith('/')) {
    cmd.url = APK_DOWNLOAD_BASE + cmd.url;
  }
  // 副屏开关只认显式布尔：缺字段/字符串一律 400，免得设备把 "false" 当开启
  if (cmd.action === 'secondary_display' && typeof cmd.on !== 'boolean') {
    return res.status(400).json({ error: 'secondary_display 需要布尔字段 on' });
  }

  // sync / sync_room_materials 走同一条补全路径：两条发到设备上的都是 syncCommandPayload 组装的
  // 全套载荷（room_id + 带幕前缀的映射 + scenes + debug + rev）。允许调用方只给 action —— 它没有
  // 这些信息，而"裸发一条素材清单同步"正是最容易把设备本地素材判空的用法。
  if (cmd.action === 'sync' || cmd.action === 'sync_room_materials') {
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
    // 【S-15】截图命令要自带回传凭据：设备上只有 MQTT 凭据、没有管理台 API key，
    // 令牌与 upload_url 只进这一台设备的私有 command 主题，别人订阅不到。
    if (cmd.action === 'screenshot') {
      const id = rows[0].id;
      cmd.token = issueShotToken(id);
      cmd.upload_url = APK_DOWNLOAD_BASE + '/api/device/' + encodeURIComponent(id) + '/screenshot';
    }
    publishToDeviceCommand(rows[0], cmd);
    logAction('sync', 'device', { device_id: deviceId, command: cmd });
    res.json({ success: true, command: cmd });
  });
});

// 【S-15】截图的两条读口（管理台用）。图不在 public/ 下，nginx 直出不到，只能从这里走：
// 一道 requireAuth 就足够 —— GET /api 全局是免鉴权的（见那道写接口闸门），但截图是"这台设备此刻
// 的实时画面"，属于现场内容，不该被任意人轮询。
app.get('/api/devices/:id/screenshot', requireAuth, (req, res) => {
  const id = String(req.params.id || '');
  if (!SHOT_ID_RE.test(id)) return res.status(400).json({ error: '非法设备 id' });
  const now = Date.now();
  pruneShots(now);
  const shot = shotStore.get(id);
  if (!shot) return res.json({ available: false });
  res.json({ available: true, ts: shot.ts, bytes: shot.buf.length, age_ms: now - shot.ts });
});

app.get('/api/devices/:id/screenshot.jpg', requireAuth, (req, res) => {
  const id = String(req.params.id || '');
  if (!SHOT_ID_RE.test(id)) return res.status(400).json({ error: '非法设备 id' });
  const now = Date.now();
  pruneShots(now);
  const shot = shotStore.get(id);
  if (!shot) {
    return res.status(404).json({ error: '这张截图已经过期（阅后即焚，只留两分钟），重新点一次实时截图' });
  }
  // no-store：管理台靠"重新点一次"取新图，缓存会让它看起来永远不更新
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Content-Length', shot.buf.length);
  res.end(shot.buf);
});

// 【S-05p】 大屏试播：把房间里某一格素材，在"它本该出现的那扇窗"里放一遍，播完自动回到原来的画面。
// 目的很具体：现场要判断某只片子放进这间包厢好不好看，而"好看"只在大屏上成立 ——
// 网页里双击预览给的是片子本身，给不了窗口位置/尺寸/裁剪/亮度叠出来的最终画面。
// 三条硬约束，缺一条这条链路就不该存在：
//   1. 纯运行时命令：不写 rooms.config、不动 folder_mappings ⇒ roomSceneDigest / rev 不变，
//      心跳对账（reconcileDeviceRev）就不会把试播误判成"设备没跟上配置"而补发同步把它踢掉。
//   2. 载荷由服务端按房间当前配置算：目标窗口、带幕前缀的物理目录、落盘文件名都不让调用方给。
//   3. 只播设备本机已有的文件：试播不下载、不改清单，素材没到位就直接回错，让人先去点同步。
// 不挂房间 debug 闸门（2026-11-08 用户定调）：单击素材卡试播是内容操作，与 stop / 推送配置同级，
// 营业中也要能用。debug 只决定设备端上不上屏运维浮层（状态文字/进度条），不再决定这条命令发不发。
// 占屏的边界改由下面第 2、3 条守：只能播本房间映射里、且设备本机已有的视频，播完必回原画面。
const PREVIEW_MAX_MS = 5 * 60 * 1000;
// 设备端播放链只认这几个扩展名（表在 VIDEO_EXT，图片素材不在链上）
const PREVIEW_VIDEO_RE = new RegExp('\\.(' + VIDEO_EXT.join('|') + ')$', 'i');

/**
 * 房间 config → "这一格的素材该落在哪些窗"（与 APK applySceneConfigs 的选窗规则同口径）：
 *   候选 = 这一幕里 enabled 不为 false、content.type 是 SCENE_<本幕>、且"能播这一格"：
 *          固定窗口看 content.folderId（为空时按 APK 的"自动取本幕第一个有素材的文件夹"回退）；
 *          content.follow=true 的窗口播哪一格由墙板决定，云端看不到设备此刻切到了哪，
 *          按"它随时可能播这一格"算命中 —— 现场主屏往往就是那扇跟随窗，
 *          排除它会让试播报"没有窗口绑这一格"，而屏上明明播得动。
 *   命中是**全部**：所有窗口的画面严格同步是用户定调的硬约束（2026-11-11），试播只落一扇
 *   等于当场分裂一次屏，而且那一扇播完回到自己被冻住的位置，轮播顺序就此错开。
 *   但"全部"只到**本幕**为止（2026-11-12 用户定调）：一扇窗属哪一幕只由 `content.type`
 *   （SCENE_A / SCENE_B）定性，**不由它躺在 scenes.A 还是 scenes.B 数组里**——201 现场那扇
 *   SCENE_B 的"新窗口5"就存在 scenes.A.windows 里（B 数组反而是空的），按数组取窗会把第二幕
 *   整个漏掉，当场表现为"试播第二幕没反应"。另一幕的窗口跟这一格没关系，点了别的幕的素材也不许被接管。
 *   winIds 按 zIndex 降序，第一扇留作旧 APK（175 那版每窗一路解码）的 win_id 兜底与日志显示；
 *   新版设备端不认这份名单，它按"本机此刻谁在播这一格"自己认，试播的账也按 folder_id 记
 *   （见 APK previewTarget / armPreview）—— 这一格唯一那一路解码多半不是这里的 win_id，
 *   所以归还只认 folder_id，别拿 win_id 去设备上找账。
 * 数据一律取 buildPrefixedScenes 的结果：键已带幕前缀且已排序，正是 APK 遍历的那一份，
 * 自己再拼前缀/再排一次序就是第四处口径漂移的开始。
 * @returns {{winIds:string[], winId:string, winName:string, physicalFolder:string}|null}
 */
function resolvePreviewTarget(cfg, scene, folder) {
  const scenes = buildPrefixedScenes((cfg && cfg.scenes) || {});
  const sceneData = scenes[scene];
  if (!sceneData) return null;
  const mappings = sceneData.folder_mappings;
  const wanted = prefixedFolderKey(scene, folder);
  // APK 的选窗是把两幕数组合成一份再按 content.type 定性（mergeSceneWindows + resolveWindowFolder），
  // 云端必须跟着合，否则像 201 那样"SCENE_B 的窗存在 scenes.A.windows"的房间，第二幕算不出任何窗。
  const allWindows = ['A', 'B'].reduce((n, k) => n.concat(((scenes[k] || {}).windows) || []), []);
  // 一个窗口都没配 → APK 会自建那个默认全屏窗口（win_1，播 A 幕第一个有素材的文件夹）。
  // 新房间第一次试片恰好就是这个状态，漏掉它等于"没配窗口的房间不能试播"。
  // 2026-11-11 用户定调：手动试播是最高权限，任何 A 幕已映射的格都能接管这扇默认窗播一遍，
  // 不再要求"这一格恰好是默认窗在播的那格"（素材在不在设备由下面的映射校验兜）。
  if (allWindows.length === 0) {
    if (scene !== 'A') return null;
    return { winIds: ['win_1'], winId: 'win_1', winName: '窗口1（默认）', physicalFolder: wanted };
  }
  // 未指定文件夹的窗口播哪一个：APK 取映射里第一个非空文件夹，排序在 buildPrefixedScenes 里已做完
  const autoFolder = Object.keys(mappings).find(k => (mappings[k] || []).length > 0);
  const matched = allWindows.filter(w => {
    if (!isPlainObject(w) || w.enabled === false) return false;
    const c = isPlainObject(w.content) ? w.content : {};
    if (String(c.type || '').toUpperCase() !== 'SCENE_' + scene) return false;
    if (c.follow === true) return true;
    const req = String(c.folderId || '').trim();
    return req ? prefixedFolderKey(scene, req) === wanted : autoFolder === wanted;
  });
  // 手动试播 = 最高权限（2026-11-11 用户定调）：点任意一格的素材都要立即接管播一遍，播完各自回到原位。
  // 这一格有窗口在播/绑定 → 接管那组（严格同步）；没有 → 退回接管**本幕**全部启用窗口，
  // 设备只落那些真在屏上的（previewTarget 的 named 兜底），素材在不在设备由下面的映射校验兜住。
  // ⚠️ 回退名单绝不能带另一幕的窗（2026-11-12 用户定调）：一只片子只有一个物理目录、只属于一幕，
  // 第二幕来源的窗口跟第一幕的这格没有任何关系。曾把两幕一起点进来，现场看到"试播第一幕 02，
  // 窗口5（内容类型 SCENE_B）也在播它"。判据是 content.type，不是它躺在哪个数组里。
  const takeover = matched.length > 0 ? matched
    : allWindows.filter(w => {
        if (!isPlainObject(w) || w.enabled === false) return false;
        const c = isPlainObject(w.content) ? w.content : {};
        return String(c.type || '').toUpperCase() === 'SCENE_' + scene;
      });
  if (takeover.length === 0) return null;
  // 按 zIndex 降序：第一扇只用于旧 APK 的兜底字段和日志显示，
  // 设备上真正接管的是"这一格的所有窗口"（用户定调 2026-11-11：任何情况下所有窗口画面严格同步，
  // 只换一扇就是当场制造画面分裂）。
  const byZ = takeover.slice().sort((a, b) => (Number(b.zIndex) || 0) - (Number(a.zIndex) || 0));
  const winIds = byZ.map(w => String(w.id));
  // 名字取 winIds[0] 那一扇（与兜底字段同口径），否则日志会出现"底部 等 2 扇窗"而 win_id 指着顶层窗
  const firstName = String(byZ[0].name || byZ[0].id);
  return {
    winIds, winId: winIds[0],
    winName: winIds.length > 1 ? firstName + ' 等 ' + winIds.length + ' 扇窗' : firstName,
    physicalFolder: wanted
  };
}

/**
 * 试播的下发前公共校验：房间 → 目标窗口 → 映射 → 素材记录 → 房间内授权设备，
 * 任一环不成立就把原因回给前端（这一步的失败必须看得见，见下面路由里的注释）。
 * @param {string} roomId
 * @param {{scene?:string, folder?:string, material_id?:string}} body
 * @param {(code:number, msg:string)=>void} fail
 * @param {(ctx:object)=>void} ok
 */
function preparePreview(roomId, body, fail, ok) {
  const scene = String((body && body.scene) || 'A').toUpperCase();
  const folder = String((body && body.folder) || '').trim();
  const materialId = String((body && body.material_id) || '').trim();
  if (!isSceneKey(scene)) return fail(400, 'scene 只能是 A 或 B');
  if (!isSafeFolderName(folder)) return fail(400, '文件夹编号不合法: ' + folder);
  if (!materialId) return fail(400, '缺少 material_id');

  db.query('SELECT name, config FROM rooms WHERE id = ?', [roomId], (err, rows) => {
    if (err) return fail(500, '房间查询失败: ' + err.message);
    if (!rows || rows.length === 0) return fail(404, '房间不存在');
    const cfg = parseRoomConfig(rows[0].config);
    const target = resolvePreviewTarget(cfg, scene, folder);
    if (!target) {
      return fail(409, '这一幕 ' + folder + ' 没有可试播的视频窗口：'
        + '需要有一个启用的窗口，内容类型是本幕素材，且它跟随墙板或绑定了这一格文件夹');
    }
    const mappings = normalizeFolderMappings(((cfg.scenes || {})[scene] || {}).folder_mappings);
    const ids = normalizeMaterialIds(mappings[folder] || mappings[target.physicalFolder]);
    if (ids.indexOf(materialId) === -1) {
      return fail(400, '该素材不在本房间 ' + scene + ' 幕 ' + folder + ' 的映射里，请先映射再试播');
    }

    // 素材记录：映射里的 id 可能是素材库的也可能是预设的（两条写入者，见记忆里的"三层不是纯三层"），
    // 所以两张表都要查。列名不同（预设没有 name），各自 SELECT 自己有的列，不做跨表 UNION
    // —— 那条路走过一次，代价是整个删除接口静默 500。id 也取：manifestFilename 的最后一级兜底靠它。
    db.query('SELECT id, filename, name, type FROM materials WHERE id = ?', [materialId], (errM, rowsM) => {
      if (errM) return fail(500, '素材查询失败: ' + errM.message);
      const done = (row) => {
        if (!row) return fail(410, '素材记录已不存在（映射里的悬空引用），请先同步让两边对齐');
        const filename = manifestFilename(row);
        if (!PREVIEW_VIDEO_RE.test(filename)) {
          return fail(400, '试播只支持视频（设备端播放链不认 ' + String(filename).replace(/^.*\./, '.') + '）');
        }
        db.query('SELECT id, fingerprint FROM devices WHERE room_id = ? AND authorized = 1',
          [roomId], (errD, devs) => {
            if (errD) return fail(500, '设备查询失败: ' + errD.message);
            if (!devs || devs.length === 0) return fail(409, '房间内没有已授权设备，无从试播');
            ok({ cfg, scene, folder, materialId, target, filename, devs,
                 roomName: rows[0].name, type: row.type || 'video' });
          });
      };
      if (rowsM && rowsM.length > 0) return done(rowsM[0]);
      db.query('SELECT id, filename, NULL AS name, type FROM preset_materials WHERE id = ?',
        [materialId], (errP, rowsP) => {
          if (errP) return fail(500, '素材查询失败: ' + errP.message);
          done(rowsP && rowsP[0] ? rowsP[0] : null);
        });
    });
  });
}

// POST /api/rooms/:id/preview  body: { scene:'A'|'B', folder:'01', material_id }
//   成功只说明"命令已按房间配置发出去了"。设备那边还有一层判定（本机到底有没有这只文件、
//   窗口在不在），那一层的成败走设备日志与大屏 debug 浮层回来看 —— 这是 MQTT 单向通道的既有形状，
//   本接口不假装自己知道结果。
app.post('/api/rooms/:id/preview', (req, res) => {
  const roomId = req.params.id;
  preparePreview(roomId, req.body, (code, msg) => res.status(code).json({ error: msg }), (ctx) => {
    const payload = {
      action: 'preview_material',
      room_id: roomId,
      win_id: ctx.target.winId,
      win_ids: ctx.target.winIds,          // 整格名单；设备端自己认成员，这里只作旧包兜底
      win_name: ctx.target.winName,
      folder_id: ctx.target.physicalFolder,   // 已带幕前缀，APK 直接过 materialDirOf
      filename: ctx.filename,                 // 与同步落盘名同源（manifestFilename）
      max_ms: PREVIEW_MAX_MS,
      timestamp: Date.now()
    };
    ctx.devs.forEach(d => publishToDeviceCommand(d, payload));
    logAction('preview', 'room', {
      // room_id 而非 id：与其它房间类审计（room_sync）同一个键，操作记录页的摘要取的就是 room_id
      room_id: roomId, room: ctx.roomName, scene: ctx.scene, folder: ctx.folder,
      material_id: ctx.materialId, filename: ctx.filename,
      win_id: ctx.target.winId, win_name: ctx.target.winName, devices: ctx.devs.length
    });
    res.json({ success: true, target: ctx.target, filename: ctx.filename, devices: ctx.devs.length });
  });
});

// POST /api/rooms/:id/preview/stop  body: { scene?, folder? } —— 带了就把那一格的试播停掉，不带则全停
//   （"全停"是给人按的兜底键：页面刷新丢了目标、或配置改动后那一扇窗已经解析不出来时用它清场）
app.post('/api/rooms/:id/preview/stop', (req, res) => {
  const roomId = req.params.id;
  const b = req.body || {};
  const scene = b.scene ? String(b.scene).toUpperCase() : '';
  const folder = b.folder ? String(b.folder).trim() : '';
  if ((scene || folder) && (!isSceneKey(scene) || !isSafeFolderName(folder))) {
    return res.status(400).json({ error: 'scene/folder 不合法' });
  }
  db.query('SELECT config, name FROM rooms WHERE id = ?', [roomId], (err, rows) => {
    if (err) return res.status(500).json({ error: '房间查询失败: ' + err.message });
    if (!rows || rows.length === 0) return res.status(404).json({ error: '房间不存在' });
    const cfg = parseRoomConfig(rows[0].config);
    const payload = { action: 'preview_stop', room_id: roomId, timestamp: Date.now() };
    if (scene && folder) {
      const target = resolvePreviewTarget(cfg, scene, folder);
      if (!target) return res.status(409).json({ error: '这一幕 ' + folder + ' 已解析不到窗口，请用「全部停止」' });
      // folder_id 是判据：设备端试播的账按格子（folder_id）记，接管与归还都认它；
      // win_id/win_ids 只给还装在机上的 175 那版兜底，以及给人看日志时有个名字
      payload.win_id = target.winId;
      payload.win_ids = target.winIds;
      payload.folder_id = target.physicalFolder;
      payload.win_name = target.winName;
    }
    db.query('SELECT id, fingerprint FROM devices WHERE room_id = ? AND authorized = 1',
      [roomId], (errD, devs) => {
        if (errD) return res.status(500).json({ error: '设备查询失败: ' + errD.message });
        if (!devs || devs.length === 0) return res.status(409).json({ error: '房间内没有已授权设备' });
        devs.forEach(d => publishToDeviceCommand(d, payload));
        // room 与 preview 那条同键：操作记录页摘要取人话房间名，只留 room_id 的话这行显示成机器 id
        logAction('preview_stop', 'room',
          { room_id: roomId, room: rows[0].name, win_id: payload.win_id || 'ALL', win_name: payload.win_name || '全部窗口', devices: devs.length });
        res.json({ success: true, win_id: payload.win_id || 'ALL', devices: devs.length });
      });
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

// 【S-06f】 485 学习窗开关：让房间内设备把"这一段收到的帧"当作候选列表报回来（xvj/device/{id}/frames）。
// 界面上的流程是"点某一格的码值框 → 开学习窗 → 按墙板那颗键"，所以设备开窗时会先清空帧台账：
// 窗内第一条到达的帧就是操作员刚按的那一下，前端取最早的一条填进框里。
// 中控把点歌机和墙板合并进同一根总线，点歌机在放歌时会连发状态帧 —— 框里显示的是原始 hex，
// 录错了看得见，清掉重学一次即可（不静默猜、也不自动绑）。
// on:false 是提前收窗（操作员按完不想等满 20 秒）；服务端不存窗的状态，界面上的倒计时是前端自己的钟。
app.post('/api/rooms/:id/wallpanel/learn', (req, res) => {
  const roomId = req.params.id;
  const b = req.body || {};
  const on = b.on !== false;
  let seconds = 20;
  if (b.seconds !== undefined) {
    const raw = Number(b.seconds);
    if (!Number.isInteger(raw) || raw < 1 || raw > WALLPANEL_LEARN_MAX_S) {
      return res.status(400).json({ error: 'seconds 需为 1~' + WALLPANEL_LEARN_MAX_S + ' 的整数秒' });
    }
    seconds = raw;
  }
  db.query('SELECT id, fingerprint, name FROM devices WHERE room_id = ? AND authorized = 1', [roomId],
    (err, devs) => {
      if (err) return res.status(500).json({ error: '设备查询失败: ' + err.message });
      const list = devs || [];
      if (list.length === 0) return res.status(409).json({ error: '房间内没有已授权设备' });
      const payload = { action: 'wallpanel_learn', on, seconds, timestamp: Date.now() };
      list.forEach(d => publishToDeviceCommand(d, payload));
      logAction('wallpanel_learn', 'room',
        { room_id: roomId, on, seconds, devices: list.length });
      res.json({ success: true, on, seconds, devices: list.map(d => d.id) });
    });
});

// 【S-07d】从房间删除素材：只清 ?scene= 指定的那一幕（前端两条写入路径都只写一幕）
// 流程：清理该幕 folder_mappings → UPDATE DB → 每台设备发 delete_material（立即删本地文件）
//      → 清单对账由 notifyRoomConfigChanged 收敛点决定（真删掉了才 sync，否则一条不发）
// ?scene= 同时决定"清哪一幕的映射"和"delete_material 的 folder 前缀（= 立即删哪个物理目录）"；
// 另一幕的同一素材不动。不传则默认 A。
app.delete('/api/rooms/:roomId/materials/:materialId', (req, res) => {
  const { roomId, materialId } = req.params;
  // ?folder= 与 ?scene= 会拼成 delete_material 的 folder 字段下发，APK 按它解析磁盘目录
  // （"A01" → scenea/01）：不卡形状就等于把 "../../etc" 交给设备端去删。两个都走白名单。
  const folder = req.query.folder || '01';
  const curScene = req.query.scene || 'A';   // 明确指定场景，默认 A
  if (!isSafeFolderName(folder)) return res.status(400).json({ error: 'invalid folder name' });
  if (!isSceneKey(curScene)) return res.status(400).json({ error: 'scene 只能是 A 或 B' });

  // 1. 查出文件名（查 materials 和 preset_materials 两个表）
  // ⚠️ 两张表的列不一样：materials 有 name（用户起的显示名）+ filename，预设只有 filename。
  // 以前第二条也写 `SELECT filename, name`，UNION 是整条语句一起失败的 —— 于是不管摘的是素材库
  // 还是预设，这个删除接口都稳定回 500 "Unknown column 'name'"，房间视图里的「×」从来就没生效过
  // （前端只弹两秒红字，很容易被当成"网络抖了一下"）。预设那侧用 NULL 占位，
  // 下面 `filename || name` 的回退链照旧成立。
  db.query(
    'SELECT filename, name FROM materials WHERE id = ? UNION SELECT filename, NULL AS name FROM preset_materials WHERE id = ?',
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

        // 只清 ?scene= 指定的那一幕。以前 A/B 两幕一起清，注释的理由是"与添加时写双幕对称"，
        // 但那前提早就不成立了：前端两条写入路径（素材推送、预设映射到房间）都只写当前一幕，
        // 于是"同一个素材两幕都用"是运营者一份份点出来的合法配置 —— 在 A 幕点「×」把 B 幕的
        // 那份也悄悄删了，而且设备还会收到 delete_material 把 B 幕正在用的文件从磁盘删掉。
        // 另一幕若因此变成孤儿，由随后的清单对账按"该目录应有的素材"清掉，不需要在这里越权代删。
        let removed = false;
        if (config.scenes) {
          [curScene].forEach(scene => {
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
            console.log('🗑 房间', roomId, curScene + ' 幕 folder', folder, '移除素材', materialId, removed ? '✓' : '(未找到)');

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
  // Express 已经把 query/body 解过一道码，这里再 decode 会把名字里的 % 当转义开头：
  // 「50%店」→ URIError → 500，这家店永远改不了状态。
  const store = req.query.store || req.body.store || '默认店';
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
  // 局部变量以前叫 config，把模块顶部的 `const config = require('./config')` 遮掉了：
  // 这个路由里一旦有人想读 broker 地址/mqtt 凭据就会拿到 JSON 字符串，且不会报错只会不对。
  const cfgJson = JSON.stringify(req.body);
  db.query('UPDATE devices SET config = ? WHERE id = ?', [cfgJson, req.params.deviceId], (err) => {
    if (err) return res.status(500).json({ error: err.message });

    const topic = `xvj/device/${req.params.deviceId}/config`;
    pubMqtt(topic, cfgJson);
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

/**
 * removeMaterialIdsFromAllRooms 的只读对照版：给定一批素材 id（素材行本身 + 同 URL 的预设行），
 * 报出哪些房间的哪些映射槽位会命中，供前端在删除前展示影响面。
 * 遍历口径与写版逐字对齐（只走 A/B 两幕、非数组槽位跳过）—— 两边算法一旦不一致，
 * "预告"就成了误导，比不预告更糟。新加一幕或改映射结构时两处一起改。
 */
function findMaterialUsageInRooms(ids, done) {
  const killIds = Array.isArray(ids) ? ids : [ids];
  db.query('SELECT id, name, store_name, config FROM rooms', [], (err, rooms) => {
    if (err) { console.error('📋 用量查询失败:', err.message); return done([]); }
    const hits = [];
    (rooms || []).forEach(room => {
      let cfg = {};
      try { cfg = room.config ? JSON.parse(room.config) : {}; } catch (e) { return; }
      const slots = [];
      ['A', 'B'].forEach(sc => {
        const fm = cfg.scenes && cfg.scenes[sc] && cfg.scenes[sc].folder_mappings;
        if (!fm || typeof fm !== 'object') return;
        Object.keys(fm).forEach(k => {
          const arr = fm[k];
          if (!Array.isArray(arr)) return;
          const n = arr.filter(x => killIds.includes(x)).length;
          if (n) slots.push({ scene: sc, folder: k, count: n });
        });
      });
      if (slots.length) hits.push({ id: room.id, name: room.name, store_name: room.store_name, slots });
    });
    done(hits);
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
  // folder_id 会被拼进房间映射键、也会随同步下发给设备当目录线索。以前它和素材库目录名共用
  // 一把 isSafeFolderName 自由文本闸，于是 '98'、'abc' 这类值也能进库 —— 而预设页的目录签是
  // 写死的 01-30，这种记录在界面上永远渲染不出来，成了看不见也删不掉的暗格。
  // 所以这里比素材库更严（那边目录名真是用户起的），只收 01-30。
  // 存量安全：线上 preset_materials.folder_id 全是 '01'（2026-09-20 核过），收紧不打到已有数据。
  const fid = String(folder_id);
  if (!PRESET_FOLDER_RE.test(fid)) return res.status(400).json({ error: 'folder_id 只能是 01-30' });
  // 这条 url 会被前端当播放地址、也会被删素材时当磁盘路径用，只允许指向 uploads 根内
  if (!resolveUploadPath(url)) return res.status(400).json({ error: 'invalid url' });
  if (thumbnail && !resolveUploadPath(thumbnail)) return res.status(400).json({ error: 'invalid thumbnail' });
  // 批量"复制到预设"是前端 for...of 串行发的，纯 Date.now() 在同一毫秒里会撞 PRIMARY KEY，
  // 撞了只是"这一条没进去"，用户完全看不出来 —— 补 4 位随机后缀（历史 id 仍是 pm_ 前缀，不解析格式）
  const id = 'pm_' + Date.now() + '_' + crypto.randomBytes(2).toString('hex');
  const safeName = clampStr(filename || url.split('/').pop() || '未知文件', 255);
  // type 只有 video/image 两种播放语义（设备端按它选解码器/ImageView）。调用方没给合法值时按扩展名判，
  // 表就是 VIDEO_EXT —— 以前这里另写了一份、只列 mp4/avi，一只 .webm 不带 type 进来就被记成 image，
  // 而房间卡片与试播闸门按另一份表判，同一条素材在三处两种身份。（原注释写的是"别的值一律按 video 收"，
  // 与代码不符，一并改齐。）
  const fileType = (type === 'video' || type === 'image') ? type : (hasVideoExt(safeName) ? 'video' : 'image');
  // 指纹按列宽收口（VARCHAR(32)）：来路是前端从素材库行带的 md5，STRICT_TRANS_TABLES 下超宽是整条写失败
  const incomingMd5 = clampStr(md5, 32) || null;
  // 同文件夹 + 同文件 = 同一条预设（幂等）。前端也判重，但它判的是自己那份 s.pm 快照：
  // 两个标签页、或者列表没刷新时连点，服务端会真的插进两条 —— 两条 id 指向同一个物理文件，
  // 映射进房间后设备清单里就是两个同名条目，白下一遍还互相打脸 md5 缓存。
  db.query('SELECT id, folder_id, filename, url, type, thumbnail, md5 FROM preset_materials WHERE folder_id = ? AND url = ? LIMIT 1',
    [fid, url], (errExist, existRows) => {
      if (errExist) return res.status(500).json({ error: errExist.message });
      if (existRows && existRows[0]) {
        const ex = existRows[0];
        // 库里这条没有指纹、而调用方手里有（素材库那行算出来的）→ 当场补一次。
        // 不补的话这条预设会在房间清单里永远下发空串，设备没有可比对的凭据只能整只重下。
        // 只补空、不改写：已有 md5 与来值不一致，意味着文件被就地换过或调用方拿着旧快照，
        // 那种分歧该由上传侧的指纹负责，不是"复制到预设"这个动作有资格覆盖的。
        if (!ex.md5 && incomingMd5) {
          return db.query('UPDATE preset_materials SET md5 = ? WHERE id = ? AND (md5 IS NULL OR md5 = "")',
            [incomingMd5, ex.id], (errM) => {
              if (!errM) ex.md5 = incomingMd5;
              logAction('exists', 'preset_material', ex);
              res.json({ success: true, existed: true, ...ex });
            });
        }
        logAction('exists', 'preset_material', ex);
        return res.json({ success: true, existed: true, ...ex });
      }
      db.query(
        'INSERT INTO preset_materials (id, folder_id, filename, url, type, thumbnail, md5) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [id, fid, safeName, url, fileType, thumbnail || null, incomingMd5],
        (err) => {
          if (err) return res.status(500).json({ error: err.message });
          logAction('create', 'preset_material', { id, folder_id: fid, filename: safeName, url });
          // success: true —— 全仓写接口统一回 {success:true}，前端 apiCall/apiPost 就按这个判。
          // 以前这条只回裸行，前端只能自己写 fetch + 判 res.ok（复制预设那条就是），
          // 等于给"约定"开了个例外，下一个调用方很容易以为成功即已新建。
          res.json({ success: true, id, folder_id: fid, filename: safeName, url, type: fileType, thumbnail: thumbnail || null, md5: incomingMd5 });
        }
      );
    });
});

// 【S-03g】 预设素材的删除影响面预告（只读，与【S-02b】同族）
// killIds 口径必须和上面的 DELETE 一致：预设只摘自己这一个 id（不牵出素材库行、不删文件）。
// 素材库那边反过来要并上同 URL 的预设行 —— 两边不对称是有意的，别"顺手统一"。
// materials 那份是"会连带删什么"，这份多带的 src_materials 只是给运营看"文件还有人用，删了不影响画质/播放源"。
app.get('/api/preset/materials/:id/usage', (req, res) => {
  const mid = req.params.id;
  if (!mid || mid.length > 36) return res.status(400).json({ error: 'invalid id' });
  db.query('SELECT id, folder_id, filename, url, type, thumbnail, md5 FROM preset_materials WHERE id = ?',
    [mid], (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!rows || !rows[0]) return res.status(404).json({ error: '预设素材不存在' });
      const preset = rows[0];
      // 共享同一物理文件的素材库行（只读展示，删除不会动它们）
      db.query('SELECT id, name, filename, folder FROM materials WHERE url = ?', [preset.url],
        (err2, mats) => {
          if (err2) return res.status(500).json({ error: err2.message });
          findMaterialUsageInRooms([mid], (rooms) => {
            res.json({
              success: true,
              preset,
              bytes: uploadSizeBytes(preset.url) + uploadSizeBytes(preset.thumbnail),
              rooms,
              slot_count: rooms.reduce((n, r) => n + r.slots.reduce((m, s) => m + s.count, 0), 0),
              src_materials: mats || []
            });
          });
        });
    });
});


// 删除预设素材（级联清理所有房间的 scenes A/B 映射并通知设备同步）
// ⚠️ 只摘引用，不碰磁盘：预设是素材库条目的一份"共享引用"，物理文件由 materials 那边管。
// 所以这条 DELETE 的影响面只有"哪些房间的哪个槽位被摘掉"，与文件、素材库行都无关。
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
    // 映射里两类 id 都可能出现：「映射预设」写 pm_* 预设 id，素材页的「推送到房间」直接把素材库 id
    // 写进去（线上确有这种房间，见 room aaa），所以清理列表必须并上同 URL 的预设 id。
    // 以前只传素材 id：凡经"素材推送到房间"建的映射一条都删不掉，这些房间也进不了 affected，
    // 于是既不通知设备也不清配置，现场能继续播被删素材最多 3 分钟（等心跳对账兜回来）。
    // 预设查失败同样停手，理由与上面materials 查询一致：少一份 id 就是一份悬空引用。
    const killPresets = (presetIds) => {
      const killIds = ids.concat(presetIds);
      removeMaterialIdsFromAllRooms(killIds, (affected) => {
        const dir = __dirname + "/public/uploads/" + name;
        if (require('fs').existsSync(dir)) require('fs').rmSync(dir, { recursive: true });
        // 行删失败只记日志不中断响应：目录已经真删了，回 500 反而会让前端以为什么都没发生
        //（materials 行留着 = 指向不存在文件的孤儿，日志里能一眼看到并手工清）
        db.query("DELETE FROM materials WHERE folder=?", [name], (errDel) => {
          if (errDel) console.error('❌ 删文件夹后 materials 行未清:', name, errDel.message);
          const dropPresets = () => {
            if (urls.length === 0) return finish();
            const ph = urls.map(() => '?').join(',');
            db.query(`DELETE FROM preset_materials WHERE url IN (${ph})`, urls, (errP) => {
              if (errP) console.error('❌ 删文件夹后 preset_materials 未清:', name, errP.message);
              finish();
            });
          };
          const finish = () => {
            affected.forEach(rid => notifyRoomDevicesOfSync(rid));
            logAction('delete', 'folder', { folder: name, materials: ids.length, presets: presetIds.length, rooms_notified: affected.length });
            res.json({ success: true, removed_materials: ids.length, rooms_notified: affected.length });
          };
          dropPresets();
        });
      });
    };
    if (urls.length === 0) return killPresets([]);
    const ph = urls.map(() => '?').join(',');
    db.query(`SELECT id FROM preset_materials WHERE url IN (${ph})`, urls, (err2, presets) => {
      if (err2) return res.status(500).json({ error: err2.message });
      killPresets((presets || []).map(p => p.id));
    });
  });
});


/**
 * 【S-02b】 删除影响面预告（只读）：给下面的 DELETE 用同一套 killIds 口径
 * （素材行本身 + 同 URL 的预设行），前端据此把确认框写成"会打到哪几间房"而不是"确定删除?"。
 * 没做成 DELETE 的 dry-run 参数：那要给 removeMaterialIdsFromAllRooms 塞"只算不写"分支，
 * 一个布尔把两条语义不同的路径揉进同一函数，比抽出这个只读版更容易出错。
 */
app.get("/api/materials/:id/usage", (req, res) => {
  db.query("SELECT id, name, filename, url, type, folder, thumbnail, md5, created_at FROM materials WHERE id=?",
    [req.params.id], (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!rows || !rows[0]) return res.status(404).json({ error: '素材不存在' });
      const mat = rows[0];
      db.query("SELECT id, folder_id, filename, type FROM preset_materials WHERE url=?", [mat.url],
        (err1, presets) => {
          if (err1) return res.status(500).json({ error: err1.message });
          const ps = presets || [];
          // 同 URL 的其它素材行：删物理文件会让它们变成"记录在、文件没了"的空壳
          db.query("SELECT id, name, folder FROM materials WHERE url=? AND id<>?", [mat.url, mat.id],
            (err2, twins) => {
              if (err2) return res.status(500).json({ error: err2.message });
              findMaterialUsageInRooms([mat.id, ...ps.map(p => p.id)], (rooms) => {
                res.json({
                  material: mat,
                  bytes: uploadSizeBytes(mat.url) + uploadSizeBytes(mat.thumbnail),
                  presets: ps,
                  rooms,
                  slot_count: rooms.reduce((n, r) => n + r.slots.reduce((m, s) => m + s.count, 0), 0),
                  twin_materials: twins || []
                });
              });
            });
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
const UPLOAD_VIDEO_EXT = VIDEO_EXT.map(e => '.' + e);   // 表在文件顶部的 VIDEO_EXT（设备播放链同源）
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

// 预设素材的目录号：前端预设页固定渲染 01-30 三十个签（见 prf），落在区间外的记录
// 无签可归、界面上不可见，等于删不掉的暗格数据。素材库那边目录名是自由文本，两边口径刻意不同。
const PRESET_FOLDER_RE = /^(0[1-9]|[12]\d|30)$/;

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

/**
 * multipart 的 filename 按浏览器实际发法是 UTF-8 字节，但 busboy 1.x 的 defParamCharset 默认 latin1，
 * 于是中文原名会被逐字节当成单字节码点解出来："DJ二维码(62).mp4" → "DJäºŒç»´ç\u{A0}\u{81}(62).mp4"。
 * 这串东西会一路进 materials.name/filename —— 而 filename 是设备端认文件的键，页面上还夹着
 * 看不见、删不掉的 U+00A0/U+0081。反解判据两条：原串必须全在 latin1 区（真 Unicode 一律不动，
 * 免得将来 busboy 改了默认值反而把对的名字弄坏），且反解结果不能带 U+FFFD
 * （带说明客户端真是按 latin1 发的字节、不是 UTF-8 流，此时保留原串才是对的）。
 */
function decodeUploadName(name) {
  if (typeof name !== 'string' || !name) return name;
  for (var i = 0; i < name.length; i++) {
    if (name.charCodeAt(i) > 0xFF) return name;
  }
  var utf8 = Buffer.from(name, 'latin1').toString('utf8');
  return utf8.indexOf('\uFFFD') >= 0 ? name : utf8;
}

function buildSafeUploadName(originalname) {
  const extMatch = originalname.match(/\.[A-Za-z0-9]+$/);
  const ext = extMatch ? extMatch[0].toLowerCase() : '';
  const base = originalname.replace(/\.[^.]*$/, '').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
  return Date.now() + '_' + uuidv4().slice(0, 8) + '_' + (base || 'file') + ext;
}

// 同一素材目录内的 filename 查重：落盘名带时间戳+uuid 不会撞，撞的是 materials.filename
// 这一列（用户起的原名）。而设备端不按 id 认文件、按 <目录>/<filename> 认，ETag/Last-Modified/md5
// 三个缓存键还只有文件名 —— 同名两条就会互相覆盖下载结果、互相打脸缓存，现场看到的是
// "播的是另一只片子"。所以 (folder, filename) 必须与 id 一一对应，撞了就自动补 " (2)"。
// 只在同目录内比（设备的目录边界就在这里），且大小写不敏感（Android 文件系统与人的直觉都不区分）。
// SELECT 失败时按原名放行：查重是正确性兜底，不该让一次查询失败把已上传完的大文件判死。
function uniqueMaterialFilename(folder, name, cb) {
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  db.query('SELECT filename FROM materials WHERE folder = ? AND filename LIKE ?',
    [folder, base.replace(/[\\%_]/g, ch => '\\' + ch) + '%'], (err, rows) => {
      if (err) return cb(name, false);
      const taken = {};
      (rows || []).forEach(r => { taken[String(r.filename || '').toLowerCase()] = 1; });
      if (!taken[name.toLowerCase()]) return cb(name, false);
      let n = 2;
      let cand = name;
      do {
        const tail = ' (' + n + ')' + ext;
        // 先截 base 再拼后缀，保证结果一定在 255 列宽内（STRICT 下超宽是整条 INSERT 失败）
        cand = clampStr(base, Math.max(0, 255 - tail.length)) + tail;
        n++;
      } while (taken[cand.toLowerCase()] && n < 1000);
      cb(cand, true);
    });
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

/**
 * LOGO 专用上传（POST /api/rooms/:id/logo）：落盘到 public/uploads/logos/<roomId>/。
 * 只收视频扩展名白名单里的文件，上限 100MB（LOGO 是循环小片，500MB 的素材上限在这里只会让误传变慢）。
 * 临时名带真扩展名：ffmpeg 按后缀选封装器，写成 .tmp 会报 "Unable to find a suitable output format"。
 */
const LOGO_UPLOAD_MAX_SIZE = 100 * 1024 * 1024;
const logoUploadMiddleware = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const roomId = String(req.params.id || '');
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(roomId)) return cb(new Error('invalid room id'));
      const dir = path.join(__dirname, 'public', 'uploads', 'logos', roomId);
      try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { return cb(e); }
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(String(file.originalname || '')).toLowerCase();
      if (UPLOAD_VIDEO_EXT.indexOf(ext) < 0) return cb(new Error('unsupported file type: ' + ext));
      cb(null, 'tmp-' + Date.now() + ext);
    }
  }),
  limits: { fileSize: LOGO_UPLOAD_MAX_SIZE }
}).single("file");

app.post("/api/upload", (req, res) => {
  const folder = uploadFolderOf(req);
  if (!folder) return res.status(400).json({ error: "invalid folder" });
  uploadMiddleware(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: "no file" });

    // 原名先按 UTF-8 反解（见 decodeUploadName）：这一句决定 materials.name/filename 里
    // 存的是用户起的名字还是一串 latin1 乱码，落盘名不受影响（那边只保留 ASCII 基名）。
    const originalName = decodeUploadName(req.file.originalname) || 'file';
    const extMatch = originalName.match(/\.[A-Za-z0-9]+$/);
    const ext = extMatch ? extMatch[0].toLowerCase() : '';
    // 类型只认扩展名白名单。以前还写 `|| mimetype.startsWith('video')` 兜底，
    // 而落盘名保留客户端扩展名（buildSafeUploadName），于是
    // `evil.html` + `Content-Type: video/mp4` 就能判定成 video，在 /uploads/ 下写出一个
    // 同源 text/html —— 上传型 stored XSS（当时写接口只认 x-api-key，而那把 key 就写在页面里，等于公开）。
    // 兜底等于把白名单作废，删掉它才是收口：能落盘的扩展名必然在两组白名单之内。
    let type = null;
    if (UPLOAD_VIDEO_EXT.includes(ext)) type = "video";
    else if (UPLOAD_IMAGE_EXT.includes(ext)) type = "image";
    if (!type) {
      safeUnlink(req.file.path);
      return res.status(400).json({ error: "unsupported file type: " + ext });
    }

    const url = "/uploads/" + folder + "/" + req.file.filename;
    let thumbnail = null;
    let resolution = null;

    const finish = (md5) => {
      const wanted = clampStr(originalName, 255);
      uniqueMaterialFilename(folder, wanted, (storedName, renamed) => {
        const displayName = storedName.replace(/\.[^.]+$/, '');
        const id = uuidv4();
        // name/filename/resolution 都按列宽截断：STRICT_TRANS_TABLES 下超宽是整条 INSERT 失败，
        // 而这里的失败分支会把刚上传完的大文件连同缩略图一起 unlink ——
        // 用户看到的只有"上传失败"五个字，200MB 白传了。文件名是用户随便起的，拦不住，只能截。
        db.query("INSERT INTO materials (id,name,filename,url,type,folder,thumbnail,resolution,md5) VALUES (?,?,?,?,?,?,?,?,?)",
          [id, clampStr(displayName, 255), storedName, url, type, folder, thumbnail,
           resolution ? clampStr(resolution, 20) : null, md5 || null],
          (e) => {
            if (e) {
              try { require('fs').unlinkSync(req.file.path); } catch (e2) {}
              if (thumbnail) { try { require('fs').unlinkSync(__dirname + thumbnail); } catch (e2) {} }
              return res.status(500).json({ error: e.message });
            }
            // 改名时把用户原本要的名字一起记账：排查"名字怎么被改了"时一眼看得懂
            logAction('upload', 'material', { id, name: displayName, folder, type, md5,
              ...(renamed ? { original_filename: wanted } : {}) });
            res.json({ id, name: displayName, filename: storedName, url, type, folder, thumbnail, resolution, md5: md5 || null });
          }
        );
      });
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
      // 图片以前直接 finish(null) —— 等于每只图片素材永远没有内容指纹。
      // 设备端 syncFolderWithIds 的判定顺序是「md5 一致 → 跳过」，md5 为空就只能退到
      // ETag/Last-Modified 复核；而装 APK 与 OTA 都会清掉 prefs（168 实测），那时连 ETag 缓存都没有，
      // 清单里的 md5 又是空串 → 只能无条件 GET 把整只文件重下一遍。
      // 摘要算的是落盘后的字节，与 room-materials-v2 下发的 md5、设备下载到的文件同源。
      // 失败仍按"无指纹"放行：不能因为一次哈希出错就把用户的上传报成失败。
      md5FileStream(req.file.path).then(finish).catch(() => finish(null));
    }
  });
});

/**
 * 【S-02c】 上传房间 LOGO（POST /api/rooms/:id/logo，multipart 字段名 file）
 * 只落文件 + 返回元数据，不直接写 config：config 仍由「LOGO设置」页读整份 → 改 logo → PUT 回去，
 * 与会话里其它配置写入口同一条链（rev / 下发 / 对账都走收敛点）。
 * 落盘名 = logo-<md5 前 12><ext>：内容一变 URL 就变，绕开 /uploads 的 1 天强缓存；
 * 同目录旧 logo-* 文件顺手清掉，只留当前这一份 + 首帧缩略图。
 * 首帧缩略图用于管理台画布预览（设备端不用它）。
 */
app.post('/api/rooms/:id/logo', (req, res) => {
  const roomId = String(req.params.id || '');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(roomId)) return res.status(400).json({ error: 'invalid room id' });
  db.query('SELECT id FROM rooms WHERE id = ?', [roomId], (errDb, rows) => {
    if (errDb) return res.status(500).json({ error: errDb.message });
    if (!rows || rows.length === 0) return res.status(404).json({ error: '房间不存在' });
    logoUploadMiddleware(req, res, (err) => {
      if (err) return res.status(400).json({ error: err.message });
      if (!req.file) return res.status(400).json({ error: 'no file' });
      const tmp = req.file.path;
      const dir = path.dirname(tmp);
      const originalName = decodeUploadName(req.file.originalname) || 'logo';
      (async () => {
        await remuxFaststart(tmp);
        const md5 = await md5FileStream(tmp);
        const ext = path.extname(tmp).toLowerCase();
        const base = 'logo-' + md5.slice(0, 12);
        const finalPath = path.join(dir, base + ext);
        const thumbPath = path.join(dir, base + '.jpg');
        fs.renameSync(tmp, finalPath);
        let width = 0, height = 0, hasThumb = false;
        try {
          const probe = await execFileAsync('ffprobe',
            ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', finalPath]);
          const wh = String(probe).trim().split(',').map(n => parseInt(n, 10));
          width = wh[0] || 0; height = wh[1] || 0;
          await execFileAsync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error',
            '-i', finalPath, '-frames:v', '1', '-q:v', '2', thumbPath]);
          hasThumb = true;
        } catch (e) { /* 探测/首帧失败不阻断上传，前端会退回不显示预览 */ }
        // 清掉同目录里不属于这一版的旧文件（替换 LOGO / 上次失败留下的 tmp）
        try {
          fs.readdirSync(dir).forEach(f => {
            if (f === path.basename(finalPath) || f === path.basename(thumbPath)) return;
            safeUnlink(path.join(dir, f));
          });
        } catch (e) { /* 清理失败无碍 */ }
        const relDir = '/uploads/logos/' + roomId + '/';
        logAction('upload', 'logo', { room: roomId, filename: originalName, md5, size: fs.statSync(finalPath).size });
        res.json({
          url: relDir + base + ext,
          thumbnail: hasThumb ? relDir + base + '.jpg' : '',
          filename: originalName,
          md5,
          size: fs.statSync(finalPath).size,
          width, height
        });
      })().catch(e => {
        safeUnlink(tmp);
        res.status(500).json({ error: 'LOGO 处理失败: ' + e.message });
      });
    });
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
// 【S-08a】 查询操作日志（从 operation_logs 表读取）
// target/action 是等值筛（下拉直接给候选值），q 是 LIKE 模糊查 details（里面是 JSON，
// 想按房间 id / 素材 id 找就得 substring）。LIKE 前的 % 与 _ 必须转义，
// 否则用户输 "01" 会命中 "A010"、输 "%" 变成全表匹配。
app.get('/api/logs', (req, res) => {
  const limit = clampLimit(req.query.limit, 20, 500);
  const where = [];
  const args = [];
  const target = clampStr(req.query.target, 50);
  const action = clampStr(req.query.action, 50);
  const q = clampStr(req.query.q, 100);
  if (target && target !== 'all') { where.push('target = ?'); args.push(target); }
  if (action && action !== 'all') { where.push('action = ?'); args.push(action); }
  if (q) { where.push('details LIKE ?'); args.push('%' + q.replace(/[\\%_]/g, ch => '\\' + ch) + '%'); }
  const sql = "SELECT id, action, target, details, created_at FROM operation_logs" +
    (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY id DESC LIMIT ?';
  args.push(limit);
  db.query(sql, args, (err, rows) => {
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
                  filename: manifestFilename(row),
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
  // 前端日志页固定要 1000 条，上限留到 2000；负数/非数字回落 100（见 clampLimit）
  const limit = clampLimit(req.query.limit, 100, 2000);
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
  // params 已由 Express 解过码，再 decode 一次会把名字里的 % 当转义开头：
  // 「50%店」→ URIError → 500（永远改不了名）；'100%25' 二次解成 '100%'，还可能撞上另一家真店铺
  const oldName = req.params.name;
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
  const storeName = req.params.name;  // 同 S-11c：params 已由 Express 解码，二次 decode 会把含 % 的店名变 500
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

// 顶层裸建表统一走 ensureTable：建表失败以前是彻底静默（无回调时 mysql2 直接丢错误），
// 结果就是「✅ 数据库初始化完成」照打，第一次请求才以 500 暴露。
function ensureTable(name, ddl) {
  db.query(ddl, (err) => {
    if (err) console.error('❌ 建表失败 ' + name + ':', err.message);
  });
}

ensureTable('stores', `CREATE TABLE IF NOT EXISTS stores (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL UNIQUE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);



// ==================== 房间管理 API ====================
// 列结构对齐生产库（SHOW CREATE TABLE rooms，2026-09-18）：id 是 'room_<ts>' 字符串主键，
// 不是自增 INT —— 建新房间走 INSERT id（S-04h），以前写 INT 主键的话全新库上要么建不出表、
// 要么插不进去。TEXT 两列也不能带 DEFAULT（MySQL 1101：TEXT 不支持默认值），
// 以前的 `TEXT DEFAULT '{}'` 让这张表在全新 MySQL 上根本建不出来。
ensureTable('rooms', `CREATE TABLE IF NOT EXISTS rooms (
  id VARCHAR(36) PRIMARY KEY,
  store_name VARCHAR(100) NOT NULL,
  name VARCHAR(50) NOT NULL,
  folder_mappings TEXT,
  config TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY unique_room (store_name, name)
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
  // config 与 PUT /rooms/:id 走同一个净化入口（prepareRoomConfig）：字符串或对象都收，
  // 但一定要落成合法 JSON 文本 —— 直接把对象塞进字符串列得到的是 "[object Object]"，
  // 房间一出生就带着一份解析不了的配置。墙板绑定/总闸也在这里同口径校验，
  // 否则脏值入库后 PUT 继承它再撞校验，这间房从创建那一刻起就存不进任何配置。
  var cfgStr = '{}';
  if (config !== undefined) {
    var prep = prepareRoomConfig(config, null);
    if (prep.error) return res.status(400).json({ error: prep.error });
    cfgStr = JSON.stringify(prep.cfg);
  }
  const id = 'room_' + Date.now();
  db.query('INSERT INTO stores (name) VALUES (?) ON DUPLICATE KEY UPDATE name=name', [store_name], (errStore) => {
    if (errStore) return res.status(500).json({error:errStore.message});
    db.query('INSERT INTO rooms (id, store_name, name, folder_mappings, config) VALUES (?, ?, ?, ?, ?)',
      [id, store_name, name, '{}', cfgStr], (err, result) => {
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

      // config 允许字符串（前端就是这么发的）或对象；解析、scenes 脏键过滤、顶层继承、逐幕合并和
      // 墙板字段的校验都在 prepareRoomConfig —— 与 POST /rooms 同一个入口，两边口径不会漂。
      // 校验失败一律 res 返 400，绝不 throw：抛在 MySQL 回调里会被顶层 uncaughtException 吞掉，
      // 那次请求永远挂着不返回，前端只看到"保存中…"转圈，且这个房间每次保存都稳定复现。
      var prep = prepareRoomConfig(config, existingConfig);
      if (prep.error) return res.status(400).json({ error: prep.error });
      var cfg = prep.cfg;

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
      existingConfig.scenes[targetScene] = mergeSceneConfig(null, null, targetScene === 'A' ? '第一幕' : '第二幕', targetScene);
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

// stores 的建表在上面 S-11 系列之前已经做过（ensureTable），这里不再重复声明；
// 两份 IF NOT EXISTS 只会让人搞清哪份是权威定义。
ensureTable('default_materials', `CREATE TABLE IF NOT EXISTS default_materials (
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
  // 这两项缺失时服务照常起（读接口与设备 MQTT 不受影响），但写接口会全线 401、管理台登录回 503：
  // 属于"配漏了 env"，必须显眼地喊出来，不能静默降级成"任何人都改不动数据"却看不出原因
  if (!config.adminPassword) console.warn('⚠️ 未配置 ADMIN_PASSWORD：管理台无法登录（POST /api/session 回 503）');
  if (!config.apiKey) console.warn('⚠️ 未配置 API_KEY：x-api-key 通道全部拒绝，脚本类写请求会 401');
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
  // 这里的列形状就是【S-03f】写入侧只收 01-30 的依据：UI 的预设目录签是写死的 01-30，
  // 存进来的 folder_id 必须是同一套键，否则那条记录在界面上永远渲染不出来（看不见也删不掉）。
  // 曾经还有一列 folder_name VARCHAR(100)：三端零写零读，新建库里已去掉；
  // 生产那列还在（NULL 到底），DROP 属于不可逆 DDL，留到预设层这轮稳定后单独点头再动。
  db.query(`
    CREATE TABLE IF NOT EXISTS preset_materials (
      id VARCHAR(36) PRIMARY KEY,
      folder_id VARCHAR(50) NOT NULL,
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
  if (isNaN(code) || code <= 0) { safeUnlink(req.file.path); return res.status(400).json({error:'version_code 必须是正整数'}); }

  // 查重：同一 version_code 不允许重复上传
  db.query('SELECT id, version FROM apk_versions WHERE version_code = ?', [code], async (err, dups) => {
    if (err) return res.status(500).json({error:err.message});
    if (dups && dups.length > 0) {
      safeUnlink(req.file.path);
      return res.status(409).json({error:'版本号 ' + code + ' 已存在（v' + dups[0].version + '），请使用新的版本号'});
    }

    let md5 = null;
    try { md5 = await fileMd5(req.file.path); } catch (e) { console.error('上传 APK 算 MD5 失败:', e.message); }

    // 先插新行（is_latest=0），成功后再把旧的清零、把新的置 1。
    // 以前是反顺序：先 UPDATE 全表 is_latest=0 再 INSERT —— INSERT 一失败（version 超 VARCHAR(50)、
    // 连接抖一下都算），全库就没有任何"最新版"了：/api/version/latest 回 {}、push-update 404，
    // OTA 链路静默断到下次上传为止，而 public/apk 里还留着刚落盘的大包没人引用。
    const filepath = '/apk/' + req.file.filename;
    db.query(
      'INSERT INTO apk_versions (version, version_code, filename, filepath, size, md5, changelog, is_latest) VALUES (?, ?, ?, ?, ?, ?, ?, 0)',
      [clampStr(version, 50), code, req.file.filename, filepath, req.file.size, md5, changelog || ''],
      (err2, result) => {
        if (err2) {
          // 行没建成，文件就是纯垃圾，立刻回收（200MB 级别）
          safeUnlink(req.file.path);
          return res.status(500).json({error:err2.message});
        }
        const newRowId = result.insertId;
        // 两条 UPDATE 任一失败都回滚新行：留着两个 is_latest=1 时，取最新的
        // SELECT ... LIMIT 1 会随机挑一行，推送/轮询可能把旧版本当最新版发给设备
        const promote = () => db.query('UPDATE apk_versions SET is_latest = 1 WHERE id = ?', [newRowId], (err3) => {
          if (err3) return rollback(err3);
          res.json({success:true, id:newRowId, filepath, md5});
        });
        const rollback = (err3) => db.query('DELETE FROM apk_versions WHERE id = ?', [newRowId], () => {
          safeUnlink(req.file.path);
          res.status(500).json({error:err3.message});
        });
        db.query('UPDATE apk_versions SET is_latest = 0', (err) => {
          if (err) return rollback(err);
          promote();
        });
      }
    );
  });
});

// 【S-12d】 删除 APK 版本（物理文件 + apk_versions 表记录）
// 最新版不许直接删：删掉后 is_latest 一行都不剩，/api/version/latest 回 {}、
// push-update 一律 404，OTA 链路就这么静默断掉（界面上只是"某一行不见了"）。
// 要换新最新版就上传新版本（S-12c 会自动把 latest 移过去）。
app.delete('/api/versions/:id', (req, res) => {
  const id = req.params.id;
  db.query('SELECT filepath, is_latest FROM apk_versions WHERE id = ?', [id], (err, results) => {
    if (err) return res.status(500).json({error:err.message});
    if (results.length === 0) return res.status(404).json({error:'版本记录不存在'});
    if (results[0].is_latest) return res.status(409).json({error:'这是当前最新版，删掉后设备将无版本可更新；请先上传新版本再删旧版'});
    // 先删记录再删文件：反顺序时若 DELETE 失败，就留下一行"记录在、文件已无"的死链，
    // 设备按 URL 下载 404，而界面看上去一切正常
    db.query('DELETE FROM apk_versions WHERE id = ?', [id], (err2) => {
      if (err2) return res.status(500).json({error:err2.message});
      const fullPath = path.join(__dirname, 'public', results[0].filepath);
      safeUnlink(fullPath);
      logAction('delete', 'apk_version', { id, filepath: results[0].filepath });
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