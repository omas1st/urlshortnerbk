// utils/openai.js - Local Smart URL Analyzer (Free)
const crypto = require('crypto');

class SmartUrlAnalyzer {
  constructor() {
    console.log('SmartUrlAnalyzer initialized - using local rule-based analysis');
  }

  // Analyze URL and suggest settings using local rules
  async analyzeUrl(url) {
    try {
      let urlObj;
      try {
        // Ensure URL has protocol for parsing
        const urlToParse = url.startsWith('http') ? url : `https://${url}`;
        urlObj = new URL(urlToParse);
      } catch (e) {
        console.log('Invalid URL format, using defaults');
        return this.getDefaultSuggestions(url);
      }

      const hostname = urlObj.hostname.toLowerCase();
      const pathname = urlObj.pathname.toLowerCase();
      
      // Initialize suggestions with defaults
      const suggestions = {
        suggestedSettings: {
          generateQrCode: true,
          brandColor: '#000000',
          smartDynamicLinks: false,
          enableAffiliateTracking: false,
          loadingPageText: 'Loading...'
        },
        explanation: '',
        tags: [],
        title: this.extractTitleFromUrl(urlObj),
        description: `Shortened URL for ${hostname}`,
        keywords: ['url', 'shortener', 'link']
      };

      // Analyze URL patterns
      const patterns = this.analyzeUrlPatterns(hostname, pathname, url);
      
      // Apply suggestions based on patterns
      this.applyPatternSuggestions(suggestions, patterns);
      
      // Generate tags
      suggestions.tags = this.generateTags(patterns);
      
      // Set explanation
      suggestions.explanation = this.generateExplanation(patterns);
      
      return suggestions;
      
    } catch (error) {
      console.error('Local URL analysis error:', error.message);
      return this.getDefaultSuggestions(url);
    }
  }

  // Analyze URL patterns
  analyzeUrlPatterns(hostname, pathname, originalUrl) {
    const patterns = {
      isEcommerce: false,
      isBlog: false,
      isSocialMedia: false,
      isVideo: false,
      isNews: false,
      isTech: false,
      isEducational: false,
      hasProduct: false,
      hasArticle: false
    };

    // Domain-based patterns
    if (hostname.includes('amazon.') || hostname.includes('ebay.') || 
        hostname.includes('etsy.') || hostname.includes('shopify.')) {
      patterns.isEcommerce = true;
    }
    
    if (hostname.includes('youtube.') || hostname.includes('vimeo.') || 
        hostname.includes('twitch.')) {
      patterns.isVideo = true;
    }
    
    if (hostname.includes('twitter.') || hostname.includes('facebook.') || 
        hostname.includes('instagram.') || hostname.includes('linkedin.')) {
      patterns.isSocialMedia = true;
    }
    
    if (hostname.includes('github.') || hostname.includes('stackoverflow.') || 
        hostname.includes('gitlab.') || hostname.includes('npmjs.')) {
      patterns.isTech = true;
    }
    
    if (hostname.includes('wikipedia.') || hostname.includes('edu.') || 
        hostname.includes('academy.')) {
      patterns.isEducational = true;
    }
    
    if (hostname.includes('nytimes.') || hostname.includes('bbc.') || 
        hostname.includes('cnn.') || hostname.includes('reuters.')) {
      patterns.isNews = true;
    }
    
    if (hostname.includes('medium.') || hostname.includes('blogspot.') || 
        hostname.includes('wordpress.')) {
      patterns.isBlog = true;
    }

    // Path-based patterns
    if (pathname.includes('/product/') || pathname.includes('/item/') || 
        pathname.includes('/p/') || pathname.includes('/shop/')) {
      patterns.hasProduct = true;
      patterns.isEcommerce = true;
    }
    
    if (pathname.includes('/blog/') || pathname.includes('/article/') || 
        pathname.includes('/post/') || pathname.includes('/news/')) {
      patterns.hasArticle = true;
      patterns.isBlog = true;
    }
    
    if (pathname.includes('/video/') || pathname.includes('/watch/') || 
        pathname.includes('/stream/')) {
      patterns.isVideo = true;
    }
    
    if (pathname.includes('/docs/') || pathname.includes('/documentation/') || 
        pathname.includes('/api/')) {
      patterns.isTech = true;
    }
    
    if (pathname.includes('/course/') || pathname.includes('/learn/') || 
        pathname.includes('/tutorial/')) {
      patterns.isEducational = true;
    }

    return patterns;
  }

  // Apply pattern-based suggestions
  applyPatternSuggestions(suggestions, patterns) {
    const { suggestedSettings } = suggestions;
    
    if (patterns.isEcommerce || patterns.hasProduct) {
      suggestedSettings.enableAffiliateTracking = true;
      suggestedSettings.affiliateTag = 'ecommerce';
      suggestedSettings.brandColor = '#FF6B35'; // Orange for e-commerce
      suggestedSettings.loadingPageText = 'Redirecting to store...';
    }
    
    if (patterns.isBlog || patterns.hasArticle || patterns.isNews) {
      suggestedSettings.previewImage = true;
      suggestedSettings.brandColor = '#2E86AB'; // Blue for content
      suggestedSettings.loadingPageText = 'Loading article...';
    }
    
    if (patterns.isSocialMedia) {
      suggestedSettings.generateQrCode = true;
      suggestedSettings.brandColor = '#1DA1F2'; // Twitter blue
      suggestedSettings.loadingPageText = 'Connecting to social media...';
    }
    
    if (patterns.isVideo) {
      suggestedSettings.brandColor = '#FF0000'; // YouTube red
      suggestedSettings.loadingPageText = 'Loading video content...';
    }
    
    if (patterns.isTech) {
      suggestedSettings.brandColor = '#333333'; // Tech gray
      suggestedSettings.loadingPageText = 'Loading tech resource...';
    }
    
    if (patterns.isEducational) {
      suggestedSettings.brandColor = '#4CAF50'; // Green for education
      suggestedSettings.loadingPageText = 'Loading educational content...';
    }
  }

  // Generate tags from patterns
  generateTags(patterns) {
    const tags = [];
    
    if (patterns.isEcommerce) tags.push('ecommerce', 'shopping', 'retail');
    if (patterns.isBlog) tags.push('blog', 'content', 'article');
    if (patterns.isSocialMedia) tags.push('social', 'media', 'networking');
    if (patterns.isVideo) tags.push('video', 'media', 'entertainment');
    if (patterns.isTech) tags.push('tech', 'development', 'coding');
    if (patterns.isEducational) tags.push('education', 'learning', 'tutorial');
    if (patterns.isNews) tags.push('news', 'media', 'information');
    
    if (patterns.hasProduct) tags.push('product');
    if (patterns.hasArticle) tags.push('article');
    
    // Add general tags if none specific
    if (tags.length === 0) {
      tags.push('web', 'link', 'url');
    }
    
    // Remove duplicates and return
    return [...new Set(tags)];
  }

  // Generate explanation based on patterns
  generateExplanation(patterns) {
    const explanations = [];
    
    if (patterns.isEcommerce) {
      explanations.push('E-commerce site detected. Added affiliate tracking and shopping-optimized settings.');
    }
    
    if (patterns.isBlog || patterns.isNews) {
      explanations.push('Content site detected. Added preview image support and reading-optimized settings.');
    }
    
    if (patterns.isSocialMedia) {
      explanations.push('Social media link detected. QR code enabled for easy sharing.');
    }
    
    if (patterns.isVideo) {
      explanations.push('Video content detected. Added video-optimized loading settings.');
    }
    
    if (patterns.isTech) {
      explanations.push('Tech resource detected. Added developer-friendly settings.');
    }
    
    if (patterns.isEducational) {
      explanations.push('Educational content detected. Added learning-optimized settings.');
    }
    
    if (explanations.length === 0) {
      return 'Smart settings applied based on URL analysis.';
    }
    
    return explanations.join(' ');
  }

  // Extract title from URL
  extractTitleFromUrl(urlObj) {
    const hostname = urlObj.hostname.replace('www.', '').split('.')[0];
    const path = urlObj.pathname.split('/').filter(p => p.length > 0).pop();
    
    if (path && path.length > 1) {
      const cleanedPath = path.replace(/[-_]/g, ' ').replace(/\.[^/.]+$/, '');
      return `${this.capitalize(cleanedPath)} - ${this.capitalize(hostname)}`;
    }
    
    return this.capitalize(hostname);
  }

  // Capitalize string helper
  capitalize(str) {
    if (!str) return '';
    return str.replace(/\b\w/g, char => char.toUpperCase());
  }

  // Get default suggestions
  getDefaultSuggestions(url) {
    try {
      const urlObj = new URL(url.startsWith('http') ? url : `https://${url}`);
      const hostname = urlObj.hostname.replace('www.', '').split('.')[0];
      
      return {
        suggestedSettings: {
          generateQrCode: true,
          brandColor: '#000000',
          smartDynamicLinks: false,
          enableAffiliateTracking: false,
          loadingPageText: 'Loading...'
        },
        explanation: 'Default settings applied. Local smart analysis ready.',
        tags: ['web', 'link', 'url'],
        title: this.capitalize(hostname),
        description: `Shortened URL for ${urlObj.hostname}`,
        keywords: ['url', 'shortener', 'link']
      };
    } catch (e) {
      return {
        suggestedSettings: {
          generateQrCode: true,
          brandColor: '#000000',
          smartDynamicLinks: false,
          loadingPageText: 'Loading...'
        },
        explanation: 'Default settings applied.',
        tags: ['web', 'link'],
        title: 'Shortened URL',
        description: 'Shortened link',
        keywords: ['url']
      };
    }
  }

  // Suggest a custom name for the URL
  suggestCustomName(url) {
    try {
      const urlObj = new URL(url.startsWith('http') ? url : `https://${url}`);
      const hostname = urlObj.hostname.replace('www.', '').split('.')[0];
      const path = urlObj.pathname.split('/').filter(p => p.length > 0).pop();
      
      let customName = hostname;
      if (path && path.length > 0) {
        const cleanPath = path.replace(/[^a-zA-Z0-9]/g, '-').substring(0, 10);
        customName = `${hostname}-${cleanPath}`;
      }
      
      // Ensure it's URL-safe and limited length
      return customName
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '')
        .substring(0, 20);
        
    } catch (e) {
      // Generate a random short ID as fallback
      return crypto.randomBytes(3).toString('hex');
    }
  }

  // --- Keep all your existing functions below ---
  // (generateBioPage, getDefaultBioPage, generateUrlDescription, suggestTags functions remain unchanged)
  // ... [Your existing functions here without modification]
}

module.exports = new SmartUrlAnalyzer();