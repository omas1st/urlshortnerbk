const CryptoJS = require('crypto-js');

class EncryptionService {
  constructor() {
    this.encryptionKey = process.env.ENCRYPTION_KEY;
    if (!this.encryptionKey) {
      console.warn('ENCRYPTION_KEY not found in environment. Using development key.');
      this.encryptionKey = 'default-development-key-change-in-production';
    }
  }

  encrypt(text) {
    try {
      return CryptoJS.AES.encrypt(text, this.encryptionKey).toString();
    } catch (error) {
      console.error('Encryption error:', error);
      throw new Error('Failed to encrypt data');
    }
  }

  decrypt(ciphertext) {
    try {
      const bytes = CryptoJS.AES.decrypt(ciphertext, this.encryptionKey);
      const result = bytes.toString(CryptoJS.enc.Utf8);
      return result;
    } catch (error) {
      console.error('Decryption error:', error);
      throw new Error('Failed to decrypt data');
    }
  }

  // For password-protected URLs
  encryptUrlPassword(password) {
    if (!password) return null;
    return this.encrypt(password);
  }

  decryptUrlPassword(encryptedPassword) {
    if (!encryptedPassword) return null;
    return this.decrypt(encryptedPassword);
  }

  // For sensitive user data
  encryptUserData(data) {
    const jsonString = JSON.stringify(data);
    return this.encrypt(jsonString);
  }

  decryptUserData(encryptedData) {
    const decryptedString = this.decrypt(encryptedData);
    return JSON.parse(decryptedString);
  }

  // Generate secure random string for short IDs
  generateSecureRandom(length = 8) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    const crypto = require('crypto');
    
    for (let i = 0; i < length; i++) {
      const randomIndex = crypto.randomInt(0, chars.length);
      result += chars.charAt(randomIndex);
    }
    
    return result;
  }

  // Hash data (one-way)
  hashData(data) {
    return CryptoJS.SHA256(data + this.encryptionKey).toString();
  }

  // Verify hash
  verifyHash(data, hash) {
    const newHash = this.hashData(data);
    return newHash === hash;
  }
}

module.exports = new EncryptionService();