# MiSub Cloudflare Pages / TUN 故障经验

记录日期：2026-08-16

这是一份脱敏的运维记录，描述 MiSub 在 Cloudflare Pages 上合并多个机场订阅、生成 Clash 配置时出现的“系统代理正常，打开 TUN 后所有流量不可达”问题。订阅 token、Cloudflare API/OAuth 凭据、KV namespace ID、完整订阅 URL 和节点密码均不写入本仓库。

## 结论

问题不能归因于 IKUUU 单独一个上游。最初选择 IKUUU 节点时出现 `resolve ip error`，切换到 KittySU 后仍复现，说明两个上游共同经过的 MiSub 生成链路才是优先排查边界。上游节点内容可能改变触发概率，但共享输出中的本地回环伪节点和不安全 DNS 默认值足以让 TUN/虚拟网卡模式失效。

本次已完成两层修复：源代码层过滤回环端点并把 DNS 安全值写入默认生成器；生产 KV 层只改写 `worker_settings_v1.customDnsOverride`，保留其余设置并维持 `enableTrafficNode: false`。新部署的 Clash 输出已通过公开订阅回读验证。客户端必须重新拉取配置；旧配置缓存不会因为服务器部署成功而自动改变。

## 现象与证据

| 观察 | 能说明什么 | 不能说明什么 |
| --- | --- | --- |
| macOS 和 Windows 都是系统代理可用、打开 TUN 后全断 | 共享的订阅输出、DNS、路由或代理核心配置是高优先级边界 | 不能只凭现象断定某个机场有问题 |
| 选 IKUUU 时先报 `resolve ip error`，切 KittySU 后仍报错 | IKUUU 不是唯一根因，至少存在 provider-independent 的公共路径 | 不能证明 IKUUU 的节点数据完全没有问题 |
| 旧生成器可能把流量/到期提示做成 `127.0.0.1:443` Trojan 节点 | 回环伪节点一旦进入测速、故障转移或代理组，会把流量导向本机 | 普通 fake-IP 地址段 `198.18.0.0/15` 本身不是回环故障 |
| 原 Clash 默认包含 `ipv6: true`、外部 DoH、`respect-rules: true` | DNS 失败时可能表现为全局不可达，尤其在 TUN 接管 DNS 的情况下 | 仅凭一次 DNS 报错不能区分客户端权限、路由和上游解析问题 |

没有保存到客户端核心的 TUN/DNS 日志，因此无法把某次失败精确归因到某个操作系统内核、代理核心或具体节点。当前结论是：先修复并验收公共生成链路，再用新配置复现；若仍失败，再收集客户端日志，而不是继续只切换机场。

## 已完成的修改

### MiSub 源代码

- 增加统一的本地代理端点判断，过滤 `localhost`、`127.0.0.0/8`、`::1`、`::`、`0.0.0.0` 和 IPv4-mapped loopback。
- 在 URL 转 Clash、订阅服务的真实节点校验两处同时过滤，避免只修一个调用方。
- 流量/到期提示和过期节点改为注释，不再伪装成可以被测速或故障转移使用的活动节点；节点计数也忽略注释。
- 新增安全 DNS 默认值，并让内置 Clash 与模板 Clash 共用：`ipv6: false`、`enhanced-mode: fake-ip`、国内 DoH、fallback；删除 `respect-rules`，不再依赖 KV 覆盖才能安全。
- 增加回环节点、默认 DNS、保护性缓存的回归测试。
- 将 `wrangler-cf-pages.toml` 收敛为合法 Pages 配置，只保留 `pages_build_output_dir`、兼容日期和 `nodejs_compat`，移除重复 `main`、旧 Workers `type/build` 和会覆盖生产值的环境段。

源代码改动已推到个人 fork 的草稿 PR：`imzyb/MiSub#452`（`iridite:codex/misub-tun-hardening`）。上游仓库仍是只读状态，不能把“已部署”写成“已合并”。

### Cloudflare KV 与 Pages

- 先读取目标 Pages 项目和 KV binding，再对 `worker_settings_v1` 做 read-modify-write。
- 只改写 `customDnsOverride` 为上述安全 YAML，保留其余 41 个设置；`enableTrafficNode` 已确认是 `false`，没有被误改。
- Wrangler 的 Node `fetch` 多次出现 `fetch failed` / TLS reset；随后改用 Cloudflare 官方 API 和现有 OAuth 完成同一部署。这个 fallback 不需要把 token 放进仓库或 Web UI。
- Pages Functions bundle、静态资源和生产部署均成功；部署后用新鲜请求回读订阅，而不是只看 Dashboard 状态。

## 验收结果

| 验收项 | 结果 |
| --- | --- |
| `npm run build` | 通过，309 个模块 |
| 全量测试 | 548/551 通过；剩余 3 项是既有 WireGuard 两个 round-trip/解析断言和 Loon `RULE-SET` 断言，不是本次改动引入 |
| 公开 Clash 订阅 HTTP | 200 |
| 生成内容 | 75 个代理、48 个代理组、9 条规则 |
| DNS | `enable: true`、`ipv6: false`、`fake-ip`；无 `respect-rules` |
| 结构检查 | 无 loopback 代理、无悬空组、无组循环；没有把客户端 TUN 开关伪装成服务端顶层配置 |

这些结果证明服务端输出已符合本次安全不变量，但不等于某台 Mac 或 Windows 的 TUN 权限、系统路由、DNS 劫持和代理核心已经验收。

## 2026-10-22 追加：下发配置的自洽性（DNS / 域名规则 / 私网直连）

现象：浏览器卡在 “Performing a TLS handshake”。根因不在节点，而在客户端 DNS 从没进过内核——macOS 解析器是路由器 `192.168.124.1`，走 en0 直连、不进 `utun7`，TUN 的 `dns-hijack` 看不到它，于是拿到被污染的记录（`www.google.com` → `69.171.235.22`，Facebook 的地址），TCP 连通后 ClientHello 没有 ServerHello，7.4 秒后 `SSL_ERROR_SYSCALL`。

订阅侧有三个实实在在的缺失，而且都**无法用 INI 模板或 `customDnsOverride` 表达**，只能在生成器里修：

| 缺失 | 后果 | 修复位置 |
| --- | --- | --- |
| `dns.listen` | 客户端没有可指向的本机解析入口，只能靠 TUN 劫持，TUN 一旦不接管就整条链路失效 | `safe-dns.js` 的默认值与显式块分支都补 `127.0.0.1:53` |
| 私网/回环直连 | `10.x`、`172.17.x` 等被送进日本节点，每次几秒超时并占用代理连接 | 新模块 `clash-hardening.js` 前插 7 条 `IP-CIDR`/`IP-CIDR6` DIRECT |
| `sniffer` | 客户端用自己的解析器拿到真实 IP 时只剩 IP 可匹配，`RULE-SET(cn_1)`、广告拦截等域名规则全部失效，一律落到 MATCH | 同一模块，仅对 `isMeta` 输出 |

两个生成器（`render-clash.js`、`builtin-clash-generator.js`）共用该模块，规则前插、同款去重、MATCH 仍在最后；Hiddify 保持纯 MATCH 的既有降级。

验收：生产订阅回读含 `listen`、7 条私网规则、`sniffer` 块并通过 `mihomo -t`；客户端实测 `www.google.com`/`www.youtube.com`/`www.wikipedia.org` 均 TLS 0.22–0.40s、HTTP 200（修复前 7.3–7.4s 且失败）；日志从清一色 `match Match using 🐟 兜底` 变为 `DomainSuffix(weixin.qq.com)`、`RuleSet(adblockmihomo_0) → REJECT`、`dial DIRECT (match IPCIDR/10.0.0.0/8)`。

源码补丁在 fork `iridite/MiSub` 的 `main` 分支（默认分支）：`44d39ef`（MRS 规则提供者，即 PR #519）→ `648c93e`（下发配置自洽：DNS listen、私网直连、sniffer）→ `8e16f96`（嗅探强制 override-destination，覆盖 TLS/HTTP/QUIC）→ `2aa75d9`（移除 fork 内镜像上游的 CI 脚本，锁定为唯一维护分支）。`imzyb/MiSub` 对该账号 `push: false`。部署流程已直接内置在仓库 `.github/workflows/deploy.yml`（在 push 到 `main` 或手动触发时运行），不再维护独立的部署仓库；其“Require delivered-config hardening”步骤确保部署前 `functions/modules/subscription/clash-hardening.js` 必须存在。

## 2026-10-22 追加二：客户端侧决策（不改系统 DNS）与反模式

要求：修复必须落在代理层（MiSub 下发的配置、ClashBar 的设置），不能靠改 macOS 系统 DNS，否则换一台新机器又得手工来一次。

先确认边界——**为什么系统 DNS 不是配置能解决的问题**：`netstat -rn -f inet` 里，局域网是 `192.168.124/24 link#13 en0` 与 `192.168.124.1/32 link#13 en0`，而隧道只有 `1`、`2/7`、`4/6`、`8/5`、`16/4`、`32/3`、`64/2`、`128.0/1` 这八条半默认路由指向 `utun7`。最长前缀匹配下，发往局域网 DNS 的包永远走 en0，不进隧道，`dns-hijack` 看不到它；订阅里任何字段都改不了宿主路由表（`route-address` 加更具体的网段属于抢路由，且要按每个网络硬编码，正是要避免的不可移植）。ClashBar 0.3.6 也没有 DNS 接管开关：`defaults read com.clashbar` 只有代理/分组/UI 相关键，二进制字符串里只有 `flush_dns_cache`、`flush_fakeip_cache` 两个维护动作。

采用的方案：**用 ClashBar 的系统代理而不是改 DNS**。浏览器把 `CONNECT www.google.com:443` 交给 `127.0.0.1:7890`，内核用自己的 DNS（境外 DoH 经代理）解析，全程不经过路由器解析器，因此污染无从介入；配置侧同时保留 `listen`、`sniffer`、私网直连，TUN 继续开着覆盖不走系统代理的程序。

- 实际操作：`networksetup -setwebproxy Wi-Fi 127.0.0.1 7890` 与 `-setsecurewebproxy`（等价于 ClashBar 界面里的系统代理开关，例外表 `::1, *.local, localhost, 127.0.0.1, 192.168/16, 10/8, 172.16/12, 10.2.2/24` 原样保留）；系统 DNS 用 `networksetup -setdnsservers Wi-Fi Empty` 回到 DHCP。
- 证据：真实浏览器（WKWebView）加载 `www.google.com`、`www.youtube.com`、`zh.wikipedia.org` 三个被污染域名全部成功；`logs/mihomo.log` 出现 `127.0.0.1:49807 --> thumb.wikimedia.org:443`、`intake-analytics.wikimedia.org:443 match RuleSet(adblockmihomo_0) → REJECT`，即混合端口连接带域名进入规则。
- 残留缺口（必须记住）：既不读系统代理、又用系统解析器的程序仍会拿到污染答案，这类只能靠路由器 DHCP 下发公网 DNS，或换一个自带 DNS 接管开关的客户端。

反模式（本次教训，别再犯）：

1. 只写 `enhanced-mode: fake-ip` 而不给 `dns.listen`，等于默认客户端一定能用内核 DNS。
2. 声明“TUN 会自动接管 DNS”，却把 DNS 留在局域网——几何上不可能。
3. 依赖“远端 DNS 恰好被 TUN 劫持”这一个条件支撑全部解析。
4. 私网不排除：`10.x`、组网地址进代理，表现为内网服务不可达加日志里的 `i/o timeout` 风暴。
5. 只做域名规则却不嗅探：客户端自解析或浏览器开 DoH 时规则静默失效，只剩 `MATCH`。
6. 把“订阅返回 200”或“`mihomo -t` 通过”当成可用；两者都不覆盖宿主的 DNS 与路由。

判据：`dig +short www.google.com` 返回 `198.18.x.x` 说明查询进了内核；返回 `69.x`／`31.x`／`199.x` 这类真实公网 IP 说明又绕回系统解析器了。

## 可重放的维护顺序

1. **确认边界。** 记录目标 Pages 项目、生产分支和 KV binding；不要把订阅链接、token 或 OAuth 内容写入 shell 历史和文档。
2. **读取再修改 KV。** 以 `worker_settings_v1` 为整体读取对象，只更新 `customDnsOverride`，保留未知字段；`enableTrafficNode` 保持 `false`。不要在 Web UI 里整段覆盖 JSON。
3. **先构建再部署。** 执行项目 build 和针对性测试；Pages 项目使用 Functions build + Pages deploy，不要用普通 Workers `wrangler deploy` 代替。
4. **回读生产输出。** 用客户端实际的 User-Agent 和本地保存的订阅 URL 请求，解析 YAML 并检查：没有本地端点、组引用完整且无环、`ipv6: false`、fake-IP、无 `respect-rules`。
5. **刷新客户端。** 在 macOS/Windows 客户端删除或刷新旧 profile，重新导入后再启用 TUN；同时保留一份失败时的核心日志，至少包含 DNS、路由安装、Tun listener 和第一条连接失败。
6. **仍失败时分层定位。** 先用新配置测试直连代理组，再看客户端 TUN/DNS/系统路由；不要因为某个 provider 节点先触发错误，就跳过公共配置和客户端边界。

## 仍需维护的事项

- `iridite/MiSub#452` 已于 2026-08-22 合并至上游。部署流程已收敛到本仓库的 `.github/workflows/deploy.yml`，直接以本仓库 `main` 分支为源，不再存在独立部署仓库或被上游未经审计代码自动覆盖的问题。
- 本次主要验收的是链接参数 `clash=3` 的 Clash 输出。sing-box 生成器有独立的 `tun`、`auto_route`、`strict_route` 和 DNS 路径，不能把 Clash 验收结果外推到 sing-box 客户端。
- 全量测试中的 3 个既有失败仍应单独清理，但它们不是本次 TUN 故障的阻断证据；修复时不要为了“全绿”放宽节点校验或删除安全断言。

## 不要重复的做法

- 不要把 `127.0.0.1`、`localhost` 或其他本机地址作为提示、过期或占位代理节点输出。
- 不要只在 KV 里临时覆盖 DNS；源代码默认值必须在 KV 缺失、解析失败或新环境部署时仍然安全。
- 不要把 `respect-rules`、外部 DoH、IPv6 和 fake-IP 组合当成通用修复；先验证客户端核心对 DNS 劫持和规则顺序的支持。
- 不要把“订阅返回 200”当成 TUN 已经可用；它只证明 Pages 函数返回了文本。
- 不要为了改一个 KV 字段整段覆盖生产 JSON，也不要把完整订阅链接、Cloudflare token、节点密码或导出配置提交到 dotfiles。

## 2026-10-22 追加三：桌面端与移动端分流设计（MRS 两套规则库与豆包输入法 UDP 语音直连）

### 1. 桌面端（macOS ClashBar）与移动端（iOS Clash Light）的分层定位

| 客户端 | 规则库形态 | 典型特征与分流策略 |
|---|---|---|
| **桌面端**（ClashBar） | **重型 MRS 分流库** | 挂载完整 Meta Rule Set（`adblockmihomo_0.mrs` 广告拦截、`cn_1.mrs` geosite 域名、`cn_2.mrs` geoip IP 段）；规则细致、白名单全面，覆盖多套本地开发、局域网工具与办公软件 |
| **移动端**（Clash Light） | **轻量 Lite 规则库** | 规则集极简，保持轻量模式；避免在 iOS 严格的 Network Extension 内存预算（15–30 MB）下因解析巨型规则集引发系统 OOM 闪退，保障后台低功耗常驻 |

### 2. 豆包输入法与字节语音服务的国内分流（UDP / QUIC 嗅探）

- **问题**：桌面端使用豆包输入法语音转文字、或微信桌面端语音转文字时，经常出现持续“转圈”甚至超时失败。
- **根因**：
  1. 规则优先级缺陷：若把 `ByteDance` 规则集统一送入 `🤖 人工智能` 节点，语音识别专用的字节/豆包国内通道会被误送往境外代理，增加几百毫秒延迟或被风控阻断。
  2. DNS 污染与目的地绑定：语音识别使用了 QUIC (UDP 443) 和 TLS 双通道。客户端 DNS 解析如果绕过内核拿到污染 IP，虽然 sniffer 能嗅探出域名，但如果未开 `override-destination: true`，核心发包时仍然会使用污染目标 IP 握手，导致 UDP 报文无应答、界面无限转圈。
- **落地修复**：
  - 规则前插：将 `DOMAIN-SUFFIX,snssdk.com`、`DOMAIN-SUFFIX,doubao.com`、`DOMAIN-SUFFIX,doubao.cn` 及 `DOMAIN,speech.bytedance.com` 明确置为 `🇨🇳 国内直连`（DIRECT），优先级高于通用 AI 代理组。
  - QUIC 嗅探重定向：补丁 `0001-fix-clash-force-override-destination-for-sniffed-TLS.patch` 在 `clash-hardening.js` 中显式配置：
    ```yaml
    sniffer:
      enable: true
      parse-pure-ip: true
      override-destination: true
      sniff:
        TLS: { ports: [443, 8443], override-destination: true }
        HTTP: { ports: [80, 8080], override-destination: true }
        QUIC: { ports: [443], override-destination: true }
    ```
    不仅对 TLS，而且对 QUIC (UDP 443) 同样强制以嗅探出的 SNI 覆盖目标 IP 并直连，彻底消除语音转文字卡死。

### 3. 源码补丁位置

改动以提交形式保存在 `iridite/MiSub` 的 `main` 分支（`44d39ef` → `648c93e` → `8e16f96` → `2aa75d9`），不再以 patch 或 git bundle 文件存档。

## 审计索引

- 本地脱敏记录：本文件
- macOS 客户端配置：`iridite/.files` 的 `config/macos/clashbar/ClashBar.yaml`
- 生产入口：Cloudflare Pages 项目 `misub`；具体订阅凭据只保存在本地客户端/密钥存储
- 关键生成路径：`functions/modules/subscription/main-handler.js`、`functions/services/subscription-service.js`、`functions/modules/subscription/builtin-clash-generator.js`、`functions/modules/subscription/template-renderers/render-clash.js`
