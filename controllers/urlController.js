// controllers/urlController.js
const Url = require('../models/Url');
const UrlVersion = require('../models/UrlVersion');
const Click = require('../models/Click');
const { uploadToCloudinary } = require('../config/cloudinary');
const encryptionService = require('../config/encryption');
const openaiService = require('../utils/openai');
const QRCode = require('qrcode');
const crypto = require('crypto');

/**
 * Helper — safe parse int
 */
const toInt = (v, fallback = 0) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
};

/**
 * Helper — validate and normalize URL
 */
const validateAndNormalizeUrl = (url) => {
  if (!url || typeof url !== 'string') return { valid: false, normalized: null };
  
  let normalized = url.trim();
  
  // Add protocol if missing
  if (!normalized.startsWith('http://') && !normalized.startsWith('https://')) {
    normalized = 'https://' + normalized;
  }
  
  // Validate URL
  try {
    const urlObj = new URL(normalized);
    // Ensure it has a valid protocol
    if (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:') {
      return { valid: false, normalized: null };
    }
    return { valid: true, normalized };
  } catch (e) {
    // Try with http if https fails
    if (normalized.startsWith('https://')) {
      const httpUrl = normalized.replace('https://', 'http://');
      try {
        new URL(httpUrl);
        return { valid: true, normalized: httpUrl };
      } catch (e2) {
        return { valid: false, normalized: null };
      }
    }
    return { valid: false, normalized: null };
  }
};

/**
 * Helper - Generate unique shortId
 */
const generateShortId = async () => {
  return crypto.randomBytes(4).toString('hex');
};

/**
 * Helper - normalize & validate destinations array shape
 * Expected incoming element: { url, rule, weight }
 * Returns cleaned array (only valid entries)
 */
const sanitizeDestinations = (destinations) => {
  if (!Array.isArray(destinations)) return [];

  const cleaned = [];

  for (const d of destinations) {
    if (!d || typeof d !== 'object') continue;
    const rawUrl = (d.url || '').toString().trim();
    const rawRule = (d.rule || '').toString().trim();

    if (!rawUrl || !rawRule) continue;

    // Normalize destination URL
    const { valid, normalized } = validateAndNormalizeUrl(rawUrl);
    if (!valid) continue;

    // Normalize rule (should be like "country:US" or "device:mobile")
    const ruleParts = rawRule.split(':');
    if (ruleParts.length < 2) continue;
    const ruleType = ruleParts[0].trim();
    const ruleValue = ruleParts.slice(1).join(':').trim();
    if (!ruleType || !ruleValue) continue;

    const weight = Math.max(1, toInt(d.weight, 1));

    cleaned.push({
      url: normalized,
      rule: `${ruleType}:${ruleValue}`,
      weight
    });
  }

  return cleaned;
};

// Helper function to calculate date range (same as in analytics controller)
const getDateRange = (range, customStartDate, customEndDate) => {
  const now = new Date();
  let startDate;
  let endDate = now;
  
  switch (range) {
    case 'today':
      startDate = new Date(now);
      startDate.setHours(0, 0, 0, 0);
      break;
    case '7days':
      startDate = new Date(now);
      startDate.setDate(now.getDate() - 7);
      break;
    case '30days':
      startDate = new Date(now);
      startDate.setDate(now.getDate() - 30);
      break;
    case '90days':
      startDate = new Date(now);
      startDate.setDate(now.getDate() - 90);
      break;
    case '180days':
      startDate = new Date(now);
      startDate.setDate(now.getDate() - 180);
      break;
    case '365days':
      startDate = new Date(now);
      startDate.setDate(now.getDate() - 365);
      break;
    case 'all':
      startDate = new Date(0); // Beginning of time
      break;
    case 'custom':
      startDate = customStartDate ? new Date(customStartDate) : new Date(now);
      startDate.setHours(0, 0, 0, 0);
      endDate = customEndDate ? new Date(customEndDate) : now;
      endDate.setHours(23, 59, 59, 999);
      break;
    default:
      startDate = new Date(now);
      startDate.setDate(now.getDate() - 7);
  }
  
  return { startDate, endDate };
};

/**
 * shortenUrl
 */
const shortenUrl = async (req, res) => {
  try {
    const {
      destinationUrl,
      customName,
      password,
      expirationDate,
      previewImage,
      loadingPageImage,
      loadingPageText,
      brandColor,
      splashImage,
      generateQrCode,
      smartDynamicLinks,
      destinations,
      enableAffiliateTracking,
      affiliateTag,
      affiliateId,
      cookieDuration,
      customParams,
      conversionPixel,
      commissionRate,
      metadata,
      tags
    } = req.body;

    if (!destinationUrl) {
      return res.status(400).json({ success: false, message: 'Destination URL is required' });
    }

    // Validate and normalize URL
    const { valid, normalized } = validateAndNormalizeUrl(destinationUrl);
    if (!valid) {
      return res.status(400).json({ success: false, message: 'Invalid URL format. Please enter a valid URL like "example.com" or "https://example.com"' });
    }

    // Generate shortId
    let shortId;
    if (customName) {
      // Check if custom name is already in use by this user
      const existingUrl = await Url.findOne({ customName, user: req.user._id });
      if (existingUrl) {
        return res.status(400).json({ success: false, message: 'Custom name already in use' });
      }
      shortId = customName;
    } else {
      // Generate unique shortId
      let isUnique = false;
      let attempts = 0;
      while (!isUnique && attempts < 10) {
        shortId = await generateShortId();
        const existing = await Url.findOne({ shortId });
        if (!existing) {
          isUnique = true;
        }
        attempts++;
      }
      
      if (!isUnique) {
        return res.status(500).json({ success: false, message: 'Failed to generate unique short URL. Please try again.' });
      }
    }

    // Sanitize destinations array if present
    const cleanedDestinations = sanitizeDestinations(destinations);

    // Normalize affiliate-related inputs
    const cleanedAffiliate = {
      enableAffiliateTracking: !!enableAffiliateTracking,
      affiliateTag: affiliateTag || null,
      affiliateId: affiliateId || null,
      cookieDuration: Math.max(1, toInt(cookieDuration, 30)),
      customParams: (typeof customParams === 'string' && customParams.trim()) ? customParams.trim() : null,
      conversionPixel: conversionPixel || null,
      commissionRate: (commissionRate !== undefined && commissionRate !== null) ? Number(commissionRate) : null
    };

    const urlData = {
      shortId,
      user: req.user._id,
      destinationUrl: normalized,
      customName: customName || null,
      password: password || null,
      expirationDate: expirationDate || null,
      previewImage: previewImage || null,
      loadingPageImage: loadingPageImage || null,
      loadingPageText: loadingPageText || 'Loading...',
      brandColor: brandColor || '#000000',
      splashImage: splashImage || null,
      generateQrCode: !!generateQrCode,
      smartDynamicLinks: !!smartDynamicLinks,
      destinations: cleanedDestinations,
      enableAffiliateTracking: !!cleanedAffiliate.enableAffiliateTracking,
      affiliateTag: cleanedAffiliate.affiliateTag,
      affiliateId: cleanedAffiliate.affiliateId,
      cookieDuration: cleanedAffiliate.cookieDuration,
      customParams: cleanedAffiliate.customParams,
      conversionPixel: cleanedAffiliate.conversionPixel,
      commissionRate: cleanedAffiliate.commissionRate,
      metadata: metadata || {},
      tags: tags || []
    };

    // Create and save URL
    const url = new Url(urlData);
    await url.save();

    // Generate QR code if requested
    if (generateQrCode && !url.qrCodeData) {
      try {
        const qrCodeUrl = `${process.env.BASE_URL || 'http://localhost:5000'}/s/${url.shortId}`;
        url.qrCodeData = await QRCode.toDataURL(qrCodeUrl, {
          errorCorrectionLevel: 'H',
          margin: 2,
          width: 300
        });
        await url.save();
      } catch (err) {
        console.warn('QR generation failed (non-fatal):', err.message);
      }
    }

    // Create initial version history
    try {
      if (UrlVersion && typeof UrlVersion.createVersion === 'function') {
        await UrlVersion.createVersion(
          url._id,
          req.user._id,
          'created',
          {
            destinationUrl: normalized,
            settings: {
              password: !!password,
              expiration: !!expirationDate,
              qrCode: !!generateQrCode,
              smartLinks: !!smartDynamicLinks
            }
          }
        );
      }
    } catch (err) {
      console.warn('UrlVersion.createVersion failed:', err.message);
    }

    // Update user stats
    try {
      req.user.stats = req.user.stats || {};
      req.user.stats.totalUrls = (req.user.stats.totalUrls || 0) + 1;
      await req.user.save();
    } catch (err) {
      console.warn('update user stats failed (non-fatal):', err.message);
    }

    return res.status(201).json({
      success: true,
      message: 'URL shortened successfully!',
      url: {
        id: url._id,
        shortId: url.shortId,
        shortUrl: `${process.env.BASE_URL || 'http://localhost:5000'}/s/${url.shortId}`,
        destinationUrl: url.destinationUrl,
        customName: url.customName,
        password: !!url.password,
        expirationDate: url.expirationDate,
        isActive: url.isActive,
        clicks: url.clicks,
        qrCodeUrl: url.qrCodeData,
        createdAt: url.createdAt
      }
    });
  } catch (error) {
    console.error('Shorten URL error:', error && error.message ? error.message : error);
    return res.status(500).json({
      success: false,
      message: 'Failed to shorten URL. Please try again.',
      error: process.env.NODE_ENV === 'development' ? (error && error.message ? error.message : String(error)) : undefined
    });
  }
};

/**
 * smartGenerate (AI suggestions)
 */
const smartGenerate = async (req, res) => {
  try {
    const { destinationUrl, customName } = req.body;
    if (!destinationUrl) {
      return res.status(400).json({ success: false, message: 'Destination URL is required' });
    }

    // Validate URL first
    const { valid, normalized } = validateAndNormalizeUrl(destinationUrl);
    if (!valid) {
      return res.status(400).json({ success: false, message: 'Invalid URL format' });
    }

    let suggestions = {};
    try {
      suggestions = await openaiService.analyzeUrl(normalized);
    } catch (e) {
      console.warn('OpenAI analyzeUrl failed, using defaults:', e.message);
      suggestions = openaiService.getDefaultSuggestions ? openaiService.getDefaultSuggestions() : {};
    }

    const suggestedSettings = {
      customName: suggestions.customName || customName,
      previewImage: suggestions.previewImage,
      loadingPageText: suggestions.loadingPageText || 'Loading...',
      brandColor: suggestions.brandColor || '#000000',
      generateQrCode: suggestions.generateQrCode !== undefined ? suggestions.generateQrCode : true,
      smartDynamicLinks: suggestions.smartDynamicLinks || false,
      tags: suggestions.tags || [],
      metadata: suggestions.metadata || {},
      isEcommerce: suggestions.isEcommerce || false,
      isTimeSensitive: suggestions.isTimeSensitive || false,
      explanation: suggestions.explanation || 'Default settings applied'
    };

    // suggest expiration if time-sensitive
    if (suggestedSettings.isTimeSensitive) {
      const expirationDate = new Date();
      expirationDate.setDate(expirationDate.getDate() + 30);
      suggestedSettings.expirationDate = expirationDate;
    }

    return res.json({
      success: true,
      message: 'Smart settings generated',
      suggestedSettings,
      explanation: suggestedSettings.explanation
    });
  } catch (error) {
    console.error('Smart generate error:', error);
    return res.json({
      success: true,
      message: 'Using default settings',
      suggestedSettings: {
        generateQrCode: true,
        brandColor: '#000000',
        loadingPageText: 'Loading...',
        tags: [],
        metadata: {},
        explanation: 'Default settings applied'
      }
    });
  }
};

/**
 * getUserUrls (paginated)
 */
const getUserUrls = async (req, res) => {
  try {
    const page = toInt(req.query.page, 1);
    const limit = toInt(req.query.limit, 20);
    const sortBy = req.query.sortBy || 'createdAt';
    const order = req.query.order === 'asc' ? 1 : -1;
    const search = req.query.search || '';

    const skip = (page - 1) * limit;

    const query = { user: req.user._id };
    if (search) {
      query.$or = [
        { destinationUrl: { $regex: search, $options: 'i' } },
        { customName: { $regex: search, $options: 'i' } },
        { shortId: { $regex: search, $options: 'i' } }
      ];
    }

    const sort = {};
    sort[sortBy] = order;

    const urls = await Url.find(query).sort(sort).skip(skip).limit(limit).lean();
    const total = await Url.countDocuments(query);

    const formatted = urls.map(u => ({
      id: u._id,
      _id: u._id,
      shortId: u.shortId,
      shortUrl: `${process.env.BASE_URL || 'http://localhost:5000'}/s/${u.shortId}`,
      destinationUrl: u.destinationUrl,
      customName: u.customName,
      password: !!u.password,
      expirationDate: u.expirationDate,
      isActive: u.isActive,
      isRestricted: u.isRestricted,
      clicks: u.clicks,
      lastClicked: u.lastClicked,
      createdAt: u.createdAt,
      tags: u.tags || [],
      hasQrCode: !!u.qrCodeData
    }));

    return res.json({
      success: true,
      urls: formatted,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('Get user URLs error:', error);
    return res.status(500).json({ success: false, message: 'Failed to get URLs' });
  }
};

/**
 * getUrl (single)
 */
const getUrl = async (req, res) => {
  try {
    const id = req.params.id;
    const url = await Url.findOne({ _id: id, user: req.user._id });
    if (!url) return res.status(404).json({ success: false, message: 'URL not found' });

    const versions = await UrlVersion.find({ urlId: url._id }).sort({ version: -1 }).limit(10).lean();
    const recentClicks = await Click.find({ urlId: url._id }).sort({ timestamp: -1 }).limit(10).lean();

    return res.json({
      success: true,
      url: {
        id: url._id,
        shortId: url.shortId,
        shortUrl: url.shortUrl,
        destinationUrl: url.destinationUrl,
        customName: url.customName,
        password: !!url.password,
        expirationDate: url.expirationDate,
        isActive: url.isActive,
        isRestricted: url.isRestricted,
        previewImage: url.previewImage,
        loadingPageImage: url.loadingPageImage,
        loadingPageText: url.loadingPageText,
        brandColor: url.brandColor,
        splashImage: url.splashImage,
        generateQrCode: url.generateQrCode,
        qrCodeData: url.qrCodeData,
        smartDynamicLinks: url.smartDynamicLinks,
        destinations: url.destinations,
        enableAffiliateTracking: url.enableAffiliateTracking,
        affiliateTag: url.affiliateTag,
        enableABTesting: url.enableABTesting,
        abTestVariants: url.abTestVariants,
        clicks: url.clicks,
        uniqueClicks: url.uniqueClicks,
        lastClicked: url.lastClicked,
        currentVersion: url.currentVersion,
        metadata: url.metadata,
        tags: url.tags,
        createdAt: url.createdAt,
        updatedAt: url.updatedAt
      },
      versions: versions.map(v => ({
        version: v.version,
        changes: v.changes,
        changedAt: v.createdAt,
        changeDetails: v.changeDetails
      })),
      recentClicks: recentClicks.map(c => ({
        ipAddress: c.ipAddress,
        country: c.country,
        device: c.device,
        browser: c.browser,
        timestamp: c.timestamp
      }))
    });
  } catch (error) {
    console.error('Get URL error:', error);
    return res.status(500).json({ success: false, message: 'Failed to get URL' });
  }
};

/**
 * updateUrl
 */
const updateUrl = async (req, res) => {
  try {
    const id = req.params.id;
    const updates = req.body || {};

    const url = await Url.findOne({ _id: id, user: req.user._id });
    if (!url) return res.status(404).json({ success: false, message: 'URL not found' });

    if (updates.shortId && updates.shortId !== url.shortId) {
      return res.status(400).json({ success: false, message: 'Cannot change short ID' });
    }

    // Validate URL if destinationUrl is being updated
    if (updates.destinationUrl) {
      const { valid, normalized } = validateAndNormalizeUrl(updates.destinationUrl);
      if (!valid) {
        return res.status(400).json({ success: false, message: 'Invalid URL format' });
      }
      updates.destinationUrl = normalized;
    }

    // If destinations included in update, sanitize them
    if (updates.destinations) {
      updates.destinations = sanitizeDestinations(updates.destinations);
    }

    // Normalize affiliate updates if present
    if (updates.cookieDuration !== undefined) {
      updates.cookieDuration = Math.max(1, toInt(updates.cookieDuration, 30));
    }
    if (updates.commissionRate !== undefined && updates.commissionRate !== null) {
      updates.commissionRate = Number(updates.commissionRate);
    }
    if (updates.customParams && typeof updates.customParams === 'string') {
      updates.customParams = updates.customParams.trim();
    }

    const changes = [];
    const changeDetails = {};

    if (updates.destinationUrl && updates.destinationUrl !== url.destinationUrl) {
      changes.push('destination_updated');
      changeDetails.oldDestination = url.destinationUrl;
      changeDetails.newDestination = updates.destinationUrl;
    }

    if (updates.customName !== undefined && updates.customName !== url.customName) {
      changes.push('settings_updated');
      changeDetails.customNameChanged = true;
    }

    if (updates.password !== undefined) {
      changes.push('password_changed');
      changeDetails.passwordChanged = true;
    }

    if (updates.expirationDate !== undefined) {
      changes.push('expiration_updated');
      changeDetails.expirationChanged = true;
    }

    Object.keys(updates).forEach(k => {
      if (k !== 'shortId' && k !== '_id') url[k] = updates[k];
    });

    await url.save();

    if (changes.length > 0 && UrlVersion && typeof UrlVersion.createVersion === 'function') {
      try {
        await UrlVersion.createVersion(url._id, req.user._id, changes.join(', '), changeDetails);
      } catch (err) {
        console.warn('UrlVersion.createVersion failed (non-fatal):', err.message);
      }
    }

    return res.json({
      success: true,
      message: 'URL updated successfully',
      url: {
        id: url._id,
        shortId: url.shortId,
        shortUrl: url.shortUrl,
        destinationUrl: url.destinationUrl,
        customName: url.customName,
        isActive: url.isActive,
        clicks: url.clicks,
        updatedAt: url.updatedAt
      }
    });
  } catch (error) {
    console.error('Update URL error:', error);
    return res.status(500).json({ success: false, message: 'Failed to update URL' });
  }
};

/**
 * deleteUrl
 */
const deleteUrl = async (req, res) => {
  try {
    const id = req.params.id;
    const url = await Url.findOne({ _id: id, user: req.user._id });
    if (!url) return res.status(404).json({ success: false, message: 'URL not found' });

    await Click.deleteMany({ urlId: url._id });
    await UrlVersion.deleteMany({ urlId: url._id });
    await url.deleteOne();

    try {
      req.user.stats = req.user.stats || {};
      req.user.stats.totalUrls = Math.max(0, (req.user.stats.totalUrls || 0) - 1);
      await req.user.save();
    } catch (err) {
      console.warn('update user stats failed (non-fatal):', err.message);
    }

    return res.json({ success: true, message: 'URL deleted successfully' });
  } catch (error) {
    console.error('Delete URL error:', error);
    return res.status(500).json({ success: false, message: 'Failed to delete URL' });
  }
};

/**
 * getUrlAnalytics - Enhanced version for all time ranges
 */
const getUrlAnalytics = async (req, res) => {
  try {
    const id = req.params.id;
    const range = req.query.range || '7days';
    const customStartDate = req.query.startDate;
    const customEndDate = req.query.endDate;

    const url = await Url.findOne({ _id: id, user: req.user._id });
    if (!url) return res.status(404).json({ success: false, message: 'URL not found' });

    // Calculate date range
    const { startDate, endDate } = getDateRange(range, customStartDate, customEndDate);
    
    console.log(`Getting analytics for URL ${id}, range: ${range}, dates: ${startDate} to ${endDate}`);

    // Get analytics using aggregation for better performance
    const analytics = await Click.aggregate([
      {
        $match: {
          urlId: url._id,
          timestamp: { $gte: startDate, $lte: endDate },
          isBot: false
        }
      },
      {
        $facet: {
          // Basic stats
          basicStats: [
            {
              $group: {
                _id: null,
                totalClicks: { $sum: 1 },
                uniqueClicks: { $addToSet: '$ipAddress' },
                returningVisitors: { $sum: { $cond: ['$isReturning', 1, 0] } },
                conversions: { $sum: { $cond: ['$isConversion', 1, 0] } },
                totalTimeOnPage: { $sum: '$timeOnPage' },
                totalScrollDepth: { $sum: '$scrollDepth' },
                clicksWithTimeToClick: { $sum: { $cond: ['$timeToClick', 1, 0] } },
                totalTimeToClick: { $sum: '$timeToClick' }
              }
            }
          ],
          
          // Time series - adjust grouping for all time
          timeSeries: [
            {
              $group: {
                _id: {
                  $dateToString: { 
                    format: range === 'all' ? '%Y-%m' : '%Y-%m-%d', 
                    date: '$timestamp' 
                  }
                },
                count: { $sum: 1 }
              }
            },
            { $sort: { _id: 1 } }
          ],
          
          // Countries
          countries: [
            {
              $match: {
                country: { $exists: true, $ne: null }
              }
            },
            {
              $group: {
                _id: '$country',
                count: { $sum: 1 }
              }
            },
            { $sort: { count: -1 } },
            { $limit: 10 }
          ],
          
          // Devices
          devices: [
            {
              $group: {
                _id: '$device',
                count: { $sum: 1 }
              }
            }
          ],
          
          // Recent clicks
          recentClicks: [
            { $sort: { timestamp: -1 } },
            { $limit: 10 }
          ],
          
          // Peak hour
          peakHour: [
            {
              $group: {
                _id: { $hour: '$timestamp' },
                count: { $sum: 1 }
              }
            },
            { $sort: { count: -1 } },
            { $limit: 1 }
          ],
          
          // Referrers
          referrers: [
            {
              $match: {
                referrerDomain: { $exists: true, $ne: null }
              }
            },
            {
              $group: {
                _id: '$referrerDomain',
                count: { $sum: 1 }
              }
            },
            { $sort: { count: -1 } },
            { $limit: 5 }
          ]
        }
      }
    ]);

    const stats = analytics[0];
    const basicStats = stats.basicStats[0] || { 
      totalClicks: 0, 
      uniqueClicks: [], 
      returningVisitors: 0,
      conversions: 0,
      totalTimeOnPage: 0,
      totalScrollDepth: 0,
      clicksWithTimeToClick: 0,
      totalTimeToClick: 0
    };
    
    const totalClicks = basicStats.totalClicks || 0;
    const uniqueClicks = basicStats.uniqueClicks ? basicStats.uniqueClicks.length : 0;
    const returningVisitors = basicStats.returningVisitors || 0;
    const conversions = basicStats.conversions || 0;
    
    // Calculate metrics
    const conversionRate = totalClicks > 0 ? ((conversions / totalClicks) * 100).toFixed(1) : 0;
    const avgTimeOnPage = basicStats.totalTimeOnPage && totalClicks > 0 
      ? Math.floor(basicStats.totalTimeOnPage / totalClicks)
      : 0;
      
    const avgScrollDepth = basicStats.totalScrollDepth && totalClicks > 0
      ? Math.round((basicStats.totalScrollDepth / totalClicks) * 100)
      : 0;
      
    const avgTimeToClick = basicStats.totalTimeToClick && basicStats.clicksWithTimeToClick > 0
      ? Math.round(basicStats.totalTimeToClick / basicStats.clicksWithTimeToClick / 1000)
      : 0;
    
    // Time series
    const timeSeriesData = stats.timeSeries || [];
    const clicksOverTime = {
      labels: timeSeriesData.map(item => {
        const dateStr = item._id;
        if (range === 'all' && /^\d{4}-\d{2}$/.test(dateStr)) {
          const [year, month] = dateStr.split('-');
          const date = new Date(year, month - 1);
          return date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
        } else {
          try {
            const date = new Date(dateStr);
            return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
          } catch {
            return dateStr;
          }
        }
      }),
      values: timeSeriesData.map(item => item.count)
    };
    
    // Countries
    const countryData = stats.countries || [];
    const topCountries = {
      rawData: countryData.map(item => ({
        country: item._id,
        visits: item.count
      })),
      countries: countryData.map(item => item._id),
      visits: countryData.map(item => item.count)
    };
    
    // Devices - FIXED: Return proper object format expected by frontend
    const deviceData = stats.devices || [];
    const deviceDistribution = {
      desktop: 0,
      mobile: 0,
      tablet: 0,
      other: 0
    };
    
    deviceData.forEach(item => {
      const deviceType = (item._id || '').toLowerCase();
      if (deviceType.includes('desktop')) {
        deviceDistribution.desktop = item.count;
      } else if (deviceType.includes('mobile')) {
        deviceDistribution.mobile = item.count;
      } else if (deviceType.includes('tablet')) {
        deviceDistribution.tablet = item.count;
      } else {
        deviceDistribution.other = item.count;
      }
    });
    
    // Calculate engagement metrics
    const engagedClicks = await Click.countDocuments({
      urlId: url._id,
      timestamp: { $gte: startDate, $lte: endDate },
      isBot: false,
      timeOnPage: { $gt: 30 } // Consider engaged if spent more than 30 seconds
    });
    
    const bounceRate = totalClicks > 0 ? Math.round(((totalClicks - engagedClicks) / totalClicks) * 100) : 0;
    const engagement = {
      bounced: Math.round(totalClicks * (bounceRate / 100)),
      engaged: engagedClicks,
      bounceRate: bounceRate
    };
    
    // Peak hour
    const peakHourData = stats.peakHour[0];
    const peakHour = peakHourData ? `${peakHourData._id}:00` : 'N/A';
    
    // Top referrer
    const topReferrerData = stats.referrers[0];
    const topReferrer = topReferrerData ? topReferrerData._id : 'Direct';
    
    // Recent clicks
    const recentClicks = stats.recentClicks || [];
    
    return res.json({
      success: true,
      analytics: {
        totalClicks,
        uniqueClicks,
        returningVisitors,
        conversionRate: `${conversionRate}%`,
        clicksOverTime,
        topCountries,
        deviceDistribution, // Now returns proper object format
        engagement,
        recentClicks: recentClicks.map(click => ({
          timestamp: click.timestamp,
          ipAddress: click.ipAddress ? click.ipAddress.substring(0, 8) + '...' : 'N/A',
          country: click.country || 'Unknown',
          device: click.device || 'Unknown',
          browser: click.browser || 'Unknown',
          referrer: click.referrer || 'Direct'
        })),
        detailedMetrics: {
          avgTimeToClick: avgTimeToClick > 0 ? `${avgTimeToClick}s` : 'N/A',
          avgScrollDepth: avgScrollDepth > 0 ? `${avgScrollDepth}%` : 'N/A',
          avgSessionDuration: avgTimeOnPage > 0 ? `${avgTimeOnPage}s` : 'N/A',
          peakHour,
          topReferrer,
          pagesPerSession: (engagedClicks > 0 ? (totalClicks / engagedClicks).toFixed(1) : 1.0),
          conversionRate: `${conversionRate}%`
        }
      }
    });
    
  } catch (error) {
    console.error('Get URL analytics error:', error);
    return res.status(500).json({ success: false, message: 'Failed to get analytics' });
  }
};

/**
 * getUrlVersions
 */
const getUrlVersions = async (req, res) => {
  try {
    const id = req.params.id;
    const url = await Url.findOne({ _id: id, user: req.user._id });
    if (!url) return res.status(404).json({ success: false, message: 'URL not found' });

    const versions = await UrlVersion.getUrlVersions(url._id, { limit: 50 });
    return res.json({
      success: true,
      versions: versions.map(v => ({
        id: v._id,
        version: v.version,
        changes: v.changes,
        changeDetails: v.changeDetails,
        changedAt: v.createdAt,
        snapshot: v.snapshot ? {
          destinationUrl: v.snapshot.destinationUrl,
          hasSettings: !!v.snapshot.settings
        } : null
      }))
    });
  } catch (error) {
    console.error('Get URL versions error:', error);
    return res.status(500).json({ success: false, message: 'Failed to get version history' });
  }
};

/**
 * rollbackToVersion
 */
const rollbackToVersion = async (req, res) => {
  try {
    const { id, versionId } = req.params;
    const url = await Url.findOne({ _id: id, user: req.user._id });
    if (!url) return res.status(404).json({ success: false, message: 'URL not found' });

    const version = await UrlVersion.findById(versionId);
    if (!version || String(version.urlId) !== String(id)) {
      return res.status(404).json({ success: false, message: 'Version not found' });
    }

    const rolledBackUrl = await UrlVersion.rollbackToVersion(url._id, version.version);
    return res.json({
      success: true,
      message: `Rolled back to version ${version.version}`,
      url: {
        id: rolledBackUrl._id,
        shortId: rolledBackUrl.shortId,
        destinationUrl: rolledBackUrl.destinationUrl,
        currentVersion: rolledBackUrl.currentVersion
      }
    });
  } catch (error) {
    console.error('Rollback error:', error);
    return res.status(500).json({ success: false, message: 'Failed to rollback' });
  }
};

/**
 * enableABTesting / disableABTesting
 */
const enableABTesting = async (req, res) => {
  try {
    const id = req.params.id;
    const { variants } = req.body;
    const url = await Url.findOne({ _id: id, user: req.user._id });
    if (!url) return res.status(404).json({ success: false, message: 'URL not found' });

    if (!variants || !Array.isArray(variants) || variants.length < 2) {
      return res.status(400).json({ success: false, message: 'At least 2 variants are required' });
    }

    const totalWeight = variants.reduce((s, v) => s + (v.weight || 1), 0) || 1;
    const normalized = variants.map(v => ({ destinationUrl: v.destinationUrl, weight: (v.weight || 1) / totalWeight, clicks: 0 }));

    url.enableABTesting = true;
    url.abTestVariants = normalized;
    await url.save();

    if (UrlVersion && typeof UrlVersion.createVersion === 'function') {
      await UrlVersion.createVersion(url._id, req.user._id, 'ab_testing_enabled', { variants: normalized.length, totalWeight });
    }

    return res.json({ success: true, message: 'A/B testing enabled', url: { id: url._id, shortId: url.shortId, enableABTesting: url.enableABTesting, abTestVariants: url.abTestVariants } });
  } catch (error) {
    console.error('Enable A/B testing error:', error);
    return res.status(500).json({ success: false, message: 'Failed to enable A/B testing' });
  }
};

const disableABTesting = async (req, res) => {
  try {
    const id = req.params.id;
    const url = await Url.findOne({ _id: id, user: req.user._id });
    if (!url) return res.status(404).json({ success: false, message: 'URL not found' });

    url.enableABTesting = false;
    url.abTestVariants = [];
    await url.save();

    if (UrlVersion && typeof UrlVersion.createVersion === 'function') {
      await UrlVersion.createVersion(url._id, req.user._id, 'ab_testing_disabled');
    }

    return res.json({ success: true, message: 'A/B testing disabled', url: { id: url._id, shortId: url.shortId, enableABTesting: url.enableABTesting } });
  } catch (error) {
    console.error('Disable A/B testing error:', error);
    return res.status(500).json({ success: false, message: 'Failed to disable A/B testing' });
  }
};

/**
 * getQRCode
 */
const getQRCode = async (req, res) => {
  try {
    const shortId = req.params.shortId;
    const url = await Url.findOne({ shortId });
    if (!url) return res.status(404).json({ success: false, message: 'URL not found' });

    if (req.user && String(url.user) !== String(req.user._id)) {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }

    if (!url.qrCodeData) {
      const qr = await QRCode.toDataURL(url.shortUrl, { errorCorrectionLevel: 'H', margin: 2, width: 300 });
      url.qrCodeData = qr;
      await url.save();
    }

    const base64 = url.qrCodeData.replace(/^data:image\/[^;]+;base64,/, '');
    const img = Buffer.from(base64, 'base64');
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': img.length });
    return res.end(img);
  } catch (error) {
    console.error('Get QR code error:', error);
    return res.status(500).json({ success: false, message: 'Failed to generate QR code' });
  }
};

/**
 * uploadImage
 *
 * Accepts both:
 * - multer configured with Cloudinary storage (req.file already contains cloudinary result fields)
 * - multer memory storage (req.file.buffer present) -> we upload via uploadToCloudinary(buffer)
 */
const uploadImage = async (req, res) => {
  try {
    const id = req.params.id;
    const type = req.body.type;

    if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });

    const url = await Url.findOne({ _id: id, user: req.user._id });
    if (!url) return res.status(404).json({ success: false, message: 'URL not found' });

    let result = null;

    // multer-storage-cloudinary often returns fields like req.file.path or req.file.secure_url
    if (req.file.path || req.file.secure_url || req.file.url) {
      // Some storages set path, others secure_url
      result = {
        secure_url: req.file.secure_url || req.file.url || req.file.path,
        public_id: req.file.public_id || req.file.filename || null
      };
    } else if (req.file.location) {
      result = { secure_url: req.file.location, public_id: req.file.key || null };
    } else if (req.file.buffer) {
      // Memory storage - upload using our cloudinary helper
      try {
        const uploadRes = await uploadToCloudinary(req.file.buffer, 'url_images');
        result = uploadRes;
      } catch (uploadErr) {
        console.error('uploadToCloudinary failed:', uploadErr && uploadErr.message ? uploadErr.message : uploadErr);
        return res.status(500).json({ success: false, message: 'Failed to upload image' });
      }
    } else {
      // Unknown multer output shape
      return res.status(400).json({ success: false, message: 'Unrecognized upload result' });
    }

    if (type === 'preview') url.previewImage = result.secure_url;
    else if (type === 'loading') url.loadingPageImage = result.secure_url;
    else if (type === 'splash') url.splashImage = result.secure_url;
    else return res.status(400).json({ success: false, message: 'Invalid image type' });

    await url.save();

    if (UrlVersion && typeof UrlVersion.createVersion === 'function') {
      await UrlVersion.createVersion(url._id, req.user._id, 'image_updated', { imageType: type });
    }

    return res.json({
      success: true,
      message: 'Image uploaded successfully',
      imageUrl: result.secure_url,
      url: { id: url._id, shortId: url.shortId, [type === 'preview' ? 'previewImage' : type === 'loading' ? 'loadingPageImage' : 'splashImage']: result.secure_url }
    });
  } catch (error) {
    console.error('Upload image error:', error && error.message ? error.message : error);
    return res.status(500).json({ success: false, message: 'Failed to upload image' });
  }
};

/**
 * getDashboardStats — returns a plain stats object (so frontend's setStats(statsRes.data) works)
 */
const getDashboardStats = async (req, res) => {
  try {
    const userId = req.user._id;

    const totalUrls = await Url.countDocuments({ user: userId });

    const activeUrls = await Url.countDocuments({
      user: userId,
      isActive: true,
      $or: [{ expirationDate: null }, { expirationDate: { $gt: new Date() } }]
    });

    // total clicks
    const totalClicksResult = await Url.aggregate([
      { $match: { user: userId } },
      { $group: { _id: null, total: { $sum: '$clicks' } } }
    ]);
    const totalClicks = totalClicksResult[0]?.total || 0;

    // today's clicks - get list of this user's url _ids
    const userUrlIds = await Url.distinct('_id', { user: userId });
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    let todayClicks = 0;
    if (Array.isArray(userUrlIds) && userUrlIds.length > 0) {
      const todayClicksResult = await Click.aggregate([
        { $match: { timestamp: { $gte: today }, urlId: { $in: userUrlIds } } },
        { $group: { _id: null, total: { $sum: 1 } } }
      ]);
      todayClicks = todayClicksResult[0]?.total || 0;
    }

    // Return **plain** stats object (not wrapped) to match frontend usage setStats(statsRes.data)
    return res.json({
      success: true,
      totalUrls,
      totalClicks,
      todayClicks,
      activeUrls
    });
  } catch (error) {
    console.error('Get dashboard stats error:', error);
    return res.status(500).json({ success: false, message: 'Failed to get dashboard stats' });
  }
};

/**
 * getRecentUrls — returns an array (so frontend's setRecentUrls(urlsRes.data) works)
 */
const getRecentUrls = async (req, res) => {
  try {
    const userId = req.user._id;
    const recent = await Url.find({ user: userId })
      .sort({ createdAt: -1 })
      .limit(5)
      .select('shortId destinationUrl clicks createdAt')
      .lean();

    // Map to the shape the frontend expects in the Dashboard component
    const mapped = recent.map(u => ({
      _id: u._id,
      shortId: u.shortId,
      shortUrl: `${process.env.BASE_URL || 'http://localhost:5000'}/s/${u.shortId}`,
      destinationUrl: u.destinationUrl,
      clicks: u.clicks || 0,
      createdAt: u.createdAt
    }));

    return res.json({
      success: true,
      data: mapped
    });
  } catch (error) {
    console.error('Get recent URLs error:', error);
    return res.status(500).json({ success: false, message: 'Failed to get recent URLs' });
  }
};

/**
 * bulkOperations
 */
const bulkOperations = async (req, res) => {
  try {
    const { action, urlIds } = req.body;
    if (!action || !Array.isArray(urlIds)) {
      return res.status(400).json({ success: false, message: 'Action and URL IDs are required' });
    }

    const urls = await Url.find({ _id: { $in: urlIds }, user: req.user._id });
    if (urls.length !== urlIds.length) {
      return res.status(403).json({ success: false, message: 'Some URLs not found or not authorized' });
    }

    if (action === 'delete') {
      await Url.deleteMany({ _id: { $in: urlIds } });
      await Click.deleteMany({ urlId: { $in: urlIds } });
      await UrlVersion.deleteMany({ urlId: { $in: urlIds } });

      try {
        req.user.stats = req.user.stats || {};
        req.user.stats.totalUrls = Math.max(0, (req.user.stats.totalUrls || 0) - urlIds.length);
        await req.user.save();
      } catch (err) {
        console.warn('update user stats failed (non-fatal):', err.message);
      }

      return res.json({ success: true, message: 'URLs deleted successfully', count: urlIds.length });
    }

    let updateQuery = {};
    let message = '';

    if (action === 'enable') { updateQuery = { isActive: true }; message = 'URLs enabled successfully'; }
    else if (action === 'disable') { updateQuery = { isActive: false }; message = 'URLs disabled successfully'; }
    else return res.status(400).json({ success: false, message: 'Invalid action' });

    const result = await Url.updateMany({ _id: { $in: urlIds } }, { $set: updateQuery });

    return res.json({ success: true, message, count: result.modifiedCount || 0 });
  } catch (error) {
    console.error('Bulk operations error:', error);
    return res.status(500).json({ success: false, message: 'Failed to perform bulk operations' });
  }
};

/**
 * Update URL status (activate/deactivate)
 */
const updateUrlStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { isActive } = req.body;

    const url = await Url.findOne({ _id: id, user: req.user._id });
    if (!url) {
      return res.status(404).json({ success: false, message: 'URL not found' });
    }

    url.isActive = isActive;
    await url.save();

    // Create version history
    if (UrlVersion && typeof UrlVersion.createVersion === 'function') {
      await UrlVersion.createVersion(
        url._id,
        req.user._id,
        isActive ? 'enabled' : 'disabled',
        { isActive }
      );
    }

    res.json({
      success: true,
      message: `URL ${isActive ? 'activated' : 'deactivated'} successfully`,
      url: {
        id: url._id,
        shortId: url.shortId,
        isActive: url.isActive
      }
    });
  } catch (error) {
    console.error('Update URL status error:', error);
    res.status(500).json({ success: false, message: 'Failed to update URL status' });
  }
};

/**
 * Get URL by shortId
 */
const getUrlByShortId = async (req, res) => {
  try {
    const { shortId } = req.params;
    const url = await Url.findOne({ shortId });

    if (!url) {
      return res.status(404).json({ success: false, message: 'URL not found' });
    }

    // Check if user owns this URL (if authenticated)
    if (req.user && url.user.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }

    res.json({
      success: true,
      url: {
        id: url._id,
        shortId: url.shortId,
        shortUrl: url.shortUrl,
        destinationUrl: url.destinationUrl,
        customName: url.customName,
        password: !!url.password,
        expirationDate: url.expirationDate,
        isActive: url.isActive,
        clicks: url.clicks,
        createdAt: url.createdAt
      }
    });
  } catch (error) {
    console.error('Get URL by shortId error:', error);
    res.status(500).json({ success: false, message: 'Failed to get URL' });
  }
};

/**
 * exportUrlAnalytics
 */
const exportUrlAnalytics = async (req, res) => {
  try {
    const { id } = req.params;
    const { format = 'csv', range = 'all', startDate, endDate } = req.query;

    const url = await Url.findOne({ _id: id, user: req.user._id });
    if (!url) {
      return res.status(404).json({ success: false, message: 'URL not found' });
    }

    // Calculate date range
    const dateRange = getDateRange(range, startDate, endDate);
    const filter = { urlId: url._id, timestamp: { $gte: dateRange.startDate, $lte: dateRange.endDate } };

    const clicks = await Click.find(filter)
      .sort({ timestamp: -1 })
      .lean();

    if (format === 'csv') {
      const headers = ['Timestamp', 'IP Address', 'Country', 'Device', 'Browser', 'Referrer', 'Time on Page (s)', 'Scroll Depth (%)'];
      const rows = clicks.map(click => [
        new Date(click.timestamp).toISOString(),
        click.ipAddress || 'N/A',
        click.country || 'Unknown',
        click.device || 'Unknown',
        click.browser || 'Unknown',
        click.referrer || 'Direct',
        click.timeOnPage || '0',
        click.scrollDepth || '0'
      ]);

      const csvContent = [
        headers.join(','),
        ...rows.map(row => row.map(cell => `"${cell}"`).join(','))
      ].join('\n');

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename=analytics_${url.shortId}_${Date.now()}.csv`);
      res.send(csvContent);
    } else {
      res.json({
        success: true,
        data: clicks,
        metadata: {
          total: clicks.length,
          url: url.shortId,
          exportedAt: new Date().toISOString(),
          range,
          startDate: dateRange.startDate,
          endDate: dateRange.endDate
        }
      });
    }
  } catch (error) {
    console.error('Export URL analytics error:', error);
    res.status(500).json({ success: false, message: 'Failed to export analytics' });
  }
};


module.exports = {
  shortenUrl,
  smartGenerate,
  getUserUrls,
  updateUrlStatus,
  getUrlByShortId,
  exportUrlAnalytics,
  getUrlAnalytics,
  getUrl,
  updateUrl,
  deleteUrl,
  getUrlVersions,
  rollbackToVersion,
  enableABTesting,
  disableABTesting,
  getQRCode,
  uploadImage,
  getDashboardStats,
  getRecentUrls,
  bulkOperations
};