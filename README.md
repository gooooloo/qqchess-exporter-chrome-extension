# QQ Chess PGN Exporter

浏览器扩展，可批量导出[天天象棋](http://h5login.qqchess.qq.com/)网页版的近期对局为 PGN 文件，方便在其他象棋软件中复盘分析。支持 Chrome、Edge 和 Safari。

## 下载

[最新版本下载](https://github.com/gooooloo/qqchess-exporter-chrome-extension/releases/latest)

## 安装

### Chrome / Edge

1. 下载并解压上述压缩包
2. 打开 `chrome://extensions`（Edge 浏览器打开 `edge://extensions`）
3. 开启右上角的**开发者模式**
4. 点击**加载已解压的扩展程序**，选择本文件夹
5. 将扩展图标固定到工具栏

### Safari (macOS)

1. 安装 Xcode（从 App Store 或 [developer.apple.com](https://developer.apple.com/xcode/)）
2. 克隆本仓库，在终端运行：
   ```bash
   xcrun safari-web-extension-converter /path/to/this/repo \
     --project-location ./safari-extension \
     --app-name "QQ Chess PGN Exporter" \
     --bundle-identifier com.gooooloo.qqchess-pgn-exporter
   ```
3. 在 Xcode 中编译运行生成的项目
4. Safari → 设置 → 高级 → 勾选**在菜单栏中显示"开发"菜单**
5. 菜单栏 → 开发 → 勾选**允许未签名的扩展**
6. Safari → 设置 → 扩展 → 启用 **QQ Chess PGN Exporter**

## 使用方法

1. 打开[天天象棋](http://h5login.qqchess.qq.com/)并登录
2. 点击工具栏中的扩展图标
3. 点击**导出全部对局**
4. 等待进度完成，`.pgn` 文件将自动下载

## PGN 查看工具

导出的 `.pgn` 文件可用以下工具打开：

- XBoard / WinBoard
- 任何支持中国象棋 PGN 的软件
- 任何文本编辑器（PGN 是纯文本格式）

## 注意事项

- 导出前需先登录
- 已导出的对局会缓存在本地，加快后续导出速度
- Chrome 重启时可能会提示"开发者模式扩展程序"警告，关闭即可；也可改用 Edge 避免此提示
- Safari 版本每次重启 Safari 后需重新勾选"允许未签名的扩展"

## 工作原理

```
popup.js  →  bridge.js (ISOLATED world, chrome.* APIs)
               →  content.js (MAIN world, game object access)
                    →  pgn.js (movelist → ICCS → PGN conversion)
```

扩展通过访问游戏的 Cocos2d-JS 运行时读取对局记录，将着法转换为 ICCS 记谱法，输出标准 PGN 格式。

### 依赖的内部 API

content.js 运行在页面的 MAIN world 中，直接访问天天象棋 Cocos2d-JS 框架的内部对象。这些对象的属性名是混淆/压缩后的，**每次天天象棋前端更新都可能导致属性名变化，从而使插件失效**。

关键依赖点（按脆弱程度排序）：

| 依赖项 | 用途 | 稳定性 | 自动检测 |
|--------|------|--------|----------|
| `fdk.getModel("QipuModel")` | 获取棋谱数据模型 | 较稳定（未混淆） | — |
| `qipuModel.requestGetQipuInfo(...)` | 请求单局详细数据 | 较稳定（未混淆） | — |
| `qipuModel.ba(eventName, data)` | 事件回调，用于拦截返回数据 | 混淆名，可能变化 | 暂未自动检测 |
| 请求对局列表的方法 | 分页获取对局列表 | 混淆名，每次更新都会变 | ✅ 通过函数源码匹配 `TRequestGetDataList` |
| 存储对局列表的数组 | 请求后存储返回的对局 | 混淆名，每次更新都会变 | ✅ 首次请求后检测含 `qipuId` 的数组 |
| 回调数据路径 `data.param.collectDataInfo` | 获取单局棋谱数据 | 可能变化 | — |
| `collectData.sData` 中的 JSON 结构 | 棋谱着法、玩家信息、结果 | 较稳定 | — |

### 排查方法

大部分混淆属性名已经实现了运行时自动检测（见 content.js 中的 `detectFetchMethod` 和 `detectListArray`），天天象棋前端更新通常不需要手动修复。

如果自动检测也失效了（Console 中出现 `[QQChess Exporter] 无法检测到...` 的错误），按以下步骤排查：

1. 打开天天象棋网页，F12 进入 DevTools Console
2. 检查模型是否存在：`fdk.getModel("QipuModel")`
3. 检查自动检测的特征是否仍然有效：
   ```js
   var qm = fdk.getModel("QipuModel");
   // 请求方法：通过函数源码搜索 "TRequestGetDataList"
   Object.getOwnPropertyNames(Object.getPrototypeOf(qm))
     .filter(k => typeof qm[k] === 'function' && qm[k].toString().includes('TRequestGetDataList'));
   // 如果返回空数组，说明特征字符串也变了，需要更新 detectFetchMethod 的匹配逻辑
   ```
4. 更新 content.js 中 `detectFetchMethod` / `detectListArray` 的匹配逻辑

### 历次属性名变更记录

| 日期 | 变更 |
|------|------|
| 2026-04-12 | `Sj` → `Xj`，`Beb` → `Wfb`，`$0a.Md.val` 路径已移除 |

## 隐私政策

详见 [PRIVACY.md](PRIVACY.md)

## 许可证

[MIT](LICENSE)
