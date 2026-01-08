const Url = require('../models/Url');
const Click = require('../models/Click');
const Analytics = require('../models/Analytics');
const User = require('../models/User');

// Helper function to calculate date range
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
    const source = ref._id ? ref._id.toLowerCase() : '';
    const count = ref.count;
    
    if (source === 'direct' || source === '') {
      categories.direct.total += count;
      categories.direct.details[source] = (categories.direct.details[source] || 0) + count;
    } 
    else if (socialPlatforms.some(platform => source.includes(platform))) {
      categories.social.total += count;
      categories.social.details[source] = (categories.social.details[source] || 0) + count;
    }
    else if (searchEngines.some(engine => source.includes(engine))) {
      categories.search.total += count;
      categories.search.details[source] = (categories.search.details[source] || 0) + count;
    }
    else if (source.includes('mail') || source.includes('email')) {
      categories.email.total += count;
      categories.email.details[source] = (categories.email.details[source] || 0) + count;
    }
    else {
      categories.others.total += count;
      categories.others.details[source] = (categories.others.details[source] || 0) + count;
    }
  });
  
  return categories;
};

// Helper function to get previous period clicks for comparison
const getPreviousPeriodClicks = async (urlIds, currentStartDate, currentEndDate) => {
  try {
    const periodDuration = currentEndDate - currentStartDate;
    const previousStartDate = new Date(currentStartDate.getTime() - periodDuration);
    const previousEndDate = new Date(currentStartDate.getTime());
    
    let previousClicksMap = {};
    
    if (Array.isArray(urlIds)) {
      // For overall analytics, get previous clicks for all URLs
      const previousClicks = await Click.aggregate([
        {
          $match: {
            urlId: { $in: urlIds },
            timestamp: { $gte: previousStartDate, $lt: previousEndDate },
            isBot: false
          }
        },
        {
          $group: {
            _id: '$urlId',
            count: { $sum: 1 }
          }
        }
      ]);
      
      previousClicks.forEach(item => {
        previousClicksMap[item._id.toString()] = item.count;
      });
    } else {
      // For single URL
      const previousClicks = await Click.countDocuments({
        urlId: urlIds,
        timestamp: { $gte: previousStartDate, $lt: previousEndDate },
        isBot: false
      });
      
      previousClicksMap[urlIds] = previousClicks;
    }
    
    return previousClicksMap;
  } catch (error) {
    console.error('Error getting previous period clicks:', error);
    return {};
  }
};

// Get overall analytics - UPDATED with new chart data
const getOverallAnalytics = async (req, res) => {
  try {
    const userId = req.user._id;
    const { range = '7days', startDate: customStartDate, endDate: customEndDate } = req.query;
    
    console.log(`Getting overall analytics for user ${userId}, range: ${range}`);
    
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
          // NEW CHART DATA
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
                referrerDomain: { $exists: true, $ne: null, $ne: '' }
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
            { $sort: { _id: 1 } },
            {
              $project: {
                hour: '$_id',
                count: 1,
                _id: 0
              }
            }
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
            { $limit: 10 },
            {
              $project: {
                city: '$_id.city',
                country: '$_id.country',
                count: 1,
                _id: 0
              }
            }
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
      hour: item.hour,
      count: item.count
    }));
    
    // NEW: Top cities
    const cityData = stats.topCities || [];
    const topCities = cityData.map(item => ({
      city: item.city,
      country: item.country,
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
          peakHour: peakHour ? `${peakHour.hour}:00` : 'N/A',
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

// Get URL-specific analytics - UPDATED with new chart data
const getUrlAnalytics = async (req, res) => {
  try {
    const { id } = req.params;
    const { range = '7days', startDate: customStartDate, endDate: customEndDate } = req.query;
    const userId = req.user._id;
    
    console.log(`Getting analytics for URL ${id}, user ${userId}, range: ${range}`);
    
    // Verify URL ownership
    const url = await Url.findOne({
      _id: id,
      user: userId
    }).lean();
    
    if (!url) {
      return res.status(404).json({
        success: false,
        message: 'URL not found or you do not have permission to view its analytics'
      });
    }
    
    // Calculate date range
    const { startDate, endDate } = getDateRange(range, customStartDate, customEndDate);
    
    // Calculate previous period for comparison
    const periodDuration = endDate - startDate;
    const previousStartDate = new Date(startDate.getTime() - periodDuration);
    const previousEndDate = new Date(startDate.getTime());
    
    // Get click statistics with aggregation including ALL new chart data
    const clickStats = await Click.aggregate([
      {
        $match: {
          urlId: id,
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
                totalTimeOnPage: { $sum: { $cond: [{ $gt: ['$timeOnPage', 0] }, '$timeOnPage', 0] } },
                totalScrollDepth: { $sum: { $cond: [{ $gt: ['$scrollDepth', 0] }, '$scrollDepth', 0] } },
                clicksWithTimeToClick: { $sum: { $cond: [{ $gt: ['$timeToClick', 0] }, 1, 0] } },
                totalTimeToClick: { $sum: { $cond: [{ $gt: ['$timeToClick', 0] }, '$timeToClick', 0] } },
                conversions: { $sum: { $cond: ['$isConversion', 1, 0] } },
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
          
          // Referrers - NEW
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
            { $sort: { _id: 1 } },
            {
              $project: {
                hour: '$_id',
                count: 1,
                _id: 0
              }
            }
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
            { $limit: 10 },
            {
              $project: {
                city: '$_id.city',
                country: '$_id.country',
                count: 1,
                _id: 0
              }
            }
          ],
          
          // Recent clicks
          recentClicks: [
            { $sort: { timestamp: -1 } },
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
      conversions: 0,
      clicksWithSessionData: 0
    };
    
    const totalClicks = basicStats.totalClicks || 0;
    const uniqueVisitors = basicStats.uniqueIPs ? basicStats.uniqueIPs.length : 0;
    const returningVisitors = basicStats.returningVisitors || 0;
    const conversions = basicStats.conversions || 0;
    
    // Calculate metrics
    const avgTimeOnPage = basicStats.clicksWithSessionData > 0 
      ? `${Math.floor(basicStats.totalTimeOnPage / basicStats.clicksWithSessionData)}s`
      : '0s';
      
    const avgScrollDepth = basicStats.clicksWithSessionData > 0
      ? `${Math.round((basicStats.totalScrollDepth / basicStats.clicksWithSessionData))}%`
      : '0%';
      
    const avgTimeToClick = basicStats.clicksWithTimeToClick > 0
      ? `${Math.round(basicStats.totalTimeToClick / basicStats.clicksWithTimeToClick / 1000)}s`
      : 'N/A';
    
    const conversionRate = totalClicks > 0 
      ? `${((conversions / totalClicks) * 100).toFixed(1)}%`
      : '0%';
    
    const peakHourStat = stats.peakHours[0];
    const peakHour = peakHourStat ? `${peakHourStat.hour}:00` : 'N/A';
    
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
    const deviceData = stats.devices[0] || { desktop: 0, mobile: 0, tablet: 0 };
    const deviceDistribution = {
      desktop: deviceData.desktop || 0,
      mobile: deviceData.mobile || 0,
      tablet: deviceData.tablet || 0
    };
    
    // Engagement
    const engagedClicks = await Click.countDocuments({
      urlId: id,
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
    const peakHourArray = stats.peakHours || [];
    const peakHourDataFormatted = peakHourArray.map(item => ({
      hour: item.hour,
      count: item.count
    }));
    
    // NEW: Top cities
    const cityData = stats.topCities || [];
    const topCities = cityData.map(item => ({
      city: item.city,
      country: item.country,
      count: item.count
    }));
    
    // Get previous period clicks for comparison
    const previousClicks = await Click.countDocuments({
      urlId: id,
      timestamp: { $gte: previousStartDate, $lt: previousEndDate },
      isBot: false
    });
    
    const change = totalClicks - previousClicks;
    const changePercent = previousClicks > 0 ? 
      ((change / previousClicks) * 100).toFixed(1) : 
      (totalClicks > 0 ? 100 : 0);
    
    // NEW: Top links for single URL
    const topLinks = [{
      _id: url._id,
      shortId: url.shortId,
      alias: url.customName || url.shortId,
      destinationUrl: url.destinationUrl,
      clicks: totalClicks,
      previousClicks: previousClicks,
      change: change,
      changePercent: parseFloat(changePercent)
    }];
    
    res.json({
      success: true,
      analytics: {
        totalClicks,
        uniqueVisitors,
        returningVisitors,
        conversionRate,
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
          avgTimeToClick,
          avgScrollDepth,
          avgSessionDuration: avgTimeOnPage,
          peakHour,
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
        topLinks
      }
    });
    
  } catch (error) {
    console.error('Get URL analytics error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get URL analytics: ' + (error.message || 'Unknown error')
    });
  }
};

// Get admin analytics
const getAdminAnalytics = async (req, res) => {
  try {
    const { range = '7days', startDate: customStartDate, endDate: customEndDate } = req.query;
    
    // Calculate date range
    const { startDate, endDate } = getDateRange(range, customStartDate, customEndDate);
    
    // Get system-wide stats
    const [
      totalUsers,
      totalUrls,
      totalClicks,
      recentUsers,
      recentUrls
    ] = await Promise.all([
      User.countDocuments(),
      Url.countDocuments(),
      Click.countDocuments({
        timestamp: { $gte: startDate, $lte: endDate },
        isBot: false
      }),
      User.find().sort({ createdAt: -1 }).limit(5).lean(),
      Url.find().sort({ createdAt: -1 }).limit(5).populate('user', 'username email').lean()
    ]);
    
    // Get clicks over time for admin - adjust grouping for all time
    const timeSeriesData = await Click.aggregate([
      {
        $match: {
          timestamp: { $gte: startDate, $lte: endDate },
          isBot: false
        }
      },
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
    ]);
    
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
    
    // Get top URLs
    const topUrls = await Click.aggregate([
      {
        $match: {
          timestamp: { $gte: startDate, $lte: endDate },
          isBot: false
        }
      },
      {
        $group: {
          _id: '$urlId',
          clicks: { $sum: 1 }
        }
      },
      { $sort: { clicks: -1 } },
      { $limit: 10 }
    ]);
    
    // Populate URL details
    const populatedTopUrls = await Promise.all(
      topUrls.map(async (item) => {
        const url = await Url.findById(item._id).populate('user', 'username email').lean();
        return {
          shortId: url?.shortId || 'Unknown',
          clicks: item.clicks,
          owner: url?.user?.username || 'Unknown',
          destinationUrl: url?.destinationUrl ? url.destinationUrl.substring(0, 50) + '...' : 'Unknown'
        };
      })
    );
    
    // Get user registrations over time
    const userRegistrations = await User.aggregate([
      {
        $match: {
          createdAt: { $gte: startDate, $lte: endDate }
        }
      },
      {
        $group: {
          _id: {
            $dateToString: { 
              format: range === 'all' ? '%Y-%m' : '%Y-%m-d', 
              date: '$createdAt' 
            }
          },
          count: { $sum: 1 }
        }
      },
      { $sort: { _id: 1 } }
    ]);
    
    res.json({
      success: true,
      analytics: {
        totalUsers,
        totalUrls,
        totalClicks,
        recentUsers: recentUsers.map(user => ({
          username: user.username,
          email: user.email,
          joined: user.createdAt
        })),
        recentUrls: recentUrls.map(url => ({
          shortId: url.shortId,
          destination: url.destinationUrl.substring(0, 50) + '...',
          owner: url.user?.username || 'Unknown',
          clicks: 0
        })),
        clicksOverTime,
        topUrls: populatedTopUrls,
        userRegistrations: {
          labels: userRegistrations.map(item => {
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
          values: userRegistrations.map(item => item.count)
        },
        systemHealth: {
          uptime: process.uptime(),
          memoryUsage: process.memoryUsage(),
          activeConnections: 0
        }
      }
    });
    
  } catch (error) {
    console.error('Get admin analytics error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get admin analytics: ' + (error.message || 'Unknown error')
    });
  }
};

// Export analytics data
const exportAnalytics = async (req, res) => {
  try {
    const { id } = req.params;
    const { format = 'csv', range = 'all', startDate: customStartDate, endDate: customEndDate } = req.query;
    
    // Verify URL ownership if ID provided
    if (id !== 'overall') {
      const url = await Url.findOne({
        _id: id,
        user: req.user._id
      });
      
      if (!url) {
        return res.status(404).json({
          success: false,
          message: 'URL not found'
        });
      }
    }
    
    // Calculate date range
    const { startDate, endDate } = getDateRange(range, customStartDate, customEndDate);
    
    // Get clicks data
    let clicks;
    if (id === 'overall') {
      const userUrls = await Url.find({ user: req.user._id }).select('_id');
      const urlIds = userUrls.map(url => url._id);
      
      clicks = await Click.find({
        urlId: { $in: urlIds },
        timestamp: { $gte: startDate, $lte: endDate },
        isBot: false
      })
      .populate({
        path: 'urlId',
        select: 'shortId destinationUrl'
      })
      .sort({ timestamp: -1 })
      .limit(1000)
      .lean();
    } else {
      clicks = await Click.find({
        urlId: id,
        timestamp: { $gte: startDate, $lte: endDate },
        isBot: false
      })
      .sort({ timestamp: -1 })
      .limit(1000)
      .lean();
    }
    
    if (format === 'csv') {
      const headers = [
        'Timestamp',
        'Short URL',
        'Destination URL',
        'IP Address',
        'Country',
        'Device',
        'Browser',
        'OS',
        'Referrer',
        'Time on Page (s)',
        'Scroll Depth (%)',
        'Returning Visitor',
        'Conversion'
      ];
      
      const rows = clicks.map(click => [
        new Date(click.timestamp).toISOString(),
        id === 'overall' ? `${process.env.BASE_URL || 'http://localhost:5000'}/s/${click.urlId?.shortId}` : `${process.env.BASE_URL || 'http://localhost:5000'}/s/${id}`,
        click.urlId?.destinationUrl || 'N/A',
        click.ipAddress || 'N/A',
        click.country || 'N/A',
        click.device || 'N/A',
        click.browser || 'N/A',
        click.os || 'N/A',
        click.referrer || 'Direct',
        click.timeOnPage || '0',
        click.scrollDepth || '0',
        click.isReturning ? 'Yes' : 'No',
        click.isConversion ? 'Yes' : 'No'
      ]);
      
      const csvContent = [
        headers.join(','),
        ...rows.map(row => row.map(cell => `"${cell}"`).join(','))
      ].join('\n');
      
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename=analytics_${id}_${range}_${Date.now()}.csv`);
      res.send(csvContent);
    } else {
      res.json({
        success: true,
        data: clicks,
        metadata: {
          total: clicks.length,
          range,
          exportedAt: new Date().toISOString(),
          startDate,
          endDate
        }
      });
    }
    
  } catch (error) {
    console.error('Export analytics error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to export analytics'
    });
  }
};

// Get real-time analytics
const getRealTimeAnalytics = async (req, res) => {
  try {
    const { id } = req.params;
    
    if (id !== 'overall') {
      const url = await Url.findOne({
        _id: id,
        user: req.user._id
      });
      
      if (!url) {
        return res.status(404).json({
          success: false,
          message: 'URL not found'
        });
      }
    }
    
    // Get clicks from last 24 hours
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    
    let clicks;
    let userUrls;
    if (id === 'overall') {
      userUrls = await Url.find({ user: req.user._id }).select('_id');
      const urlIds = userUrls.map(url => url._id);
      
      clicks = await Click.find({
        urlId: { $in: urlIds },
        timestamp: { $gte: twentyFourHoursAgo },
        isBot: false
      })
      .limit(1000)
      .lean();
    } else {
      clicks = await Click.find({
        urlId: id,
        timestamp: { $gte: twentyFourHoursAgo },
        isBot: false
      })
      .limit(1000)
      .lean();
    }
    
    // Process data
    const clicksByHour = {};
    for (let i = 0; i < 24; i++) {
      clicksByHour[i] = 0;
    }
    
    clicks.forEach(click => {
      const hour = new Date(click.timestamp).getHours();
      clicksByHour[hour] = (clicksByHour[hour] || 0) + 1;
    });
    
    // Get active users (last 5 minutes)
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    const activeUsers = await Click.distinct('ipAddress', {
      timestamp: { $gte: fiveMinutesAgo },
      isBot: false,
      ...(id !== 'overall' ? { urlId: id } : { urlId: { $in: userUrls?.map(u => u._id) || [] } })
    }).maxTimeMS(5000);
    
    res.json({
      success: true,
      realTime: {
        totalClicks24h: clicks.length,
        activeUsersNow: activeUsers.length,
        clicksByHour: Object.entries(clicksByHour).map(([hour, count]) => ({
          hour: parseInt(hour),
          count
        }))
      }
    });
    
  } catch (error) {
    console.error('Get real-time analytics error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get real-time analytics'
    });
  }
};

// Get analytics summary
const getAnalyticsSummary = async (req, res) => {
  try {
    const userId = req.user._id;
    
    // Get user's URLs
    const userUrls = await Url.find({ user: userId }).select('_id');
    const urlIds = userUrls.map(url => url._id);
    
    if (urlIds.length === 0) {
      return res.json({
        success: true,
        summary: {
          totalClicks: 0,
          todayClicks: 0,
          topUrl: null,
          growth: 0
        }
      });
    }
    
    // Get total clicks
    const totalClicks = await Click.countDocuments({
      urlId: { $in: urlIds },
      isBot: false
    }).maxTimeMS(5000);
    
    // Get today's clicks
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const todayClicks = await Click.countDocuments({
      urlId: { $in: urlIds },
      timestamp: { $gte: today },
      isBot: false
    }).maxTimeMS(5000);
    
    // Get yesterday's clicks
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayEnd = new Date(yesterday);
    yesterdayEnd.setDate(yesterdayEnd.getDate() + 1);
    
    const yesterdayClicks = await Click.countDocuments({
      urlId: { $in: urlIds },
      timestamp: { $gte: yesterday, $lt: yesterdayEnd },
      isBot: false
    }).maxTimeMS(5000);
    
    // Calculate growth
    const growth = yesterdayClicks > 0 
      ? ((todayClicks - yesterdayClicks) / yesterdayClicks) * 100 
      : (todayClicks > 0 ? 100 : 0);
    
    // Get top URL
    const topUrlStats = await Click.aggregate([
      {
        $match: {
          urlId: { $in: urlIds },
          isBot: false
        }
      },
      {
        $group: {
          _id: '$urlId',
          clicks: { $sum: 1 }
        }
      },
      { $sort: { clicks: -1 } },
      { $limit: 1 }
    ]).maxTimeMS(5000);
    
    let topUrl = null;
    if (topUrlStats.length > 0) {
      const url = await Url.findById(topUrlStats[0]._id).select('shortId destinationUrl');
      if (url) {
        topUrl = {
          shortId: url.shortId,
          destinationUrl: url.destinationUrl.substring(0, 50) + '...',
          clicks: topUrlStats[0].clicks
        };
      }
    }
    
    res.json({
      success: true,
      summary: {
        totalClicks,
        todayClicks,
        growth: parseFloat(growth.toFixed(2)),
        topUrl
      }
    });
    
  } catch (error) {
    console.error('Get analytics summary error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get analytics summary'
    });
  }
};

module.exports = {
  getOverallAnalytics,
  getUrlAnalytics,
  getAdminAnalytics,
  exportAnalytics,
  getRealTimeAnalytics,
  getAnalyticsSummary
};