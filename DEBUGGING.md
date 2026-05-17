# 调试指南：天天象棋前端更新后扩展挂掉怎么办

## 问题模式

扩展依赖 `QipuModel` 上几个被混淆过的属性：

| 角色 | 历史名字 |
|---|---|
| 请求对局列表的方法 | `Sj` → `Xj` → `Yj` |
| 列表被填充的数组 | `Beb` → `Wfb` → `qgb` |
| 详情回调（被 hook 用） | `ba`（暂未变） |
| 详情请求方法 | `requestGetQipuInfo`（非混淆名，稳定） |

天天象棋每次重打包前端，混淆器就会重新分配 `Yj` / `qgb` 这种短名字。扩展跑不通基本都是这个原因。修复就是定位**当前这一版**对应的新名字，替换 `content.js` 里的硬编码。

最近一次定位发生在 2026-05-17（commit `f842c50`）。本文档记录那次的完整流程，方便下次复用。

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

如果 `ba` 也变了（极少见），需要找它的替代：原 `ba` 的签名是 `function(ha,ua,sa,qa){...this.Bq.ba(ha,ua,sa)}`。找 `Bq.ba` 调用 + 4 个参数的方法。

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

## 为什么不做 auto-detect

历史上 commit `96ead5a` 尝试过运行时自动检测 `_fetchMethodName` / `_listArrayName`，但 commit `ac48a5d` 又 revert 掉了（没写原因，可能不够稳）。当前选择是**继续硬编码 + 出问题时按本文档手工修一次**。

如果哪天想重新尝试 auto-detect，原则上应该：
- 用 `TRequestGetDataList` + `requestData(85131, ...)` 双重特征匹配请求方法（光匹配 `TRequestGetDataList` 有两个候选）
- 用"调用后被填充 + 元素含 qipuId" 检测列表数组
- 一定保留硬编码作为 fallback
