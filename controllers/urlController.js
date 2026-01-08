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
 * Helper — validate and normalize URL (updated to accept ANY valid URL format)
 */
const validateAndNormalizeUrl = (url) => {
  if (!url || typeof url !== 'string') return { valid: false, normalized: null };
  
  let normalized = url.trim();
  
  // Check if it's a valid URL format - support ANY protocol or no protocol
  try {
    // First, try to parse as-is
    const urlObj = new URL(normalized);
    
    // If no protocol and it starts with //, add https:
    if (normalized.startsWith('//')) {
      normalized = 'https:' + normalized;
      const testObj = new URL(normalized);
      return { valid: true, normalized };
    }
    
    // If it already has a protocol (http, https, ftp, mailto, tel, etc.), accept it
    return { valid: true, normalized };
  } catch (e) {
    // Try adding https:// for URLs without protocol
    try {
      // Don't add protocol if it's a special protocol like mailto:, tel:, whatsapp:, etc.
      const hasSpecialProtocol = /^[a-z]+:/i.test(normalized) && !normalized.startsWith('http');
      if (hasSpecialProtocol) {
        // For special protocols, validate differently
        return { valid: true, normalized };
      }
      
      // For URLs without any protocol, add https://
      const withProtocol = 'https://' + normalized;
      const urlObj = new URL(withProtocol);
      
      // Additional check for common domain patterns
      if (urlObj.hostname && urlObj.hostname.includes('.')) {
        return { valid: true, normalized: withProtocol };
      }
      
      return { valid: false, normalized: null };
    } catch (e2) {
      // Try with http://
      try {
        const withHttp = 'http://' + normalized;
        const urlObj = new URL(withHttp);
        if (urlObj.hostname && urlObj.hostname.includes('.')) {
          return { valid: true, normalized: withHttp };
        }
        return { valid: false, normalized: null };
      } catch (e3) {
        // Check for common URL patterns without strict validation
        const urlPattern = /^(?:[a-z]+:)?\/\/[^\s$.?#].[^\s]*$/i;
        const domainPattern = /^[a-zA-Z0-9][a-zA-Z0-9-]{1,61}[a-zA-Z0-9]\.[a-zA-Z]{2,}$/;
        const ipPattern = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/;
        
        // Check if it looks like a domain or IP
        const testUrl = normalized.split('/')[0];
        if (domainPattern.test(testUrl) || ipPattern.test(testUrl)) {
          return { valid: true, normalized: 'https://' + normalized };
        }
        
        // Check if it already has a protocol
        if (/^[a-z]+:\/\//i.test(normalized)) {
          return { valid: true, normalized };
        }
        
        return { valid: false, normalized: null };
      }
    }
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

    // Normalize destination URL using our flexible validator
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

// Helper function to categorize referrers
const categorizeReferrers = (referrers) => {
  const socialPlatforms = ['facebook', 'twitter', 'whatsapp', 'instagram', 'linkedin', 'pinterest', 'tiktok', 'reddit'];
  const searchEngines = ['google', 'bing', 'yahoo', 'duckduckgo', 'baidu', 'yandex'];
  
  const categories = {
    social: { total: 0, details: {} },
    search: { total: 0, details: {} },
    email: { total: 0, details: {} },
    direct: { total: 0, details: {} },
    others: { total: 0, details: {} }
  };
  
  referrers.forEach(ref => {
    const source = ref._id.toLowerCase();
    const count = ref.count;
    
    if (source === 'direct' || source === '') {
      categories.direct.total += count;
      categories.direct.details[source] = count;
    } 
    else if (socialPlatforms.some(platform => source.includes(platform))) {
      categories.social.total += count;
      categories.social.details[source] = count;
    }
    else if (searchEngines.some(engine => source.includes(engine))) {
      categories.search.total += count;
      categories.search.details[source] = count;
    }
    else if (source.includes('mail') || source.includes('email')) {
      categories.email.total += count;
      categories.email.details[source] = count;
    }
    else {
      categories.others.total += count;
      categories.others.details[source] = count;
    }
  });
  
  return categories;
};

// Helper function to get previous period clicks
const getPreviousPeriodClicks = async (urlId, currentStartDate, currentEndDate) => {
  try {
    const periodDuration = currentEndDate - currentStartDate;
    const previousStartDate = new Date(currentStartDate.getTime() - periodDuration);
    const previousEndDate = new Date(currentStartDate.getTime());
    
    const previousClicks = await Click.countDocuments({
      urlId,
      timestamp: { $gte: previousStartDate, $lt: previousEndDate },
      isBot: false
    });
    
    return previousClicks;
  } catch (error) {
    console.error('Error getting previous period clicks:', error);
    return 0;
  }
};

// Helper function to get top performing links (for overall analytics)
const getTopPerformingLinks = async (userId, startDate, endDate, previousStartDate, previousEndDate, limit = 10) => {
  try {
    // Get all URLs for the user
    const userUrls = await Url.find({ user: userId })
      .select('_id shortId destinationUrl customName clicks')
      .lean();
    
    // Get click counts for current period
    const currentPeriodClicks = await Click.aggregate([
      {
        $match: {
          urlId: { $in: userUrls.map(u => u._id) },
          timestamp: { $gte: startDate, $lte: endDate },
          isBot: false
        }
      },
      {
        $group: {
          _id: '$urlId',
          currentClicks: { $sum: 1 }
        }
      }
    ]);
    
    // Get click counts for previous period
    const previousPeriodClicks = await Click.aggregate([
      {
        $match: {
          urlId: { $in: userUrls.map(u => u._id) },
          timestamp: { $gte: previousStartDate, $lte: previousEndDate },
          isBot: false
        }
      },
      {
        $group: {
          _id: '$urlId',
          previousClicks: { $sum: 1 }
        }
      }
    ]);
    
    // Create maps for easy lookup
    const currentMap = {};
    currentPeriodClicks.forEach(item => {
      currentMap[item._id.toString()] = item.currentClicks;
    });
    
    const previousMap = {};
    previousPeriodClicks.forEach(item => {
      previousMap[item._id.toString()] = item.previousClicks;
    });
    
    // Combine data
    const topLinks = userUrls.map(url => {
      const currentClicks = currentMap[url._id.toString()] || 0;
      const previousClicks = previousMap[url._id.toString()] || 0;
      const change = currentClicks - previousClicks;
      const changePercent = previousClicks > 0 ? 
        ((change / previousClicks) * 100).toFixed(1) : 
        (currentClicks > 0 ? 100 : 0);
      
      return {
        _id: url._id,
        shortId: url.shortId,
        alias: url.customName || url.shortId,
        destinationUrl: url.destinationUrl,
        clicks: currentClicks,
        previousClicks: previousClicks,
        change: change,
        changePercent: parseFloat(changePercent)
      };
    });
    
    // Sort by current clicks and limit
    return topLinks
      .sort((a, b) => b.clicks - a.clicks)
      .slice(0, limit);
    
  } catch (error) {
    console.error('Error getting top performing links:', error);
    return [];
  }
};

/**
 * shortenUrl - Updated with better URL validation and QR code handling
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

    // Validate and normalize URL using our flexible validator
    const { valid, normalized } = validateAndNormalizeUrl(destinationUrl);
    if (!valid) {
      return res.status(400).json({ 
        success: false, 
        message: 'Invalid URL format. Please enter a valid URL (e.g., example.com, https://example.com, mailto:user@example.com, tel:+1234567890)' 
      });
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

    // Generate QR code if requested - Always generate immediately
    let qrCodeData = null;
    if (generateQrCode) {
      try {
        const qrCodeUrl = `${process.env.BASE_URL || 'http://localhost:5000'}/s/${url.shortId}`;
        qrCodeData = await QRCode.toDataURL(qrCodeUrl, {
          errorCorrectionLevel: 'H',
          margin: 2,
          width: 300,
          color: {
            dark: '#000000',  // QR code color
            light: '#FFFFFF'  // Background color
          }
        });
        
        // Save to database
        url.qrCodeData = qrCodeData;
        await url.save();
      } catch (err) {
        console.warn('QR generation failed (non-fatal):', err.message);
        // Still proceed even if QR generation fails
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

    // Build the complete response with QR code data
    const responseData = {
      id: url._id,
      _id: url._id,
      shortId: url.shortId,
      shortUrl: `${process.env.BASE_URL || 'http://localhost:5000'}/s/${url.shortId}`,
      destinationUrl: url.destinationUrl,
      customName: url.customName,
      password: !!url.password,
      expirationDate: url.expirationDate,
      isActive: url.isActive,
      clicks: url.clicks,
      createdAt: url.createdAt,
      // Include all advanced settings
      generateQrCode: url.generateQrCode,
      qrCodeData: qrCodeData, // This will be null if not generated
      hasQrCode: !!qrCodeData,
      splashImage: url.splashImage,
      // Include other settings that might be useful for the frontend
      advancedSettings: {
        generateQrCode: url.generateQrCode,
        splashImage: url.splashImage,
        password: !!url.password,
        expirationDate: url.expirationDate,
        destinations: url.destinations,
        enableAffiliateTracking: url.enableAffiliateTracking
      }
    };

    return res.status(201).json({
      success: true,
      message: 'URL shortened successfully!',
      url: responseData
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

    // Validate URL first using our flexible validator
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
      hasQrCode: !!u.qrCodeData,
      qrCodeData: u.qrCodeData || null,
      generateQrCode: u.generateQrCode || false
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
 * updateUrl - FIXED: Now updates shortId when customName changes
 */
const updateUrl = async (req, res) => {
  try {
    const id = req.params.id;
    const updates = req.body || {};

    const url = await Url.findOne({ _id: id, user: req.user._id });
    if (!url) return res.status(404).json({ success: false, message: 'URL not found' });

    // FIXED: Handle customName change - update shortId if customName changed
    if (updates.customName && updates.customName !== url.customName) {
      // Check if new customName is already in use as shortId
      const existingUrl = await Url.findOne({ 
        shortId: updates.customName,
        _id: { $ne: url._id } // Exclude current URL
      });
      
      if (existingUrl) {
        return res.status(400).json({ 
          success: false, 
          message: 'Custom name already in use as a short URL. Please choose a different name.' 
        });
      }
      
      // Update shortId to match new customName
      updates.shortId = updates.customName;
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
      changes.push('alias_updated');
      changeDetails.oldAlias = url.customName;
      changeDetails.newAlias = updates.customName;
      changeDetails.shortIdUpdated = true;
    }

    if (updates.password !== undefined && updates.password !== '') {
      changes.push('password_changed');
      changeDetails.passwordChanged = true;
    } else if (updates.password === '') {
      // If empty password, set to null to remove password protection
      updates.password = null;
      changes.push('password_removed');
    }

    if (updates.expirationDate !== undefined) {
      changes.push('expiration_updated');
      changeDetails.expirationChanged = true;
    }

    // Handle QR code generation if generateQrCode is being enabled
    if (updates.generateQrCode !== undefined && updates.generateQrCode && !url.qrCodeData) {
      try {
        const qrCodeUrl = `${process.env.BASE_URL || 'http://localhost:5000'}/s/${updates.shortId || url.shortId}`;
        const qrCodeData = await QRCode.toDataURL(qrCodeUrl, {
          errorCorrectionLevel: 'H',
          margin: 2,
          width: 300
        });
        updates.qrCodeData = qrCodeData;
        changes.push('qr_code_generated');
      } catch (err) {
        console.warn('QR generation failed during update:', err.message);
      }
    }

    // Update all fields except _id
    Object.keys(updates).forEach(k => {
      if (k !== '_id') url[k] = updates[k];
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
        shortUrl: `${process.env.BASE_URL || 'http://localhost:5000'}/s/${url.shortId}`,
        destinationUrl: url.destinationUrl,
        customName: url.customName,
        isActive: url.isActive,
        clicks: url.clicks,
        generateQrCode: url.generateQrCode,
        qrCodeData: url.qrCodeData,
        hasQrCode: !!url.qrCodeData,
        splashImage: url.splashImage,
        destinations: url.destinations,
        enableAffiliateTracking: url.enableAffiliateTracking,
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
 * getUrlAnalytics - Enhanced with ALL new chart data
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
    
    // Calculate previous period for comparison
    const periodDuration = endDate - startDate;
    const previousStartDate = new Date(startDate.getTime() - periodDuration);
    const previousEndDate = new Date(startDate.getTime());
    
    console.log(`Getting enhanced analytics for URL ${id}, range: ${range}`);

    // Get analytics using aggregation for all new charts
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
                totalTimeOnPage: { $sum: { $cond: [{ $gt: ['$timeOnPage', 0] }, '$timeOnPage', 0] } },
                totalScrollDepth: { $sum: { $cond: [{ $gt: ['$scrollDepth', 0] }, '$scrollDepth', 0] } },
                clicksWithTimeToClick: { $sum: { $cond: [{ $gt: ['$timeToClick', 0] }, 1, 0] } },
                totalTimeToClick: { $sum: { $cond: [{ $gt: ['$timeToClick', 0] }, '$timeToClick', 0] } },
                clicksWithSessionData: { $sum: { $cond: [{ $gt: ['$timeOnPage', 0] }, 1, 0] } }
              }
            }
          ],
          
          // Time series
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
                country: { $exists: true, $ne: null, $ne: '' }
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
                _id: null,
                desktop: {
                  $sum: {
                    $cond: [
                      { $regexMatch: { input: '$device', regex: /desktop/i } },
                      1,
                      0
                    ]
                  }
                },
                mobile: {
                  $sum: {
                    $cond: [
                      { $regexMatch: { input: '$device', regex: /mobile/i } },
                      1,
                      0
                    ]
                  }
                },
                tablet: {
                  $sum: {
                    $cond: [
                      { $regexMatch: { input: '$device', regex: /tablet/i } },
                      1,
                      0
                    ]
                  }
                }
              }
            }
          ],
          
          // Browsers - NEW
          browsers: [
            {
              $match: {
                browser: { $exists: true, $ne: null }
              }
            },
            {
              $group: {
                _id: '$browser',
                count: { $sum: 1 }
              }
            },
            { $sort: { count: -1 } },
            { $limit: 10 }
          ],
          
          // Operating Systems - NEW
          operatingSystems: [
            {
              $match: {
                os: { $exists: true, $ne: null }
              }
            },
            {
              $group: {
                _id: '$os',
                count: { $sum: 1 }
              }
            },
            { $sort: { count: -1 } },
            { $limit: 10 }
          ],
          
          // Referrers - NEW enhanced
          referrers: [
            {
              $match: {
                referrerDomain: { $exists: true, $ne: null, $ne: 'invalid' }
              }
            },
            {
              $group: {
                _id: '$referrerDomain',
                count: { $sum: 1 }
              }
            },
            { $sort: { count: -1 } },
            { $limit: 20 }
          ],
          
          // Peak hours - NEW
          peakHours: [
            {
              $group: {
                _id: { $hour: '$timestamp' },
                count: { $sum: 1 }
              }
            },
            { $sort: { _id: 1 } }
          ],
          
          // Top cities - NEW
          topCities: [
            {
              $match: {
                city: { $exists: true, $ne: null, $ne: '' }
              }
            },
            {
              $group: {
                _id: { city: '$city', country: '$country' },
                count: { $sum: 1 }
              }
            },
            { $sort: { count: -1 } },
            { $limit: 10 }
          ],
          
          // Recent clicks
          recentClicks: [
            { $sort: { timestamp: -1 } },
            { $limit: 10 }
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
      totalTimeToClick: 0,
      clicksWithSessionData: 0
    };
    
    const totalClicks = basicStats.totalClicks || 0;
    const uniqueClicks = basicStats.uniqueClicks ? basicStats.uniqueClicks.length : 0;
    const returningVisitors = basicStats.returningVisitors || 0;
    const conversions = basicStats.conversions || 0;
    
    // Calculate metrics
    const conversionRate = totalClicks > 0 ? ((conversions / totalClicks) * 100).toFixed(1) : 0;
    const avgTimeOnPage = basicStats.clicksWithSessionData > 0 
      ? Math.floor(basicStats.totalTimeOnPage / basicStats.clicksWithSessionData)
      : 0;
      
    const avgScrollDepth = basicStats.clicksWithSessionData > 0
      ? Math.round((basicStats.totalScrollDepth / basicStats.clicksWithSessionData))
      : 0;
      
    const avgTimeToClick = basicStats.clicksWithTimeToClick > 0
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
    
    // Devices
    const deviceData = stats.devices[0] || { desktop: 0, mobile: 0, tablet: 0 };
    const deviceDistribution = {
      desktop: deviceData.desktop || 0,
      mobile: deviceData.mobile || 0,
      tablet: deviceData.tablet || 0
    };
    
    // NEW: Browser distribution
    const browserData = stats.browsers || [];
    const browserDistribution = browserData.map(item => ({
      _id: item._id,
      browser: item._id,
      count: item.count
    }));
    
    // NEW: OS distribution
    const osData = stats.operatingSystems || [];
    const osDistribution = osData.map(item => ({
      _id: item._id,
      os: item._id,
      count: item.count
    }));
    
    // NEW: Referrer categories
    const referrerData = stats.referrers || [];
    const referrerCategories = categorizeReferrers(referrerData);
    
    // NEW: Peak hour data
    const peakHourData = stats.peakHours || [];
    const peakHourDataFormatted = peakHourData.map(item => ({
      hour: item._id,
      count: item.count
    }));
    
    // NEW: Top cities
    const cityData = stats.topCities || [];
    const topCities = cityData.map(item => ({
      city: item._id.city,
      country: item._id.country,
      count: item.count
    }));
    
    // Calculate engagement metrics
    const engagedClicks = await Click.countDocuments({
      urlId: url._id,
      timestamp: { $gte: startDate, $lte: endDate },
      isBot: false,
      timeOnPage: { $gt: 30 }
    });
    
    const bounceRate = totalClicks > 0 ? Math.round(((totalClicks - engagedClicks) / totalClicks) * 100) : 0;
    const engagement = {
      bounced: Math.round(totalClicks * (bounceRate / 100)),
      engaged: engagedClicks,
      bounceRate: bounceRate
    };
    
    // Peak hour
    const peakHour = peakHourData.length > 0 ? 
      peakHourData.reduce((max, curr) => curr.count > max.count ? curr : max, peakHourData[0]) : null;
    
    // Top referrer
    const topReferrer = referrerData.length > 0 ? referrerData[0]._id : 'Direct';
    
    // Recent clicks
    const recentClicks = stats.recentClicks || [];
    
    // Calculate pages per session
    const sessionData = await Click.aggregate([
      {
        $match: {
          urlId: url._id,
          timestamp: { $gte: startDate, $lte: endDate },
          timeOnPage: { $gt: 0 }
        }
      },
      {
        $group: {
          _id: '$sessionId',
          totalClicks: { $sum: 1 }
        }
      }
    ]);
    
    const totalSessions = sessionData.length;
    const totalPagesViewed = sessionData.reduce((sum, session) => sum + session.totalClicks, 0);
    const pagesPerSession = totalSessions > 0 ? (totalPagesViewed / totalSessions).toFixed(1) : 1.0;
    
    // Get previous period clicks for comparison
    const previousClicks = await Click.countDocuments({
      urlId: url._id,
      timestamp: { $gte: previousStartDate, $lt: previousEndDate },
      isBot: false
    });
    
    // NEW: Top links data (for single URL, just return this URL's data with comparison)
    const topLinks = [{
      _id: url._id,
      shortId: url.shortId,
      alias: url.customName || url.shortId,
      destinationUrl: url.destinationUrl,
      clicks: totalClicks,
      previousClicks: previousClicks,
      change: totalClicks - previousClicks,
      changePercent: previousClicks > 0 ? ((totalClicks - previousClicks) / previousClicks * 100).toFixed(1) : (totalClicks > 0 ? 100 : 0)
    }];
    
    return res.json({
      success: true,
      analytics: {
        totalClicks,
        uniqueClicks,
        returningVisitors,
        conversionRate: `${conversionRate}%`,
        clicksOverTime,
        topCountries,
        deviceDistribution,
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
          peakHour: peakHour ? `${peakHour._id}:00` : 'N/A',
          topReferrer,
          pagesPerSession: parseFloat(pagesPerSession),
          conversionRate: `${conversionRate}%`
        },
        // NEW chart data
        browserDistribution,
        osDistribution,
        referrerCategories,
        peakHourData: peakHourDataFormatted,
        topCities,
        topLinks
      }
    });
    
  } catch (error) {
    console.error('Get URL analytics error:', error);
    return res.status(500).json({ success: false, message: 'Failed to get analytics' });
  }
};

/**
 * getOverallAnalytics - Enhanced with ALL new chart data
 */
const getOverallAnalytics = async (req, res) => {
  try {
    const userId = req.user._id;
    const { range = '7days', startDate: customStartDate, endDate: customEndDate } = req.query;
    
    console.log(`Getting enhanced overall analytics for user ${userId}, range: ${range}`);
    
    // Calculate date range
    const { startDate, endDate } = getDateRange(range, customStartDate, customEndDate);
    
    // Calculate previous period for comparison
    const periodDuration = endDate - startDate;
    const previousStartDate = new Date(startDate.getTime() - periodDuration);
    const previousEndDate = new Date(startDate.getTime());
    
    // Get all user URLs
    const userUrls = await Url.find({ user: userId }).select('_id shortId destinationUrl customName clicks').lean();
    const urlIds = userUrls.map(url => url._id);
    
    if (urlIds.length === 0) {
      return res.json({
        success: true,
        analytics: {
          totalClicks: 0,
          uniqueVisitors: 0,
          returningVisitors: 0,
          conversionRate: '0%',
          totalUrls: 0,
          clicksOverTime: { labels: [], values: [] },
          topCountries: { countries: [], visits: [] },
          deviceDistribution: { desktop: 0, mobile: 0, tablet: 0 },
          engagement: { bounced: 0, engaged: 0, bounceRate: 0 },
          recentClicks: [],
          detailedMetrics: {
            avgTimeToClick: '0s',
            avgScrollDepth: '0%',
            peakHour: 'N/A',
            topReferrer: 'Direct',
            avgSessionDuration: '0:00',
            pagesPerSession: 0
          },
          // NEW chart data
          browserDistribution: [],
          osDistribution: [],
          referrerCategories: {
            social: { total: 0, details: {} },
            search: { total: 0, details: {} },
            email: { total: 0, details: {} },
            direct: { total: 0, details: {} },
            others: { total: 0, details: {} }
          },
          peakHourData: [],
          topCities: [],
          topLinks: []
        }
      });
    }
    
    // Aggregate clicks across all user URLs with ALL new chart data
    const clickStats = await Click.aggregate([
      {
        $match: {
          urlId: { $in: urlIds },
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
                uniqueIPs: { $addToSet: '$ipAddress' },
                returningVisitors: { $sum: { $cond: ['$isReturning', 1, 0] } },
                totalTimeOnPage: { $sum: '$timeOnPage' },
                totalScrollDepth: { $sum: '$scrollDepth' },
                clicksWithTimeToClick: { $sum: { $cond: ['$timeToClick', 1, 0] } },
                totalTimeToClick: { $sum: '$timeToClick' },
                conversions: { $sum: { $cond: ['$isConversion', 1, 0] } }
              }
            }
          ],
          
          // Time series
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
          
          // Browsers - NEW
          browsers: [
            {
              $match: {
                browser: { $exists: true, $ne: null }
              }
            },
            {
              $group: {
                _id: '$browser',
                count: { $sum: 1 }
              }
            },
            { $sort: { count: -1 } },
            { $limit: 10 }
          ],
          
          // Operating Systems - NEW
          operatingSystems: [
            {
              $match: {
                os: { $exists: true, $ne: null }
              }
            },
            {
              $group: {
                _id: '$os',
                count: { $sum: 1 }
              }
            },
            { $sort: { count: -1 } },
            { $limit: 10 }
          ],
          
          // Referrers - NEW
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
            { $limit: 20 }
          ],
          
          // Peak hours - NEW
          peakHours: [
            {
              $group: {
                _id: { $hour: '$timestamp' },
                count: { $sum: 1 }
              }
            },
            { $sort: { _id: 1 } }
          ],
          
          // Top cities - NEW
          topCities: [
            {
              $match: {
                city: { $exists: true, $ne: null, $ne: '' }
              }
            },
            {
              $group: {
                _id: { city: '$city', country: '$country' },
                count: { $sum: 1 }
              }
            },
            { $sort: { count: -1 } },
            { $limit: 10 }
          ],
          
          // Recent clicks
          recentClicks: [
            { $sort: { timestamp: -1 } },
            { $limit: 10 }
          ],
          
          // URL clicks for top links
          urlClicks: [
            {
              $group: {
                _id: '$urlId',
                clicks: { $sum: 1 }
              }
            },
            { $sort: { clicks: -1 } },
            { $limit: 10 }
          ]
        }
      }
    ]);

    const stats = clickStats[0];
    const basicStats = stats.basicStats[0] || { 
      totalClicks: 0, 
      uniqueIPs: [], 
      returningVisitors: 0, 
      totalTimeOnPage: 0,
      totalScrollDepth: 0,
      clicksWithTimeToClick: 0,
      totalTimeToClick: 0,
      conversions: 0
    };
    
    const totalClicks = basicStats.totalClicks || 0;
    const uniqueVisitors = basicStats.uniqueIPs ? basicStats.uniqueIPs.length : 0;
    const returningVisitors = basicStats.returningVisitors || 0;
    const conversions = basicStats.conversions || 0;
    
    // Calculate metrics
    const avgTimeOnPage = basicStats.totalTimeOnPage && totalClicks > 0 
      ? `${Math.floor(basicStats.totalTimeOnPage / totalClicks)}s`
      : '0s';
      
    const avgScrollDepth = basicStats.totalScrollDepth && totalClicks > 0
      ? `${Math.round((basicStats.totalScrollDepth / totalClicks) * 100)}%`
      : '0%';
      
    const avgTimeToClick = basicStats.totalTimeToClick && basicStats.clicksWithTimeToClick > 0
      ? `${Math.round(basicStats.totalTimeToClick / basicStats.clicksWithTimeToClick / 1000)}s`
      : 'N/A';
    
    const conversionRate = totalClicks > 0 
      ? `${((conversions / totalClicks) * 100).toFixed(1)}%`
      : '0%';
    
    const peakHourData = stats.peakHours || [];
    const peakHour = peakHourData.length > 0 ? 
      peakHourData.reduce((max, curr) => curr.count > max.count ? curr : peakHourData[0]) : null;
    
    const topReferrerData = stats.referrers[0];
    const topReferrer = topReferrerData ? topReferrerData._id : 'Direct';
    
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
    
    // Devices
    const deviceData = stats.devices || [];
    const deviceDistribution = {
      desktop: 0,
      mobile: 0,
      tablet: 0
    };
    
    deviceData.forEach(item => {
      const deviceType = (item._id || '').toLowerCase();
      if (deviceType.includes('desktop')) {
        deviceDistribution.desktop = item.count;
      } else if (deviceType.includes('mobile')) {
        deviceDistribution.mobile = item.count;
      } else if (deviceType.includes('tablet')) {
        deviceDistribution.tablet = item.count;
      }
    });
    
    // Engagement
    const engagedClicks = await Click.countDocuments({
      urlId: { $in: urlIds },
      timestamp: { $gte: startDate, $lte: endDate },
      isBot: false,
      timeOnPage: { $gt: 30 }
    });
    
    const bounceRate = totalClicks > 0 ? Math.round(((totalClicks - engagedClicks) / totalClicks) * 100) : 0;
    const engagement = {
      bounced: Math.round(totalClicks * (bounceRate / 100)),
      engaged: engagedClicks,
      bounceRate: bounceRate
    };
    
    // Recent clicks
    const recentClicks = stats.recentClicks || [];
    
    // NEW: Browser distribution
    const browserData = stats.browsers || [];
    const browserDistribution = browserData.map(item => ({
      _id: item._id,
      browser: item._id,
      count: item.count
    }));
    
    // NEW: OS distribution
    const osData = stats.operatingSystems || [];
    const osDistribution = osData.map(item => ({
      _id: item._id,
      os: item._id,
      count: item.count
    }));
    
    // NEW: Referrer categories
    const referrerData = stats.referrers || [];
    const referrerCategories = categorizeReferrers(referrerData);
    
    // NEW: Peak hour data
    const peakHourDataFormatted = peakHourData.map(item => ({
      hour: item._id,
      count: item.count
    }));
    
    // NEW: Top cities
    const cityData = stats.topCities || [];
    const topCities = cityData.map(item => ({
      city: item._id.city,
      country: item._id.country,
      count: item.count
    }));
    
    // NEW: Top performing links with comparison
    const urlClicksData = stats.urlClicks || [];
    const topLinks = await Promise.all(urlClicksData.map(async (item) => {
      const url = userUrls.find(u => u._id.toString() === item._id.toString());
      if (!url) return null;
      
      // Get previous period clicks for this URL
      const previousClicks = await Click.countDocuments({
        urlId: url._id,
        timestamp: { $gte: previousStartDate, $lt: previousEndDate },
        isBot: false
      });
      
      const change = item.clicks - previousClicks;
      const changePercent = previousClicks > 0 ? 
        ((change / previousClicks) * 100).toFixed(1) : 
        (item.clicks > 0 ? 100 : 0);
      
      return {
        _id: url._id,
        shortId: url.shortId,
        alias: url.customName || url.shortId,
        destinationUrl: url.destinationUrl,
        clicks: item.clicks,
        previousClicks: previousClicks,
        change: change,
        changePercent: parseFloat(changePercent)
      };
    }));
    
    // Filter out null values and sort
    const filteredTopLinks = topLinks
      .filter(link => link !== null)
      .sort((a, b) => b.clicks - a.clicks);
    
    res.json({
      success: true,
      analytics: {
        totalClicks,
        uniqueVisitors,
        returningVisitors,
        conversionRate,
        totalUrls: urlIds.length,
        clicksOverTime,
        topCountries,
        deviceDistribution,
        engagement,
        recentClicks: recentClicks.map(click => ({
          timestamp: click.timestamp,
          ipAddress: click.ipAddress ? click.ipAddress.substring(0, 8) + '...' : 'N/A',
          country: click.country || 'Unknown',
          device: click.device || 'Unknown',
          browser: click.browser || 'Unknown',
          referrer: click.referrer || 'Direct',
          referrerDomain: click.referrerDomain
        })),
        detailedMetrics: {
          avgTimeToClick,
          avgScrollDepth,
          avgSessionDuration: avgTimeOnPage,
          peakHour: peakHour ? `${peakHour._id}:00` : 'N/A',
          topReferrer,
          pagesPerSession: (engagedClicks > 0 ? (totalClicks / engagedClicks).toFixed(1) : 1.0),
          conversionRate
        },
        // NEW CHART DATA
        browserDistribution,
        osDistribution,
        referrerCategories,
        peakHourData: peakHourDataFormatted,
        topCities,
        topLinks: filteredTopLinks
      }
    });
    
  } catch (error) {
    console.error('Get overall analytics error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get overall analytics: ' + (error.message || 'Unknown error')
    });
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

    // Generate QR code if not exists
    if (!url.qrCodeData) {
      try {
        const qrCodeUrl = `${process.env.BASE_URL || 'http://localhost:5000'}/s/${url.shortId}`;
        const qrCodeData = await QRCode.toDataURL(qrCodeUrl, {
          errorCorrectionLevel: 'H',
          margin: 2,
          width: 300
        });
        
        url.qrCodeData = qrCodeData;
        await url.save();
      } catch (err) {
        console.error('QR code generation error:', err);
        return res.status(500).json({ success: false, message: 'Failed to generate QR code' });
      }
    }

    // Return as base64 image
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
      .select('shortId destinationUrl clicks createdAt qrCodeData generateQrCode')
      .lean();

    // Map to the shape the frontend expects in the Dashboard component
    const mapped = recent.map(u => ({
      _id: u._id,
      shortId: u.shortId,
      shortUrl: `${process.env.BASE_URL || 'http://localhost:5000'}/s/${u.shortId}`,
      destinationUrl: u.destinationUrl,
      clicks: u.clicks || 0,
      createdAt: u.createdAt,
      qrCodeData: u.qrCodeData || null,
      generateQrCode: u.generateQrCode || false,
      hasQrCode: !!u.qrCodeData
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
        generateQrCode: url.generateQrCode,
        qrCodeData: url.qrCodeData,
        hasQrCode: !!url.qrCodeData,
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

/**
 * getUserQRCodes - Get all user URLs with QR codes
 */
const getUserQRCodes = async (req, res) => {
  try {
    const userId = req.user._id;
    
    // Find all URLs for the user that have QR codes
    const urls = await Url.find({ 
      user: userId,
      $or: [
        { qrCodeData: { $ne: null } },
        { generateQrCode: true }
      ]
    })
    .sort({ createdAt: -1 })
    .lean();
    
    // Format the response
    const formatted = urls.map(u => ({
      id: u._id,
      _id: u._id,
      shortId: u.shortId,
      shortUrl: `${process.env.BASE_URL || 'http://localhost:5000'}/s/${u.shortId}`,
      destinationUrl: u.destinationUrl,
      customName: u.customName || '',
      clicks: u.clicks || 0,
      createdAt: u.createdAt,
      qrCodeData: u.qrCodeData || null,
      generateQrCode: u.generateQrCode || false,
      hasQrCode: !!u.qrCodeData
    }));
    
    return res.json({
      success: true,
      data: formatted,
      count: formatted.length
    });
  } catch (error) {
    console.error('Get user QR codes error:', error);
    return res.status(500).json({ success: false, message: 'Failed to get QR codes' });
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
  getOverallAnalytics,
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
  getUserQRCodes,
  bulkOperations
};