import { describe, expect, it } from 'vitest';
import {
    DNS_PROXY_GROUP,
    IPV6_FAKE_RANGE6,
    buildSingboxDnsConfig,
    resolveDnsPolicy,
    resolveIpv6Flag,
    resolveSafeDnsConfig,
} from '../../functions/modules/subscription/safe-dns.js';

describe('shared split DNS policy', () => {
    it('routes domestic names directly and foreign names through the proxy group in clean mode', () => {
        const dns = resolveSafeDnsConfig('');

        expect(dns['respect-rules']).toBe(true);
        expect(dns['nameserver-policy']['geosite:cn']).toEqual([
            'https://223.5.5.5/dns-query',
            'https://223.6.6.6/dns-query',
            'https://120.53.53.53/dns-query',
        ]);
        expect(dns['nameserver-policy']['geosite:private']).toEqual(['223.5.5.5', '119.29.29.29']);
        expect(dns.nameserver).toEqual([
            `udp://8.8.8.8:53#${DNS_PROXY_GROUP}`,
            `udp://1.1.1.1:53#${DNS_PROXY_GROUP}`,
        ]);
        expect(dns.fallback).toEqual([]);
        expect(dns['proxy-server-nameserver']).toEqual([
            '223.5.5.5',
            '119.29.29.29',
            'https://223.5.5.5/dns-query',
            'https://223.6.6.6/dns-query',
            'https://120.53.53.53/dns-query',
        ]);
        // 直连出站的解析路径必须加密：明文 UDP:53 会被部分网络丢弃，导致国内直连站点解析超时
        expect(dns['direct-nameserver']).toEqual([
            'https://223.5.5.5/dns-query',
            'https://223.6.6.6/dns-query',
            'https://120.53.53.53/dns-query',
        ]);
    });

    it('uses encrypted foreign resolvers only in polluted mode', () => {
        const dns = resolveSafeDnsConfig('', { mode: 'polluted' });
        const singbox = buildSingboxDnsConfig('', { mode: 'polluted' });

        expect(dns.nameserver.every((server) => server.startsWith('https://'))).toBe(true);
        expect(dns.nameserver.every((server) => server.endsWith(`#${DNS_PROXY_GROUP}`))).toBe(true);
        expect(
            singbox.servers.some(
                (server) => server.type === 'https' && server.detour === DNS_PROXY_GROUP
            )
        ).toBe(true);
        expect(singbox.final).toBe('dns-foreign-1');
        expect(singbox.rules[0]).toEqual({
            rule_set: ['geosite-cn'],
            action: 'route',
            server: 'dns-cn-1',
        });
    });

    it('downgrades encrypted KV foreign resolvers to plain UDP in clean mode', () => {
        const dns = resolveSafeDnsConfig({ nameserver: ['https://dns.google/dns-query'] });

        expect(dns.nameserver).toEqual([`udp://dns.google:53#${DNS_PROXY_GROUP}`]);
        expect(dns.fallback).toEqual([]);
    });

    it('rejects unsafe resolver overrides and keeps the safe policy', () => {
        const policy = resolveDnsPolicy({
            mode: 'polluted',
            domestic: ['127.0.0.1'],
            foreign: ['udp://0.0.0.0:53#DIRECT'],
            polluted: ['https://8.8.8.8/dns-query'],
        });

        expect(policy.domestic).toEqual(['223.5.5.5', '119.29.29.29']);
        expect(policy.foreign).toEqual(['udp://8.8.8.8:53', 'udp://1.1.1.1:53']);
        expect(policy.polluted).toEqual(['https://8.8.8.8/dns-query']);
    });

    it('keeps IPv4-only by default and never emits a routable IPv6 fake range', () => {
        const dns = resolveSafeDnsConfig('');

        expect(dns.ipv6).toBe(false);
        expect(dns['fake-ip-range6']).toBeUndefined();
        expect(resolveIpv6Flag('')).toBe(false);
        expect(resolveIpv6Flag('mode: clean')).toBe(false);
    });

    it('enables IPv6 fake range only when explicitly requested', () => {
        expect(resolveIpv6Flag('ipv6: true')).toBe(true);
        expect(resolveIpv6Flag('dns:\n  ipv6: true')).toBe(true);

        const dns = resolveSafeDnsConfig('ipv6: true');
        expect(dns.ipv6).toBe(true);
        // 必须是公网段：ULA 段会被 Chromium Local Network Access 拦掉
        expect(dns['fake-ip-range6']).toBe(IPV6_FAKE_RANGE6);
        expect(dns['fake-ip-range6'].startsWith('2001:2::/')).toBe(true);
    });

    it('excludes STUN, OS connectivity probes and NTP from fake-ip', () => {
        const filter = resolveSafeDnsConfig('')['fake-ip-filter'];

        for (const entry of [
            'stun.*.*',
            '+.stun.*',
            '*.msftconnecttest.com',
            '*.msftncsi.com',
            'time.windows.com',
            'ntp.*.com',
            '+.push.apple.com',
        ]) {
            expect(filter).toContain(entry);
        }
    });
});
