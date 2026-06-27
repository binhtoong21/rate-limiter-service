import { describe, it, expect } from 'vitest';
import { AuthService } from '../src/services/auth.service';

describe('AuthService', () => {
  it('should generate a valid API key and hash', () => {
    const { apiKey, keyHash } = AuthService.generateApiKey('pk_test');
    
    expect(apiKey).toMatch(/^pk_test_[a-f0-9]{64}$/);
    expect(keyHash).toHaveLength(64); // SHA-256 hex string
  });

  it('should validate API key format correctly', () => {
    expect(AuthService.isValidFormat('pk_test_abcdef123456')).toBe(true);
    expect(AuthService.isValidFormat('invalid-format-without-underscore')).toBe(false);
    expect(AuthService.isValidFormat('pk_test_!@#$%^&*()')).toBe(false);
  });

  it('should hash API key consistently', () => {
    const apiKey = 'pk_test_0123456789abcdef';
    const hash1 = AuthService.hashApiKey(apiKey);
    const hash2 = AuthService.hashApiKey(apiKey);
    
    expect(hash1).toBe(hash2);
  });
});
