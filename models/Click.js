const mongoose = require('mongoose');

const clickSchema = new mongoose.Schema({
  urlId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Url',
    required: true,
    index: true
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  sessionId: {
    type: String,
    index: true
  },
  // Geographic data
  ipAddress: {
    type: String,
    required: true,
    index: true
  },
  country: {
    type: String,
    index: true
  },
  city: {
    type: String
  },
  region: {
    type: String
  },
  latitude: {
    type: Number
  },
  longitude: {
    type: Number
  },
  // Device data
  device: {
    type: String,
    enum: ['desktop', 'mobile', 'tablet', 'bot', 'other'],
    default: 'other'
  },
  deviceModel: {
    type: String
  },
  deviceVendor: {
    type: String
  },
  // Browser data
  browser: {
    type: String
  },
  browserVersion: {
    type: String
  },
  engine: {
    type: String
  },
  engineVersion: {
    type: String
  },
  // OS data
  os: {
    type: String
  },
  osVersion: {
    type: String
  },
  cpu: {
    type: String
  },
  // Screen data
  screenResolution: {
    width: Number,
    height: Number
  },
  viewportSize: {
    width: Number,
    height: Number
  },
  colorDepth: {
    type: Number
  },
  pixelRatio: {
    type: Number
  },
  // Network data
  connectionType: {
    type: String
  },
  effectiveType: {
    type: String
  },
  downlink: {
    type: Number
  },
  rtt: {
    type: Number
  },
  // Referrer data
  referrer: {
    type: String
  },
  referrerDomain: {
    type: String,
    index: true
  },
  medium: {
    type: String,
    enum: ['direct', 'organic', 'social', 'email', 'paid', 'referral', 'other'],
    default: 'direct'
  },
  source: {
    type: String
  },
  campaign: {
    type: String
  },
  term: {
    type: String
  },
  content: {
    type: String
  },
  // User behavior
  isReturning: {
    type: Boolean,
    default: false
  },
  timeOnPage: {
    type: Number // in seconds
  },
  scrollDepth: {
    type: Number // percentage
  },
  clicksOnPage: {
    type: Number
  },
  // Conversion data
  isConversion: {
    type: Boolean,
    default: false
  },
  conversionValue: {
    type: Number
  },
  conversionCategory: {
    type: String
  },
  // Timing data
  timeToClick: {
    type: Number // milliseconds from page load to click
  },
  timestamp: {
    type: Date,
    default: Date.now,
    index: true
  },
  // Additional metadata
  userAgent: {
    type: String
  },
  language: {
    type: String
  },
  timezone: {
    type: String
  },
  // Custom data
  customData: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  // Affiliate data
  affiliateId: {
    type: String
  },
  affiliateTag: {
    type: String
  },
  // Bot detection
  isBot: {
    type: Boolean,
    default: false
  },
  botName: {
    type: String
  }
}, {
  timestamps: true
});

// Compound indexes for common queries
clickSchema.index({ urlId: 1, timestamp: -1 });
clickSchema.index({ country: 1, timestamp: -1 });
clickSchema.index({ device: 1, timestamp: -1 });
clickSchema.index({ referrerDomain: 1, timestamp: -1 });
clickSchema.index({ isConversion: 1, timestamp: -1 });
clickSchema.index({ userId: 1, timestamp: -1 });

// Pre-save middleware
// Use async middleware (no `next` parameter) so Mongoose treats this as promise-based.
clickSchema.pre('save', async function() {
  // Parse user agent if not already parsed
  if (this.userAgent && (!this.browser || !this.os)) {
    try {
      const UAParser = require('ua-parser-js');
      const parser = new UAParser(this.userAgent);
      const result = parser.getResult();

      this.browser = result.browser.name;
      this.browserVersion = result.browser.version;
      this.os = result.os.name;
      this.osVersion = result.os.version;
      this.deviceModel = result.device.model;
      this.deviceVendor = result.device.vendor;
      this.engine = result.engine.name;
      this.engineVersion = result.engine.version;
      this.cpu = result.cpu.architecture;

      // Determine device type
      if (result.device && result.device.type === 'mobile') {
        this.device = 'mobile';
      } else if (result.device && result.device.type === 'tablet') {
        this.device = 'tablet';
      } else if (result.device && result.device.type === 'desktop') {
        this.device = 'desktop';
      } else if (result.device && result.device.type) {
        this.device = result.device.type;
      }

      // Detect bots
      const botPatterns = [
        /bot/i, /crawler/i, /spider/i, /scraper/i,
        /curl/i, /wget/i, /python/i, /java/i,
        /google/i, /bing/i, /yahoo/i, /duckduckgo/i,
        /baidu/i, /yandex/i, /facebook/i, /twitter/i
      ];

      this.isBot = botPatterns.some(pattern => pattern.test(this.userAgent));
      if (this.isBot) {
        // attempt a simple bot name extraction, fallback to full UA string
        const split = this.userAgent.split('/');
        this.botName = split && split[0] ? split[0] : this.userAgent;
      }
    } catch (err) {
      // Non-fatal: don't block save if UA parsing fails
      console.error('UA parsing error in click pre-save:', err && err.message ? err.message : err);
    }
  }

  // Extract referrer domain
  if (this.referrer && !this.referrerDomain) {
    try {
      const url = new URL(this.referrer);
      this.referrerDomain = url.hostname;

      // Determine medium
      const socialDomains = [
        'facebook.com', 'twitter.com', 'instagram.com',
        'linkedin.com', 'pinterest.com', 'tiktok.com',
        'youtube.com', 'reddit.com'
      ];

      const searchEngines = [
        'google.com', 'bing.com', 'yahoo.com',
        'duckduckgo.com', 'baidu.com', 'yandex.com'
      ];

      if (socialDomains.some(domain => url.hostname.includes(domain))) {
        this.medium = 'social';
      } else if (searchEngines.some(domain => url.hostname.includes(domain))) {
        this.medium = 'organic';
      } else {
        this.medium = 'referral';
      }
    } catch (error) {
      this.referrerDomain = 'invalid';
      this.medium = 'other';
    }
  }

  // Set default medium if not set
  if (!this.medium) {
    this.medium = this.referrer ? 'referral' : 'direct';
  }

  // No `next()` call — async middleware resolves the promise and continues
});

// Static methods
clickSchema.statics.getClicksByUrl = async function(urlId, options = {}) {
  const { 
    startDate, 
    endDate, 
    limit = 100, 
    skip = 0,
    groupBy = 'date' 
  } = options;
  
  const matchStage = { urlId };
  
  if (startDate || endDate) {
    matchStage.timestamp = {};
    if (startDate) matchStage.timestamp.$gte = startDate;
    if (endDate) matchStage.timestamp.$lte = endDate;
  }
  
  const pipeline = [
    { $match: matchStage },
    { $sort: { timestamp: -1 } },
    { $skip: skip },
    { $limit: limit }
  ];
  
  return await this.aggregate(pipeline);
};

clickSchema.statics.getClickStats = async function(urlId, timeRange = '7days') {
  const now = new Date();
  let startDate;
  
  switch (timeRange) {
    case 'today':
      startDate = new Date(now.setHours(0, 0, 0, 0));
      break;
    case '7days':
      startDate = new Date(now.getDate() - 7);
      break;
    case '30days':
      startDate = new Date(now.getDate() - 30);
      break;
    case '90days':
      startDate = new Date(now.getDate() - 90);
      break;
    case '180days':
      startDate = new Date(now.getDate() - 180);
      break;
    case '365days':
      startDate = new Date(now.getDate() - 365);
      break;
    default:
      startDate = new Date(0);
  }
  
  // careful: ensure startDate is a Date object
  if (!(startDate instanceof Date)) startDate = new Date(startDate);

  const stats = await this.aggregate([
    {
      $match: {
        urlId,
        timestamp: { $gte: startDate },
        isBot: false
      }
    },
    {
      $group: {
        _id: null,
        totalClicks: { $sum: 1 },
        uniqueClicks: { $addToSet: '$ipAddress' },
        totalConversions: { $sum: { $cond: ['$isConversion', 1, 0] } },
        avgTimeOnPage: { $avg: '$timeOnPage' },
        avgScrollDepth: { $avg: '$scrollDepth' },
        returningVisitors: { $sum: { $cond: ['$isReturning', 1, 0] } },
        countries: { $addToSet: '$country' },
        devices: { $push: '$device' },
        browsers: { $push: '$browser' },
        referrers: { $push: '$referrerDomain' }
      }
    },
    {
      $project: {
        _id: 0,
        totalClicks: 1,
        uniqueClicks: { $size: '$uniqueClicks' },
        conversionRate: {
          $cond: [
            { $eq: ['$totalClicks', 0] },
            0,
            { $multiply: [{ $divide: ['$totalConversions', '$totalClicks'] }, 100] }
          ]
        },
        avgTimeOnPage: 1,
        avgScrollDepth: 1,
        returningVisitors: 1,
        newVisitors: { $subtract: ['$totalClicks', '$returningVisitors'] },
        countryCount: { $size: '$countries' },
        deviceCount: { $size: { $setUnion: ['$devices', []] } },
        browserCount: { $size: { $setUnion: ['$browsers', []] } },
        referrerCount: { $size: { $setUnion: ['$referrers', []] } }
      }
    }
  ]);
  
  return stats[0] || {
    totalClicks: 0,
    uniqueClicks: 0,
    conversionRate: 0,
    avgTimeOnPage: 0,
    avgScrollDepth: 0,
    returningVisitors: 0,
    newVisitors: 0,
    countryCount: 0,
    deviceCount: 0,
    browserCount: 0,
    referrerCount: 0
  };
};

clickSchema.statics.getTimeSeries = async function(urlId, startDate, endDate, interval = 'day') {
  const groupFormat = {
    day: { $dateToString: { format: '%Y-%m-%d', date: '$timestamp' } },
    hour: { $dateToString: { format: '%Y-%m-%d %H:00', date: '$timestamp' } },
    week: { $dateToString: { format: '%Y-%W', date: '$timestamp' } },
    month: { $dateToString: { format: '%Y-%m', date: '$timestamp' } }
  };
  
  const pipeline = [
    {
      $match: {
        urlId,
        timestamp: { $gte: startDate, $lte: endDate },
        isBot: false
      }
    },
    {
      $group: {
        _id: groupFormat[interval] || groupFormat.day,
        clicks: { $sum: 1 },
        uniqueClicks: { $addToSet: '$ipAddress' },
        conversions: { $sum: { $cond: ['$isConversion', 1, 0] } }
      }
    },
    {
      $project: {
        date: '$_id',
        clicks: 1,
        uniqueClicks: { $size: '$uniqueClicks' },
        conversions: 1,
        conversionRate: {
          $cond: [
            { $eq: ['$clicks', 0] },
            0,
            { $multiply: [{ $divide: ['$conversions', '$clicks'] }, 100] }
          ]
        }
      }
    },
    { $sort: { date: 1 } }
  ];
  
  return await this.aggregate(pipeline);
};

clickSchema.statics.getTopCountries = async function(urlId, limit = 10) {
  return await this.aggregate([
    {
      $match: {
        urlId,
        country: { $ne: null },
        isBot: false
      }
    },
    {
      $group: {
        _id: '$country',
        clicks: { $sum: 1 },
        uniqueClicks: { $addToSet: '$ipAddress' }
      }
    },
    {
      $project: {
        country: '$_id',
        clicks: 1,
        uniqueClicks: { $size: '$uniqueClicks' }
      }
    },
    { $sort: { clicks: -1 } },
    { $limit: limit }
  ]);
};

// Instance method to enrich with geo data
clickSchema.methods.enrichWithGeoData = async function() {
  if (!this.country && this.ipAddress) {
    try {
      const geoip = require('geoip-lite');
      const geo = geoip.lookup(this.ipAddress);
      
      if (geo) {
        this.country = geo.country;
        this.city = geo.city;
        this.region = geo.region;
        this.latitude = geo.ll[0];
        this.longitude = geo.ll[1];
      }
    } catch (error) {
      console.error('Error enriching click with geo data:', error);
    }
  }
  
  return this;
};

const Click = mongoose.model('Click', clickSchema);

module.exports = Click;
