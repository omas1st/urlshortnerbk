const mongoose = require('mongoose');
const encryptionService = require('../config/encryption');
const crypto = require('crypto');

const urlSchema = new mongoose.Schema({
  shortId: {
    type: String,
    required: true,
    unique: true,
    default: () => crypto.randomBytes(4).toString('hex') // Generate default shortId
  },
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  destinationUrl: {
    type: String,
    required: true,
    validate: {
      validator: function(v) {
        try {
          // More flexible URL validation
          const url = v.trim();
          if (!url) return false;
          
          // Add protocol if missing
          let testUrl = url;
          if (!testUrl.startsWith('http://') && !testUrl.startsWith('https://')) {
            testUrl = 'https://' + testUrl;
          }
          
          // Try to create URL object
          new URL(testUrl);
          return true;
        } catch (e) {
          return false;
        }
      },
      message: props => `${props.value} is not a valid URL!`
    }
  },
  customName: {
    type: String,
    trim: true,
    maxlength: [50, 'Custom name cannot exceed 50 characters']
  },
  // Branded Domains
  brandedDomains: [{
    domain: String,
    brandedShortId: String,
    customDomainId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'CustomDomain'
    },
    createdAt: Date,
    isActive: Boolean
  }],
  // Security & Access
  password: {
    type: String, // Encrypted password
    default: null
  },
  expirationDate: {
    type: Date,
    default: null
  },
  isActive: {
    type: Boolean,
    default: true
  },
  isRestricted: {
    type: Boolean,
    default: false
  },
  // Customization
  previewImage: {
    type: String,
    default: null
  },
  loadingPageImage: {
    type: String,
    default: null
  },
  loadingPageText: {
    type: String,
    default: 'Loading...',
    maxlength: [200, 'Loading text cannot exceed 200 characters']
  },
  brandColor: {
    type: String,
    default: '#000000'
  },
  splashImage: {
    type: String,
    default: null
  },
  // Smart Features
  generateQrCode: {
    type: Boolean,
    default: false
  },
  qrCodeData: {
    type: String,
    default: null
  },
  smartDynamicLinks: {
    type: Boolean,
    default: false
  },
  destinations: [{
    url: { type: String },
    rule: { type: String },
    weight: { type: Number, default: 1, min: 1 }
  }],
  // Affiliate & Tracking
  enableAffiliateTracking: {
    type: Boolean,
    default: false
  },
  affiliateId: {
    type: String,
    default: null
  },
  affiliateTag: {
    type: String,
    default: null
  },
  commissionRate: {
    type: Number,
    default: null
  },
  cookieDuration: {
    type: Number,
    default: 30
  },
  customParams: {
    type: String,
    default: null
  },
  conversionPixel: {
    type: String,
    default: null
  },
  // A/B Testing
  enableABTesting: {
    type: Boolean,
    default: false
  },
  abTestVariants: [{
    destinationUrl: String,
    weight: Number,
    clicks: { type: Number, default: 0 }
  }],
  // Analytics
  clicks: {
    type: Number,
    default: 0
  },
  uniqueClicks: {
    type: Number,
    default: 0
  },
  lastClicked: Date,
  // Version Control
  currentVersion: {
    type: Number,
    default: 1
  },
  // Metadata
  metadata: {
    title: String,
    description: String,
    keywords: [String]
  },
  tags: [{
    type: String,
    trim: true
  }]
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Virtual for QR code URL
urlSchema.virtual('qrCodeUrl').get(function() {
  if (this.qrCodeData) {
    return this.qrCodeData;
  }
  return `${process.env.BASE_URL}/api/urls/${this.shortId}/qr`;
});

// Virtual for short URL
urlSchema.virtual('shortUrl').get(function() {
  return `${process.env.BASE_URL || 'http://localhost:5000'}/s/${this.shortId}`;
});

// Virtual for branded URLs
urlSchema.virtual('brandedUrls').get(function() {
  if (!this.brandedDomains || this.brandedDomains.length === 0) return [];
  
  return this.brandedDomains.map(bd => ({
    url: `https://${bd.domain}/${bd.brandedShortId}`,
    domain: bd.domain,
    shortId: bd.brandedShortId,
    isActive: bd.isActive,
    customDomainId: bd.customDomainId
  }));
});

// Indexes
// NOTE: shortId is defined with `unique: true` on the field above, so we must NOT declare a second non-unique index for it.
// Removed: urlSchema.index({ shortId: 1 });
urlSchema.index({ user: 1 });
urlSchema.index({ createdAt: -1 });
urlSchema.index({ clicks: -1 });
urlSchema.index({ expirationDate: 1 });
urlSchema.index({ isActive: 1, isRestricted: 1 });
urlSchema.index({ tags: 1 });
// Add indexes for brandedDomains queries
urlSchema.index({ 'brandedDomains.domain': 1 });
urlSchema.index({ 'brandedDomains.brandedShortId': 1 });
urlSchema.index({ 'brandedDomains.customDomainId': 1 });

// Pre-save middleware
urlSchema.pre('save', async function() {
  // 'this' is the document being saved
  const Url = mongoose.model('Url');
  
  // Generate short ID if not present
  if (!this.shortId) {
    this.shortId = await Url.generateUniqueShortId();
  }
  
  // FIXED: Always use encryptionService for password encryption (AES)
  // This ensures consistency with decryption in server.js
  if (this.password && this.password !== '' && this.isModified('password')) {
    try {
      // Only encrypt if it's not already encrypted (doesn't look like AES encrypted)
      if (!this.password.startsWith('U2FsdGVkX1')) { // AES encrypted strings start with this
        this.password = encryptionService.encryptUrlPassword(this.password);
      }
    } catch (error) {
      console.error('Password encryption error:', error);
      // Don't fail the save if encryption fails
    }
  }
  
  // Generate QR code data if requested
  if (this.generateQrCode && !this.qrCodeData) {
    const QRCode = require('qrcode');
    try {
      this.qrCodeData = await QRCode.toDataURL(this.shortUrl, {
        errorCorrectionLevel: 'H',
        margin: 2,
        width: 300
      });
    } catch (error) {
      console.error('QR Code generation error:', error);
    }
  }
  
  // If this is an update and destination changed, increment version
  if (this.isModified('destinationUrl') && !this.isNew) {
    this.currentVersion += 1;
    
    // Create version history entry
    try {
      const UrlVersion = require('./UrlVersion');
      const version = new UrlVersion({
        urlId: this._id,
        version: this.currentVersion,
        destinationUrl: this.destinationUrl,
        changes: 'destination_updated',
        userId: this.user,
        changeDetails: {
          oldDestination: this._previousDestinationUrl,
          newDestination: this.destinationUrl
        }
      });
      await version.save();
    } catch (error) {
      console.error('Error saving URL version:', error);
      // Don't fail the save if version creation fails
    }
  }
});

// Post-save middleware to track previous destination URL
urlSchema.post('init', function() {
  this._previousDestinationUrl = this.destinationUrl;
});

// Static methods
urlSchema.statics.generateUniqueShortId = async function() {
  let shortId;
  let isUnique = false;
  let attempts = 0;
  const maxAttempts = 10;
  
  while (!isUnique && attempts < maxAttempts) {
    shortId = crypto.randomBytes(4).toString('hex');
    const existing = await this.findOne({ shortId });
    if (!existing) {
      isUnique = true;
    }
    attempts++;
  }
  
  return shortId;
};

urlSchema.statics.findByShortId = function(shortId) {
  return this.findOne({ shortId });
};

urlSchema.statics.findByUser = function(userId, options = {}) {
  const query = this.find({ user: userId });
  
  if (options.limit) {
    query.limit(options.limit);
  }
  
  if (options.sort) {
    query.sort(options.sort);
  }
  
  return query;
};

urlSchema.statics.getActiveCount = function(userId) {
  return this.countDocuments({ 
    user: userId, 
    isActive: true,
    $or: [
      { expirationDate: null },
      { expirationDate: { $gt: new Date() } }
    ]
  });
};

// Instance methods
urlSchema.methods.trackClick = async function(clickData = {}) {
  this.clicks += 1;
  this.lastClicked = new Date();
  await this.save();
  
  // Record detailed click data
  const Click = require('./Click');
  const click = new Click({
    urlId: this._id,
    ...clickData
  });
  await click.save();
  
  return click;
};

urlSchema.methods.getAnalytics = async function(timeRange = '7days') {
  const Click = require('./Click');
  
  const now = new Date();
  let startDate;
  
  switch (timeRange) {
    case 'today':
      startDate = new Date(now.setHours(0, 0, 0, 0));
      break;
    case '7days':
      startDate = new Date(now.setDate(now.getDate() - 7));
      break;
    case '30days':
      startDate = new Date(now.setDate(now.getDate() - 30));
      break;
    case '90days':
      startDate = new Date(now.setDate(now.getDate() - 90));
      break;
    case '180days':
      startDate = new Date(now.setDate(now.getDate() - 180));
      break;
    case '365days':
      startDate = new Date(now.setDate(now.getDate() - 365));
      break;
    default:
      startDate = new Date(0); // All time
  }
  
  // Get click statistics
  const clicks = await Click.find({
    urlId: this._id,
    timestamp: { $gte: startDate }
  });
  
  // Calculate various metrics
  const analytics = {
    totalClicks: clicks.length,
    uniqueClicks: new Set(clicks.map(c => c.ipAddress)).size,
    clicksByCountry: {},
    clicksByDevice: {},
    clicksByBrowser: {},
    clicksByHour: {},
    referrers: {},
    timeSeries: []
  };
  
  // Process clicks data
  clicks.forEach(click => {
    // Group by country
    const country = click.country || 'Unknown';
    analytics.clicksByCountry[country] = (analytics.clicksByCountry[country] || 0) + 1;
    
    // Group by device
    const device = click.device || 'Unknown';
    analytics.clicksByDevice[device] = (analytics.clicksByDevice[device] || 0) + 1;
    
    // Group by hour
    const hour = new Date(click.timestamp).getHours();
    analytics.clicksByHour[hour] = (analytics.clicksByHour[hour] || 0) + 1;
    
    // Track referrers
    if (click.referrer) {
      try {
        const domain = new URL(click.referrer).hostname;
        analytics.referrers[domain] = (analytics.referrers[domain] || 0) + 1;
      } catch (e) {
        // Invalid referrer URL, skip
      }
    }
  });
  
  // Generate time series data
  const days = timeRange === 'today' ? 1 : 
               timeRange === '7days' ? 7 : 
               timeRange === '30days' ? 30 : 90;
  
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date();
    date.setDate(date.getDate() - i);
    date.setHours(0, 0, 0, 0);
    
    const dayClicks = clicks.filter(click => {
      const clickDate = new Date(click.timestamp);
      return clickDate.toDateString() === date.toDateString();
    }).length;
    
    analytics.timeSeries.push({
      date: date.toISOString().split('T')[0],
      clicks: dayClicks
    });
  }
  
  return analytics;
};

urlSchema.methods.disable = async function() {
  this.isActive = false;
  await this.save();
  return this;
};

urlSchema.methods.enable = async function() {
  this.isActive = true;
  await this.save();
  return this;
};

urlSchema.methods.restrict = async function() {
  this.isRestricted = true;
  await this.save();
  return this;
};

urlSchema.methods.unrestrict = async function() {
  this.isRestricted = false;
  await this.save();
  return this;
};

urlSchema.methods.getPassword = function() {
  if (!this.password) return null;
  return encryptionService.decryptUrlPassword(this.password);
};

const Url = mongoose.model('Url', urlSchema);

module.exports = Url;