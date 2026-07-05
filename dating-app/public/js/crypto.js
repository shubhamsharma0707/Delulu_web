/**
 * Delulu E2EE Crypto Helper
 * Uses Web Crypto API (supported natively in all modern secure contexts / localhost)
 */
const E2EECrypto = {
  // Helper to convert ArrayBuffer to Base64
  arrayBufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
  },

  // Helper to convert Base64 to ArrayBuffer
  base64ToArrayBuffer(base64) {
    const binaryString = window.atob(base64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes.buffer;
  },

  // Helper to convert string to ArrayBuffer (UTF-8)
  stringToBuffer(str) {
    return new TextEncoder().encode(str);
  },

  // Helper to convert ArrayBuffer to string (UTF-8)
  bufferToString(buffer) {
    return new TextDecoder().decode(buffer);
  },

  /**
   * Derive a 256-bit AES key from a user's password and email (used as salt)
   */
  async deriveKeyFromPassword(password, email) {
    const enc = new TextEncoder();
    const passwordBuffer = enc.encode(password);
    const saltBuffer = enc.encode(email || 'delulusalt');

    const baseKey = await window.crypto.subtle.importKey(
      'raw',
      passwordBuffer,
      'PBKDF2',
      false,
      ['deriveKey']
    );

    return window.crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: saltBuffer,
        iterations: 100000,
        hash: 'SHA-256'
      },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      true, // exportable
      ['encrypt', 'decrypt']
    );
  },

  /**
   * Generate an ECDH P-256 Keypair
   */
  async generateECDHKeypair() {
    return window.crypto.subtle.generateKey(
      {
        name: 'ECDH',
        namedCurve: 'P-256'
      },
      true, // extractable
      ['deriveKey', 'deriveBits']
    );
  },

  /**
   * Export key to JSON Web Key (JWK) format
   */
  async exportKeyToJwk(key) {
    return window.crypto.subtle.exportKey('jwk', key);
  },

  /**
   * Import public key from JWK format
   */
  async importPublicKeyFromJwk(jwk) {
    return window.crypto.subtle.importKey(
      'jwk',
      jwk,
      {
        name: 'ECDH',
        namedCurve: 'P-256'
      },
      true,
      []
    );
  },

  /**
   * Import private key from JWK format
   */
  async importPrivateKeyFromJwk(jwk) {
    return window.crypto.subtle.importKey(
      'jwk',
      jwk,
      {
        name: 'ECDH',
        namedCurve: 'P-256'
      },
      true,
      ['deriveKey', 'deriveBits']
    );
  },

  /**
   * Encrypt a private key JWK string using a PBKDF2 AES key
   */
  async encryptPrivateKey(privateKey, pbkdf2Key) {
    const jwk = await this.exportKeyToJwk(privateKey);
    const jwkStr = JSON.stringify(jwk);
    const rawData = this.stringToBuffer(jwkStr);
    
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await window.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv },
      pbkdf2Key,
      rawData
    );

    return {
      ciphertext: this.arrayBufferToBase64(encrypted),
      iv: this.arrayBufferToBase64(iv)
    };
  },

  /**
   * Decrypt an encrypted private key JWK and import it
   */
  async decryptPrivateKey(encryptedJwkBase64, ivBase64, pbkdf2Key) {
    const ciphertext = this.base64ToArrayBuffer(encryptedJwkBase64);
    const iv = new Uint8Array(this.base64ToArrayBuffer(ivBase64));

    const decrypted = await window.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv },
      pbkdf2Key,
      ciphertext
    );

    const jwkStr = this.bufferToString(decrypted);
    const jwk = JSON.parse(jwkStr);
    return this.importPrivateKeyFromJwk(jwk);
  },

  /**
   * Derive a shared symmetric AES-GCM key from my private key and their public key
   */
  async deriveSharedSecret(myPrivateKey, otherPublicKey) {
    return window.crypto.subtle.deriveKey(
      {
        name: 'ECDH',
        public: otherPublicKey
      },
      myPrivateKey,
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    );
  },

  /**
   * Encrypt plain text using a shared symmetric key
   */
  async encryptMessage(text, sharedSecretKey) {
    const rawData = this.stringToBuffer(text);
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    
    const encrypted = await window.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv },
      sharedSecretKey,
      rawData
    );

    return {
      ciphertext: this.arrayBufferToBase64(encrypted),
      iv: this.arrayBufferToBase64(iv)
    };
  },

  /**
   * Decrypt ciphertext using a shared symmetric key
   */
  async decryptMessage(ciphertextBase64, ivBase64, sharedSecretKey) {
    const ciphertext = this.base64ToArrayBuffer(ciphertextBase64);
    const iv = new Uint8Array(this.base64ToArrayBuffer(ivBase64));

    const decrypted = await window.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv },
      sharedSecretKey,
      ciphertext
    );

    return this.bufferToString(decrypted);
  },

  /**
   * Encrypt a file/audio Blob before upload
   */
  async encryptBlob(blob, sharedSecretKey) {
    const arrayBuffer = await blob.arrayBuffer();
    const iv = window.crypto.getRandomValues(new Uint8Array(12));

    const encrypted = await window.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv },
      sharedSecretKey,
      arrayBuffer
    );

    const encryptedBlob = new Blob([encrypted], { type: 'application/octet-stream' });
    return {
      encryptedBlob,
      iv: this.arrayBufferToBase64(iv)
    };
  },

  /**
   * Decrypt an encrypted file array buffer
   */
  async decryptBlob(arrayBuffer, ivBase64, sharedSecretKey, mimeType = 'audio/webm') {
    const iv = new Uint8Array(this.base64ToArrayBuffer(ivBase64));

    const decrypted = await window.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv },
      sharedSecretKey,
      arrayBuffer
    );

    return new Blob([decrypted], { type: mimeType });
  }
};
