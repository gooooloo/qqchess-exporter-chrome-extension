# QQ Chess PGN Exporter

Chrome/Edge 浏览器扩展，可批量导出[天天象棋](http://h5login.qqchess.qq.com/)网页版的近期对局为 PGN 文件，方便在其他象棋软件中复盘分析。

## 下载

[最新版本下载](https://github.com/gooooloo/qqchess-exporter-chrome-extension/releases/latest)

## 安装

1. 下载并解压上述压缩包
2. 打开 `chrome://extensions`（Edge 浏览器打开 `edge://extensions`）
3. 开启右上角的**开发者模式**
4. 点击**加载已解压的扩展程序**，选择本文件夹
5. 将扩展图标固定到工具栏

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

## 工作原理

```
popup.js  →  bridge.js (ISOLATED world, chrome.* APIs)
               →  content.js (MAIN world, game object access)
                    →  pgn.js (movelist → ICCS → PGN conversion)
```

扩展通过访问游戏的 Cocos2d-JS 运行时读取对局记录，将着法转换为 ICCS 记谱法，输出标准 PGN 格式。

## 隐私政策

详见 [PRIVACY.md](PRIVACY.md)

## 许可证

[MIT](LICENSE)
