/**
 * Clash / Mihomo 输出加固层。
 *
 * 这里只放"无论用户模板怎么写都必须成立"的不变量，与 safe-dns.js 的分工一致：
 * - 域名还原（sniffer）：客户端用自己的解析器拿到真实 IP 时，内核仍能按域名命中规则；
 *   缺少它时，模板里的 DOMAIN-SUFFIX / RULE-SET(domain) 全部失效，流量一律落到 MATCH。
 * - 私网与回环直连：局域网、组网工具（EZT / Tailscale）的地址永远不进代理。
 *
 * 模板可以追加规则，但不能取消这两条。
 */

export function buildMihomoSnifferConfig() {
    return {
        enable: true,
        // 客户端直连真实 IP（绕过内核 DNS）时也要嗅探，否则只剩 IP 可供规则匹配。
        'parse-pure-ip': true,
        'override-destination': false,
        sniff: {
            TLS: { ports: [443, 8443] },
            // HTTP 的目标必须以 Host 为准，否则域名规则和 SNI 校验都会落空。
            HTTP: { ports: [80, 8080], 'override-destination': true },
            QUIC: { ports: [443] },
        },
    };
}

export const PRIVATE_NETWORK_RULES = Object.freeze([
    'IP-CIDR,10.0.0.0/8,DIRECT,no-resolve',
    'IP-CIDR,172.16.0.0/12,DIRECT,no-resolve',
    'IP-CIDR,192.168.0.0/16,DIRECT,no-resolve',
    'IP-CIDR,100.64.0.0/10,DIRECT,no-resolve',
    'IP-CIDR,169.254.0.0/16,DIRECT,no-resolve',
    'IP-CIDR6,fc00::/7,DIRECT,no-resolve',
    'IP-CIDR6,fe80::/10,DIRECT,no-resolve',
]);

/**
 * 给已经组装好的 Clash 配置对象追加加固项。
 * 规则按原顺序前插，MATCH 仍然留在最后；模板里已有的同款规则不重复添加。
 *
 * @param {Object} config 已组装的 Clash 配置对象
 * @param {{ enableSniffer?: boolean, enablePrivateRules?: boolean }} [options]
 *   enableSniffer 仅 Mihomo/Meta 支持；enablePrivateRules 在 Hiddify 之类只认纯 MATCH 的
 *   客户端上关闭，避免重新引入导入失败。
 */
export function applyClashHardening(config, options = {}) {
    if (!config || typeof config !== 'object' || Array.isArray(config)) return config;

    const hardened = { ...config };
    if (options.enableSniffer && hardened.sniffer === undefined) {
        hardened.sniffer = buildMihomoSnifferConfig();
    }

    if (options.enablePrivateRules === false) return hardened;

    const rules = Array.isArray(config.rules) ? config.rules.map(String) : [];
    const present = new Set(rules);
    const missing = PRIVATE_NETWORK_RULES.filter((rule) => !present.has(rule));
    if (missing.length > 0) {
        hardened.rules = [...missing, ...(Array.isArray(config.rules) ? config.rules : [])];
    }

    return hardened;
}
