const mongoose = require('mongoose');

const customDomainSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  domain: {
    type: String,
    required: true,
    lowercase: true,
    trim: true,
    unique: true
  },
  shortId: {
    type: String,
    ref: 'Url'
  },
  brandedShortId: {
    type: String,
    required: true,
    unique: true
  },
  status: {
    type: String,
    enum: ['pending', 'active', 'failed', 'verifying'],
    default: 'pending'
  },
  verificationToken: {
    type: String,
    default: function() {
      return require('crypto').randomBytes(16).toString('hex');
    }
  },
  dnsRecords: {
    txtRecord: String,
    cnameRecord: String
  },
  sslCertificate: {
    issued: { type: Boolean, default: false },
    expiresAt: Date,
    certificateId: String
  },
  isPrimary: {
    type: Boolean,
    default: false
  },
  verificationMethod: {
    type: String,
    enum: ['txt', 'cname', 'html'],
    default: 'txt'
  },
  lastVerifiedAt: Date,
  verificationError: String,
  metadata: {
    registrar: String,
    purchasedAt: Date,
    expiresAt: Date
  }
}, {
  timestamps: true
});

// Indexes
customDomainSchema.index({ user: 1 });
customDomainSchema.index({ domain: 1 }, { unique: true });
customDomainSchema.index({ brandedShortId: 1 }, { unique: true });
customDomainSchema.index({ status: 1 });

// Remove the pre-save hook and handle domain cleaning in controller
// This is the fix - no more pre-save hook with next() issues

// Static method to generate branded short ID
customDomainSchema.statics.generateBrandedShortId = function(domain, shortId) {
  const crypto = require('crypto');
  return crypto.createHash('md5').update(`${domain}:${shortId}:${Date.now()}`).digest('hex').substring(0, 8);
};

// Static method to clean domain
customDomainSchema.statics.cleanDomain = function(domain) {
  if (!domain || typeof domain !== 'string') return domain;
  return domain
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/$/, '')
    .toLowerCase()
    .trim();
};

// Instance method to get DNS instructions
customDomainSchema.methods.getDNSInstructions = function() {
  const baseUrl = process.env.BASE_URL || 'http://localhost:5000';
  const baseDomain = new URL(baseUrl).hostname;
  
  return {
    txt: {
      type: 'TXT',
      name: '_brandlink_verify',
      value: this.verificationToken,
      ttl: 3600
    },
    cname: {
      type: 'CNAME',
      name: '@',
      value: `links.${baseDomain}`,
      ttl: 3600
    }
  };
};

// Instance method to get branded URL
customDomainSchema.methods.getBrandedUrl = function() {
  return `https://${this.domain}/${this.brandedShortId}`;
};

const CustomDomain = mongoose.model('CustomDomain', customDomainSchema);

module.exports = CustomDomain;