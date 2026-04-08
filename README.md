# Local RTC CLI

一个基于 Node.js + WebRTC DataChannel 的局域网传输工具，可通过 CLI 启动本地服务，并在浏览器中完成文本、文件和文件夹的点对点传输。

- GitHub: `https://github.com/YOUR_GITHUB_USERNAME/local-rtc-cli`
- npm: `https://www.npmjs.com/package/local-rtc-cli`

## 功能特性

- 局域网在线设备发现
- 浏览器内发送文本
- 单文件与文件夹传输
- WebRTC 点对点 DataChannel 直传
- WebSocket 优先，HTTP 轮询降级
- 兼容桌面、Pad、手机浏览器

## 本地开发

```bash
npm install
npm start
```

默认启动后会打印：

- `Local: http://localhost:3000`
- `Recommended: http://你的局域网IP:3000`

## npm 全局安装

```bash
npm install -g local-rtc-cli
local-rtc
```

也可以直接运行：

```bash
npx local-rtc-cli
```

## CLI 用法

```bash
local-rtc [options]
```

可用参数：

- `--port <number>`: 指定监听端口，默认 `3000`
- `--host <address>`: 指定监听地址，默认 `0.0.0.0`
- `--no-open`: 预留参数，当前版本不会自动打开浏览器
- `--help`: 查看帮助
- `--version`: 查看版本

示例：

```bash
local-rtc
local-rtc --port 3100
local-rtc --host 127.0.0.1 --port 3100
```

## 使用方式

1. 在局域网中启动服务。
2. 用电脑、平板或手机访问服务地址。
3. 设备会自动出现在在线列表中。
4. 选择目标设备后，发送文本、文件或文件夹。
5. 接收端确认后，数据通过 WebRTC 点对点传输。

## 浏览器兼容

- Chrome / Edge 桌面版：优先支持
- Android Chromium 浏览器：支持
- iPadOS / iOS Safari：基础可用
- 不支持文件夹上传的浏览器会自动降级为文本和普通文件发送

## 发布到 GitHub

建议流程：

1. 在 GitHub 创建公开仓库 `local-rtc-cli`
2. 更新 `package.json` 中的以下占位地址：
   - `repository.url`
   - `homepage`
   - `bugs.url`
3. 推送默认分支
4. 配置仓库描述和 topics，例如：
   - `webrtc`
   - `lan`
   - `file-transfer`
   - `p2p`
   - `cli`

## 发布到 npm

建议流程：

1. 登录 npm

```bash
npm login
```

2. 先检查包内容

```bash
npm run pack:check
```

3. 如果 `local-rtc-cli` 名称已被占用：
   - 先尝试相近无 scope 名称
   - 若仍不可用，再切换为 `@your-user/local-rtc-cli`

4. 发布

```bash
npm publish
```

## 已知限制

- 当前版本只支持单目标传输
- 不支持断点续传
- 不支持公网穿透
- 接收文件夹时，浏览器通常会按文件逐个下载

## 开发校验

```bash
npm test
```

## 许可证

MIT
