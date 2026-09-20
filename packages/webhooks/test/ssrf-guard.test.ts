import { describe, expect, it } from 'vitest';
import { assertPublicWebhookUrl, isPrivateAddress, WebhookUrlError } from '../src/index.js';

describe('isPrivateAddress', () => {
  it.each([
    ['10.0.0.5', true],
    ['172.16.0.1', true],
    ['172.31.255.255', true],
    ['172.32.0.1', false],
    ['192.168.1.1', true],
    ['127.0.0.1', true],
    ['169.254.169.254', true], // cloud metadata endpoint
    ['100.64.0.1', true], // carrier-grade NAT
    ['8.8.8.8', false],
    ['93.184.216.34', false],
    ['::1', true],
    ['fe80::1', true],
    ['fd00::1', true],
    ['2001:4860:4860::8888', false],
  ])('%s -> private=%s', (ip, expected) => {
    expect(isPrivateAddress(ip)).toBe(expected);
  });
});

describe('assertPublicWebhookUrl', () => {
  it('rejects non-http(s) protocols', async () => {
    await expect(assertPublicWebhookUrl('ftp://example.com/hook')).rejects.toThrow(WebhookUrlError);
  });

  it('rejects malformed URLs', async () => {
    await expect(assertPublicWebhookUrl('not a url')).rejects.toThrow(WebhookUrlError);
  });

  it('rejects localhost and .local/.internal hostnames without a DNS lookup', async () => {
    await expect(assertPublicWebhookUrl('http://localhost/hook')).rejects.toThrow(WebhookUrlError);
    await expect(assertPublicWebhookUrl('http://printer.local/hook')).rejects.toThrow(WebhookUrlError);
  });

  it('rejects a literal private IP without needing DNS', async () => {
    await expect(assertPublicWebhookUrl('http://169.254.169.254/latest/meta-data')).rejects.toThrow(WebhookUrlError);
  });

  it('rejects a hostname that resolves to a private address', async () => {
    await expect(
      assertPublicWebhookUrl('https://internal.example.com/hook', {
        resolve: async () => [{ address: '10.0.0.5', family: 4 }],
      }),
    ).rejects.toThrow(WebhookUrlError);
  });

  it('accepts a hostname that resolves only to public addresses', async () => {
    const url = await assertPublicWebhookUrl('https://merchant.example.com/hook', {
      resolve: async () => [{ address: '93.184.216.34', family: 4 }],
    });
    expect(url.hostname).toBe('merchant.example.com');
  });
});
