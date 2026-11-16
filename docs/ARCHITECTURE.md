# XVJ 系统架构文档

> 最后更新：2026-11-13
> 代码规模：前端 `public/index.html` **5365 行** · 后端 `server.js` **4014 行** · APK `MainActivity.kt` **4266 行**
> （另：`ShareCanvasView.kt` 511 行、`serial/WallPanelLink.kt` 272 行、`serial/WallPanelFrames.kt` 147 行、`serial/WallPanelParser.kt` 156 行）
>
> **本文是导览，不是契约。** 三端源码头部注释才是权威口径：
> `server.js` L1–154（表结构 / MQTT 主题 / 场景与 WinConfig 字段 / 同步触发口径）、
> `index.html` 的 `【F-XX】` 代码索引、`MainActivity.kt` 的 `【A-XX】` 代码索引。
> 两者冲突时以代码为准，并顺手把本文改对。

---

## 一、系统概述

### 1.1 三端职责

| | 前端 (Web) | 后端 (Node.js) | APK (Android) |
|---|---|---|---|
| 文件 | `public/index.html` | `server.js` | `MainActivity.kt` + `ShareCanvasView.kt` + `serial/` |
| 规模 | 5365 行，单文件 SPA | 4014 行 | 4266 行 + 511 行 |
| 技术 | 原生 JS + HTML + CSS，无框架无构建 | Express + mysql2 + mqtt | Kotlin + media3 ExoPlayer + Paho + GLES20（同格共享解码那层） |
| 职责 | 素材/客户/房间配置、窗口编辑、运维控制台 | 唯一真相源：落库、校验、下发、审计 | 瘦执行器：下素材、渲染窗口、上报状态 |
| 通信 | 只走 HTTP `/api/*`，**不直连 MQTT** | HTTP + MQTT broker | MQTT + HTTP GET（素材/清单/APK） |

### 1.2 核心设计哲学

```
房间是配置中心，设备只是执行器
        ↓
设备无交互、可替换：数据随时从云端恢复
        ↓
分布式视频伺服器，最大化减少现场人力维护
```

由此推出几条硬约束：

- **窗口数据必须按房间严格隔离**（每间房对应独立设备），前端任何缓存都要带房间归属键。
- **设备身份 = `deviceId`**：APK 首启用指纹播种后写入 SharedPreferences，之后不再变。历史版本指纹算法不同会漂移，
  所以服务端定向下发对 `{id, fingerprint}` 去重双发兜底（`publishToDeviceCommand`）。
- **云端落库后只经一个收敛点决定要不要打扰设备**（`notifyRoomConfigChanged`），前端不再自己补枪式发同步。

### 1.3 部署形态

| 层 | 实现 |
|---|---|
| 静态资源 | **nginx :80**，`root=/var/www/xvj/public` 直出（含 `/uploads/`、`/apk/`）。改前端/加静态文件**不需要重启 node** |
| API | nginx `location /api/` 反代到 **node :3000**（`proxy_read_timeout 300s`，上传要跑 ffmpeg） |
| 进程托管 | **systemd `xvj.service`**（`Restart=always`，`After=mysql.service`）。唯一自启动入口，不要再往 `rc.local` 加 |
| 数据库 | MySQL `xvj_db`（localhost:3306） |
| MQTT | mosquitto :1883，已开 `password_file`（账号 `xvj_server` / `xvj_device`）；**ACL 尚未启用**，见 §七 |
| APK 构建 | GitHub Actions（`.github/workflows/build.yml`），固定 keystore 从 Secret 恢复；产物走 OTA |
| 配置注入 | `config.js` 全部字段支持环境变量覆盖（`MQTT_*` / `DB_*` / `API_KEY` / `PORT` / `SERVER_URL`），凭据由 systemd `EnvironmentFile` 注入 |

⚠️ **broker 重启 = 全设备重连**：重连后 `register → auth_result → applySceneConfigs` 会释放并重建全部播放器，
现场视频从头播。任何 MQTT 侧切换都要挑演出之外的时间。

---

## 二、场景与输出模型

### 2.1 Scene A / Scene B 到底是什么

借鉴 Resolume Arena 的部分概念，但**不是两块独立 HDMI 输出**（旧文档这么写，代码从来不是）：

- A/B 是**两套互相独立的素材命名空间**（各自的 `folder_mappings` / `play_settings`）与各自的窗口列表。
- 设备端 `mergeSceneWindows(scenes)` 把 **A 和 B 的 windows 合并成一个数组**，按 `zIndex` 升序全部渲染进
  **同一个合成容器**（`flSurface`）。一扇窗播哪一套素材由它自己的 `content.type`（`SCENE_A` / `SCENE_B`）决定。
- 没有"当前幕"概念：切幕只是前端编辑视角，设备侧两幕的窗口同时活着。485 墙板走独立链路（见 §五.7）。

```
                 终端设备（单一合成面，按房间输出基准换算落屏）
   ┌──────────────────────────────────────────────────────────────┐
   │  zIndex 升序叠放，A/B 的窗口混在同一容器里                     │
   │   ┌─────────────┐  ┌─────────────┐  ┌─────────────┐          │
   │   │ Win(SCENE_A)│  │ Win(SCENE_B)│  │ Win(color)  │  ...     │
   │   │ 独立ExoPlayer│  │ 独立ExoPlayer│  │  占位 View  │          │
   │   └─────────────┘  └─────────────┘  └─────────────┘          │
   └──────────────────────────────────────────────────────────────┘
```

### 2.2 文件夹编号前缀与物理目录

DB 里存**未加前缀**的两位编号 `"01"`；凡经 `buildPrefixedScenes` 下发给设备的
`folder_mappings` / `play_settings` 两张表，键一律变成 `"A01"` / `"B01"`。
**`windows` 原样透传**，`content.folderId` 仍是裸 `"01"`，由设备端按 `A01`/`01` 双键回退查表。

| 下发键 | 设备物理目录（素材根 = `getFilesDir()`，内部存储免权限） |
|---|---|
| `A01`~`A30` | `filesDir/scenea/01` ~ `filesDir/scenea/30`（**小写**） |
| `B01`~`B30` | `filesDir/sceneb/01` ~ `filesDir/sceneb/30` |
| 裸 `01`~`30`（老载荷） | `filesDir/01` ~ `filesDir/30` |

解析统一走 `materialDirOf()`；开机预建三套各 30 个目录（`createMaterialFolders`）。
**素材缓存键是相对素材根的路径**（`"scenea/01/x.mp4"`），不是裸文件名 —— 否则跨目录同名文件会互刷缓存。

### 2.3 两把尺不是一回事

| 域 | 范围 | 含义 |
|---|---|---|
| 文件夹编号 | `01`~`30` | 素材分组，前端目录签写死 30 个 |
| 帧指纹 | 1~64 字节的十六进制串 | 学习绑定表（`wallpanel_bindings`）的键：整帧原样字节，不含任何厂家语义（§五.8） |
| 输出基准宽高 | `16`~`7680` px | 窗口坐标那把尺（`config.output`），见 §二.4 |

**墙板没有"编号"这一层了**（2026-11-13 整条下线）。配置页是一张 `01`~`30` × A/B 的码值表，
每行两个独立输入框：**点歌机码**与**墙板码**（同一格允许两路码各一个，谁按到都切到这一格）。
点进某一列、按一下对应的键，这一帧的指纹就落进那一格并自动保存；留空 = 那一列不响应。
原来那套「帧 → 编号 → 格子」的两跳映射只认得视翰 QB 一族，跨厂家就得再加一层；
现在的口径是**只认字节**：帧长帧头随厂家变，字节不会。DMX512 尚未实现。

### 2.4 输出基准（`config.output`，任务 #177）

窗口 `x/y/width/height` 写在哪把尺上，编辑器画布就开多大、设备就按那把尺换算落屏：

```
落屏 px = 设计 px × (屏宽 / output.w)   ← 横向
落屏 px = 设计 px × (屏高 / output.h)   ← 纵向
```

- **没设 = `1920×1080` 设计稿**（历史口径）。两轴分母不等时形状会变形：20:9 的手机上 `sx/sy = 1.25`，
  数据里的正方形落屏就是长方形。
- **设成这台屏的真实像素 ⇒ 两轴相等 ⇒ 编辑器里画成正方形，屏上就是正方形**（不用在拉伸/黑边/裁边里挑）。
  设备心跳自报 `screen_w/screen_h`（内存 90s 缓存，无 DDL），前端画布右下角一键「取本机」。
- 非法值（非整数、越界、非 `{w,h}` 对象）在写库前 400，绝不静默回落成设计稿——那等于替运营改了整间房的版式。
- 进 `roomSceneDigest`（rev），但**只在真设了时才计入**：存量房间全部没设，部署瞬间指纹逐字节不变，
  不会把全库设备判成落后各补发一次素材同步（`play_settings`「空表不落键」的同一条教训）。
- ⚠️ 改基准是**重排**不是**倒带**：已存在的窗口坐标不会被换算，原来 1920×1080 铺满整屏的窗，
  换成 2400×1080 的尺后只占画布左边一截，要手动拉大或删了重画。旧版 APK 不认这个字段（仍按 1920×1080
  理解坐标），给没升级的设备设基准反而更宽出截——前端在按钮上写明了。

---

## 三、前端架构（`public/index.html`）

### 3.1 页面

单文件 SPA，7 个页面由 `_PAGE_MAP` 统一登记（页标识 → 容器 id + 标题）。
加页只改这一处，避免"菜单点得动、容器永不显示"。

| 页标识 | 容器 | 标题 |
|---|---|---|
| `materials` | `pm` | 素材管理 |
| `devices` | `pd` | 客户管理（客户 → 房间 → 工作台三级都在这页） |
| `unregistered` | `pu` | 未注册设备 |
| `presets` | `pp` | 预设素材 |
| `versions` | `pv` | 版本管理 |
| `logs` | `pl` | 设备日志 |
| `operations` | `po` | 操作记录 |

当前页存 `localStorage.xp`，白名单外的值回落 `materials`。

### 3.2 模块索引（与代码里的 `【F-XX】` 标签一一对应）

| 标签 | 功能 | 核心函数 |
|---|---|---|
| F-00 | 写接口凭据（fetch + XHR 双覆盖） | 带同源会话 cookie；401 `LOGIN_REQUIRED` 弹口令框并重放一次 |
| F-01 | 全局状态对象 | `var s = {...}` |
| F-02 | 菜单切换与各页初始化 | `sp(p)` |
| F-03 / F-03b | 素材管理页 / 预设素材页 | `lm()` / `lp()` |
| F-04 / F-04b | 未注册设备 / 设备列表 | `lu()` / `ld()` |
| F-04c | 设备手动命令 | `sendDeviceCommand()`（stop / 强制对账 / 重推素材） |
| F-05 | 设备授权 | `ar()` → `confirmAuth()`（一次 POST 同时授权与绑房） |
| F-06 ~ F-06d | 房间列表 / 选房 / 新建 / 工作台 | `lr()` / `sr()` / `createRoom()` / `rmDevice()` |
| F-06e | 工作台模式开关与互斥 | `sfW()` / `sfCrop()` / `sfWP()` / `sfPS()`，草稿确认统一在 `_exitTableModes()` |
| F-06f | 墙板配置表（含学习区） | `renderWpEditor()` / `wpSave()` / `wpLearnStart()` / `wpBindFrame()` / `wpUnbind()` |
| F-06g | 播放设置表 | `renderPsEditor()` / `psSave()` |
| F-07 | 素材推送 | `showPushDialog()` / `doPushToRoom()` |
| F-08 / F-08b / F-08d | 删房间素材 / 调试开关 / 大屏试播 | `rmRoomMat()` / `toggleRoomDebug()` / `pvMat()` |
| F-09 | 窗口编辑器 | `renderWinEditorFull()` / `saveWindows()` |
| F-09b | 输入截取 crop 数据模型与控件 | `_cropOf()` / `_setWinCrop()` / `updWinCropField()` |
| F-09c | 画布吸附（纯编辑辅助） | `_snapLines()` / `toggleSnap()` |
| F-09d | 自动同步 | `autoSyncWinConfig()` / `flushAutoSync()` |
| F-09e | 输入截取取景画板 | `renderCropEditor()` |
| F-09f | 房间输出基准（画布那把尺） | `_designOf()` / `_roomDesign()` / `saveOutputBase()`（§二.4） |
| F-10 | 设备日志页 | `loadDeviceLogs()` |
| F-11 | 客户/店铺两级 Tab | `rd()`（`sd`/`as`/`ds`/`rs`/`rr`） |
| F-12 | 版本管理页 | `lv()` / `lvd()` / `uv()` / `dv()` / `pushUpdate()` / `pushVersionToAll()` |
| F-13 | 操作记录页 | `loadOpLogs()` |

> `logAction()` 只是往 `POST /api/log` 打埋点；服务端另有同名的写库函数，两者不是一回事。
> **设备日志（`device_logs`，设备自己上报）与操作记录（`operation_logs`，控制台审计）是两张表、两个页面。**

### 3.3 全局状态对象 `s`

```javascript
var s = {
    folders: {},   p: 'materials',  f: '01',      // 文件夹备注 / 当前页 / 当前文件夹
    _windowEditorActive: false,                  // 工作台「窗口配置」模式
    _cropMode: false,                            // 「输入截取」模式（依附于窗口配置）
    _wpMode: false,  _wpDraft: null,             // 「墙板配置」模式 + 草稿（只跟当前房间绑定）
    _wpTgt: null,    _wpFrames: [],  _wpLearnUntil: 0,   // 学习区界面态：这帧落到哪 / 设备上报的最近帧 / 本地倒计时
    _psMode: false,  _psDraft: null,             // 「播放设置」模式 + 草稿（同上）
    _snap: true,                                 // 画布吸附开关（localStorage 本地偏好）
    fs: [], ms: [], pm: [], ds: [],              // 文件夹 / 素材 / 预设素材 / 设备
    selected: [], stores: [],
    df: null, rf: null, rooms: [],               // 当前客户 / 当前房间 / 房间列表
    devicePollInterval: null,
    _preview: null,                              // 最近一次大屏试播的结果（err 有值=没发出去）
    logAutoRefreshTimer: null, opAutoRefreshTimer: null, opLogs: [],
    loadingMaterials: false, lmCallId: 0, _lmCallCounter: 0, _lastLmCallId: ''
};
```

`pm`（预设素材）必须在房间工作台也可用：「已映射素材」按 id 在这里查名字，不能只在预设页加载。

### 3.4 工作台三模式互斥

右侧工作区同一时刻只摆一样：**窗口编辑器**（输入截取画板依附于它）/ **墙板配置表** / **播放设置表**。
打开任意一个之前先过 `_exitTableModes()`：另两张表若有未保存草稿就问一句，用户选留下就把刚拨的开关拨回去。

- 开关显示态以 `rmDevice()` 按 `s` 上的模式标志重画为准；`sfCrop` 是例外 —— 它不一定重渲染工作区，
  所以自己就地补一次滑条底色/圆点。
- `sfW` 是同步函数；`sfCrop` / `sfWP` / `sfPS` 是 async，切模式前必须 `await flushAutoSync()`
  把攒着的窗口编辑落库，否则读后写会拿旧快照覆盖。

### 3.5 自动同步链路（前端不碰 MQTT）

```
编辑完成（松手 / 输入防抖 / 滑条 change）
      ↓ autoSyncWinConfig()  500ms 防抖，拖动过程中零请求
saveWindows(silent=true)
      ↓ PUT /api/rooms/:id/windows  body 带 live:true
服务端：无条件落库 → notifyRoomConfigChanged → publish update_windows
      ↓
设备 applyLiveWindowUpdate()：原地改视图，不释放播放器、视频不从头播
```

手动「💾 保存并推送」= `saveWindows()` 不带 `live` → 走全量同步（素材对账 + 通知全部设备）。
`addWin` / `delWin` / `updSceneMaster` 也走全量。

### 3.6 取数与渲染口径

- 读接口一律 `apiGet` + `asList` / `asObj` 兜底（DB 宕机时 API 可能返回非数组，裸 `.filter` 会连带炸）。
- 写接口不能只看 `res.ok`，要读响应体判成功。
- **读后写必须先重新 GET**（`mapPreset` / `toggleRoomDebug`）：`s.rooms` 是几分钟前的列表快照，
  整份 PUT 会抹掉期间别人改的映射。
- 写请求显式带 `headers:{'Content-Type':'application/json'}`。
- 轮询用轻量 `pd()`（只刷设备区），不整页重绘 —— 全量重绘会在点击瞬间替换 DOM 吞掉点击。
- 房间工作台在 `#pd` 容器里：脚本驱动 UI 前必须先 `sp('devices')`，否则整棵子树 `clientWidth=0`，
  几何断言会双向出错。

---

## 四、后端架构（`server.js`）

### 4.1 依赖与模块索引

```javascript
const express = require('express');
const mysql   = require('mysql2');
const mqtt    = require('mqtt');
const cors    = require('cors');
const { v4: uuidv4 } = require('uuid');
```

| 标签 | 内容 |
|---|---|
| S-01 | 数据库初始化 & MySQL 连接池 |
| S-02 | 素材管理（`GET /api/materials`、`DELETE /api/materials/:id`、`POST /api/upload`）**没有 POST /api/materials，入库只走 upload** |
| S-03 | 预设素材（`/api/preset/materials*`） |
| S-04 | 房间 CRUD（含 `PUT /api/rooms/:id/windows`） |
| S-05 / S-05p | 授权 & 设备管理 / 大屏试播（`resolvePreviewTarget`） |
| S-06 | MQTT 收发、载荷组装与变更收敛（`roomSceneDigest` / `roomSyncFields` / `syncCommandPayload` / `windowCommandPayload` / `notifyRoomConfigChanged` / `reconcileDeviceRev` / `resolveDeviceId`；输出基准 `roomOutputField` + 心跳自报屏幕的内存缓存 `rememberDeviceScreen` / `deviceScreen`，见 §二.4） |
| S-07 | 素材同步 & 删除 |
| S-08 | 日志 & 操作记录（`logAction`） |
| S-09 | 静态文件 & 前端页面 |
| S-10 | 文件夹管理 |
| S-11 | 店铺管理 |
| S-12 | 版本管理 & OTA |
| S-13 | 配置 & 默认素材 & 未注册设备 |
| S-14 | 会话鉴权（口令换 cookie） |

### 4.2 API 路由全表

**鉴权**：`app.use('/api', ...)` 对 **POST / PUT / DELETE** 要求二者之一（见【S-14】）：
① 浏览器带来的会话 cookie `xvj_session`（`POST /api/session` 用管理口令换，12 小时有效，HttpOnly + SameSite=Lax，
无状态 HMAC 签名，换口令即整体失效）；② `x-api-key`（header 或 `query.apiKey`，值取 `config.apiKey`）——
留给自测脚本与机器客户端。两条凭据都只从 `/etc/xvj/web.env` 读，仓库与页面里都不再有明文。
GET / OPTIONS / HEAD 开放（设备端只做 GET）。前端由【F-00】负责带 cookie 与"401 就弹口令框后重放"。

| 分组 | 路由 |
|---|---|
| 素材 | `GET /api/materials` · `GET /api/materials/:id/usage` · `DELETE /api/materials/:id` · `POST /api/upload` |
| 预设 | `GET/POST /api/preset/materials` · `GET /api/preset/materials/:id/usage` · `DELETE /api/preset/materials/:id` |
| 文件夹 | `GET/POST /api/folders` · `DELETE /api/folders/:name` · `POST /api/folders/note` · `GET /api/folders/notes` |
| 客户 | `GET/POST /api/stores` · `PUT/DELETE /api/stores/:name` |
| 房间 | `GET/POST /api/rooms` · `GET/PUT/DELETE /api/rooms/:id` · `PUT /api/rooms/:id/windows` |
| 房间素材 | `GET /api/room-materials-v2/:roomId`（设备清单出口） · `POST /api/rooms/:id/sync` · `DELETE /api/rooms/:roomId/materials/:materialId` |
| 试播 | `POST /api/rooms/:id/preview` · `POST /api/rooms/:id/preview/stop` |
| 设备 | `GET /api/devices` · `DELETE /api/devices/:id` · `POST /api/devices/:id/block` · `POST /api/devices/:id/command` · `POST /api/devices/:id/authorize` · `POST /api/devices/:id/deauthorize` · `POST /api/devices/:id/bind-room` · `GET /api/unregistered` |
| 版本/OTA | `GET /api/versions` · `GET /api/version/latest` · `POST /api/versions/upload` · `DELETE /api/versions/:id` · `POST /api/device/version` · `GET /api/device/versions` · `POST /api/devices/:id/push-update` · `POST /api/versions/:id/push-to-all` |
| 日志 | `GET /api/logs`（操作记录） · `GET /api/device_logs`（设备日志） · `POST /api/log`（前端埋点） |
| 配置/默认素材 | `GET /api/config` · `GET/POST /api/config/:deviceId` · `GET/POST /api/default-materials` · `DELETE /api/default-materials/:id` |
| 静态 | `GET /` · `GET /mqtt.min.js` · `/uploads`（express.static） |

**已不存在的路由**（旧文档里有，别再照着调）：`POST /api/devices`（手工白名单，绕过审核）、
`POST /api/materials`、`POST /api/devices/push-update-all`、`preset_sync` 相关全部。

**`GET/POST /api/config/:deviceId` 与出站主题 `xvj/device/{id}/config` 目前没有任何调用方**
（前端和 APK 都不碰），实际处于停用状态。

### 4.3 MQTT 主题

服务端 `subscribe('xvj/device/#')` + `subscribe('xvj/auth/response')`。

| 方向 | 主题 | 说明 |
|---|---|---|
| 入 | `xvj/device/register` | 注册（`deviceId` 在 payload，无第二段） |
| 入 | `xvj/device/{id}/status` | 心跳：`version` / `model` / `mac` / `rev`（已应用配置指纹）/ `syncing` / `frames`（最近收到的 485 帧，见 §五.8） |
| 入 | `xvj/device/{id}/frames` | 学习窗内的帧候选快照 `{learning, frames:[{hex,n,age}]}`，只进服务端内存台账（`DEVICE_FRAMES_TTL` 120s，无 DDL） |
| 入 | `xvj/device/{id}/request` | 设备主动请求配置 |
| 入 | `xvj/device/{id}/log` | 设备日志上报（远程 DEBUG 通道） |
| 入 | `xvj/auth/response` | 设备回复 deauthorize |
| 出 | `xvj/device/{id}/command` | 命令下发，QoS1 非 retain，对 `{id, fingerprint}` 去重双发 |
| 出 | `xvj/device/{id}/config` | 仅 `POST /api/config/:deviceId` 会发，**无调用方，停用** |
| 出 | `xvj/auth/response` | ⚠️ **全设备共享广播**，载荷含完整 scenes/folder_mappings → 见 §七 P1-4 |

**服务端自己也订阅 command 通配**，等于自带抓包：`journalctl -u xvj.service` 里
`📨 设备命令: <id> -> <完整 JSON>` 就是下发取证的第一现场。

### 4.4 同步触发收敛（最重要的架构约定）

房间 config 落库后**一律只经 `notifyRoomConfigChanged`** 决定是否打扰设备，四类**并列判定**（不是 else-if）：

| 变化 | 下发 |
|---|---|
| 素材映射变了（`roomMappingDigest`） | `sync_room_materials`（全量对账） |
| 窗口 / 总亮度 / 播放设置 / 输出基准变了（`roomSceneDigest`） | `update_windows`（轻通道，设备原地改视图；只改基准也是在这一跳按新分母重排几何） |
| `debug` 变了 | `set_debug` |
| `wallpanel_*` 变了 | `set_wallpanel` |
| 什么都没变 | 一条不发 |

同一次 PUT 既改学习绑定又开总闸就两条都发；命中全量同步时轻枪省掉（它的载荷已带这些字段）。
日志前缀 `🔔`。

**兜底是 rev 对账**：命令带 `rev = roomSceneDigest(config)`，设备心跳回传已应用的 rev，
服务端发现落后就补发一次（**3 分钟/台节流**），所以设备离线期间的变更会在上线后收敛。

⚠️ **两个故意不进指纹的例外**：`debug` 与 `wallpanel_*`（总闸/串口节点与字符格式/学习绑定表）都不参与 `roomSceneDigest`
—— 开个开关不该惊动素材同步。代价是它们对不上账、**不会被心跳对账补发**；命令是 QoS1 非 retain，
设备正好掉线那一跳就会丢，靠下次重连的 `auth_result`（或手工 sync 载荷）里的同名字段自愈。
> 现场口径：「云端开了开关但大屏没反应」→ 先让设备重连一次或点一次手工同步，别急着怀疑开关本身。

⚠️ **空表落键口径**：`folder_mappings` 恒在（空表也是 `{}`），`play_settings`
**空表不落键** —— 否则新增字段会让每间存量房间的 rev 漂移，触发一轮无谓全量同步、现场视频集体从头播。

### 4.5 config 写库口径

`POST /rooms` 与 `PUT /rooms/:id` 共用一个净化入口 `prepareRoomConfig`：

```
JSON 合法性 → scenes 脏键过滤 → 顶层键「incoming 覆盖、其余继承 DB」
→ 墙板字段按下发口径归一 → 播放设置校验 → 逐幕合并
→ 学习绑定校验（帧形状 + 格子号 + 来源取值，最多 64 条；同格两列各一条）
```

任一步不过就 **400，绝不带病入库**：脏值一旦落库，后续不带 `wallpanel_bindings` 的 PUT 会继承它再撞上同一道校验，
这间房就再也存不进配置了。顶层继承同时挡 `__proto__` / `constructor` / `prototype`（原型污染）。

`PUT /rooms/:id` 只接受 `name` / `config`（房间不跨客户迁移）。
`PUT /rooms/:id/windows` **无论 live 与否都落库**，`live` 只影响设备通知方式；
按 `room_id` 查设备做定向发送**必须带 `authorized = 1` 过滤并逐台 publish** ——
房间设备记录会因卸载重装无限累积，取 `rows[0]` 会把命令全发给不在线的幽灵设备。

### 4.6 数据库表

| 表 | 用途 |
|---|---|
| `materials` | 素材库。视频上传时重封装为 faststart；`md5` 存**落盘后字节**的摘要（视频在重封装之后才算） |
| `preset_materials` | 预设素材（从素材库复制，可跨房间复用） |
| `rooms` | 房间配置中心。**真相在 `config` 这个 JSON 列**；表上的 `folder_mappings` 列是建表遗留，只在 INSERT 时写 `'{}'`，读侧无人使用 |
| `stores` | 客户/店铺 |
| `devices` | 设备注册表（`authorized` / `status` / `room_id` / `fingerprint`） |
| `default_materials` | 默认（欢迎）素材 |
| `folder_notes` | 文件夹备注 |
| `operation_logs` | 控制台操作审计（`logAction` 写入，**每小时清理 30 天前**） |
| `device_logs` | 设备日志（MQTT log 主题上报，按设备分区留 2000 条） |
| `apk_versions` | OTA 包（含 `md5`） |
| `device_versions` | 每台设备实际版本（心跳 upsert） |

> `device_versions` / `device_logs` 写入前都要过 `resolveDeviceId()`：设备自报 id 可能是指纹而非规范 `devices.id`
> （每次装机都会漂一次），不归一就会写出旁表孤儿行，版本页/日志页按规范 id 查永远查不到。

---

## 五、APK 架构（`MainActivity.kt`）

### 5.1 构建参数

| 项 | 值 |
|---|---|
| 语言 / JVM | Kotlin，`jvmTarget 17` |
| SDK | `compileSdk 34` / `targetSdk 34` / `minSdk 24` |
| 当前版本 | `versionCode 170` / `versionName "170"`（**运行时读 `packageInfo`，绝不硬编码**） |
| 播放器 | `androidx.media3:media3-exoplayer/ui/common` **1.2.1** |
| MQTT | Eclipse Paho，`clientId == deviceId`，凭据由 `BuildConfig.MQTT_DEVICE_PASSWORD` 注入（CI Secret，缺省空串=匿名） |
| 签名 | 固定 debug keystore（CI 从 Secret 恢复到 `~/.android/debug.keystore`）。**keystore 绝不进公开仓库** |

⚠️ media3 **1.2.1** 没有 `VideoSize.frameRate`（1.3+ 才有）。本机无 Kotlin 编译器，
括号平衡检查挡不住这类 API 版本问题 ⇒ 改完 `.kt` 的首次 CI 构建要当"真编译"看待。
结构性体检脚本：`node 工作区/apk_artifacts/kt-balance.js <各 .kt 路径>`（跳过注释与字符串数花括号/圆括号，只挡"编辑时少了一瓣括号"）。

其余 `.kt` 文件（`BootReceiver` / `SettingsActivity` / `FolderManagerActivity` / `hdmi/*` / `serial/Hdmi*` /
`serial/Serial*`）都只有一行 `// disabled`，是历史遗留占位；`android_serialport_api/SerialPort.kt`（180 行）
全文无人引用（墙板链路改用 `Os.open` + `stty`，不走 JNI）。
**真正活着的只有 `MainActivity.kt`、`ShareCanvasView.kt`（同格共享解码的 GL 画布，见 §5.7）与 `serial/` 三件
（`WallPanelLink.kt` + `WallPanelParser.kt` + `WallPanelFrames.kt`）。**
⚠️ 但 Manifest 仍声明着那三个不存在的类，见 §七。

### 5.2 模块索引（与代码里的 `【A-XX】` 标签对应）

| 标签 | 功能 | 核心函数 |
|---|---|---|
| A-01 | 生命周期 & 初始化 | `onCreate` / `loadConfig` / `setDebugMode` / `applyDebugUi` / `onResume` / `onPause` / `onDestroy` |
| A-02 | MQTT 连接 | `connectMQTT` / `onMqttConnected` / `reconnectMQTT` |
| A-03 | 注册 & 授权 | `registerDevice` / `sendStatus` / `handleAuthResponse` |
| A-04 | 命令分发 | `handleCommand` → `when(action)` |
| A-06 | 素材同步 | `requestRoomMaterialSync` / `runRoomSyncLoop` / `doRoomMaterialSync` / `fetchRoomMaterials` / `syncSceneFolders` / `syncFolderWithIds` |
| A-07 | 窗口配置 & 渲染 | `applySceneConfigs` / `scenesFingerprint` / `enabledWindowsSorted` / `applyLiveWindowUpdate` / `createWindowView` / `resolveWindowFolder` / `playFolderInWindow`；同格共享解码那层 `createShareGroup` / `refreshShareGroup` / `destroyShareGroups`（画布在 `ShareCanvasView.kt`），日志共用 `armWindowLogger` |
| A-08 | 窗口释放 | `releaseAllWindows` |
| A-09 | OTA 自更新 | `checkForUpdate` / `isTrustedApkUrl` / `isValidFilepath` / `verifyApkSignature` / `downloadAndInstall` / `installApk` / `retryPendingInstall` |
| A-10 | 系统 UI | `hideSystemUI` |
| A-11 | 工具方法 | `logToFile` / `sha256` / `generateDeviceFingerprint` / `calculateMd5` |
| A-12 | 播放设置 | `playSettingsOf` / `playSettingsJson` |
| A-13 | 大屏试播 | `startGroupPreview` / `previewTarget` / `armPreview` / `endPreview` / `endPreviewCovering` / `abortAllPreviews`；**账按格子记**（`previews[folderKey]`），接管那一刻的正片位置抄进 `PreviewState` |
| A-14 | 墙板 485 链路 | `applyWallPanelEnabled` / `applyWallPanelFields` / `applyWallPanelBindings` / `handleWallPanelEvent` / `applyPanelSource` / `panelFolderFor` / `startWallPanelLearn` / `publishFrameSnapshot` |

> **A-05 是空号**：单播放器点播时代的 `playFromUrl()` / `playLocalVideo()` 早已删除，标签保留不复用。
> `syncRoomMaterialsAllScenes()` 也已改名，旧文档里的这两个名字都不存在了。

### 5.3 命令 action 全表（`xvj/device/{id}/command`）

| action | 行为 |
|---|---|
| `stop` | 停欢迎视频播放器 + 释放全部窗口播放器（必须 post 到主线程） |
| `config` | 改 `mqtt_server` / `loop`（只影响单播放器，不影响窗口播放器） |
| `sync_room_materials` | 房间素材全量对账 |
| `update_windows` | 轻量窗口重排，不下素材（载荷也带 `output`：只改基准时走这条轻通道原地重排） |
| `delete_material` | 删单个本地素材文件 |
| `update` | OTA：带 `url` / `version` / `md5` → `downloadAndInstall` |
| `set_debug` | 立即开关 `debug_mode`（临时值，下次带该字段的载荷会覆盖） |
| `set_wallpanel` | 立即开关 485 链路 + 串口节点与字符格式 / 学习绑定表（同样是临时值） |
| `wallpanel_learn` | 开/关学习窗（`on` + `seconds` 1~60）：开窗即清空帧台账，此后每一帧到达都上报 `frames` 快照 |
| `preview_material` | 整组接管：把**这一格的所有窗口**同时换成那只素材，播完同时回到正片同一位置 |
| `preview_stop` | 收掉试播（带 `folder_id` 收那一格整组，不带则全收） |
| `exit_desktop` | 退出到桌面：停播 + 释放窗口 + 显式把原厂桌面（HOME 候选里非本包那个）顶到身前，进程/MQTT/心跳全活着；镜像里没有别的桌面就退化成一层黑布（APK【A-15】；本机另有鼠标左键连点 5 下同一入口，但连点只管"退出"这一个方向） |
| `reopen_desktop` | 唤回画面：设备侧用 root `am start` 把自己顶回前台，回到前台那次按 `scenes_json` 缓存重建；无 root 就只放开闸门，等现场按 HOME 键或点桌面图标。已非授权态则改播欢迎视频 |

⚠️ **没有 `sync`**：服务端的 `action:'sync'` 只是 HTTP 入参，publish 前已改写成 `sync_room_materials`。
授权广播 `xvj/auth/response` 上另有 `auth_result` / `deauthorize` 两个 action，
**接收端必须按 `device_id` 定向比对**，无法确认目标的一律不动作（共享 topic 的历史事故）。

### 5.4 开机与渲染流程

```
1. APP 启动 → loadConfig() 读 SharedPreferences 的 scenes_json 缓存 → applySceneConfigs 恢复窗口
2. MQTT 连上 → register → 服务端回 auth_result（带 scenes）→ 缓存并再次 applySceneConfigs
3. 收到 command → 同步素材 / 只重排窗口 / 试播
4. 拿不到 scenes（未授权或离线）→ 停在欢迎视频，或用 scenes_json 缓存
```

**两条渲染路径的代价差别是设计依据**：

| 路径 | 触发 | 代价 |
|---|---|---|
| `applySceneConfigs` | 全量同步、授权、重连 | **释放并重建全部播放器 → 视频从头播** |
| `applyLiveWindowUpdate` | `update_windows` | 原地更新几何/属性，不重建；判定为结构变化时才回退全量重建 |

**窗口坐标怎么落屏**：`windowGeom()` 是唯一换算口，两轴各算各的比例，
分母是**这间房的输出基准**（`config.output`，没设则 `1920×1080` 设计稿，冷启动从 `output_w/output_h` 读回），
和编辑器画布那把尺同一份。写成 `屏宽/基准宽` 而不是统一比例，是为了让基准**恰好等于本机物理分辨率**时
比例恒为 1，达到所见即所得；基准与屏比例不符时会按轴拉伸，这是选择不是缺陷（§二.4）。
心跳把 `displayMetrics.widthPixels/heightPixels` 作为 `screen_w/screen_h` 回传，供后台「取本机」一键对齐基准。

**窗口该播哪一格**由 `resolveWindowFolder()` 单一入口决定（全量重建与墙板切换共用，两处各写一份口径必漂），
其中墙板那一层再经 `panelFolderFor()` 收口（只看学习绑定表，全房间只有这一条来源）：

```
content.follow=true → panelFolderFor()：
      最近一帧命中的是学习帧 → 查 wallpanelBindings（这一幕没绑这一帧 = 退回下面，不劫持）
      没按过 / 未绑 / 绑的那格没素材 → 退回下面
   ↓
content.folderId 非空 → 只播指定那格；不在映射或那格空 → null（不偷偷换播别的格）
   ↓ 两者都空
本幕第一个「有素材」的文件夹（不是固定 01）
```

**所有场景都没有窗口时**，自动为 Scene A 建一扇整屏默认窗口（尺寸=房间输出基准，`content.type = SCENE_A`），
并**必须把它塞回 `allWindows`** —— 后面那圈选文件夹的循环按 `allWindows` 查配置，漏了就是"视图建了、素材也在、画面全黑"。
第二幕默认窗口为空，由用户手动配置。

`HDMI` / `color` 两类内容目前都是**占位 View**（`createHdmiView` 只显示 "HDMI N" 文本），
没有真实采集；`HdmiManager` / `HdmiProcessor` 仍是 `// disabled`。

### 5.5 素材同步

```
云端变更 → MQTT sync_room_materials（或授权/重连）
      ↓ requestRoomMaterialSync → runRoomSyncLoop（在飞去重）
doRoomMaterialSync：拆成「计划 + 执行」两段
      ↓ fetchRoomMaterials  GET /api/room-materials-v2/:roomId
      ↓ syncSceneFolders 遍历 A/B 两幕 folder_mappings（键带前缀）
      ↓ syncFolderWithIds 逐格对账下载
落盘 filesDir/scenea|sceneb/NN，缓存键 = 相对路径
```

内容一致性判据三把钥匙：**ETag / Last-Modified / md5**，缓存键都是相对路径。
云端无 md5 且本机无 ETag/LM 缓存时，用 **size 兜底**（本地字节数 == 清单 `size` 就跳过下载），
判定特意收紧在"无复核凭据"这一格，常态条件 GET 保留。

运维信息（底部进度条、状态文字）**只在 `debug_mode` 打开时上屏**；覆盖层顺序要 `bringToFront`。

### 5.6 播放设置（A-12）

`scenes[X].play_settings` 每格只有 `{ order }`：`'seq'` 顺序循环 | `'shuffle'` 随机循环。

> **叠化（`dissolve` / `dissolve_ms`）已于 2026-11-12 从三端整条删除**：第二路预卷播放器、alpha/音量交叉淡入、
> 同步组的淡入闸门一起没了，素材轮播交接**一律硬切**（切墙板 / 切幕 / 试播接管本来也是硬切）。
> 存量格子里残留的那两个键，云端写库和下发时都会被规范化丢掉、设备端也不再读，**不必清库**；
> 只有"曾经开过叠化"的那些格子会因这一格形状变化多同步一次（视频从头播），仅此而已。

- 全默认的格子云端不落键，空表整个键都不下发 —— 否则部署那一刻存量房间的 rev 集体漂移，
  每台在线设备都被对账判成落后、各补发一次同步、视频从头播。
- 表键带幕前缀（`"A01"`），老载荷的裸 `"01"` 也认（`playSettingsOf` 双键回退）。
- 随机播放在进入文件夹时用 `items.shuffled()` 定一次序（不是 ExoPlayer 的 `shuffleModeEnabled`）；
  同格多扇窗要共洗一次，见 §5.7 的 `folderPlaylists`。
- **改设置不动映射** → 服务端发 `update_windows` 轻通道；但设置不在窗口 `content` 里，内容签名比不出它，
  所以本机另记 `appliedPlaySettingsJson`，真变了就判成结构变化回退全量重建（**视频会从头播**）。

### 5.7 同格严格同步与整组试播（A-07 / A-13）

**硬约束（2026-11-11 用户定调）：任何情况下，所有窗口的播放画面严格同步。**
多扇窗绑同一格是生产常态（201/301 四扇窗全部无 `folderId` → 都自动解析到 01），
"各放各的"从来不是设计意图，只是几处实现细节让它们在路上分家。

**同格 ≥2 扇视频窗 = 一路解码 + GL 复制 N 份画面**（任务 #175，见 §5.7.1）：散差按构造就是 0，
不存在"两路播放器要对齐"这回事。因此 2026-11-13 把 N 路解码时代那整套**同步巡检校正**整层删掉了
—— 100ms 闹钟 `playTick` / 减速贴齐 / 摁住等待 / 硬对齐 seek / 清单指纹 `playlistSig` / 3 轮熔断
（任务 #155 #156 #162，含 #166 那次"闹钟睡死"的修补）。删的理由不是它不努力，是它修不动结构问题：
308 实测同格 6 扇散差 3.5s、混进 4K 那一路凝滞 4.8s，**校正在第一次交接就熔断**，
而每一次拽回自己还要付一遍解码器重配。留着它只剩两个害处：白烧主线程 + 让"同格有几路解码"这件事在代码里含糊。

剩下的分家点只有三处，各由一处收口：

| 分家点 | 收口做法 |
|---|---|
| 每扇窗进格时独立 `items.shuffled()` → 随机顺序两两不同 | `folderPlaylists[folderKey]` 按格缓存，同格共用一份清单（随机只洗一次；缓存是否在效按 URI 逐个比 `sameItems`，素材增删过自然作废） |
| 进格就从 index 0 起播 → 重进同一格等于整组倒带 | `groupClock(folderKey)` 取这一格此刻的（第几只，第几毫秒），清单对得上就 `setMediaItems(playlist, index, positionMs)` 接着走 |
| 试播只接管一扇，播完只回它自己的快照位置 | `startGroupPreview` 一次接管这一格、`endPreview` 一次归还；#175 后一格只有一路解码，同格其余窗跟着同一张画布一起回去 |

- **`groupClock` 的基准 = 组内 ID 最小、真有播放器在跑、且没在试播的那一路**，与 `ShareGroup.leaderId` 同一口径。
  #175 之后一格只有一路播放器，所以它**不再排除"正要起播的那扇自己"**：那是多路时代的口径（新起的窗停在第 1 只 0ms，
  拿它当基准会把全组拽回开头），照搬到现在会让共享组的基准窗每次重进自己那一格都从头播。
  换到别的格子时手上那份清单跟新清单逐个对不上（`sameItems` 为假），照旧从头起播 —— 判据是内容，不是格子编号。
- **不需要对齐的两种情形**：一格只挂一扇窗 → 本来就是唯一那一路；两扇窗播**不同**的格子 → 屏上就是两只
  不同的片子，各走各的正是预期。
- **同步不再有运行时手段**：变速（`PlaybackParameters` —— media3 1.2.1 变速即变调，±3% 就听得出走调）、
  摁住（`playWhenReady=false`，一扇窗定在屏上比散一次交接严重）、硬拽（`seekTo`，每次付一遍解码器重配）
  这三样随这一层一起删掉了，代码里剩下的 `playWhenReady` / `seekTo` 只服务于试播的接管与归还，不再参与同步。
  以后若要求"不同格的切换也落在同一帧"，那是 §5.7.1 那条 GL 合成路的延伸（把多格喂进同一张画布），
  不是把巡检捞回来。

- **同格的同帧精度取决于解码方式**：≥2 扇窗并到一路解码之后，N 张画面是同一张纹理的各份拷贝，
  天生同帧（§5.7.1）。剩下的 0.1~0.5s 级别误差只出现在"两个不同格子并排"那种情形 —— 两路独立解码，
  各自的首帧凝滞不同，那本来就不是同一只片子，不需要同帧。

**整格试播**（接管范围与"几路解码"无关；#175 后一格只有一路解码，账因此按格子记）：

- 设备端**不认云端算好的 `win_ids`**：云端按库里那份配置算窗，设备却可能刚应用过更新的一版，
  那一刻"谁在播这一格"只有设备知道。`previewTarget()` 按本机 `VideoSurface.folderKey` 认那一路解码，
  `win_ids` 只在 `folderKey` 还没落上时兜底，**且兜底名单也要按幕筛过**（`sceneOfWindow()`：
  先认 folderKey 的幕前缀，落不上再查生效配置里的 `content.type`）；云端 `resolvePreviewTarget`
  因此返回**整组名单**（`winIds` 按 zIndex 降序，第一扇留作旧包的 `win_id` 兜底与日志显示）。
- **试播的账按格子（`folder_id`）记，归还也只认 `folder_id`**：`previews[folderKey]` 里那一格只有条账，
  账上记的是那一路解码（共享组的基准窗）。云端点名的 `win_id` 是 zIndex 最高那扇，往往正是没有播放器的成员，
  拿它去设备上找账会一声不响地找不到 —— 页面却已经清了状态条，看起来就像「提前结束」按了没反应
  （#175 之后共享解码组才有的这条断链，2026-11-13 改按格子记账后按构造不存在）。
- **手动试播 = 最高权限（2026-11-11 用户定调）**：点任意一格的素材都要立即接管、播一遍、回到原位，
  不再要求"恰好有窗口绑定/跟随这一格"。`resolvePreviewTarget` 命中这一格的窗口优先；一格都没绑定时
  退回接管**本幕全部启用窗口**（设备只落真在屏上的那些），没配窗口的房间则落 APK 自建的默认窗 `win_1`。
  素材在不在设备上仍由"必须在本房间本格映射里"这道校验兜底（映射过的格才会同步到本机），所以能点的素材必然播得动。
- **试播的作用域止于那一幕（2026-11-12 用户定调）**：一只素材只在一个物理目录、只属于一幕，
  另一幕来源的窗口跟它没有任何关系。曾出过的现场事故：试播第一幕 02，第二幕来源的窗口5 也跟着播 ——
  那是"一格没绑定时接管全部启用窗口"这条回退跨了幕。回退名单与设备兜底都改成只取本幕后，
  这一幕自己的窗口照样整组接管，`B/02` 那种"另一幕的同号格没素材"根本不会被点到（映射校验先拦 400）。
  **判据是 `content.type`（SCENE_A / SCENE_B），不是窗口躺在 `scenes.A.windows` 还是 `scenes.B.windows` 里**：
  APK 一直是把两幕数组合并（`mergeSceneWindows`）再按 `content.type` 逐窗定归属的，201 现场那扇 SCENE_B 的
  窗口5 就存在 `scenes.A.windows` 里（B 数组反而空）。回退第一版按数组取窗，第二幕算不出任何窗口，
  当场表现为"试播第二幕 01 无反应"（`resolvePreviewTarget` 返回 null → 409，一条 MQTT 都没发）。
  云端因此同样在**合并后的窗口表**上筛 `content.type`（`resolvePreviewTarget` 的 `allWindows`）。

#### 5.7.1 同格共享解码（任务 #175，`ShareCanvasView.kt`）

**它治的是结构问题，不是调参问题**：同一格挂 N 扇窗，以前起 N 路 ExoPlayer、N 个 MediaCodec 解同一条码流，
交接延迟与凝滞按窗数线性放大（308 实测 6 扇同格散差 3.5s、混进 4K 那一路凝滞 4.8s，同步校正因此在第一次交接就熔断）。
解出来的画面明明一模一样，却付了 N 遍解码。现在 **1 路解码 → GL 复制 N 份**：

- `applySceneConfigs` 先把每扇窗该播哪一格解析出来（`enabledWindowsSorted` + `resolveWindowFolder`），
  同格 ≥2 扇的**视频**窗合成一个 `ShareGroup`：一路 ExoPlayer 输出到画布自己的离屏 `SurfaceTexture`，
  `ShareCanvasView` 在独立 GL 线程把这张外部纹理按每扇成员窗的位置/尺寸/取景/旋转/镜像/透明度/亮度各画一遍。
  复制发生在 GPU 上，代价与窗口数基本无关。
- **成员窗不再有自己的播放器**：`windowPlayers[leaderId]` 是唯一真值，基准 = 组内 ID 最小那扇（与 `groupClock` 同一口径）。
  `playFolderInWindow` 里跟随那几扇只代记 `folderKey` / `settings`，试播范围、墙板认成员、日志扇数都按这张账找到整组
  （`previewTarget` 只认有播放器的基准那一路，扇数由 `winShareGroup` 换算）。
- 单窗房间、以及一格只有一扇窗的房间**完全不走这条路**，渲染链路逐字节照旧。
- 代价（已与用户确认）：整组是一块画布（成员矩形的并集），跨组的 z 交错没了；音频只剩一路。
- 组构成变化只由全量重建负责（`update_windows` 轻路径只重排几何 `refreshShareGroup`）；墙板绑定若把成员分到不同格子，
  `applyPanelSource` 检测到就回退全量重建。
- ⚠️ **未真机验证**：GL/EGL 在 RK3588 盒子上首次跑这条路，三处必须上机看 —— `bindWindow` 把解码端
  （离屏 `SurfaceTexture` + `Surface`）生在常驻上下文里、经 `onDecoderSurface` 回主线程喂播放器；
  帧驱动（`onFrameAvailable` → GL 线程 `updateTexImage`）跟不跟手；切后台再回来，承载 st 换了一块而
  上下文与解码端都不动，画面能不能复活。

### 5.8 墙板 485 链路（A-14 + `serial/`）

**上游不是墙板，是中控**：它把点歌机和墙板两家的流量合进同一根 485（同一只后面板 RJ45），
所以这一条链路必须同时吃「认识的帧族」和「从没见过的帧」——字节先收下、含义后判定。

两层字段各司其职（编号那一层已于 2026-11-13 整条下线，现口径见 §二.3）：

| 层 | 字段 | 作用 |
|---|---|---|
| 房间 config 顶层 | `wallpanel_enabled` | 链路总闸（**严格 `true` 才算开**） |
| 房间 config 顶层 | `wallpanel_serial_path` / `_baud` / `_data_bits` / `_parity` / `_stop_bits` | 串口节点 + 波特率 + 字符格式（各家面板默认值不同，白名单与 `WallPanelLink` 同一份；非法值写库前 400，不静默回落） |
| 房间 config 顶层 | `wallpanel_bindings` | **学习绑定表**：`[{frame, folder, source}]`，`source ∈ player/panel`（点歌机/墙板，缺省 `panel`）；同一格最多两码（每列一个），同一帧只能对一个格，不分幕，上限 64 条。`source` 只供界面分列，设备端忽略 |
| 窗口 | `content.follow` | 这一窗是否跟着墙板切文件夹（只对 `SCENE_*` 有意义） |

- **`WallPanelParser.kt`**：纯字节状态机，无 Android 依赖（时间戳由调用方给，便于逐行移植成 JS 跑用例）。
  已知帧族查 `PROFILES` 表按定长切帧 + 校验（QB 6 字节、VOD 方向帧 5 字节…，`0x21` 家族解成 `NumberSelect`，
  其余只当指纹）；**帧头不认识就攒进 64 字节缓冲，等线路安静过 `gapMs` 整段吐出一个 `Unknown`** —— 即 Modbus/DMX
  那套空闲断帧，不需要知道别家帧长，只需要它一帧之内不静默。`gapMsOf(baud, 数据位, 校验位, 停止位)` = 2 个字符时间，
  速率没下发按 9600 估（估小了一帧会被切成两半，估大了只推迟几毫秒）。读线程按 `parser.busy()` 加密轮询、
  空闲慢轮询省电；校验不过逐字节滑动重同步，容忍噪声与粘包。
  ⚠️ 已知代价：中控把两帧零间隔转发过来会切成一长帧 —— 所以每台机都要能把实际收到的字节亮给人看。
- **`WallPanelLink.kt`**：`android.system.Os` 直接开 `/dev/tty`（`O_RDWR|O_NOCTTY`），不依赖 `.so`。
  termios 交给 toybox `stty`（公开 SDK 没有 termios 结构体）：`raw -echo cs<N>` + 校验位三档
  （none=`-parenb` / odd=`parenb parodd` / even=`parenb -parodd`，**必须是多个 argv**）；
  设不上只告警继续收帧，不为参数杀掉整条链路。打开失败/中途断掉按 **5s→10s→20s→30s** 退避自动重开
  （大屏设备基本不重启，一次失败就放弃等于永久失灵）。单一 fd 持有者 + 代数守卫，避免关掉刚重开好的串口。
- **`WallPanelFrames.kt`**：`WallPanelHex`（大写偶数长度 hex，1~64 字节，与服务端 `WALLPANEL_FRAME_HEX_RE` 同闸）、
  `WallPanelFrameLedger`（容量 24 条 / TTL 60s，`{hex, n, age}`，学习窗开始时清空）、
  `WallPanelBindings.parse`（一张按帧查的表，脏规则当场丢，同帧后写的覆盖；`source` 不读）与 `PanelSource` / `PanelAction`。
- **判义次序**（`handleWallPanelEvent`，一处收口）：帧先记进台账 → **学习绑定表命中就切格**（跟随窗问同一张表，
  不分幕；同一格可能挂着点歌机与墙板两路码，设备不区分来源，谁按到都切这一格）→ 没命中就只留痕（日志带 hex 与帧族标签），不动画面。
  **一帧落到"当前正在播的那一格" = 该格播下一支**（`advancePanelFolder` 用播放器自己的"下一支"，次序就是播放设置那份：顺序=文件名、随机=只洗一次后的固定次序；
  一格一路解码，只推基准窗一次）；判据看**落点**而不是看帧是否相同——点歌机码与墙板码可能指向同一格，交替按也不该把画面拽回第一支。
  **300ms 内**的同一帧当按键重复帧去抖（墙上按键常按下/松开各发一帧），超窗才算下一支。已知帧族解析出来的编号**再没有下游可查**，
  只用于日志里标一下"这一帧是编号键"。
- **帧的可见性**（学习与排障都靠它）：每一帧都进台账，随心跳带最近 8 条（`status.frames`，空则整段不带）；
  学习窗内每一帧到达额外发一次 `xvj/device/{id}/frames` 快照（≤8 条，`{learning, frames, timestamp}`）。
  服务端只存内存（`DEVICE_FRAMES_TTL` 120s / `DEVICE_FRAMES_MAX` 8，无 DDL），经 `GET /api/devices` 的 `d.frames`
  给前端「这一分钟总线上飞过什么」的学习区。学习窗由 `POST /api/rooms/:id/wallpanel/learn`（`seconds` 1~60）开闸。
- **墙板字段全部不进 rev**（含字符格式与学习表），自愈口径同 `debug`（见 §四.4）：
  「按一鍵学一条」绝不该引发全量素材重下；变更走轻量 `set_wallpanel`，其判据是 `roomWallpanelDigest`
  （= `JSON.stringify(roomWallpanelFields(cfg))`，学习表按帧排序后入指纹，同批规则换个录入顺序不算改动）。

### 5.9 OTA

`checkForUpdate` 按「远端 > 本机」判定 → 下载 → **md5 校验** → **签名校验**
（`EXPECTED_CERT_FINGERPRINT` = 整张 X.509 证书 DER 的 SHA-256，小写无冒号，**不是 SPKI**）→ `installApk`。

`installApk` = 权限闸门（`canRequestPackageInstalls`，无权限跳设置页并暂存，`onResume` 续装）+ 系统安装器。
**静默安装未做**：等上 RK3588 盒子再按环境选 root `pm install` 或 device-owner `PackageInstaller`，届时只换这一个实现。

下载 URL 走 **nginx :80** 直出 `/apk/`，node 本身不伺服 APK。
`filepath` 统一存 `/apk/xxx.apk`（带前导斜杠），下发 URL = `APK_DOWNLOAD_BASE + filepath`。

⚠️ 装机按"清了数据"处理：prefs 全空 → 身份播种成指纹 → **每次 OTA 设备身份漂一次**（云端已用 `resolveDeviceId` 收口），
且 ETag/LM/md5 缓存全丢 → 首轮同步可能整目录重下（size 兜底就是为此加的）。
覆盖安装后进程被杀、**应用不会自启**，需手动打开一次才会重连并回报新版本。

---

## 六、数据模型

### 6.1 房间配置（`rooms.config`，JSON 列 = 唯一真相）

```javascript
{
  scenes: {
    A: {
      name: '第一幕',
      folder_mappings: { "01": [materialId, ...], "02": [...] },
      // 键是未加前缀的两位编号；值是素材库 id 或预设素材 id，两种都合法
      play_settings: { "01": { order: 'shuffle' } },   // 全默认的格子不落键
      windows: [ WinConfig, ... ],
      master: { brightness: 1.0 }                // 场景总亮度 0..1，与窗口 brightness 相乘
    },
    B: { ... }
  },
  debug: false,                    // 运维层闸门（进度条/状态文字上屏）；不进 rev
  output: { w: 2400, h: 1080 },    // 输出基准（§二.4）：窗口坐标那把尺；没设=不落这个键，设备按 1920×1080 设计稿；进 rev
  wallpanel_enabled: false,        // 串口监听总闸，严格 true 才算开；不进 rev
  wallpanel_serial_path: '/dev/ttyUSB0',   // 串口节点，只收 /dev/ 下的设备名；非法值写库前 400
  wallpanel_baud: null,            // 1200~115200 白名单，留空 = 用驱动默认档
  wallpanel_data_bits: 8,          // 5/6/7/8 ┐
  wallpanel_parity: 'none',        // none/odd/even ├ 字符格式三档，全留空回落 8N1
  wallpanel_stop_bits: 1,          // 1/2           ┘
  wallpanel_bindings: [            // 学习绑定表：帧指纹 → 格号（判义只有这一条来源），不分幕
    { frame: 'D3', folder: '05', source: 'player' },  // 点歌机码（单字节功能码也合法）
    { frame: 'B5', folder: '05', source: 'panel' }    // 墙板码：同格两列各一个，谁按到都切到 05
  ]                                // source 缺省 = panel；上限 64 条，同帧绑多格 / 同格同列多码写库前 400
}                                  // 不进 rev；空格子 = 这一列不响应
```

### 6.2 WinConfig（服务端整体透传，不解析渲染字段，新增字段无需改后端代码）

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` / `name` | String | 窗口唯一 ID / 显示名 |
| `x` / `y` / `width` / `height` | Number | 画布坐标与尺寸（px，写在这间房的**输出基准**坐标系里，见 §二.4；设备按 屏宽/基准宽、屏高/基准高 两轴换算） |
| `zIndex` | Number | 层级，越大越上层（A/B 合并后统一排序） |
| `aspectRatio` | String \| null | 如 `"16:9"`，可选 |
| `opacity` | Number | 0..1，作用于容器 alpha |
| `brightness` | Number | 0..1，与所在幕 `master.brightness` 相乘，用黑色遮罩实现 |
| `enabled` | Boolean | false 时设备不创建播放器 |
| `flip` | `'none' \| 'h' \| 'v'` | 内容镜像 |
| `rotation` | `0 \| 90 \| 180 \| 270` | 内容在窗口框内旋转 |
| `crop` | `{x,y,w,h}` | **输入截取**（对标 Arena Slice InputRect）：素材画面内归一化 0..1 的取景区，设备拉伸填满窗口框；缺省 `{0,0,1,1}` |
| `content` | Object | 见下表 |

### 6.3 窗口内容类型（`content.type`）

**取值以前端 `saveWindows()` 实际写入的为准**：

| type | 含义 | 附加字段 | 设备实现 |
|---|---|---|---|
| `SCENE_A` / `SCENE_B` | 播该幕对应文件夹的素材 | `folderId`（裸编号 `"01"`）、`follow`（Boolean，墙板跟随） | 独立 ExoPlayer + TextureView |
| `HDMI` | HDMI 输入 | `inputIndex`（0-based） | **占位 TextView，采集未实现** |
| `color` | 纯色背景（**小写**） | `color`（如 `"#000000"`） | 占位 View |

> 旧文档里的 `COLOR`（大写）/ `IMAGE` / `VIDEO` 取值**都不存在**。设备端对 type 做 `uppercase()`，
> 所以前端写小写 `color` 能命中 `COLOR` 分支。
> `follow` 与 `folderId` 不打架：`folderId` 是"墙板没按过 / 这一帧没绑这一幕时的默认那格"。

### 6.4 素材三层架构

```
素材库 [M] ──cp2p──→ 预设素材 [P] ──mapPreset──→ 房间 [D]
                     └────────推送到房间────────┘   // 旁路：素材库 id 直接进映射（线上确实在用）
```

- 两层目录号都是 `01`~`30`（前端目录签写死）；预设侧额外用 `PRESET_FOLDER_RE` 挡区间外的值。
- **映射的值可以是素材库 id 或预设素材 id，两种都合法**（`room-materials-v2` 用 UNION 反查两张表）。
- **素材库 `filename` 在同目录内唯一**（`uniqueMaterialFilename` 自动补 `" (2)"`）——
  设备端不按 id 而按 `<目录>/<filename>` 认文件，同名会互相覆盖下载与缓存。
- **落盘名与认文件名是两回事**：磁盘上叫 `buildSafeUploadName()` 生成的
  `时间戳_uuid8_净化名.ext`（非 `A-Za-z0-9_-` 一律转 `_`、截 40 字符，天然唯一）；
  而 `materials.filename` 存的是用户原名，**设备按后者认文件**。老素材落盘就是裸名，
  就地替换要提醒强刷（`/uploads/` 带 24h 强缓存）。
- 上传类型判定**只认扩展名白名单**，没有 mimetype 兜底（否则 `evil.html` + `Content-Type: video/mp4`
  就能在无鉴权的 `/uploads/` 下写出同源 HTML = 存储型 XSS）。

---

## 七、已知缺口与待办

| 编号 | 问题 | 现状 |
|---|---|---|
| **P1-4** | `xvj/auth/response` 是全设备共享广播，载荷带完整 scenes/folder_mappings → 场端任意设备可读到别店配置 | **未修**。改 per-device `xvj/device/{id}/auth` 必须**先发新 APK（同时订阅两个主题）再改服务端只发定向**，顺序不能反 |
| **P3-10** | `x-api-key` 内嵌在公开的 `index.html` 里，写接口等于无鉴权 | **已修**（2026-11-12，见【S-14】）：管理台改为口令登录换 12h 会话 cookie，页面与仓库里都不再有凭据；`API_KEY` 已轮换并只留在 `/etc/xvj/web.env`。**仍待**「店铺独立账号」做多用户登录态（现在是一把全员共用口令，只有"能不能改数据"，没有"谁改的"） |
| broker 阶段3 | mosquitto ACL 未启用（`allow_anonymous true` 仍在） | 已在临时实例做过正/负对照验证；**前置条件是所有设备都装了 `clientId == deviceId` 的 167+**，提前开会把老包挡死 |
| HDMI 输入 | `content.type = HDMI` 只有占位视图 | `HdmiManager` / `HdmiProcessor` 仍是 `// disabled`，真采集未实现 |
| **开机自启** | Manifest 声明了 `.BootReceiver`（`BOOT_COMPLETED`，`exported=true`），但 `BootReceiver.kt` 只有一行 `// disabled`，**类不存在** → 广播投递时 `ClassNotFoundException`，开机自启这条链路是断的 | 未修。`MainActivity` 带 `HOME` category，盒子设成默认桌面时仍能起；要真自启得补回 receiver 类（需构建）。另有 `.SettingsActivity` / `.FolderManagerActivity` 两条同样悬空的声明，无人启动，属可删的死条目 |
| 墙板真机验证 | 485 物理层（波特率/字符格式/电气）未抓包，未知厂家帧的空闲断帧阈值（2 字符时间）只在盒子上才算得准 | 「按键→切窗」「学习绑定→切窗」「试播抢占跟随窗」只过了纯函数用例；真机第一眼要看的是设备列表里回传的 `frames`（分帧对不对全靠它）。另：编号层已于 2026-11-13 下线，但带编号的 APK 还没出过包，现场装的仍是旧口径 |
| 同帧精度 | 一格只挂一扇窗、或不同格并排：各路首帧凝滞不同（实测 0.12~0.55s），切点落不到同一帧 | 同格 ≥2 扇已改成 1 路解码 + GL 合成多视图（§5.7.1，任务 #175），天生同帧；**代码已就位、真机未验**（GL/EGL 首次在盒子上跑）。叠化那条路已于 2026-11-12 整条删除，同步巡检校正层已于 2026-11-13 随它一起删除 |
| 故障记录路径 | `FAULT_LOG = '/workspace/xvj-backup/故障记录.md'` 是容器时代遗留绝对路径 | 裸机上该目录不存在则写入失败（已有 try/catch 告警），崩溃现场只剩 `journalctl` |
| 静默安装 | OTA 需人工确认，覆盖安装后应用不自启 | 等上 RK3588 盒子再按环境选实现 |
| 店铺独立账号 | 现平台 = 总部端，无账号体系 | 将来每店独立账号只看自己门店，落地时窗口/素材/设备查询都要带店铺隔离 |

---

## 八、关键不变量（历史事故沉淀）

改代码前先读这一节，这些都是踩过坑换来的：

1. **按 `room_id` 查设备做定向发送，必须 `authorized = 1` 过滤 + 逐台 publish。**
   房间设备记录会因卸载重装无限累积，取 `rows[0]` 会把命令全发给幽灵设备（"保存成功但真机看不见变化"）。
2. **共享 topic 上的每条消息都要问"这是发给我的吗"。** 接收端按 `device_id` 定向，无法确认目标一律不动作。
3. **写 `status` 的 MQTT 回环处理要考虑自家 publish 触发自己**（服务端订阅 `xvj/auth/response`，
   自己发的 deauthorize 会被自己收回来覆盖 DB）。
4. **OTA 比较值和指纹 vc 段永远不要硬编码**，运行时读 `packageInfo`。
5. **新增下发字段时想清楚空表落不落键**：落错会让全库 rev 漂移 → 无谓全量同步 → 现场视频集体从头播。
6. **读后写必须先重新 GET**，`s.rooms` 是旧快照；写窗口前必须 `flushAutoSync()`。
7. **`folder_mappings: {}` 的语义是「显式清空」**，不是「不改」。别拿真实房间测这个字段。
8. **脏值绝不带病入库**：一旦落库，后续继承它的 PUT 会撞上同一道校验，这间房就再也存不进配置。
9. **进程级异常记完就 `exit(1)`**，交给 systemd 重启。只记不退会变成"MQTT/DB 活着但无 HTTP"的僵尸，
   `Restart=always` 因进程不退出而失效（2026-09-08 全站瘫 3 小时正是这个形状）。
10. **catch 掉外部进程失败的分支必须 warn 一行**，否则"代码上线了但文件字节没动"这类故障只能靠读二进制发现。
11. **前端页面容器没 `sp()` 切过去时 DOM 存在但完全没布局**，几何断言会双向出错（相等式假通过、不等式假失败）。
12. **`lr()` / `rmDevice()` 每次重绘都用 innerHTML 重建工作台**，脚本里提前捕获的元素引用会变僵尸节点。
13. **同一格的多扇窗是一个画面，不是 N 个画面**（2026-11-11 定调）。任何"只动一扇窗"的路径都会当场分裂屏幕，
    而且那一扇播完回到自己被冻住的位置 —— 这一格的轮播顺序从那一刻永久错开，现场看到的就是"顺序乱了"。
    新增接管类动作（试播、切格、重排）一律按整组下发、整组收尾。

---

## 九、文件路径与仓库

### 9.1 服务器（生产机，IP 见 `config.js` 的 `SERVER_URL` / APK 的 `APK_DOWNLOAD_BASE`）

| 用途 | 路径 |
|---|---|
| 部署根 | `/var/www/xvj/` |
| 前端 | `/var/www/xvj/public/index.html` |
| 后端 | `/var/www/xvj/server.js` |
| 上传素材 | `/var/www/xvj/public/uploads/` |
| OTA 包 | `/var/www/xvj/public/apk/` |
| nginx vhost | `/etc/nginx/conf.d/xvj.conf` |
| systemd | `xvj.service` + drop-in `/etc/systemd/system/xvj.service.d/mqtt-env.conf` |
| 服务日志 | `journalctl -u xvj.service` |
| broker 日志 | **`/var/log/mosquitto/mosquitto.log`**（journalctl 只有启动/停止行，用它查连接会误判） |
| MQTT 凭据 | `/etc/mosquitto/passwd`、`/etc/xvj/mqtt.env`（都不在仓库里） |

部署纪律：上传前先 `md5sum` 生产文件比对上一轮记录值（确认没人插过改动）→ 备份 → scp →
`node --check` → 重启 → md5 parity + `systemctl show xvj -p MainPID` 单实例确认。
**纯静态改动不重启 node**（避免设备重连、视频从头播）。
`scp` 上来的待检文件要先 `cp` 成 `.js` 再 `node --check`（`.js.new` 会 `ERR_UNKNOWN_FILE_EXTENSION`，
`&&` 链后面的 mv/restart 全部不跑，"部署看起来执行了其实没执行"）。

### 9.2 本地工作区

| 用途 | 路径 |
|---|---|
| 云端 + 前端 | `C:\Users\77977\Desktop\VJ研发\QODER工作区\xvj-cloud\` |
| APK 源码 | `C:\Users\77977\Desktop\VJ研发\QODER工作区\xvj-apk\` |
| APK 产物与取证脚本 | `C:\Users\77977\Desktop\VJ研发\QODER工作区\apk_artifacts\` |

### 9.3 Git 仓库

| 仓库 | 地址 | 可见性 |
|---|---|---|
| 前端 + 后端 | https://github.com/mason909/xvj-cloud | **公开** |
| APK 源码 | https://github.com/mason909/xvj-apk | **公开** |

### 9.4 自检脚本（`xvj-cloud/` 根目录）

| 脚本 | 覆盖 |
|---|---|
| `config-funnel-selftest.js` | config 净化漏斗 + 同步收敛（可对部署后文件跑） |
| `preview-selftest.js` | 大屏试播全链路（自建自删临时数据 + 订阅 MQTT 抓真实载荷） |
| `wp-selftest.js` / `wp-table-selftest.js` | 墙板字段（含字符格式、学习表、帧台账）与前端表格口径 |
| `../wp-follow-selftest.js`（**工作区根目录**，不在 `xvj-cloud/`） | 设备端那条链逐行移植的 JS：`resolveWindowFolder` / `panelFolderFor` / `handleWallPanelEvent` / `applyPanelSource` + 学习表解析 |
| `ps-settings-selftest.js` / `ps-table-selftest.js` | 播放设置字段与表格 |
| `win-queue-selftest.js` | 窗口编辑串行化 |
| `esc-selftest.js` | 转义三件套（**只存在于本地仓库，生产没有，别在服务器上跑**） |
| `.ref-audit.js` | 引用审计（孤儿函数/悬空调用） |

一次性探针脚本**必须放在 `/var/www/xvj/` 下再 node 跑**（`require('mqtt')` / `require('./config')` 靠 cwd 解析，
放 `/tmp` 一律 `MODULE_NOT_FOUND`），凭据走环境变量，用完 `rm`。

---

## 十、凭据纪律

**这两个仓库都是公开的。任何凭据都不得提交进仓库** —— 包括但不限于：
第三方 API key、数据库密码、MQTT 密码、SSH 私钥、APK 签名 keystore、GitHub PAT。

> 本节原先直接列着三把第三方 API key（DeepSeek / DashScope / ARK Coding），现已删除。
> ⚠️ **删文件不等于撤销泄露**：那些值随 commit `aab4741` 进了 `origin/main`，公开历史里任何人可读。
> **必须去对应平台轮换（作废重发）这三把 key**，只改文件是没有用的。

凭据的正确存放位置：

| 凭据 | 位置 |
|---|---|
| MQTT 服务端/设备密码 | 服务器 `/etc/xvj/mqtt.env`（root 600）+ `/etc/mosquitto/passwd`；CI 走 GitHub Secret `XVJ_MQTT_DEVICE_PW` |
| APK 签名 keystore | GitHub Secret `XVJ_DEBUG_KEYSTORE`（base64），CI 解到 `~/.android/debug.keystore`；本地留档在工作区 `apk_artifacts/keystore/`（不在 git 仓库内） |
| DB 密码 / API key | `config.js` 的环境变量覆盖（`DB_PASSWORD` / `API_KEY`），生产由 systemd `EnvironmentFile` 注入 |
| GitHub PAT | 本机 git credential manager（`git credential fill`，host 必须写 `github.com`） |

**红线**：keystore 进公开仓库 = 任何人都能构造可覆盖安装现场设备的 APK。
验证 CI Secret 内容是否正确，只能靠解包 dex 后字节匹配，**全程只输出 MATCH / NO_MATCH，绝不打印值**。