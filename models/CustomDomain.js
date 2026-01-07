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
    trim: true
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
    default: () => require('crypto').randomBytes(16).toString('hex')
  },
  dnsRecords: {
    aRecord: String,
    cnameRecord: String,
    txtRecord: String
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
customDomainSchema.index({ 'dnsRecords.txtRecord': 1 });

// Pre-save to ensure domain format
customDomainSchema.pre('save', function(next) {
  // Remove protocol and trailing slashes
  this.domain = this.domain.replace(/^https?:\/\//, '').replace(/\/$/, '');
  next();
});

// Static method to generate branded short ID
customDomainSchema.statics.generateBrandedShortId = function(domain, shortId) {
  const crypto = require('crypto');
  return crypto.createHash('md5').update(`${domain}:${shortId}:${Date.now()}`).digest('hex').substring(0, 8);
};

// Instance method to get DNS instructions
customDomainSchema.methods.getDNSInstructions = function() {
  const baseDomain = process.env.BASE_URL ? 
    new URL(process.env.BASE_URL).hostname : 'your-platform.com';
  
  return {
    txt: {
      type: 'TXT',
      name: '_brandlink_verify',
      value: this.verificationToken,
      ttl: 3600
    },
    cname: {
      type: 'CNAME',
      name: this.domain,
      value: `links.${baseDomain}`,
      ttl: 3600
    },
    a: {
      type: 'A',
      name: this.domain,
      value: process.env.SERVER_IP || '52.6.84.124', // Your server IP
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