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

    // Validate domain format
    if (!validateDomain(domain)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid domain format'
      });
    }

    // Check if domain already exists
    const existingDomain = await CustomDomain.findOne({ domain });
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
    const brandedShortId = CustomDomain.generateBrandedShortId(domain, shortId);

    // Create custom domain
    const customDomain = new CustomDomain({
      user: req.user._id,
      domain,
      shortId,
      brandedShortId,
      status: 'pending',
      verificationToken: crypto.randomBytes(16).toString('hex')
    });

    // Generate DNS instructions
    const dnsInstructions = customDomain.getDNSInstructions();
    customDomain.dnsRecords = {
      txtRecord: dnsInstructions.txt.value,
      cnameRecord: dnsInstructions.cname.value
    };

    await customDomain.save();

    // Update URL with branded domain reference
    url.brandedDomains = url.brandedDomains || [];
    url.brandedDomains.push({
      domain,
      brandedShortId,
      customDomainId: customDomain._id,
      createdAt: new Date(),
      isActive: false
    });
    await url.save();

    res.status(201).json({
      success: true,
      message: 'Domain added successfully. Please configure DNS.',
      data: {
        customDomain: {
          id: customDomain._id,
          domain: customDomain.domain,
          status: customDomain.status,
          verificationToken: customDomain.verificationToken,
          dnsInstructions
        }
      }
    });
  } catch (error) {
    console.error('Add custom domain error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to add custom domain'
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
      // Check TXT record
      const txtRecords = await dns.resolveTxt(`_brandlink_verify.${customDomain.domain}`);
      const foundToken = txtRecords.flat().includes(customDomain.verificationToken);
      
      if (foundToken) {
        // Update status
        customDomain.status = 'active';
        customDomain.lastVerifiedAt = new Date();
        customDomain.verificationError = null;

        // Update URL branded domain status
        const url = await Url.findOne({ shortId: customDomain.shortId });
        if (url) {
          const brandIndex = url.brandedDomains.findIndex(
            bd => bd.customDomainId.toString() === customDomain._id.toString()
          );
          if (brandIndex !== -1) {
            url.brandedDomains[brandIndex].isActive = true;
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
        customDomain.status = 'pending';
        customDomain.verificationError = 'TXT record not found or incorrect';
        await customDomain.save();

        res.status(400).json({
          success: false,
          message: 'DNS verification failed. TXT record not found.',
          data: {
            domain: customDomain.domain,
            status: customDomain.status,
            error: customDomain.verificationError,
            instructions: customDomain.getDNSInstructions()
          }
        });
      }
    } catch (dnsError) {
      customDomain.status = 'pending';
      customDomain.verificationError = dnsError.message;
      await customDomain.save();

      res.status(400).json({
        success: false,
        message: 'DNS lookup failed',
        data: {
          domain: customDomain.domain,
          status: customDomain.status,
          error: dnsError.message
        }
      });
    }
  } catch (error) {
    console.error('Verify domain error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to verify domain'
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
            name: domain.domain,
            value: `links.${process.env.BASE_URL ? new URL(process.env.BASE_URL).hostname : 'your-platform.com'}`,
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
      .select('shortId destinationUrl customName clicks createdAt')
      .sort({ createdAt: -1 })
      .lean();

    // Filter URLs that aren't already branded (or get all for selection)
    const brandableUrls = urls.map(url => ({
      id: url._id,
      shortId: url.shortId,
      shortUrl: `${process.env.BASE_URL || 'http://localhost:5000'}/s/${url.shortId}`,
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