import { describe, it, expect } from 'vitest';
import { scrubSecrets, containsSecrets } from '../secret-scrubber.ts';

describe('scrubSecrets', () => {
  it('redacts Anthropic API keys', () => {
    const key = 'sk-ant-' + 'x'.repeat(20);
    const input = 'Using key ' + key + ' in the request';
    const result = scrubSecrets(input);
    expect(result).toBe('Using key [REDACTED:ANTHROPIC_KEY] in the request');
    expect(result).not.toContain('sk-ant-');
  });

  it('redacts OpenAI-style API keys', () => {
    const key = 'sk-' + 'a'.repeat(20);
    const input = 'OPENAI_API_KEY=' + key;
    const result = scrubSecrets(input);
    expect(result).toContain('[REDACTED:');
    expect(result).not.toContain(key);
  });

  it('redacts GitHub personal access tokens', () => {
    // Construct dynamically to avoid GitHub secret scanning
    const token = 'ghp_' + 'a'.repeat(36);
    const input = token + ' is my token';
    const result = scrubSecrets(input);
    expect(result).toContain('[REDACTED:GITHUB_PAT]');
    expect(result).not.toContain('ghp_');
  });

  it('redacts GitHub OAuth tokens', () => {
    const token = 'gho_' + 'a'.repeat(36);
    const input = 'auth: ' + token;
    const result = scrubSecrets(input);
    expect(result).toContain('[REDACTED:GITHUB_OAUTH]');
  });

  it('redacts AWS access key IDs', () => {
    // Construct the test key dynamically to avoid GitHub secret scanning
    const prefix = 'AKIA';
    const suffix = 'XXXXXXXXXXXXXXXX'; // 16 uppercase chars
    const input = 'AWS_ACCESS_KEY_ID=' + prefix + suffix;
    const result = scrubSecrets(input);
    expect(result).toContain('[REDACTED:AWS_KEY]');
    expect(result).not.toContain(prefix + suffix);
  });

  it('redacts Slack bot tokens', () => {
    const token = 'xoxb-' + '1234567890' + '-' + 'a'.repeat(24);
    const input = 'SLACK_TOKEN=' + token;
    const result = scrubSecrets(input);
    expect(result).toContain('[REDACTED:');
    expect(result).not.toContain('xoxb-');
  });

  it('redacts Linear API keys', () => {
    const token = 'lin_api_' + 'a'.repeat(30);
    const input = token;
    const result = scrubSecrets(input);
    expect(result).toContain('[REDACTED:LINEAR_KEY]');
  });

  it('redacts OpenRouter keys', () => {
    const input = 'sk-or-v1-' + 'a'.repeat(64);
    const result = scrubSecrets(input);
    expect(result).toContain('[REDACTED:OPENROUTER_KEY]');
  });

  it('redacts Bearer tokens', () => {
    const token = 'a'.repeat(30);
    const input = 'Authorization: Bearer ' + token;
    const result = scrubSecrets(input);
    expect(result).toContain('[REDACTED:BEARER_TOKEN]');
  });

  it('redacts env var secrets', () => {
    const input = 'API_KEY="my-super-secret-value-1234"';
    const result = scrubSecrets(input);
    expect(result).toContain('[REDACTED:ENV_SECRET]');
  });

  it('handles multiple secrets in one string', () => {
    const antKey = 'sk-ant-' + 'a'.repeat(20);
    const ghpKey = 'ghp_' + 'a'.repeat(36);
    const input = 'key1=' + antKey + ' key2=' + ghpKey;
    const result = scrubSecrets(input);
    expect(result).not.toContain('sk-ant-');
    expect(result).not.toContain('ghp_');
    expect(result).toContain('[REDACTED:ANTHROPIC_KEY]');
    expect(result).toContain('[REDACTED:GITHUB_PAT]');
  });

  it('leaves non-secret text unchanged', () => {
    const input = 'This is a normal log message with no secrets at all. It mentions sklearn and github.com.';
    const result = scrubSecrets(input);
    expect(result).toBe(input);
  });

  it('handles empty string', () => {
    expect(scrubSecrets('')).toBe('');
  });

  it('handles repeated calls (global regex state reset)', () => {
    const input = 'sk-ant-' + 'x'.repeat(20);
    expect(scrubSecrets(input)).toContain('[REDACTED:ANTHROPIC_KEY]');
    expect(scrubSecrets(input)).toContain('[REDACTED:ANTHROPIC_KEY]');
  });
});

describe('containsSecrets', () => {
  it('returns true when secrets present', () => {
    expect(containsSecrets('key: sk-ant-' + 'x'.repeat(20))).toBe(true);
    expect(containsSecrets('ghp_' + 'x'.repeat(36))).toBe(true);
  });

  it('returns false for clean text', () => {
    expect(containsSecrets('Hello world')).toBe(false);
    expect(containsSecrets('')).toBe(false);
  });

  it('handles repeated calls (global regex state reset)', () => {
    const key = 'sk-ant-' + 'x'.repeat(20);
    expect(containsSecrets(key)).toBe(true);
    expect(containsSecrets(key)).toBe(true);
  });
});
