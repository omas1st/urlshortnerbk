const mongoose = require('mongoose');

const analyticsSchema = new mongoose.Schema({
  urlId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Url',
    required: true,
    index: true
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  date: {
    type: Date,
    required: true,
    index: true
  },
  // Timezone field for analytics data
  timezone: {
    type: String,
    default: 'UTC'
  },
  // Click metrics
  clicks: {
    type: Number,
    default: 0
  },
  uniqueClicks: {
    type: Number,
    default: 0
  },
  // Geographic data
  countries: [{
    country: String,
    clicks: Number,
    uniqueClicks: Number
  }],
  cities: [{
    city: String,
    country: String,
    clicks: Number
  }],
  // Device data
  devices: {
    desktop: { type: Number, default: 0 },
    mobile: { type: Number, default: 0 },
    tablet: { type: Number, default: 0 }
  },
  // Browser data
  browsers: [{
    browser: String,
    version: String,
    clicks: Number
  }],
  // OS data
  operatingSystems: [{
    os: String,
    version: String,
    clicks: Number
  }],
  // Engagement metrics
  bounceRate: {
    type: Number,
    default: 0
  },
  avgSessionDuration: {
    type: Number,
    default: 0
  },
  pagesPerSession: {
    type: Number,
    default: 0
  },
  // Conversion tracking
  conversions: {
    type: Number,
    default: 0
  },
  conversionRate: {
    type: Number,
    default: 0
  },
  // Time-based metrics
  peakHour: {
    type: Number,
    default: 0
  },
  // Time-based clicks with timezone support
  clicksByHour: [{
    hour: Number,
    clicks: Number,
    timezone: String // Store timezone for each hour if needed
  }],
  // Referrer data
  referrers: [{
    domain: String,
    clicks: Number,
    medium: String // organic, social, email, etc.
  }],
  // User behavior
  returningVisitors: {
    type: Number,
    default: 0
  },
  newVisitors: {
    type: Number,
    default: 0
  },
  // Scroll depth
  scrollDepth: {
    '0-25': { type: Number, default: 0 },
    '25-50': { type: Number, default: 0 },
    '50-75': { type: Number, default: 0 },
    '75-100': { type: Number, default: 0 }
  },
  // Time to click
  avgTimeToClick: {
    type: Number,
    default: 0
  },
  // Custom events
  events: [{
    name: String,
    count: Number,
    metadata: mongoose.Schema.Types.Mixed
  }],
  // Affiliate data
  affiliateData: {
    tag: String,
    clicks: Number,
    conversions: Number,
    revenue: Number
  },
  // Metadata
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  }
}, {
  timestamps: true
});

// Indexes for efficient querying
analyticsSchema.index({ urlId: 1, date: 1 });
analyticsSchema.index({ userId: 1, date: 1 });
analyticsSchema.index({ date: 1 });
analyticsSchema.index({ 'countries.clicks': -1 });
analyticsSchema.index({ timezone: 1 }); // Added index for timezone queries

// Static methods
analyticsSchema.statics.getUrlAnalytics = async function(urlId, startDate, endDate) {
  return this.aggregate([
    {
      $match: {
        urlId: mongoose.Types.ObjectId(urlId),
        date: { $gte: startDate, $lte: endDate }
      }
    },
    {
      $group: {
        _id: null,
        totalClicks: { $sum: '$clicks' },
        totalUniqueClicks: { $sum: '$uniqueClicks' },
        avgBounceRate: { $avg: '$bounceRate' },
        avgSessionDuration: { $avg: '$avgSessionDuration' },
        totalConversions: { $sum: '$conversions' },
        returningVisitors: { $sum: '$returningVisitors' },
        newVisitors: { $sum: '$newVisitors' },
        countries: { $push: '$countries' },
        devices: { $push: '$devices' },
        browsers: { $push: '$browsers' },
        referrers: { $push: '$referrers' },
        timezones: { $addToSet: '$timezone' } // Added timezones to aggregation
      }
    },
    {
      $project: {
        _id: 0,
        totalClicks: 1,
        totalUniqueClicks: 1,
        avgBounceRate: 1,
        avgSessionDuration: 1,
        conversionRate: {
          $cond: [
            { $eq: ['$totalClicks', 0] },
            0,
            { $multiply: [{ $divide: ['$totalConversions', '$totalClicks'] }, 100] }
          ]
        },
        returningVisitors: 1,
        newVisitors: 1,
        // Process aggregated arrays
        countries: { $reduce: {
          input: '$countries',
          initialValue: [],
          in: { $concatArrays: ['$$value', '$$this'] }
        }},
        devices: { $reduce: {
          input: '$devices',
          initialValue: { desktop: 0, mobile: 0, tablet: 0 },
          in: {
            desktop: { $add: ['$$value.desktop', '$$this.desktop'] },
            mobile: { $add: ['$$value.mobile', '$$this.mobile'] },
            tablet: { $add: ['$$value.tablet', '$$this.tablet'] }
          }
        }},
        browsers: { $reduce: {
          input: '$browsers',
          initialValue: [],
          in: { $concatArrays: ['$$value', '$$this'] }
        }},
        referrers: { $reduce: {
          input: '$referrers',
          initialValue: [],
          in: { $concatArrays: ['$$value', '$$this'] }
        }},
        timezones: 1 // Include timezones in the result
      }
    }
  ]);
};

analyticsSchema.statics.getUserAnalytics = async function(userId, startDate, endDate) {
  return this.aggregate([
    {
      $match: {
        userId: mongoose.Types.ObjectId(userId),
        date: { $gte: startDate, $lte: endDate }
      }
    },
    {
      $group: {
        _id: '$urlId',
        clicks: { $sum: '$clicks' },
        uniqueClicks: { $sum: '$uniqueClicks' },
        conversions: { $sum: '$conversions' },
        timezones: { $addToSet: '$timezone' } // Added timezones to grouping
      }
    },
    {
      $lookup: {
        from: 'urls',
        localField: '_id',
        foreignField: '_id',
        as: 'url'
      }
    },
    {
      $unwind: '$url'
    },
    {
      $project: {
        urlId: '$_id',
        shortId: '$url.shortId',
        destinationUrl: '$url.destinationUrl',
        clicks: 1,
        uniqueClicks: 1,
        conversions: 1,
        conversionRate: {
          $cond: [
            { $eq: ['$clicks', 0] },
            0,
            { $multiply: [{ $divide: ['$conversions', '$clicks'] }, 100] }
          ]
        },
        timezones: 1 // Include timezones in the result
      }
    },
    {
      $sort: { clicks: -1 }
    }
  ]);
};

analyticsSchema.statics.getSystemAnalytics = async function(startDate, endDate) {
  const results = await this.aggregate([
    {
      $match: {
        date: { $gte: startDate, $lte: endDate }
      }
    },
    {
      $group: {
        _id: null,
        totalClicks: { $sum: '$clicks' },
        totalUniqueClicks: { $sum: '$uniqueClicks' },
        totalUrls: { $addToSet: '$urlId' },
        totalUsers: { $addToSet: '$userId' },
        avgBounceRate: { $avg: '$bounceRate' },
        timezones: { $addToSet: '$timezone' } // Added timezones to aggregation
      }
    },
    {
      $project: {
        _id: 0,
        totalClicks: 1,
        totalUniqueClicks: 1,
        totalUrls: { $size: '$totalUrls' },
        totalUsers: { $size: '$totalUsers' },
        avgBounceRate: 1,
        timezones: 1 // Include timezones in the result
      }
    }
  ]);

  return results[0] || {
    totalClicks: 0,
    totalUniqueClicks: 0,
    totalUrls: 0,
    totalUsers: 0,
    avgBounceRate: 0,
    timezones: ['UTC']
  };
};

// Instance method to update analytics
analyticsSchema.methods.updateFromClick = function(clickData) {
  this.clicks += 1;
  
  // Update timezone if provided
  if (clickData.timezone && !this.timezone) {
    this.timezone = clickData.timezone;
  }
  
  // Update unique clicks if IP is new
  // This would require checking against stored IPs
  
  // Update country data
  if (clickData.country) {
    const countryIndex = this.countries.findIndex(c => c.country === clickData.country);
    if (countryIndex > -1) {
      this.countries[countryIndex].clicks += 1;
    } else {
      this.countries.push({
        country: clickData.country,
        clicks: 1,
        uniqueClicks: 1
      });
    }
  }
  
  // Update city data
  if (clickData.city) {
    const cityIndex = this.cities.findIndex(c => 
      c.city === clickData.city && c.country === clickData.country
    );
    if (cityIndex > -1) {
      this.cities[cityIndex].clicks += 1;
    } else {
      this.cities.push({
        city: clickData.city,
        country: clickData.country || 'Unknown',
        clicks: 1
      });
    }
  }
  
  // Update device data
  if (clickData.device) {
    const device = clickData.device.toLowerCase();
    if (device.includes('mobile')) {
      this.devices.mobile += 1;
    } else if (device.includes('tablet')) {
      this.devices.tablet += 1;
    } else {
      this.devices.desktop += 1;
    }
  }
  
  // Update browser data
  if (clickData.browser) {
    const browserIndex = this.browsers.findIndex(b => 
      b.browser === clickData.browser && b.version === clickData.browserVersion
    );
    if (browserIndex > -1) {
      this.browsers[browserIndex].clicks += 1;
    } else {
      this.browsers.push({
        browser: clickData.browser,
        version: clickData.browserVersion,
        clicks: 1
      });
    }
  }
  
  // Update hour data with timezone
  const hour = new Date().getHours();
  const timezone = clickData.timezone || this.timezone || 'UTC';
  
  // Find existing hour entry with the same timezone
  const hourIndex = this.clicksByHour.findIndex(h => 
    h.hour === hour && h.timezone === timezone
  );
  
  if (hourIndex > -1) {
    this.clicksByHour[hourIndex].clicks += 1;
  } else {
    this.clicksByHour.push({ 
      hour, 
      clicks: 1,
      timezone 
    });
  }
  
  // Update peak hour (considering all timezones)
  const maxHour = this.clicksByHour.reduce((max, h) => 
    h.clicks > max.clicks ? h : max, 
    { hour: 0, clicks: 0, timezone: 'UTC' }
  );
  this.peakHour = maxHour.hour;
  
  return this;
};

const Analytics = mongoose.model('Analytics', analyticsSchema);

module.exports = Analytics;