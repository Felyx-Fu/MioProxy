# MioProxy V0.1

一个从零搭建的 Windows 桌面代理客户端骨架：**Tauri 2 + React + TypeScript + Rust + Mihomo sidecar**。

## V0.1 已完成

- Tauri 2 桌面应用骨架
- React/TypeScript 深色桌面 UI
- Rust 侧启动/停止 Mihomo
- Mihomo Controller API 只经 Rust 转发给前端
- `/version` 版本读取
- `/proxies` 代理组读取
- 默认 `config.yaml` 自动生成到应用数据目录
- Windows x64 Mihomo 自动下载/准备脚本

## V0.2 当前已完成

- Profile 名称与订阅 URL 管理
- 订阅 YAML 下载、原子保存与应用
- Mihomo 配置 reload
- Controller 代理组节点切换
- 节点延迟测速

## 暂未实现

- Windows System Proxy
- 托盘/开机启动
- Connections/Traffic WebSocket
- TUN + Windows Service

这些能力仍按 V0.2 → V1.0 逐步加，不在 V0.1 一次塞完。

## Windows 开发环境

建议安装：

1. Node.js 20+
2. Rust stable (`rustup`)
3. Microsoft C++ Build Tools / Visual Studio Build Tools
4. WebView2 Runtime（Windows 11 通常已存在）

## 第一次运行

在项目根目录 PowerShell：

```powershell
npm install
npm run mihomo:setup
npm run tauri dev
```

`npm run mihomo:setup` 会读取 MetaCubeX/mihomo 的 GitHub Latest Release，优先下载 `windows-amd64-compatible` 版本，并按 Tauri sidecar 规则放到：

```text
src-tauri/binaries/mihomo-x86_64-pc-windows-msvc.exe
```

## 配置在哪里？

第一次点击“启动内核”后，Rust 后端会生成应用数据目录下的 `config.yaml`。设置页会直接显示实际路径。

初始配置：

- mixed-port: `7890`
- external-controller: `127.0.0.1:9090`
- allow-lan: `false`
- mode: `rule`
- 代理组 `PROXY` 默认只有 `DIRECT`

因此第一次运行不会自动获得代理节点；添加 Profile 并下载订阅 YAML 后，才会出现实际代理节点。

## 架构

```text
React UI
   │ invoke()
   ▼
Tauri / Rust
   ├── Core lifecycle
   ├── Controller API client
   └── config.yaml
          │
          ▼
       Mihomo
          │
          ▼
       Network
```

前端不直接访问 `127.0.0.1:9090`，这样后续可以把 Controller secret、配置校验、日志过滤等统一放在 Rust 层。

## 后续建议

1. 本地 Profile 数据模型
2. 从 URL 下载订阅
3. 原子写入/校验 YAML
4. Reload Mihomo config
5. `/proxies` 节点选择
6. Delay test
7. 订阅流量和到期时间

## License / Mihomo

Mihomo 是 GPL-3.0 软件，并作为独立 sidecar 进程使用。若最终发布安装包并捆绑 Mihomo，请阅读 `THIRD_PARTY.md` 并履行对应的再分发义务。
