# 调试指南：天天象棋前端更新后扩展挂掉怎么办

## 问题模式

扩展依赖 `QipuModel` 上几个被混淆过的属性：

| 角色 | 历史名字 |
|---|---|
| 请求对局列表的方法 | `Sj` → `Xj` → `Yj` → `fk` → `Bj`（v1.3.6 起运行时检测） |
| 列表被填充的数组 | `Beb` → `Wfb` → `qgb` → `skb`/`tkb`（v1.3.4 起运行时检测） |
| 详情回调（被 hook 用） | `ba` → `sa`（v1.3.7 起运行时检测） |
| 详情请求方法 | `requestGetQipuInfo`（非混淆名，稳定） |

天天象棋每次重打包前端，混淆器就会重新分配 `Yj` / `qgb` 这种短名字。扩展跑不通基本都是这个原因。修复就是定位**当前这一版**对应的新名字，替换 `content.js` 里的硬编码。

最近一次定位发生在 2026-05-27（commit 待定，`Yj`→`fk`、`qgb`→`skb`）。本文档记录那次的完整流程，方便下次复用。

## 修复套路（高层流程）

1. 用 Playwright MCP 接管一个开启 remote debugging 的本机 Chrome
2. 让那个 Chrome 加载未打包扩展 + 登录天天象棋
3. 在天天象棋页面里 dump `fdk.getModel("QipuModel")` 的属性
4. 找当前哪个方法 / 哪个数组对应历史上的 `Xj` / `Wfb`
5. 改 `content.js`，bump 版本
6. 端到端测试一遍（reload 扩展 + 刷新页面 + 模拟 popup 消息）
7. 收尾：还原 MCP 配置，commit

## 详细步骤

### 0. 准备

确认 Playwright MCP 已经装好（`claude mcp list` 能看到 `plugin:playwright:playwright`）。

### 1. 启动一个带 debug 端口的 Chrome

**注意**：Chrome 出于安全原因禁止默认 user-data-dir 开 remote debugging，会报：

```
DevTools remote debugging requires a non-default data directory.
```

所以必须用独立 profile 目录。这个 profile 可以持久保留，下次复用不用重新登录。

先彻底退出现有 Chrome（`Cmd+Q`），然后：

```bash
mkdir -p "$HOME/.cache/chrome-cdp-profile"
nohup /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.cache/chrome-cdp-profile" \
  --no-first-run --no-default-browser-check \
  "https://h5login.qqchess.qq.com/" \
  "chrome://extensions/" \
  >/tmp/chrome-debug.log 2>&1 &
disown
```

验证 9222 起来了：

```bash
curl -s --noproxy '*' http://localhost:9222/json/version
```

应该看到 `Browser: Chrome/...`。

### 2. 让 Playwright MCP 走 CDP 模式连接这个 Chrome

改 `~/.claude/plugins/cache/claude-plugins-official/playwright/unknown/.mcp.json`，加 `--cdp-endpoint`：

```json
{
  "playwright": {
    "command": "npx",
    "args": ["@playwright/mcp@latest", "--cdp-endpoint=http://localhost:9222"]
  }
}
```

记得**先备份原文件**（修完后要还原，别污染全局配置）：

```bash
cp ~/.claude/plugins/cache/claude-plugins-official/playwright/unknown/.mcp.json{,.bak}
```

然后在 Claude Code 里 `/mcp`，把 `plugin:playwright:playwright` **重连**。

### 3. 在那个 Chrome 里准备好环境

需要手动做两件事（Playwright MCP 没法替你做）：

1. **登录天天象棋**：那个 Chrome 应该已经打开了 `h5login.qqchess.qq.com`，点"微信登录"扫码登录。登录态会保存在 `~/.cache/chrome-cdp-profile`，下次复用。
2. **加载未打包扩展**：在 `chrome://extensions/` 页面，右上角开"开发者模式"，点"加载已解压的扩展程序"，选当前项目根目录。

### 4. Dump QipuModel 当前属性

让 Claude（或自己写代码）通过 MCP 在天天象棋 tab 上跑：

```javascript
() => {
  var m = fdk.getModel('QipuModel');
  var proto = Object.getPrototypeOf(m);
  var funcs = Object.getOwnPropertyNames(proto).filter(k => typeof m[k] === 'function');
  // 找包含 TRequestGetDataList 关键字的函数（候选请求方法）
  var fetchCandidates = funcs.filter(k => {
    try { return m[k].toString().indexOf('TRequestGetDataList') !== -1; }
    catch(e) { return false; }
  }).map(k => ({ name: k, preview: m[k].toString().substring(0, 200) }));
  return {
    hasXj: typeof m.Xj,         // 旧名字
    hasWfb: typeof m.Wfb,        // 旧名字
    hasBa: typeof m.ba,          // 回调名（基本不变）
    hasRequestGetQipuInfo: typeof m.requestGetQipuInfo,  // 非混淆名（不变）
    fetchCandidates: fetchCandidates
  };
}
```

如果 `Xj` / `Wfb` 是 `undefined`，就是又被改名了。从 `fetchCandidates` 里挑：**真正的列表请求方法签名是 `(iDataType, iPageFlag, iReqNum, iDirID)`，会调用 `requestData(85131, ...)`**（不是 `requestData(85053, ...)`，那是另一个 API）。

```
function(Ma,Pa,Qa,Ra){...Ta.iDataType=Ma...Ta.iPageFlag=Pa...Ta.iReqNum=Qa...Ta.iDirID=Ra...this.requestData(85131,Ta)}
```

### 5. 找新数组名（`Wfb` 的替代）

调用一次新方法，看哪个数组被填充：

```javascript
async () => {
  var m = fdk.getModel('QipuModel');
  var before = {};
  Object.keys(m).forEach(k => { if (Array.isArray(m[k])) before[k] = m[k].length; });
  m.<NEW_FETCH_NAME>(13, 1, 50, 0);  // iDataType=13, page=1, size=50, dirId=0
  await new Promise(r => setTimeout(r, 3500));
  return Object.keys(m)
    .filter(k => Array.isArray(m[k]) && m[k].length !== (before[k] || 0))
    .map(k => ({
      name: k, length: m[k].length,
      firstItemKeys: Object.keys(m[k][0] || {}).slice(0, 8),
      hasQipuId: typeof (m[k][0] || {}).qipuId !== 'undefined'
    }));
}
```

填充后元素含 `qipuId`、`createTime`、`labelTitle` 等字段的，就是新的列表数组。

### 6. 改 `content.js`

定位 `fetchPage` 函数（约 84 行附近），替换两处属性名：

```javascript
qipuModel.<OLD_ARRAY> = [];        // → 新数组名
qipuModel.<OLD_FETCH>(13, ...);    // → 新方法名
```

以及注释里 "用 X 请求一页，等 2 秒让 Y 填满"。

详情回调（历史 `ba`，现 `sa`）v1.3.7 起已运行时检测，谓词：**4 个形参、函数体内含 `this.<X>.<自身名>(参1,参2,参3)` 三参转发**（如 `function(db,sx,cx,sh){...this.Fp.sa(db,sx,cx)}`），找不到时按 `sa`→`ba` 兜底。若再失效，先用下文"无浏览器快速诊断法"确认新签名。

更新 `manifest.json` 的 `version`。

### 7. 端到端测试

通过 MCP 让 Chrome 跑：

```javascript
// 在 chrome://extensions tab 上 reload 扩展
async () => {
  const items = document.querySelector('extensions-manager')
    .shadowRoot.querySelector('extensions-item-list')
    .shadowRoot.querySelectorAll('extensions-item');
  for (const it of items) {
    const name = it.shadowRoot.querySelector('#name');
    const btn = it.shadowRoot.querySelector('#dev-reload-button');
    if (name && name.textContent.includes('QQ Chess') && btn) btn.click();
  }
}
```

刷新天天象棋页面后，模拟 popup 触发 list 加载：

```javascript
async () => {
  return await new Promise(resolve => {
    function handler(e) {
      if (e.data && e.data.type === 'QQCHESS_GAME_LIST') {
        window.removeEventListener('message', handler);
        resolve({ ok: true, count: e.data.payload.games.length, first: e.data.payload.games[0] });
      }
      if (e.data && e.data.type === 'QQCHESS_EXPORT_ERROR') {
        window.removeEventListener('message', handler);
        resolve({ ok: false, error: e.data.payload });
      }
    }
    window.addEventListener('message', handler);
    window.postMessage({ type: 'QQCHESS_LOAD_LIST_REQUEST' }, '*');
    setTimeout(() => resolve({ timeout: true }), 30000);
  });
}
```

应该返回 `{ ok: true, count: 20, first: { qipuId, createTime, redName, blackName, result } }`。

### 8. 收尾

1. 还原 MCP 配置：`mv ~/.claude/plugins/cache/claude-plugins-official/playwright/unknown/.mcp.json{.bak,}`
2. `git commit -m "Fix broken extension due to QQ Chess frontend update (OLD→NEW, ...)" -m "Bump version to X.Y.Z"`
3. CDP profile 留着（`~/.cache/chrome-cdp-profile`），下次还能复用。要清掉就 `rm -rf` 这个目录。

### 9. 注意：Chrome 进程退出后再启动 Dock 图标的坑

调试结束后，如果你想正常用日常 Chrome（default profile），先确保：

```bash
pgrep -fl "Google Chrome.app/Contents/MacOS/Google Chrome"
```

返回空。任何一个 Chrome 进程还在跑（哪怕是 Playwright MCP 自启动的 chromium），从 Dock 点 Chrome 图标都会 focus 到那个已有窗口，不会启动 default profile，这会让你误以为账号丢了。

确保的方法：在 Claude Code 里 `/mcp` 把 `plugin:playwright:playwright` 断开，并 kill 残留的 chromium 进程。

## auto-detect 的历史

历史上 commit `96ead5a` 尝试过运行时自动检测 `_fetchMethodName` / `_listArrayName`，但 commit `ac48a5d` 又 revert 掉了（没写原因，可能不够稳）。

后来又分阶段重新引入：
- **v1.3.4 (2026-05-30)**：列表数组名改成运行时检测（调用请求方法后找含 `qipuId` 的数组）。起因是 Tencent CDN 同一时间向不同设备分发了两版 bundle（`skb` vs `tkb`），任何单一硬编码都会让一拨用户挂掉。
- **v1.3.5 (2026-05-30)**：缓存识别结果，每次调用前清空数组，处理"页面预填充"导致 length 不变的问题。
- **v1.3.6 (2026-06-20)**：请求方法名也改成运行时检测（按签名 `TRequestGetDataList` + `requestData(85131, ...)` 匹配），列表数组检测加严（要求 `qipuId` + `createTime` 双字段，排除 `_underscored` 命名属性），并补上错误传回 popup 的链路。
- **v1.3.7 (2026-08-08)**：详情回调 `ba`→`sa`。症状：所有未缓存对局的详情 15 秒超时后被静默丢弃，用户看到"最近 N 局加载不出来"（老对局都命中扩展 localStorage 缓存所以正常）。回调名改为运行时检测（谓词见上文；当日 bundle 全量扫描该谓词只命中 `sa` 和一个不在 Model 原型链上的 UI 方法 `hQ`，无歧义）。同时把"每次 fetch 各自 monkey-patch + restore"改成**常驻共享 hook 按 lDataID 分发**——旧写法并发时先返回的 restore 会把后装的 hook 挤掉导致对方必然超时。失败局数现在会传回 popup 显示，不再静默丢弃。另注意：新版 `requestGetQipuInfo` 命中页面本地棋谱缓存（`QipuFileSysModel.showQipuWithCacheFileName`）时会**同步**走 `khb`→分发方法而不发网络请求，因此必须先注册 resolver 再调用它（现有代码已如此）。

目前还硬编码的只剩 `requestGetQipuInfo`（详情请求方法），它是非混淆名，历史稳定。

## 无浏览器快速诊断法（v1.3.7 修复时的新套路）

不需要 CDP Chrome / Playwright，直接把线上 bundle 拉下来做静态分析，几分钟定位改名：

1. `curl -s https://h5login.qqchess.qq.com/` → HTML 里找到 `application.<hash>.js`（Chaos VM 混淆，不用读它）
2. `grep -oE '[A-Za-z0-9./_-]*\.json' application.js` → 得到 `src/settings.<hash>.json`
3. settings.json 的 `assets.bundleVers` 里查 `scripts` 的 hash → 下载 `assets/scripts/index.<hash>.js`（约 13MB，象棋业务逻辑都在这一个文件里）
4. 用稳定锚点定位：`TRequestGetDataList`、`85131`（列表请求）、`requestGetQipuInfo`、`85054`、`collectDataInfo`（详情链路），对比周边的混淆短名是否变化

注意 bundle 里五子棋（日志前缀 `[Five]`）和象棋各有一套 QipuModel/Controller，认准象棋那套（其 `requestGetQipuInfo` 里 `iDataType=13`）。
