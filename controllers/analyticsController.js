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

// Get overall analytics for user
const getOverallAnalytics = async (req, res) => {
  try {
    const { range = '7days', startDate: customStartDate, endDate: customEndDate } = req.query;
    const userId = req.user._id;
    
    console.log(`Getting overall analytics for user ${userId}, range: ${range}`);
    
    // Calculate date range
    const { startDate, endDate } = getDateRange(range, customStartDate, customEndDate);
    
    // Get user's URLs
    const userUrls = await Url.find({ user: userId }).select('_id shortId destinationUrl').lean();
    const urlIds = userUrls.map(url => url._id);
    
    console.log(`User has ${urlIds.length} URLs, date range: ${startDate} to ${endDate}`);
    
    if (urlIds.length === 0) {
      return res.json({
        success: true,
        analytics: {
          totalClicks: 0,
          uniqueVisitors: 0,
          returningVisitors: 0,
          conversionRate: '0%',
          totalUrls: 0,
          topUrls: [],
          clicksOverTime: { labels: [], values: [] },
          topCountries: { rawData: [], countries: [], visits: [] },
          deviceDistribution: { desktop: 0, mobile: 0, tablet: 0 },
          engagement: { bounced: 0, engaged: 0, bounceRate: 0 },
          recentClicks: [],
          detailedMetrics: {
            avgTimeToClick: '0s',
            avgScrollDepth: '0%',
            peakHour: 'N/A',
            topReferrer: 'Direct',
            avgSessionDuration: '0s',
            pagesPerSession: 1.0
          }
        }
      });
    }
    
    // Get click statistics with aggregation for better performance
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
          // Total and unique clicks
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
          
          // Clicks by date for time series - adjust grouping based on range
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
          
          // Device distribution - FIXED: Proper aggregation for device types
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
          
          // Recent clicks
          recentClicks: [
            { $sort: { timestamp: -1 } },
            { $limit: 10 }
          ],
          
          // Peak hour - FIXED: Proper hour aggregation
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
          
          // Referrers - FIXED: Proper referrer domain handling
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
            { $limit: 5 }
          ],
          
          // Session data for pages/session calculation
          sessionData: [
            {
              $match: {
                timeOnPage: { $gt: 0 }
              }
            },
            {
              $group: {
                _id: '$sessionId',
                totalClicks: { $sum: 1 },
                avgTimeOnPage: { $avg: '$timeOnPage' }
              }
            }
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
    
    // Calculate detailed metrics based on actual data
    const avgTimeOnPage = basicStats.clicksWithSessionData > 0 
      ? `${Math.round(basicStats.totalTimeOnPage / basicStats.clicksWithSessionData)}s`
      : '0s';
      
    const avgScrollDepth = basicStats.clicksWithSessionData > 0
      ? `${Math.round((basicStats.totalScrollDepth / basicStats.clicksWithSessionData))}%`
      : '0%';
      
    const avgTimeToClick = basicStats.clicksWithTimeToClick > 0
      ? `${Math.round(basicStats.totalTimeToClick / basicStats.clicksWithTimeToClick / 1000)}s`
      : 'N/A';
    
    const peakHourData = stats.peakHour[0];
    const peakHour = peakHourData ? `${peakHourData._id}:00` : 'N/A';
    
    const topReferrerData = stats.referrers[0];
    const topReferrer = topReferrerData ? topReferrerData._id : 'Direct';
    
    // Calculate pages per session from session data
    const sessionData = stats.sessionData || [];
    const totalSessions = sessionData.length;
    const totalPagesViewed = sessionData.reduce((sum, session) => sum + session.totalClicks, 0);
    const pagesPerSession = totalSessions > 0 ? (totalPagesViewed / totalSessions).toFixed(1) : 1.0;
    
    // Time series data with proper formatting
    const timeSeriesData = stats.timeSeries || [];
    const clicksOverTime = {
      labels: timeSeriesData.map(item => {
        const dateStr = item._id;
        if (range === 'all' && /^\d{4}-\d{2}$/.test(dateStr)) {
          // Format as "Jan 2024" for monthly data
          const [year, month] = dateStr.split('-');
          const date = new Date(year, month - 1);
          return date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
        } else {
          // Format as "MMM DD" for daily data
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
    
    // Country data
    const countryData = stats.countries || [];
    const topCountries = {
      rawData: countryData.map(item => ({
        country: item._id,
        visits: item.count
      })),
      countries: countryData.map(item => item._id),
      visits: countryData.map(item => item.count)
    };
    
    // Device data - FIXED: Proper device distribution
    const deviceData = stats.devices[0] || { desktop: 0, mobile: 0, tablet: 0 };
    const deviceDistribution = {
      desktop: deviceData.desktop || 0,
      mobile: deviceData.mobile || 0,
      tablet: deviceData.tablet || 0
    };
    
    // Calculate actual engagement metrics
    const engagedClicks = await Click.countDocuments({
      urlId: { $in: urlIds },
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
    
    // Recent clicks
    const recentClicks = stats.recentClicks || [];
    
    // Calculate actual conversion rate
    const conversionRate = totalClicks > 0 ? ((conversions / totalClicks) * 100).toFixed(1) : 0;
    
    res.json({
      success: true,
      analytics: {
        totalClicks,
        uniqueVisitors,
        returningVisitors,
        conversionRate: `${conversionRate}%`,
        totalUrls: urlIds.length,
        topUrls: userUrls.slice(0, 5).map(url => ({
          id: url._id,
          shortId: url.shortId,
          destinationUrl: url.destinationUrl ? url.destinationUrl.substring(0, 50) + '...' : 'Unknown',
          clicks: Math.floor(totalClicks / Math.max(1, urlIds.length))
        })),
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
          peakHour,
          topReferrer,
          pagesPerSession: parseFloat(pagesPerSession),
          conversionRate: `${conversionRate}%`
        }
      }
    });
    
  } catch (error) {
    console.error('Get overall analytics error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get analytics: ' + (error.message || 'Unknown error')
    });
  }
};

// Get URL-specific analytics
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
    
    // Get click statistics with aggregation
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
          
          // Time series - adjust grouping based on range
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
          
          // Device distribution - FIXED: Proper aggregation for device types
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
          
          // Recent clicks
          recentClicks: [
            { $sort: { timestamp: -1 } },
            { $limit: 10 }
          ],
          
          // Peak hour - FIXED: Proper hour aggregation
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
          
          // Referrers - FIXED: Proper referrer domain handling
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
            { $limit: 5 }
          ],
          
          // Session data for pages/session calculation
          sessionData: [
            {
              $match: {
                timeOnPage: { $gt: 0 }
              }
            },
            {
              $group: {
                _id: '$sessionId',
                totalClicks: { $sum: 1 },
                avgTimeOnPage: { $avg: '$timeOnPage' }
              }
            }
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
    
    // Calculate metrics based on actual data
    const avgTimeOnPage = basicStats.clicksWithSessionData > 0 
      ? `${Math.round(basicStats.totalTimeOnPage / basicStats.clicksWithSessionData)}s`
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
    
    const peakHourData = stats.peakHour[0];
    const peakHour = peakHourData ? `${peakHourData._id}:00` : 'N/A';
    
    const topReferrerData = stats.referrers[0];
    const topReferrer = topReferrerData ? topReferrerData._id : 'Direct';
    
    // Calculate pages per session from session data
    const sessionData = stats.sessionData || [];
    const totalSessions = sessionData.length;
    const totalPagesViewed = sessionData.reduce((sum, session) => sum + session.totalClicks, 0);
    const pagesPerSession = totalSessions > 0 ? (totalPagesViewed / totalSessions).toFixed(1) : 1.0;
    
    // Time series with proper formatting
    const timeSeriesData = stats.timeSeries || [];
    const clicksOverTime = {
      labels: timeSeriesData.map(item => {
        const dateStr = item._id;
        if (range === 'all' && /^\d{4}-\d{2}$/.test(dateStr)) {
          // Format as "Jan 2024" for monthly data
          const [year, month] = dateStr.split('-');
          const date = new Date(year, month - 1);
          return date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
        } else {
          // Format as "MMM DD" for daily data
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
    
    // Devices - FIXED: Proper device distribution
    const deviceData = stats.devices[0] || { desktop: 0, mobile: 0, tablet: 0 };
    const deviceDistribution = {
      desktop: deviceData.desktop || 0,
      mobile: deviceData.mobile || 0,
      tablet: deviceData.tablet || 0
    };
    
    // Calculate actual engagement metrics
    const engagedClicks = await Click.countDocuments({
      urlId: id,
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
    
    // Recent clicks
    const recentClicks = stats.recentClicks || [];
    
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
          pagesPerSession: parseFloat(pagesPerSession),
          conversionRate
        }
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
              format: range === 'all' ? '%Y-%m' : '%Y-%m-%d', 
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