import { describe, expect, it } from 'vitest';
import yaml from 'js-yaml';
import {
    PRIVATE_NETWORK_RULES,
    applyClashHardening,
    buildMihomoSnifferConfig,
} from '../../functions/modules/subscription/clash-hardening.js';
import { DEFAULT_DNS_LISTEN, resolveSafeDnsConfig } from '../../functions/modules/subscription/safe-dns.js';
import { renderClashFromIniTemplate } from '../../functions/modules/subscription/template-pipeline.js';

const proxies = [
    {
        name: 'HK 01',
        type: 'ss',
        server: 'hk.example.com',
        port: 443,
        cipher: 'aes-128-gcm',
        password: 'example',
        udp: true,
    },
];

const iniTemplate = [
    '[rule]',
    'DOMAIN-SUFFIX,example.com,🚀 节点选择',
    'FINAL,🐟 兜底',
    '',
    '[custom]',
    'custom_proxy_group=🚀 节点选择`select`[]DIRECT',
    'custom_proxy_group=🐟 兜底`select`[]🚀 节点选择`[]DIRECT',
].join('\n');

describe('clash hardening invariants', () => {
    it('prepends private-network DIRECT rules once and keeps MATCH last', () => {
        const config = { rules: ['DOMAIN-SUFFIX,example.com,PROXY', 'MATCH,🐟 兜底'] };
        const once = applyClashHardening(config);
        const twice = applyClashHardening(once);

        expect(once.rules.slice(0, PRIVATE_NETWORK_RULES.length)).toEqual([
            ...PRIVATE_NETWORK_RULES,
        ]);
        expect(once.rules.at(-1)).toBe('MATCH,🐟 兜底');
        expect(twice.rules).toEqual(once.rules);
        expect(config.rules).toHaveLength(2);
    });

    it('does not duplicate private rules already present in a template', () => {
        const config = { rules: ['IP-CIDR,10.0.0.0/8,DIRECT,no-resolve', 'MATCH,兜底'] };
        const hardened = applyClashHardening(config);

        expect(hardened.rules.filter((rule) => rule === 'IP-CIDR,10.0.0.0/8,DIRECT,no-resolve'))
            .toHaveLength(1);
    });

    it('can leave the rule list untouched for clients that only accept pure MATCH', () => {
        const config = { rules: ['MATCH,🚀 节点选择'] };
        const hardened = applyClashHardening(config, { enablePrivateRules: false });

        expect(hardened.rules).toEqual(['MATCH,🚀 节点选择']);
    });

    it('adds sniffer only for Meta clients', () => {
        expect(applyClashHardening({}, {}).sniffer).toBeUndefined();

        const sniffer = applyClashHardening({}, { enableSniffer: true }).sniffer;
        expect(sniffer.enable).toBe(true);
        expect(sniffer.sniff.TLS.ports).toContain(443);
        expect(sniffer.sniff.HTTP['override-destination']).toBe(true);
        expect(buildMihomoSnifferConfig()).not.toBe(buildMihomoSnifferConfig());
    });

    it('listens on loopback for DNS by default and lets an explicit value win', () => {
        expect(resolveSafeDnsConfig('').listen).toBe(DEFAULT_DNS_LISTEN);
        expect(resolveSafeDnsConfig('dns:\n  enable: true\n  ipv6: false').listen).toBe(
            DEFAULT_DNS_LISTEN
        );
        expect(
            resolveSafeDnsConfig('dns:\n  enable: true\n  listen: "127.0.0.1:5353"').listen
        ).toBe('127.0.0.1:5353');
        expect(resolveSafeDnsConfig('dns:\n  enable: true\n  listen: ""').listen).toBe('');
    });

    it('emits hardening through the template renderer for Meta clients', () => {
        const parsed = yaml.load(
            renderClashFromIniTemplate(iniTemplate, { proxies, isMeta: true, ruleLevel: 'none' })
        );

        expect(parsed.sniffer.enable).toBe(true);
        expect(parsed.dns.listen).toBe(DEFAULT_DNS_LISTEN);
        expect(parsed.rules.slice(0, PRIVATE_NETWORK_RULES.length)).toEqual([
            ...PRIVATE_NETWORK_RULES,
        ]);
        expect(parsed.rules.at(-1)).toBe('MATCH,🐟 兜底');
    });

    it('keeps non-Meta Clash clients free of the sniffer block', () => {
        const parsed = yaml.load(
            renderClashFromIniTemplate(iniTemplate, { proxies, isMeta: false, ruleLevel: 'none' })
        );

        expect(parsed.sniffer).toBeUndefined();
        expect(parsed.rules.slice(0, PRIVATE_NETWORK_RULES.length)).toEqual([
            ...PRIVATE_NETWORK_RULES,
        ]);
    });
});
