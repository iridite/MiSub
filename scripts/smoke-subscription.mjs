import yaml from 'js-yaml';
import { pathToFileURL } from 'node:url';
import { PINNED_RULE_REVISIONS } from '../functions/modules/subscription/builtin-rules-provider.js';
import { DNS_PROXY_GROUP, SINGBOX_CN_RULE_SET } from '../functions/modules/subscription/safe-dns.js';

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function array(value) {
    return Array.isArray(value) ? value : [];
}

function isLoopbackHost(value) {
    const host = String(value || '').trim().replace(/^\[|\]$/g, '').toLowerCase();
    return host === 'localhost' || host === '::1' || host === '::' || host === '0.0.0.0' || host.startsWith('127.');
}

// MiSub 会往订阅里塞“流量剩余 / 到期时间”这类纯展示用的伪节点（server 固定 127.0.0.1，
// 见 main-handler.js 的 enableTrafficNode）。它们不是可拨号的代理端点，校验时放行；
// 其它回环 server 仍然是缺陷。
// 节点名会带国旗前缀（如 "🇬🇧 流量剩余 ≫ 547.37 GB"），所以按包含匹配，不锚定开头。
const INFO_PSEUDO_NODE_PATTERN = /(?:流量剩余|剩余流量|到期时间|套餐到期)\s*≫/;

function assertNoLoopbackNodes(nodes, label) {
    for (const node of array(nodes)) {
        if (!node?.server || !isLoopbackHost(node.server)) continue;
        // Clash 用 name，sing-box 用 tag
        if (INFO_PSEUDO_NODE_PATTERN.test(String(node.name || node.tag || ''))) continue;
        throw new Error(`${label} contains loopback proxy endpoint`);
    }
}

// 内置生成器的 DNS 出口一律带 #<DNS 出口> 组后缀；实例用 customDnsOverride 覆盖 DNS 块时不会有这个签名，
// 此时 ?dns-mode= 对输出不再生效（DNS 是显式指定的），只能校验与模式无关的必需项。
function hasGeneratedDnsDialect(dns) {
    const servers = array(dns?.nameserver).map(server => String(server));
    return servers.length > 0 && servers.every(server => server.endsWith(`#${DNS_PROXY_GROUP}`));
}

function assertDnsMode(values, mode, label) {
    const servers = array(values);
    assert(servers.length > 0, `${label} has no DNS servers`);
    if (mode === 'clean') {
        assert(servers.every(server => /^udp:\/\//i.test(String(server))), `${label} clean mode is not plaintext UDP`);
        assert(servers.every(server => !/^https?:\/\//i.test(String(server))), `${label} clean mode contains encrypted DNS`);
    } else {
        assert(servers.every(server => /^(?:https|tls):\/\//i.test(String(server))), `${label} polluted mode is not encrypted DNS`);
        assert(servers.every(server => String(server).endsWith(`#${DNS_PROXY_GROUP}`)), `${label} polluted DNS is not proxied`);
    }
}

export function validateClashConfig(config, mode) {
    assert(config && typeof config === 'object', 'Clash output is not an object');
    assert(config.ipv6 === false, 'Clash IPv6 is enabled');
    assert(config['allow-lan'] === false, 'Clash LAN access is enabled');
    assert(config['bind-address'] === '127.0.0.1', 'Clash bind address is not loopback-only');
    assert(config['external-controller'] === '127.0.0.1:9090', 'Clash controller is not loopback-only');

    const dns = config.dns || {};
    assert(dns['enhanced-mode'] === 'fake-ip', 'Clash fake-ip mode is missing');
    assert(dns['respect-rules'] === true, 'Clash DNS respect-rules is disabled');
    assert(array(dns.nameserver).length > 0, 'Clash DNS has no nameservers');
    assert(array(dns['nameserver-policy']?.['geosite:cn']).length > 0, 'Clash geosite:cn DNS policy is missing');
    if (hasGeneratedDnsDialect(dns)) assertDnsMode(dns.nameserver, mode, 'Clash DNS');
    if (mode === 'clean') assert(array(dns.fallback).length === 0, 'Clash clean mode has fallback DNS');

    // 结构不变量：网段类规则集中排在最前，不夹在规则集之间；MATCH 永远在最后。
    const rules = array(config.rules).map(rule => String(rule));
    assert(rules.length > 0, 'Clash rules are missing');
    const firstRuleSetIndex = rules.findIndex(rule => /^RULE-SET,/i.test(rule));
    const cidrRulePattern = /^(?:IP-CIDR6?|SRC-IP-CIDR|IP-ASN|GEOIP),/i;
    const misplacedCidr = rules.findIndex(
        (rule, index) => cidrRulePattern.test(rule) && firstRuleSetIndex !== -1 && index > firstRuleSetIndex
    );
    assert(
        misplacedCidr === -1,
        `Clash IP/CIDR rules must be grouped before the rule sets (offenders after index ${firstRuleSetIndex})`
    );
    assert(/^MATCH,/i.test(rules[rules.length - 1]), 'Clash last rule must be MATCH');

    assertNoLoopbackNodes(config.proxies, 'Clash');
    const aiGroups = array(config['proxy-groups']).filter(group => String(group?.name || '').startsWith('🤖'));
    // 生成器默认注入 fail-closed 的 AI 服务组（存在性由 template-pipeline 单测覆盖）；
    // 自定义模板可以不发布这些组，但一旦发布就绝不能含 DIRECT。
    assert(aiGroups.every(group => !array(group.proxies).includes('DIRECT')), 'Clash AI group allows DIRECT');
    return true;
}

export function validateSingboxConfig(config, mode) {
    assert(config && typeof config === 'object', 'sing-box output is not an object');
    const tun = array(config.inbounds).find(inbound => inbound?.type === 'tun');
    assert(tun, 'sing-box TUN inbound is missing');
    assert(tun.auto_route === true && tun.strict_route === true && tun.stack === 'mixed', 'sing-box TUN route hardening is incomplete');
    assert(array(tun.address).includes('172.19.0.1/30'), 'sing-box TUN address is unexpected');
    assert(config.route?.auto_detect_interface === true, 'sing-box auto interface detection is disabled');

    const dns = config.dns || {};
    assert(dns.strategy === 'prefer_ipv4', 'sing-box DNS strategy is not prefer_ipv4');
    assert(array(dns.rules).some(rule => array(rule.rule_set).includes(SINGBOX_CN_RULE_SET) && rule.server === 'dns-cn-1'), 'sing-box geosite-cn DNS route is missing');
    const cnRuleSet = array(config.route?.rule_set).find(ruleSet => ruleSet?.tag === SINGBOX_CN_RULE_SET);
    assert(cnRuleSet?.type === 'remote' && cnRuleSet.format === 'binary', 'sing-box geosite-cn rule-set definition is missing');
    assert(String(cnRuleSet.url || '').includes(PINNED_RULE_REVISIONS.SING_GEOSITE), 'sing-box geosite-cn rule-set is not SHA-pinned');

    const domestic = array(dns.servers).filter(server => String(server?.tag || '').startsWith('dns-cn-'));
    const foreign = array(dns.servers).filter(server => String(server?.tag || '').startsWith('dns-foreign-'));
    // 国内解析必须直连且加密：明文 UDP:53 会被部分网络链路丢弃（国内域名解析超时），
    // 而 sing-box 的 geosite-cn 只路由到 dns-cn-1，所以首位必须是加密 DoH。
    assert(
        domestic.length > 0 && domestic.every(server => server.detour === 'DIRECT'),
        'sing-box domestic DNS path is not direct'
    );
    assert(
        domestic.every(server => server.type === 'https'),
        'sing-box domestic DNS is not encrypted'
    );
    assertDnsMode(foreign.map(server => `${server.type}://${server.server}${server.detour === DNS_PROXY_GROUP ? `#${DNS_PROXY_GROUP}` : ''}`), mode, 'sing-box foreign DNS');
    assert(foreign.every(server => server.detour === DNS_PROXY_GROUP), 'sing-box foreign DNS is not proxied');

    assertNoLoopbackNodes(array(config.outbounds).filter(outbound => outbound?.server), 'sing-box');
    const aiGroups = array(config.outbounds).filter(outbound => String(outbound?.tag || '').startsWith('🤖'));
    assert(aiGroups.every(group => !array(group.outbounds).includes('DIRECT')), 'sing-box AI group allows DIRECT');
    return true;
}

async function fetchConfig(baseUrl, params) {
    const url = new URL(baseUrl);
    url.searchParams.delete('clash');
    url.searchParams.delete('singbox');
    url.searchParams.delete('dns-mode');
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

    let lastError;
    // Cloudflare Pages 新部署生效后路由切换可能短暂返回 404，退避共约 15s 覆盖边缘传播窗口
    for (let attempt = 0; attempt < 6; attempt += 1) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 20_000);
        try {
            const response = await fetch(url, { signal: controller.signal, redirect: 'follow' });
            const body = await response.text();
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return body;
        } catch (error) {
            lastError = error;
            if (attempt < 5) await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
        } finally {
            clearTimeout(timeout);
        }
    }
    throw lastError || new Error('request failed');
}

export async function runSmoke(baseUrl) {
    assert(baseUrl, 'MISUB_SMOKE_URL is not set');
    for (const mode of ['clean', 'polluted']) {
        const suffix = mode === 'clean' ? {} : { 'dns-mode': 'polluted' };
        const clash = yaml.load(await fetchConfig(baseUrl, { clash: '3', extend: '1', ...suffix }));
        validateClashConfig(clash, mode);
        console.log(`smoke: Clash ${mode} passed`);

        const singbox = JSON.parse(await fetchConfig(baseUrl, { singbox: '1', extend: '1', ...suffix }));
        validateSingboxConfig(singbox, mode);
        console.log(`smoke: sing-box ${mode} passed`);
    }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
    runSmoke(process.env.MISUB_SMOKE_URL?.trim()).catch(error => {
        console.error(`subscription smoke failed: ${error.message}`);
        process.exitCode = 1;
    });
}
