# XVJ 系统架构文档

> 最后更新：2026-04-05
> 三端代码版本：前端 3649 行，后端 2540 行，APK MainActivity.kt 2273 行

---

## 一、系统概述

### 1.1 三端架构

```
┌─────────────────────────────────────────────────────────────────────┐
│                     XVJ 视频伺服系统                                   │
├─────────────────┬────────────────────────┬──────────────────────────┤
│   前端 (Web)    │      后端 (Node.js)    │       APK (Android)      │
│   3649 行       │        2540 行         │      MainActivity 2273行  │
├─────────────────┼────────────────────────┼──────────────────────────┤
│ index.html      │ server.js              │ MainActivity.kt          │
│ 单文件SPA       │ Express + MySQL + MQTT │ Kotlin + ExoPlayer      │
│ 素材/房间管理   │ API + 设备通信         │ 视频播放 + 素材同步      │
└─────────────────┴────────────────────────┴──────────────────────────┘
```

### 1.2 核心设计哲学

```
设备 → 瘦客户端（无交互、可替换）
      ↓
   数据随时从云端恢复
      ↓
   分布式视频伺服器
      ↓
   最大化减少人力维护
```

---

## 二、双路平行输出架构

### 2.1 Scene A / Scene B 概念

借鉴 Resolume Arena 部分概念，XVJ 实现双路平行输出：

```
┌─────────────────────────────────────────────────────────────────────┐
│                        终端设备 (APK)                               │
│  ┌─────────────────────────┐    ┌─────────────────────────┐        │
│  │      Scene A (第一幕)   │    │     Scene B (第二幕)   │        │
│  │   独立 HDMI 输出 #1    │    │   独立 HDMI 输出 #2    │        │
│  │                        │    │                        │        │
│  │   ┌────┐ ┌────┐      │    │   ┌────┐ ┌────┐      │        │
│  │   │Win1│ │Win2│ ...  │    │   │Win1│ │Win2│ ...  │        │
│  │   └────┘ └────┘      │    │   └────┘ └────┘      │        │
│  └─────────────────────────┘    └─────────────────────────┘        │
└─────────────────────────────────────────────────────────────────────┘
```

### 2.2 文件夹编号前缀

| 前缀 | 含义 | 物理文件夹 |
|------|------|-----------|
| A01~A30 | Scene A 第 1~30 个文件夹 | /sceneA/01 ~ /sceneA/30 |
| B01~B30 | Scene B 第 1~30 个文件夹 | /sceneB/01 ~ /sceneB/30 |

---

## 三、前端架构 (index.html)

### 3.1 代码规模
- **文件**：单文件 SPA (`public/index.html`)
- **行数**：3649 行
- **框架**：原生 JavaScript + HTML + CSS

### 3.2 主要功能模块

| 模块标识 | 功能 | 核心函数 |
|---------|------|---------|
| F-03 | 素材管理 | `lm()`, `rm()`, `sf()`, `rf()` |
| F-03b | 预设素材 | `lp()`, `prf()`, `spf()` |
| F-04 | 设备管理 | `ld()`, `lu()`, `ar()` |
| F-05 | 设备授权 | `confirmAuth()`, `unbind()` |
| F-06 | 房间管理 | `lr()`, `sr()`, `createRoom()` |
| F-06b | 房间设备 | `rmDevice()` |
| F-08 | 删除房间素材 | `rmRoomMat()` |
| F-09 | 窗口编辑器 | `renderWinEditorFull()` |
| F-10 | 推送 | `showPushDialog()`, `doPushToRoom()` |
| F-11 | 版本管理 | `lv()`, `lvd()`, `uv()` |

### 3.3 全局状态对象 (s)

```javascript
var s = {
    folders: {},           // 文件夹备注
    p: 'materials',       // 当前页面
    f: '01',              // 当前文件夹
    fs: [],               // 文件夹列表 (01~30)
    ms: [],               // 素材列表
    ds: [],               // 设备列表
    selected: [],         // 选中的素材
    df: null,             // 当前店铺 (设备管理用)
    rf: null,             // 当前房间 ID
    rooms: [],            // 房间列表
    loadingMaterials: false,
    lmCallId: 0,
    _lmCallCounter: 0,
    _lastLmCallId: ''
};
```

### 3.4 页面切换状态管理

**重要修复 (2026-04-05)**：切换到素材管理页时必须清除设备相关状态

```javascript
if (p === 'materials') {
    s.df = null;  // 清除设备状态
    s.rf = null;  // 清除房间状态
    lm();
}
```

### 3.5 渲染函数调用规则

| 条件 | 调用函数 |
|------|---------|
| `s.df && s.rf` 为真 | `rmDevice()` (房间视图) |
| 其他情况 | `rm()` (素材管理视图) |

---

## 四、后端架构 (server.js)

### 4.1 代码规模
- **文件**：`server.js`
- **行数**：2540 行
- **框架**：Express + MySQL + MQTT

### 4.2 核心依赖

```javascript
const express = require('express');
const mysql = require('mysql2');
const mqtt = require('mqtt');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
```

### 4.3 主要 API 路由

| 路由 | 方法 | 功能 |
|------|------|------|
| `/api/devices` | GET/POST/DELETE | 设备管理 |
| `/api/materials` | GET/POST/DELETE | 素材管理 |
| `/api/preset/*` | GET/POST/DELETE | 预设素材 |
| `/api/rooms` | GET/POST/PUT/DELETE | 房间管理 |
| `/api/rooms/:id/windows` | PUT | 窗口配置 |
| `/api/folders` | GET/POST/DELETE | 文件夹管理 |
| `/api/stores` | GET/POST/PUT/DELETE | 店铺管理 |
| `/api/logs` | GET | 操作日志 |

### 4.4 Scene 前缀构建

```javascript
function buildPrefixedScenes(scenes) {
    // A01, A02... → Scene A 的文件夹
    // B01, B02... → Scene B 的文件夹
}
```

---

## 五、APK 架构 (MainActivity.kt)

### 5.1 代码规模
- **文件**：`MainActivity.kt`
- **行数**：2273 行
- **语言**：Kotlin
- **播放器**：ExoPlayer

### 5.2 核心模块

| 模块标识 | 功能 | 核心函数 |
|---------|------|---------|
| A-02 | MQTT 连接 | `connectMQTT()` |
| A-03 | 设备注册 | `registerDevice()` |
| A-04 | 命令分发 | `handleCommand()` |
| A-05 | 视频播放 | `playFromUrl()`, `playLocalVideo()` |
| A-06 | 素材同步 | `syncRoomMaterialsAllScenes()` |
| A-07 | 场景配置 | `applySceneConfigs()` |

### 5.3 素材同步流程

```
云端配置变更 → MQTT 推送 → APK 接收
      ↓
syncRoomMaterialsAllScenes()
      ↓
遍历 A/B 两个场景的 folder_mappings
      ↓
syncFolderWithIds() 下载各文件夹素材
      ↓
本地存储，按 scenePrefix (A/B) 分类
```

### 5.4 开机行为

| 条件 | 行为 |
|------|------|
| Scene A windows 为空 | APK 自动创建全屏窗口播放文件夹 01 |
| Scene B windows 为空 | APK 保持黑屏，等待用户手动配置 |

---

## 六、数据模型

### 6.1 房间配置结构

```javascript
{
  id: "room_xxx",
  name: "房间名",
  store_name: "店铺名",
  config: {
    scenes: {
      A: {
        name: "第一幕",
        folder_mappings: { "01": [materialId1, materialId2], "02": [...] },
        windows: [{ id, name, x, y, width, height, content: {...} }]
      },
      B: {
        name: "第二幕",
        folder_mappings: { "01": [...], "02": [...] },
        windows: [...]
      }
    }
  }
}
```

### 6.2 窗口内容类型

| type | 含义 |
|------|------|
| `COLOR` | 纯色背景 |
| `SCENE_A` | 嵌套 Scene A |
| `SCENE_B` | 嵌套 Scene B |
| `HDMI` | HDMI 输入 |
| `IMAGE` | 图片 |

---

## 七、Bug 修复历史

### 7.1 2026-04-05 素材管理渲染 bug

**问题**：切换一级菜单后回到素材管理，所有文件夹显示 folder 01 的素材

**根因**：`s.df` 和 `s.rf` 状态未清除，导致 `sf()` 调用 `rmDevice()` 而非 `rm()`

**修复**：在 `sp('materials')` 中添加 `s.df = null; s.rf = null;`

### 7.2 2026-04-02 窗口编辑器 bug

**Bug1**：`switchScene()` 未调用 `renderWinEditorFull()`
**Bug2**：`saveWins()` 后 `s.rooms[idx].config` 内存未同步
**Bug3**：`updWinContent()` 改完属性后无重渲染

---

## 八、文件路径

### 8.1 服务器路径

| 用途 | 路径 |
|------|------|
| 前端 | `/var/www/xvj/public/index.html` |
| 后端 | `/var/www/xvj/server.js` |
| 上传 | `/var/www/xvj/public/uploads/` |
| 故障记录 | `/workspace/xvj-backup/故障记录.md` |

### 8.2 本地路径

| 用途 | 路径 |
|------|------|
| 前端项目 | `~/.openclaw/workspace-main/xvj-cloud/` |
| APK 源码 | `~/xvj-apk/` |

---

## 九、Git 仓库

| 仓库 | 地址 |
|------|------|
| 前端+后端 | https://github.com/mason909/xvj-cloud |
| APK 源码 | https://github.com/mason909/xvj-apk |

---

## 十、API 密钥

| 服务 | 密钥 |
|------|------|
| DeepSeek | `sk-6b4d3abd153f4e10bcb35bd8b6c8353a` |
| DashScope | `sk-3f5ec257ab89468bab98ee025c7d510f` |
| ARK Coding | `20cd4723-e1d2-4c42-a59d-c6c400aa006a` |
