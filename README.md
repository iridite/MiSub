# MiSub Enhanced

<div align="center">

**为现代代理生态（Mihomo / Sing-box / Surge）深度优化的订阅管理与分发中枢**

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Cloudflare Pages](https://img.shields.io/badge/Cloudflare-Pages-orange.svg)](https://pages.cloudflare.com/)
[![Mihomo Enhanced](https://img.shields.io/badge/Mihomo-MRS%20%2B%20Sniffer%20Ready-brightgreen.svg)](https://github.com/MetaCubeX/mihomo)
[![Fork](https://img.shields.io/badge/Fork%20of-imzyb%2FMiSub-6f42c1.svg)](https://github.com/imzyb/MiSub)
[![PR Status](https://img.shields.io/badge/PR%20to%20Upstream-%23519-informational.svg)](https://github.com/imzyb/MiSub/pull/519)

[⚡ 为什么选择 Enhanced](#-为什么选择-enhanced) • [✨ 特性矩阵](#-特性矩阵) • [🚀 一键部署](#-一键部署) • [🛠️ 解决的真实痛点](#️-解决的真实痛点) • [📖 原版功能](#-原版完整功能)

</div>

---

## ⚡ 为什么选择 Enhanced？

本项目是 [imzyb/MiSub](https://github.com/imzyb/MiSub) 的深度增强分支（Enhanced Fork）。

原版 MiSub 是极出色的轻量级 Cloudflare Pages 订阅管理工具，但在当今日益普及的 **Mihomo (Clash.Meta) / 现代 TUN 网卡代理** 场景下，存在三处致命结构缺陷：
1. **不支持现代 MRS 格式规则集**：Mihomo 生态已广泛转向二进制编译、加载快十倍且占用极小内存的 `.mrs` 规则集，原版下发会报格式错误导致整个配置无法导入。
2. **TUN 模式下握手卡死（TLS Handshake Timeout）**：下发的配置没有启用真实流量嗅探与目标重写（`override-destination: true`），当操作系统或浏览器因局域网 DNS 投毒拿到伪造 IP 时，ClientHello 无法得到应答，连接卡死 7–15 秒以上。
3. **缺少 DNS 本地监听与私网直连防线**：生成的配置没有 `dns.listen: 127.0.0.1:53`，局域网与虚拟组网（如 EasyTier、Tailscale）流量会被误代理至海外节点，引发严重的拨号超时风暴。

**MiSub Enhanced 完全重构并加固了订阅生成链路，让下发的配置开箱自洽，真正实现跨平台、跨客户端、零折腾。**

---

## ✨ 特性矩阵

| 能力特性 | 上游原版 (imzyb/MiSub) | 🚀 MiSub Enhanced | 带来的收益 |
|---|:---:|:---:|---|
| **Mihomo MRS 规则集原生支持** | ❌ 报错 `ErrInvalidFormat` | ✅ **原生智能支持** | 支持 Meta 官方与第三方 `.mrs` 规则文件，解析与匹配速度提升 10 倍，极大降低移动端内存溢出风险 |
| **规则行为智能推断** | ❌ 只能固定为 classical | ✅ **自动推断** (`domain`/`ipcidr`) | 根据 URL 路径特征自动赋予正确的 `behavior`，彻底杜绝语法校验失败 |
| **纯 TUN 模式防 TLS 握手卡死** | ❌ 握手卡死 7–15s 报 exit 35 | ✅ **Sniffer 全覆盖 + 强制目标重写** | 开启 `override-destination: true`，即使本地 DNS 被污染，内核也能直接从 ClientHello 中嗅探真实 SNI 并修正建连，秒级连通 |
| **DNS 回环监听 (`dns.listen`)** | ❌ 仅配置假 IP，无监听端口 | ✅ **默认 `127.0.0.1:53`** | 提供宿主机可显式指向的本地解析入口，不依赖平台路由表的特殊劫持假设 |
| **前置私网直连白名单** | ❌ 规则未穷尽私网段 | ✅ **顶层注入 7 条直连规则** | `10/8`、`172.16/12`、`192.168/16`、`100.64/10`、`fe80::` 强行前置直连，消除局域网与 Mesh 流量误出境的超时风暴 |
| **Hiddify 纯 MATCH 兼容** | ⚠️ 依赖客户端特征降级 | ✅ **严谨兼容** | 保留针对 Hiddify 4.x 的专用规避策略，私网规则平滑自适应 |
| **Cloudflare Pages 零成本部署** | ✅ 支持 | ✅ **一键无缝替换** | 保持与上游 100% 相同的数据存储结构（D1 / KV），已有数据无需迁移即可直接升级 |

---

## 🛠️ 解决的真实痛点

### 痛点一：浏览器访问海外网站停在 “Performing a TLS handshake” 卡死
- **根因**：macOS 等系统发往局域网路由器（如 `192.168.124.1`）的 DNS 查询由于 `/32` 主机路由优先，永远不会流入 TUN 网卡。系统拿回运营商/路由器被 GFW 污染的伪造 IP（例如将 Google 解析为 Facebook 地址）。原版配置未开启带有 `override-destination` 的 Sniffer，导致内核老老实实把包发给错误的海外服务器，对端拒绝响应，握手超时。
- **Enhanced 解法**：在订阅输出时强制注入：
  ```yaml
  sniffer:
    enable: true
    parse-pure-ip: true
    override-destination: true
    sniff:
      TLS:  { ports: [443, 8443], override-destination: true }
      HTTP: { ports: [80, 8080],  override-destination: true }
      QUIC: { ports: [443],       override-destination: true }
  ```
  即使客户端拿到错 IP，流量进入网卡的瞬间，内核直接从 SNI 还原真实域名，**强制抛弃污染 IP 并在远端重新建立正确连接**。实测 Google / YouTube / V2EX / Wikipedia 握手从 7.4 秒超时恢复到 0.2–0.3 秒即时载入。

### 痛点二：自定义 INI 模板写了 MRS 规则但 Mihomo 拒绝启动
- **根因**：Mihomo 对 rule-provider 的格式有严格校验，对 `format: mrs` 只接受 `behavior: domain` 或 `behavior: ipcidr`，若缺省或写成 `classical` 会在启动时直接报 `ErrInvalidFormat` 闪退。
- **Enhanced 解法**：重构 `render-clash.js`，按 URL 特征智能识别（含 geoip/geosite 分流），自动生成标准 Mihomo 规则提供者语法，并已向上游提交 [PR #519](https://github.com/imzyb/MiSub/pull/519)。

### 痛点三：局域网工具、NAS 或 EasyTier 流量被莫名其妙代理出境
- **根因**：配置模板末尾通常是 `MATCH,🐟 兜底`。部分未命中国内规则的内网网段流量（如公司内网、本地 Docker、异地组网 IP）被送去国外节点，造成连接超时和日志刷屏。
- **Enhanced 解法**：配置构建器强制在最顶部注入带 `no-resolve` 的私网直连规则，无需在每个 profile 模板里重复人肉添加。

---

## 🚀 一键部署

MiSub Enhanced 完全支持部署在 **Cloudflare Pages** 免费额度上，无需服务器、无需数据库费用。

### 方式 A：Fork 本仓库并使用 GitHub Actions 自动部署（推荐）

1. Fork 本仓库 [`iridite/MiSub`](https://github.com/iridite/MiSub) 到你自己的 GitHub 账号下。
2. 在 Cloudflare Dashboard 创建一个 Pages 项目（名称如 `misub`），绑定 Workers KV（Binding 设为 `MISUB_KV`）。
3. 在 GitHub 仓库设置 `Settings > Secrets and variables > Actions`：
   - **Repository Secrets**：
     - `CLOUDFLARE_API_TOKEN`：具备 Pages 编辑权限的 Cloudflare API Token。
   - **Repository Variables**：
     - `CLOUDFLARE_ACCOUNT_ID`：你的 Cloudflare Account ID。
     - `MISUB_KV_ID`：你的 KV Namespace ID。
4. 提交或手动触发 GitHub Actions 即可完成自动化构建与部署！

### 方式 B：本地命令行快速发布

```bash
# 1. 克隆代码并安装依赖
git clone https://github.com/iridite/MiSub.git
cd MiSub
npm install

# 2. 构建生产静态资源
npm run build

# 3. 使用 Wrangler 直接发布至 Cloudflare Pages
npx wrangler pages deploy dist --project-name misub --branch main
```

---

## 📸 应用界面预览

<div align="center">

| 现代化控制面板 | 规则与订阅分组管理 |
|:---:|:---:|
| ![登录与控制台](images/1.png) | ![分组与订阅视图](images/2.png) |

</div>

---

## 📖 原版完整功能保持

MiSub Enhanced 保持了上游优秀的基础能力，并在此之上做了全量加固：

- **🗂️ 订阅分组 (Profiles)**：自由组合多个机场订阅与自建节点，按设备专属分发。
- **🧩 统一模板流水线**：内置 ACL4SSR 风格与现代分流模板，支持 Clash / Sing-box / Surge / Loon / Quantumult X 一键互转。
- **🔗 操作符链 (Operator Chain)**：支持节点去重（Dedup）、名称正则重命名、节点排序与协议过滤流水线。
- **🎨 磨砂玻璃质感 UI**：支持暗黑模式自适应、全响应式移动端适配。
- **🌍 公开主页与安全隔离**：支持免登录分享订阅、多管理用户鉴权。

---

## 🤝 向上游回馈与开源协议

- 本仓库核心 MRS 改进已提交至上游官方仓库：[PR #519: feat(template): support mrs rule providers for Mihomo](https://github.com/imzyb/MiSub/pull/519)。
- 遵循 [MIT 许可证](LICENSE)。欢迎提交 Issue、PR，如果对你有所帮助，**请为本项目点一个 Star ⭐️ 支持持续维护！**
