const mongoose = require('mongoose');

const urlVersionSchema = new mongoose.Schema({
  urlId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Url',
    required: true,
    index: true
  },
  version: {
    type: Number,
    required: true
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  destinationUrl: {
    type: String,
    required: true
  },
  changes: {
    type: String,
    required: true,
    enum: [
      'created',
      'destination_updated',
      'settings_updated',
      'password_changed',
      'expiration_updated',
      'image_updated',
      'disabled',
      'enabled',
      'restricted',
      'unrestricted',
      'ab_testing_enabled',
      'ab_testing_disabled',
      'rollback',
      'rollback_completed'
    ]
  },
  changeDetails: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  metadata: {
    ipAddress: String,
    userAgent: String,
    notes: String
  },
  snapshot: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  }
}, {
  timestamps: true
});

// Indexes
urlVersionSchema.index({ urlId: 1, version: -1 });
urlVersionSchema.index({ userId: 1, createdAt: -1 });
urlVersionSchema.index({ createdAt: -1 });

// FIXED: Pre-save middleware without next parameter issue
urlVersionSchema.pre('save', async function() {
  try {
    // If destinationUrl is not set, fetch it from the URL document
    if (!this.destinationUrl) {
      const Url = mongoose.model('Url');
      const url = await Url.findById(this.urlId);
      
      if (url) {
        this.destinationUrl = url.destinationUrl;
      } else {
        this.destinationUrl = 'URL_NOT_FOUND';
      }
    }
    
    // If this is a new version, take a snapshot of the current URL state
    if (this.isNew) {
      const Url = mongoose.model('Url');
      const url = await Url.findById(this.urlId).lean();
      
      if (url) {
        this.snapshot = {
          destinationUrl: url.destinationUrl,
          customName: url.customName,
          password: url.password ? 'ENCRYPTED' : null,
          expirationDate: url.expirationDate,
          isActive: url.isActive,
          isRestricted: url.isRestricted,
          settings: {
            previewImage: url.previewImage,
            loadingPageImage: url.loadingPageImage,
            brandColor: url.brandColor,
            splashImage: url.splashImage,
            generateQrCode: url.generateQrCode,
            smartDynamicLinks: url.smartDynamicLinks,
            enableAffiliateTracking: url.enableAffiliateTracking
          },
          clicks: url.clicks,
          currentVersion: url.currentVersion
        };
      }
    }
  } catch (error) {
    console.error('UrlVersion pre-save error:', error);
    // Set default values to avoid validation error
    if (!this.destinationUrl) {
      this.destinationUrl = 'ERROR_FETCHING_URL';
    }
  }
});

// Static methods - FIXED createVersion method
urlVersionSchema.statics.createVersion = async function(urlId, userId, changes, changeDetails = {}) {
  try {
    // Get current version number
    const lastVersion = await this.findOne({ urlId }).sort({ version: -1 });
    const newVersion = (lastVersion ? lastVersion.version : 0) + 1;
    
    // Get the URL to fetch destinationUrl
    const Url = mongoose.model('Url');
    const url = await Url.findById(urlId);
    
    if (!url) {
      throw new Error(`URL with ID ${urlId} not found`);
    }
    
    const version = new this({
      urlId,
      version: newVersion,
      userId,
      destinationUrl: url.destinationUrl,
      changes,
      changeDetails,
      metadata: {
        timestamp: new Date().toISOString(),
        ipAddress: 'SYSTEM'
      }
    });
    
    await version.save();
    return version;
  } catch (error) {
    console.error('Error creating URL version:', error);
    throw error;
  }
};

urlVersionSchema.statics.getUrlVersions = async function(urlId, options = {}) {
  const { limit = 50, skip = 0 } = options;
  
  return await this.find({ urlId })
    .sort({ version: -1 })
    .skip(skip)
    .limit(limit)
    .populate('userId', 'username email')
    .lean();
};

urlVersionSchema.statics.rollbackToVersion = async function(urlId, versionNumber) {
  const version = await this.findOne({ urlId, version: versionNumber });
  
  if (!version) {
    throw new Error(`Version ${versionNumber} not found for URL ${urlId}`);
  }
  
  // Restore URL from snapshot
  const Url = mongoose.model('Url');
  const url = await Url.findById(urlId);
  
  if (!url) {
    throw new Error(`URL ${urlId} not found`);
  }
  
  // Save current state as a new version before rollback
  await this.createVersion(
    urlId,
    url.user,
    'rollback',
    {
      fromVersion: url.currentVersion,
      toVersion: versionNumber,
      snapshot: {
        destinationUrl: url.destinationUrl,
        settings: {
          previewImage: url.previewImage,
          loadingPageImage: url.loadingPageImage,
          brandColor: url.brandColor
        }
      }
    }
  );
  
  // Restore from snapshot
  url.destinationUrl = version.snapshot.destinationUrl;
  url.customName = version.snapshot.customName;
  
  // Only restore password if it exists in snapshot
  if (version.snapshot.password && version.snapshot.password !== 'ENCRYPTED') {
    url.password = version.snapshot.password;
  }
  
  url.expirationDate = version.snapshot.expirationDate;
  url.isActive = version.snapshot.isActive;
  url.isRestricted = version.snapshot.isRestricted;
  
  // Restore settings
  if (version.snapshot.settings) {
    url.previewImage = version.snapshot.settings.previewImage;
    url.loadingPageImage = version.snapshot.settings.loadingPageImage;
    url.brandColor = version.snapshot.settings.brandColor;
    url.splashImage = version.snapshot.settings.splashImage;
    url.generateQrCode = version.snapshot.settings.generateQrCode;
    url.smartDynamicLinks = version.snapshot.settings.smartDynamicLinks;
    url.enableAffiliateTracking = version.snapshot.settings.enableAffiliateTracking;
  }
  
  url.currentVersion = versionNumber;
  await url.save();
  
  // Create a new version entry for the rollback
  await this.createVersion(
    urlId,
    url.user,
    'rollback_completed',
    {
      rolledBackFrom: url.destinationUrl,
      rolledBackTo: version.snapshot.destinationUrl,
      version: versionNumber
    }
  );
  
  return url;
};

urlVersionSchema.statics.getChangeLog = async function(urlId) {
  const versions = await this.find({ urlId })
    .sort({ version: -1 })
    .populate('userId', 'username')
    .lean();
  
  return versions.map(version => ({
    version: version.version,
    changes: version.changes,
    changeDetails: version.changeDetails,
    changedBy: version.userId?.username || 'System',
    changedAt: version.createdAt,
    snapshot: version.snapshot ? {
      hasDestination: !!version.snapshot.destinationUrl,
      hasSettings: !!version.snapshot.settings
    } : null
  }));
};

// Instance method to get formatted version info
urlVersionSchema.methods.getFormattedInfo = function() {
  const changeMessages = {
    'created': 'URL was created',
    'destination_updated': 'Destination URL was changed',
    'settings_updated': 'Settings were updated',
    'password_changed': 'Password protection was changed',
    'expiration_updated': 'Expiration date was updated',
    'image_updated': 'Image was updated',
    'disabled': 'URL was disabled',
    'enabled': 'URL was enabled',
    'restricted': 'URL was restricted by admin',
    'unrestricted': 'URL restriction was removed',
    'ab_testing_enabled': 'A/B testing was enabled',
    'ab_testing_disabled': 'A/B testing was disabled',
    'rollback': 'Rollback was initiated',
    'rollback_completed': 'Rollback was completed'
  };
  
  return {
    version: this.version,
    change: changeMessages[this.changes] || this.changes,
    details: this.changeDetails,
    timestamp: this.createdAt,
    user: this.userId
  };
};

const UrlVersion = mongoose.model('UrlVersion', urlVersionSchema);

module.exports = UrlVersion;