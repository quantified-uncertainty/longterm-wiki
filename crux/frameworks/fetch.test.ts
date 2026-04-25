import { describe, it, expect } from 'vitest';
import { classifyIngest, assertPublicHttpUrl } from './fetch.ts';

describe('classifyIngest', () => {
  it('treats a missing hash as fetch_failed', () => {
    expect(classifyIngest('abc', null, true)).toBe('fetch_failed');
  });

  it('treats a first-sight hash as new_version', () => {
    expect(classifyIngest(null, 'abc', false)).toBe('new_version');
  });

  it('treats a matching hash as unchanged', () => {
    expect(classifyIngest('abc', 'abc', true)).toBe('unchanged');
  });

  it('detects silent update when label is unchanged but hash differs', () => {
    expect(classifyIngest('abc', 'def', true)).toBe('silent_update_detected');
  });

  it('treats differing hash with differing label as new_version', () => {
    expect(classifyIngest('abc', 'def', false)).toBe('new_version');
  });
});

describe('assertPublicHttpUrl', () => {
  it('accepts public http(s) URLs', () => {
    expect(() => assertPublicHttpUrl('https://anthropic.com/rsp')).not.toThrow();
    expect(() => assertPublicHttpUrl('http://example.com/page')).not.toThrow();
    expect(() => assertPublicHttpUrl('https://about.fb.com/news/2025/02/meta/')).not.toThrow();
  });

  it('rejects non-http(s) protocols', () => {
    expect(() => assertPublicHttpUrl('file:///etc/passwd')).toThrow(/http\(s\)/);
    expect(() => assertPublicHttpUrl('ftp://example.com/x')).toThrow(/http\(s\)/);
    expect(() => assertPublicHttpUrl('javascript:alert(1)')).toThrow(/http\(s\)/);
  });

  it('rejects loopback / RFC1918 / link-local IPv4', () => {
    expect(() => assertPublicHttpUrl('http://127.0.0.1/x')).toThrow(/private\/loopback/);
    expect(() => assertPublicHttpUrl('http://10.0.0.5/x')).toThrow(/private\/loopback/);
    expect(() => assertPublicHttpUrl('http://172.16.0.1/x')).toThrow(/private\/loopback/);
    expect(() => assertPublicHttpUrl('http://172.31.255.255/x')).toThrow(/private\/loopback/);
    expect(() => assertPublicHttpUrl('http://192.168.1.1/x')).toThrow(/private\/loopback/);
    expect(() => assertPublicHttpUrl('http://169.254.169.254/latest/meta-data/')).toThrow(/private\/loopback/);
    expect(() => assertPublicHttpUrl('http://0.0.0.0/x')).toThrow(/private\/loopback/);
    expect(() => assertPublicHttpUrl('http://224.0.0.1/x')).toThrow(/private\/loopback/);
  });

  it('does NOT reject 172.x outside the RFC1918 16-31 band', () => {
    expect(() => assertPublicHttpUrl('http://172.15.0.1/x')).not.toThrow();
    expect(() => assertPublicHttpUrl('http://172.32.0.1/x')).not.toThrow();
  });

  it('rejects loopback / private hostnames', () => {
    expect(() => assertPublicHttpUrl('http://localhost/x')).toThrow(/loopback\/private/);
    expect(() => assertPublicHttpUrl('http://api.localhost/x')).toThrow(/loopback\/private/);
  });

  it('rejects IPv6 loopback / unique-local / link-local', () => {
    expect(() => assertPublicHttpUrl('http://[::1]/x')).toThrow(/loopback\/private/);
    expect(() => assertPublicHttpUrl('http://[fc00::1]/x')).toThrow(/loopback\/private/);
    expect(() => assertPublicHttpUrl('http://[fd00::1]/x')).toThrow(/loopback\/private/);
    expect(() => assertPublicHttpUrl('http://[fe80::1]/x')).toThrow(/loopback\/private/);
  });

  it('throws on malformed URLs', () => {
    expect(() => assertPublicHttpUrl('not a url')).toThrow(/not a valid URL/);
    expect(() => assertPublicHttpUrl('')).toThrow(/not a valid URL/);
  });
});

