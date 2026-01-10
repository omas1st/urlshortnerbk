const CustomDomain = require('../models/CustomDomain');
const Url = require('../models/Url');
const dns = require('dns').promises;
const crypto = require('crypto');

/**
 * Helper to validate domain format
 */
const validateDomain = (domain) => {
  const domainRegex = /^(?!:\/\/)([a-zA-Z0-9]+(-[a-zA-Z0-9]+)*\.)+[a-zA-Z]{2,}$/;
  return domainRegex.test(domain);
};

/**
 * Helper to clean domain
 */
const cleanDomain = (domain) => {
  if (!domain || typeof domain !== 'string') return domain;
  return domain
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/$/, '')
    .toLowerCase()
    .trim();
};

/**
 * Add a custom domain
 */
const addCustomDomain = async (req, res) => {
  try {
    const { domain, shortId } = req.body;
    
    if (!domain || !shortId) {
      return res.status(400).json({
        success: false,
        message: 'Domain and short ID are required'
      });
    }

    // Clean and validate domain
    const cleanedDomain = cleanDomain(domain);
    
    if (!cleanedDomain) {
      return res.status(400).json({
        success: false,
        message: 'Invalid domain'
      });
    }

    if (!validateDomain(cleanedDomain)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid domain format. Please enter a valid domain like "yourbrand.com"'
      });
    }

    // Check if domain already exists
    const existingDomain = await CustomDomain.findOne({ domain: cleanedDomain });
    if (existingDomain) {
      return res.status(400).json({
        success: false,
        message: 'Domain already registered'
      });
    }

    // Check if user owns the URL
    const url = await Url.findOne({ shortId, user: req.user._id });
    if (!url) {
      return res.status(404).json({
        success: false,
        message: 'URL not found or unauthorized'
      });
    }

    // Generate branded short ID
    const brandedShortId = CustomDomain.generateBrandedShortId(cleanedDomain, shortId);
    
    // Generate verification token
    const verificationToken = crypto.randomBytes(16).toString('hex');

    // Get DNS instructions
    const baseUrl = process.env.BASE_URL || 'http://localhost:5000';
    const baseDomain = new URL(baseUrl).hostname;

    // Create custom domain
    const customDomain = new CustomDomain({
      user: req.user._id,
      domain: cleanedDomain,
      shortId,
      brandedShortId,
      status: 'pending',
      verificationToken,
      dnsRecords: {
        txtRecord: verificationToken,
        cnameRecord: `links.${baseDomain}`
      }
    });

    await customDomain.save();

    // Update URL with branded domain reference
    if (!url.brandedDomains) {
      url.brandedDomains = [];
    }
    
    url.brandedDomains.push({
      domain: cleanedDomain,
      brandedShortId,
      customDomainId: customDomain._id,
      createdAt: new Date(),
      isActive: false
    });
    
    await url.save();

    // Prepare DNS instructions for response
    const dnsInstructions = {
      txt: {
        type: 'TXT',
        name: '_brandlink_verify',
        value: verificationToken,
        ttl: 3600
      },
      cname: {
        type: 'CNAME',
        name: '@',
        value: `links.${baseDomain}`,
        ttl: 3600
      }
    };

    res.status(201).json({
      success: true,
      message: 'Domain added successfully. Please configure DNS.',
      data: {
        customDomain: {
          id: customDomain._id,
          domain: customDomain.domain,
          status: customDomain.status,
          verificationToken: customDomain.verificationToken,
          brandedShortId: customDomain.brandedShortId,
          dnsInstructions
        }
      }
    });
  } catch (error) {
    console.error('Add custom domain error:', error);
    
    // Handle specific Mongoose validation errors
    if (error.name === 'ValidationError') {
      const messages = Object.values(error.errors).map(err => err.message);
      return res.status(400).json({
        success: false,
        message: messages.join(', ')
      });
    }
    
    // Handle duplicate key error
    if (error.code === 11000) {
      const field = Object.keys(error.keyPattern)[0];
      const fieldName = field === 'domain' ? 'Domain' : 'Branded short ID';
      return res.status(400).json({
        success: false,
        message: `${fieldName} already exists`
      });
    }
    
    res.status(500).json({
      success: false,
      message: 'Failed to add custom domain',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

/**
 * Verify domain DNS configuration
 */
const verifyDomain = async (req, res) => {
  try {
    const { domainId } = req.params;
    
    const customDomain = await CustomDomain.findOne({
      _id: domainId,
      user: req.user._id
    });

    if (!customDomain) {
      return res.status(404).json({
        success: false,
        message: 'Domain not found'
      });
    }

    // Update status to verifying
    customDomain.status = 'verifying';
    await customDomain.save();

    try {
      console.log(`Attempting to verify domain: ${customDomain.domain}`);
      console.log(`Looking for TXT record at: _brandlink_verify.${customDomain.domain}`);
      console.log(`Expected token: ${customDomain.verificationToken}`);

      // Check TXT record
      const txtRecords = await dns.resolveTxt(`_brandlink_verify.${customDomain.domain}`);
      console.log(`Found TXT records:`, JSON.stringify(txtRecords, null, 2));
      
      const foundToken = txtRecords.flat().includes(customDomain.verificationToken);
      
      if (foundToken) {
        console.log('✓ TXT record verified successfully');
        
        // Update status
        customDomain.status = 'active';
        customDomain.lastVerifiedAt = new Date();
        customDomain.verificationError = null;

        // Update URL branded domain status
        const url = await Url.findOne({ shortId: customDomain.shortId });
        if (url && url.brandedDomains) {
          const brandIndex = url.brandedDomains.findIndex(
            bd => bd.customDomainId && bd.customDomainId.toString() === customDomain._id.toString()
          );
          if (brandIndex !== -1) {
            url.brandedDomains[brandIndex].isActive = true;
            url.brandedDomains[brandIndex].verifiedAt = new Date();
            await url.save();
          }
        }

        await customDomain.save();

        res.json({
          success: true,
          message: 'Domain verified successfully!',
          data: {
            domain: customDomain.domain,
            status: customDomain.status,
            brandedUrl: customDomain.getBrandedUrl()
          }
        });
      } else {
        console.log('✗ TXT record not found or incorrect');
        
        customDomain.status = 'pending';
        customDomain.verificationError = 'TXT record not found or incorrect';
        await customDomain.save();

        res.status(400).json({
          success: false,
          message: 'DNS verification failed. TXT record not found or incorrect.',
          data: {
            domain: customDomain.domain,
            status: customDomain.status,
            error: customDomain.verificationError,
            instructions: customDomain.getDNSInstructions(),
            debug: {
              expectedToken: customDomain.verificationToken,
              foundRecords: txtRecords.flat(),
              lookupDomain: `_brandlink_verify.${customDomain.domain}`
            }
          }
        });
      }
    } catch (dnsError) {
      console.error('DNS lookup error:', dnsError);
      
      // Provide user-friendly messages based on DNS error code
      let userMessage = 'DNS lookup failed';
      let detailedError = dnsError.message;
      
      if (dnsError.code === 'ENOTFOUND' || dnsError.code === 'ENODATA') {
        userMessage = 'DNS record not found. Please make sure you added the TXT record correctly.';
        detailedError = `No TXT record found for _brandlink_verify.${customDomain.domain}`;
      } else if (dnsError.code === 'ETIMEOUT') {
        userMessage = 'DNS lookup timed out. Please try again in a few minutes.';
        detailedError = 'DNS server did not respond in time';
      } else if (dnsError.code === 'ESERVFAIL') {
        userMessage = 'DNS server failed to respond. Please check your domain configuration.';
        detailedError = 'DNS server returned SERVFAIL';
      }

      customDomain.status = 'pending';
      customDomain.verificationError = detailedError;
      await customDomain.save();

      res.status(400).json({
        success: false,
        message: userMessage,
        data: {
          domain: customDomain.domain,
          status: customDomain.status,
          error: detailedError,
          instructions: customDomain.getDNSInstructions(),
          troubleshooting: {
            step1: 'Go to your domain registrar (GoDaddy, Namecheap, Cloudflare, etc.)',
            step2: 'Add a TXT record with:',
            step3: `Name/Host: _brandlink_verify.${customDomain.domain}`,
            step4: `Value: ${customDomain.verificationToken}`,
            step5: 'TTL: 3600 (or 1 hour)',
            step6: 'Wait 5-10 minutes for DNS propagation',
            step7: 'Click "Verify Domain" again'
          }
        }
      });
    }
  } catch (error) {
    console.error('Verify domain error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to verify domain',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

/**
 * Get user's custom domains
 */
const getUserDomains = async (req, res) => {
  try {
    const domains = await CustomDomain.find({ user: req.user._id })
      .sort({ createdAt: -1 })
      .lean();

    // Get URL info for each domain
    const domainsWithUrls = await Promise.all(
      domains.map(async (domain) => {
        const url = await Url.findOne({ shortId: domain.shortId })
          .select('destinationUrl clicks createdAt')
          .lean();
        
        return {
          ...domain,
          urlInfo: url,
          brandedUrl: `https://${domain.domain}/${domain.brandedShortId}`
        };
      })
    );

    res.json({
      success: true,
      data: domainsWithUrls,
      count: domainsWithUrls.length
    });
  } catch (error) {
    console.error('Get user domains error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get domains'
    });
  }
};

/**
 * Get domain by ID
 */
const getDomainById = async (req, res) => {
  try {
    const { domainId } = req.params;
    
    const domain = await CustomDomain.findOne({
      _id: domainId,
      user: req.user._id
    }).lean();

    if (!domain) {
      return res.status(404).json({
        success: false,
        message: 'Domain not found'
      });
    }

    // Get URL info
    const url = await Url.findOne({ shortId: domain.shortId })
      .select('destinationUrl shortId customName clicks')
      .lean();

    const baseUrl = process.env.BASE_URL || 'http://localhost:5000';
    const baseDomain = new URL(baseUrl).hostname;

    res.json({
      success: true,
      data: {
        ...domain,
        urlInfo: url,
        dnsInstructions: {
          txt: {
            type: 'TXT',
            name: '_brandlink_verify',
            value: domain.verificationToken,
            ttl: 3600
          },
          cname: {
            type: 'CNAME',
            name: '@',
            value: `links.${baseDomain}`,
            ttl: 3600
          }
        },
        brandedUrl: `https://${domain.domain}/${domain.brandedShortId}`
      }
    });
  } catch (error) {
    console.error('Get domain by ID error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get domain'
    });
  }
};

/**
 * Delete custom domain
 */
const deleteDomain = async (req, res) => {
  try {
    const { domainId } = req.params;
    
    const customDomain = await CustomDomain.findOneAndDelete({
      _id: domainId,
      user: req.user._id
    });

    if (!customDomain) {
      return res.status(404).json({
        success: false,
        message: 'Domain not found'
      });
    }

    // Remove from URL branded domains
    await Url.updateOne(
      { shortId: customDomain.shortId },
      { $pull: { brandedDomains: { customDomainId: domainId } } }
    );

    res.json({
      success: true,
      message: 'Domain deleted successfully'
    });
  } catch (error) {
    console.error('Delete domain error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete domain'
    });
  }
};

/**
 * Get URLs available for branding (user's URLs without custom domains)
 */
const getBrandableUrls = async (req, res) => {
  try {
    // Get all user URLs
    const urls = await Url.find({ user: req.user._id })
      .select('shortId destinationUrl customName clicks createdAt brandedDomains')
      .sort({ createdAt: -1 })
      .lean();

    // Get base URL
    const baseUrl = process.env.BASE_URL || 'http://localhost:5000';

    // Format URLs for frontend
    const brandableUrls = urls.map(url => ({
      id: url._id,
      shortId: url.shortId,
      shortUrl: url.customName ? `${baseUrl}/${url.customName}` : `${baseUrl}/${url.shortId}`,
      destinationUrl: url.destinationUrl,
      customName: url.customName,
      clicks: url.clicks,
      createdAt: url.createdAt,
      hasBrandedDomains: url.brandedDomains && url.brandedDomains.length > 0
    }));

    res.json({
      success: true,
      data: brandableUrls,
      count: brandableUrls.length
    });
  } catch (error) {
    console.error('Get brandable URLs error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get URLs'
    });
  }
};

module.exports = {
  addCustomDomain,
  verifyDomain,
  getUserDomains,
  getDomainById,
  deleteDomain,
  getBrandableUrls
};