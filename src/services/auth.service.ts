import crypto from 'crypto';

export class AuthService {
  /**
   * Generates a new API Key with format: prefix_randomString
   * Example: pk_live_f8a9b2...
   */
  static generateApiKey(prefix: string = 'pk_live'): { apiKey: string; keyHash: string } {
    const randomBytes = crypto.randomBytes(32).toString('hex');
    const apiKey = `${prefix}_${randomBytes}`;
    
    // Hash the API key using SHA-256 for storage
    const keyHash = this.hashApiKey(apiKey);
    
    return { apiKey, keyHash };
  }

  /**
   * Hashes a raw API key using SHA-256 to compare with DB or Cache
   */
  static hashApiKey(apiKey: string): string {
    return crypto.createHash('sha256').update(apiKey).digest('hex');
  }

  /**
   * Validate API key format
   */
  static isValidFormat(apiKey: string): boolean {
    return /^[a-zA-Z0-9_]+_[a-zA-Z0-9]+$/.test(apiKey);
  }
}
