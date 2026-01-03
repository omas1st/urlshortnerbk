const User = require('../models/User');
const Url = require('../models/Url');
const Click = require('../models/Click');
const Notification = require('../models/Notification');
const { sendEmail } = require('../utils/emailService');
const mongoose = require('mongoose');

// Get admin dashboard stats
const getAdminStats = async (req, res) => {
  try {
    // Total users
    const totalUsers = await User.countDocuments();
    
    // New users today
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const newUsersToday = await User.countDocuments({ createdAt: { $gte: today } });
    
    // Total URLs
    const totalUrls = await Url.countDocuments();
    
    // New URLs today
    const newUrlsToday = await Url.countDocuments({ createdAt: { $gte: today } });
    
    // Total clicks (exclude bots where applicable)
    const totalClicks = await Click.countDocuments({ isBot: false });
    
    // Clicks today (support both timestamp and createdAt)
    const clicksToday = await Click.countDocuments({ 
      $and: [
        { isBot: false },
        { $or: [{ timestamp: { $gte: today } }, { createdAt: { $gte: today } }] }
      ]
    });
    
    // Active users (last 24 hours) - distinct IP address count
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const activeIps = await Click.distinct('ipAddress', {
      isBot: false,
      $or: [
        { timestamp: { $gte: twentyFourHoursAgo } },
        { createdAt: { $gte: twentyFourHoursAgo } }
      ]
    });

    // System health (db stats) - be defensive
    let dbStats = { dataSize: 0, collections: 0 };
    try {
      dbStats = await mongoose.connection.db.stats();
    } catch (e) {
      console.warn('Could not fetch DB stats:', e.message || e);
    }

    // recentActivity: combine latest registrations and latest url creations
    const recentUsers = await User.find({})
      .sort({ createdAt: -1 })
      .limit(5)
      .select('email username createdAt')
      .lean();

    const recentUrls = await Url.find({})
      .sort({ createdAt: -1 })
      .limit(5)
      .select('shortId user createdAt')
      .populate({ path: 'user', select: 'username email' })
      .lean();

    const recentActivity = [];

    recentUsers.forEach(u => {
      recentActivity.push({
        type: 'registration',
        message: `New user registered: ${u.email || u.username || 'unknown'}`,
        timestamp: u.createdAt || new Date()
      });
    });

    recentUrls.forEach(u => {
      recentActivity.push({
        type: 'url_created',
        message: `New short URL created: ${u.shortId} (owner: ${u.user?.username || u.user?.email || 'unknown'})`,
        timestamp: u.createdAt || new Date()
      });
    });

    // sort combined activity by timestamp desc and limit to 10
    recentActivity.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    const limitedActivity = recentActivity.slice(0, 10);

    res.json({
      success: true,
      stats: {
        totalUsers,
        newUsersToday,
        totalUrls,
        newUrlsToday,
        totalClicks,
        clicksToday,
        activeUsers: activeIps.length,
        dbSize: `${(dbStats.dataSize / 1024 / 1024).toFixed(2)} MB`,
        collections: dbStats.collections
      },
      recentActivity: limitedActivity
    });
    
  } catch (error) {
    console.error('Get admin stats error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get admin stats'
    });
  }
};

// Get all users
const getAllUsers = async (req, res) => {
  try {
    const { 
      page = 1, 
      limit = 20, 
      search = '',
      sortBy = 'createdAt',
      order = 'desc',
      role,
      active
    } = req.query;
    
    const skip = (page - 1) * limit;
    
    // Build query
    const query = {};
    
    if (search) {
      query.$or = [
        { email: { $regex: search, $options: 'i' } },
        { username: { $regex: search, $options: 'i' } }
      ];
    }
    
    if (role) {
      query.role = role;
    }
    
    if (active !== undefined) {
      query.isActive = active === 'true';
    }
    
    // Build sort
    const sort = {};
    sort[sortBy] = order === 'desc' ? -1 : 1;
    
    // Get users with URL count
    const users = await User.aggregate([
      { $match: query },
      {
        $lookup: {
          from: 'urls',
          localField: '_id',
          foreignField: 'user',
          as: 'urls'
        }
      },
      {
        $addFields: {
          urlCount: { $size: '$urls' },
          totalClicks: { $sum: '$urls.clicks' }
        }
      },
      { $sort: sort },
      { $skip: skip },
      { $limit: parseInt(limit) },
      {
        $project: {
          password: 0,
          verificationToken: 0,
          resetPasswordToken: 0,
          resetPasswordExpires: 0,
          urls: 0
        }
      }
    ]);
    
    // Get total count
    const total = await User.countDocuments(query);
    
    res.json({
      success: true,
      users,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    });
    
  } catch (error) {
    console.error('Get all users error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get users'
    });
  }
};

// Get user details
const getUserDetails = async (req, res) => {
  try {
    const { id } = req.params;
    
    const user = await User.findById(id)
      .select('-password -verificationToken -resetPasswordToken -resetPasswordExpires');
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }
    
    // Get user's URLs
    const urls = await Url.find({ user: id })
      .select('shortId destinationUrl clicks isActive createdAt')
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();
    
    // Get user's clicks
    const clicks = await Click.aggregate([
      {
        $lookup: {
          from: 'urls',
          localField: 'urlId',
          foreignField: '_id',
          as: 'url'
        }
      },
      { $unwind: '$url' },
      { $match: { 'url.user': user._id } },
      { $sort: { timestamp: -1 } },
      { $limit: 100 },
      {
        $project: {
          timestamp: 1,
          ipAddress: 1,
          country: 1,
          device: 1,
          browser: 1,
          'url.shortId': 1,
          'url.destinationUrl': 1
        }
      }
    ]);
    
    res.json({
      success: true,
      user,
      stats: {
        totalUrls: urls.length,
        totalClicks: urls.reduce((sum, url) => sum + (url.clicks || 0), 0),
        activeUrls: urls.filter(url => url.isActive).length
      },
      recentUrls: urls,
      recentClicks: clicks
    });
    
  } catch (error) {
    console.error('Get user details error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get user details'
    });
  }
};

// Update user
const updateUser = async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;
    
    const user = await User.findById(id);
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }
    
    // Update allowed fields
    const allowedUpdates = ['username', 'email', 'role', 'isActive', 'profile', 'settings'];
    const updatedFields = {};
    
    allowedUpdates.forEach(field => {
      if (updates[field] !== undefined) {
        updatedFields[field] = updates[field];
      }
    });
    
    // Check if email is being changed and if it's unique
    if (updates.email && updates.email !== user.email) {
      const existingUser = await User.findOne({ email: updates.email });
      if (existingUser) {
        return res.status(400).json({
          success: false,
          message: 'Email already in use'
        });
      }
    }
    
    // Check if username is being changed and if it's unique
    if (updates.username && updates.username !== user.username) {
      const existingUser = await User.findOne({ username: updates.username });
      if (existingUser) {
        return res.status(400).json({
          success: false,
          message: 'Username already in use'
        });
      }
    }
    
    // Update user
    Object.assign(user, updatedFields);
    await user.save();
    
    // Remove sensitive data
    user.password = undefined;
    
    res.json({
      success: true,
      message: 'User updated successfully',
      user
    });
    
  } catch (error) {
    console.error('Update user error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update user'
    });
  }
};

// Delete user
const deleteUser = async (req, res) => {
  try {
    const { id } = req.params;
    
    const user = await User.findById(id);
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }
    
    // Prevent deleting admin users (except super admin)
    if (user.role === 'admin' && user.email !== process.env.ADMIN_EMAIL) {
      return res.status(403).json({
        success: false,
        message: 'Cannot delete admin users'
      });
    }
    
    // Delete user's URLs and associated data
    const urls = await Url.find({ user: id });
    const urlIds = urls.map(url => url._id);
    
    await Url.deleteMany({ user: id });
    await Click.deleteMany({ urlId: { $in: urlIds } });
    
    // Delete user
    await user.deleteOne();
    
    res.json({
      success: true,
      message: 'User deleted successfully'
    });
    
  } catch (error) {
    console.error('Delete user error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete user'
    });
  }
};

// Get all URLs
const getAllUrls = async (req, res) => {
  try {
    const { 
      page = 1, 
      limit = 20, 
      search = '',
      userId,
      active,
      restricted,
      sortBy = 'createdAt',
      order = 'desc'
    } = req.query;
    
    const skip = (page - 1) * limit;
    
    // Build query
    const query = {};
    
    if (search) {
      query.$or = [
        { shortId: { $regex: search, $options: 'i' } },
        { destinationUrl: { $regex: search, $options: 'i' } },
        { customName: { $regex: search, $options: 'i' } }
      ];
    }
    
    if (userId) {
      query.user = userId;
    }
    
    if (active !== undefined) {
      query.isActive = active === 'true';
    }
    
    if (restricted !== undefined) {
      query.isRestricted = restricted === 'true';
    }
    
    // Build sort
    const sort = {};
    sort[sortBy] = order === 'desc' ? -1 : 1;
    
    // Get URLs with user info
    const urls = await Url.find(query)
      .populate('user', 'username email')
      .sort(sort)
      .skip(skip)
      .limit(parseInt(limit))
      .lean();
    
    // Get total count
    const total = await Url.countDocuments(query);
    
    // Format response
    const formattedUrls = urls.map(url => ({
      id: url._id,
      shortId: url.shortId,
      shortUrl: `${process.env.BASE_URL}/s/${url.shortId}`,
      destinationUrl: url.destinationUrl,
      customName: url.customName,
      user: url.user,
      password: !!url.password,
      expirationDate: url.expirationDate,
      isActive: url.isActive,
      isRestricted: url.isRestricted,
      clicks: url.clicks,
      createdAt: url.createdAt,
      lastClicked: url.lastClicked
    }));
    
    res.json({
      success: true,
      urls: formattedUrls,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    });
    
  } catch (error) {
    console.error('Get all URLs error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get URLs'
    });
  }
};

// Get URL details
const getUrlDetails = async (req, res) => {
  try {
    const { id } = req.params;
    
    const url = await Url.findById(id)
      .populate('user', 'username email')
      .lean();
    
    if (!url) {
      return res.status(404).json({
        success: false,
        message: 'URL not found'
      });
    }
    
    // Get click statistics
    const clicks = await Click.find({ urlId: id })
      .sort({ timestamp: -1 })
      .limit(100)
      .lean();
    
    // Get version history
    const versions = await require('../models/UrlVersion').find({ urlId: id })
      .sort({ version: -1 })
      .limit(10)
      .lean();
    
    res.json({
      success: true,
      url,
      stats: {
        totalClicks: clicks.length,
        uniqueClicks: new Set(clicks.map(c => c.ipAddress)).size,
        countries: [...new Set(clicks.map(c => c.country).filter(Boolean))],
        devices: clicks.reduce((acc, click) => {
          const device = click.device || 'unknown';
          acc[device] = (acc[device] || 0) + 1;
          return acc;
        }, {})
      },
      recentClicks: clicks.slice(0, 10),
      versions: versions.map(v => ({
        version: v.version,
        changes: v.changes,
        changedAt: v.createdAt
      }))
    });
    
  } catch (error) {
    console.error('Get URL details error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get URL details'
    });
  }
};

// Update URL
const updateUrl = async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;
    
    const url = await Url.findById(id);
    
    if (!url) {
      return res.status(404).json({
        success: false,
        message: 'URL not found'
      });
    }
    
    // Update allowed fields
    const allowedUpdates = ['isActive', 'isRestricted', 'expirationDate', 'customName'];
    const updatedFields = {};
    
    allowedUpdates.forEach(field => {
      if (updates[field] !== undefined) {
        updatedFields[field] = updates[field];
      }
    });
    
    // Update URL
    Object.assign(url, updatedFields);
    await url.save();
    
    // Create notification if URL was disabled/restricted
    if (updates.isActive === false && url.user) {
      await require('./notificationController').sendDisabledNotification(
        url._id,
        'disabled by admin'
      );
    }
    
    if (updates.isRestricted === true && url.user) {
      await require('./notificationController').sendDisabledNotification(
        url._id,
        'restricted by admin'
      );
    }
    
    res.json({
      success: true,
      message: 'URL updated successfully',
      url: {
        id: url._id,
        shortId: url.shortId,
        isActive: url.isActive,
        isRestricted: url.isRestricted,
        expirationDate: url.expirationDate
      }
    });
    
  } catch (error) {
    console.error('Update URL error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update URL'
    });
  }
};

// Delete URL
const deleteUrl = async (req, res) => {
  try {
    const { id } = req.params;
    
    const url = await Url.findById(id);
    
    if (!url) {
      return res.status(404).json({
        success: false,
        message: 'URL not found'
      });
    }
    
    // Delete URL and associated data
    await url.deleteOne();
    await Click.deleteMany({ urlId: id });
    await require('../models/UrlVersion').deleteMany({ urlId: id });
    
    res.json({
      success: true,
      message: 'URL deleted successfully'
    });
    
  } catch (error) {
    console.error('Delete URL error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete URL'
    });
  }
};

// Send message to user
const sendMessageToUser = async (req, res) => {
  try {
    const { id } = req.params;
    const { message } = req.body;
    
    if (!message || message.trim() === '') {
      return res.status(400).json({
        success: false,
        message: 'Message is required'
      });
    }
    
    const user = await User.findById(id);
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }
    
    // Create notification
    await Notification.createAdminMessage(
      user._id,
      message,
      req.admin?.userId || 'admin'
    );
    
    // Send email if user has email notifications enabled
    if (user.settings?.notifications?.email) {
      try {
        await sendEmail({
          to: user.email,
          subject: 'Message from Admin - ShortLink Pro',
          html: `
            <h1>Message from Admin</h1>
            <p>${message}</p>
            <p>You can view and respond to this message in your notifications.</p>
          `
        });
      } catch (emailError) {
        console.error('Failed to send email:', emailError);
        // Continue even if email fails
      }
    }
    
    res.json({
      success: true,
      message: 'Message sent successfully'
    });
    
  } catch (error) {
    console.error('Send message error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to send message'
    });
  }
};

// Get system analytics
const getSystemAnalytics = async (req, res) => {
  try {
    const { range = '7days' } = req.query;
    
    // Calculate date range
    const now = new Date();
    let startDate;
    
    switch (range) {
      case 'today':
        startDate = new Date(now.setHours(0, 0, 0, 0));
        break;
      case '7days':
        startDate = new Date(now.setDate(now.getDate() - 7));
        break;
      case '30days':
        startDate = new Date(now.setDate(now.getDate() - 30));
        break;
      case '90days':
        startDate = new Date(now.setDate(now.getDate() - 90));
        break;
      case '180days':
        startDate = new Date(now.setDate(now.getDate() - 180));
        break;
      case '365days':
        startDate = new Date(now.setDate(now.getDate() - 365));
        break;
      default:
        startDate = new Date(0);
    }
    
    // Get user registrations over time
    const userRegistrations = await User.aggregate([
      {
        $match: {
          createdAt: { $gte: startDate }
        }
      },
      {
        $group: {
          _id: {
            $dateToString: { format: '%Y-%m-%d', date: '$createdAt' }
          },
          count: { $sum: 1 }
        }
      },
      { $sort: { _id: 1 } }
    ]);
    
    // Get URL creations over time
    const urlCreations = await Url.aggregate([
      {
        $match: {
          createdAt: { $gte: startDate }
        }
      },
      {
        $group: {
          _id: {
            $dateToString: { format: '%Y-%m-%d', date: '$createdAt' }
          },
          count: { $sum: 1 }
        }
      },
      { $sort: { _id: 1 } }
    ]);
    
    // Get clicks over time
    const clicksOverTime = await Click.aggregate([
      {
        $match: {
          timestamp: { $gte: startDate },
          isBot: false
        }
      },
      {
        $group: {
          _id: {
            $dateToString: { format: '%Y-%m-%d', date: '$timestamp' }
          },
          count: { $sum: 1 }
        }
      },
      { $sort: { _id: 1 } }
    ]);
    
    // Get top users by URL count
    const topUsers = await Url.aggregate([
      {
        $group: {
          _id: '$user',
          urlCount: { $sum: 1 },
          totalClicks: { $sum: '$clicks' }
        }
      },
      { $sort: { urlCount: -1 } },
      { $limit: 10 },
      {
        $lookup: {
          from: 'users',
          localField: '_id',
          foreignField: '_id',
          as: 'user'
        }
      },
      { $unwind: '$user' },
      {
        $project: {
          username: '$user.username',
          email: '$user.email',
          urlCount: 1,
          totalClicks: 1
        }
      }
    ]);
    
    // Get top URLs
    const topUrls = await Url.find()
      .sort({ clicks: -1 })
      .limit(10)
      .populate('user', 'username')
      .select('shortId destinationUrl clicks user')
      .lean();
    
    res.json({
      success: true,
      analytics: {
        userRegistrations: userRegistrations.map(item => ({
          date: item._id,
          count: item.count
        })),
        urlCreations: urlCreations.map(item => ({
          date: item._id,
          count: item.count
        })),
        clicksOverTime: clicksOverTime.map(item => ({
          date: item._id,
          count: item.count
        })),
        topUsers,
        topUrls: topUrls.map(url => ({
          shortId: url.shortId,
          destinationUrl: url.destinationUrl.substring(0, 50) + '...',
          clicks: url.clicks,
          owner: url.user?.username
        }))
      }
    });
    
  } catch (error) {
    console.error('Get system analytics error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get system analytics'
    });
  }
};

// Get user's URLs
const getUserUrls = async (req, res) => {
  try {
    const { id } = req.params;
    
    const urls = await Url.find({ user: id })
      .sort({ createdAt: -1 })
      .lean();
    
    res.json({
      success: true,
      urls: urls.map(url => ({
        id: url._id,
        shortId: url.shortId,
        shortUrl: `${process.env.BASE_URL}/s/${url.shortId}`,
        destinationUrl: url.destinationUrl,
        isActive: url.isActive,
        isRestricted: url.isRestricted,
        clicks: url.clicks,
        createdAt: url.createdAt
      }))
    });
    
  } catch (error) {
    console.error('Get user URLs error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get user URLs'
    });
  }
};

// Bulk operations
const bulkOperations = async (req, res) => {
  try {
    const { action, ids, type } = req.body;
    
    if (!action || !ids || !Array.isArray(ids)) {
      return res.status(400).json({
        success: false,
        message: 'Action and IDs are required'
      });
    }
    
    let result;
    
    switch (type) {
      case 'users':
        switch (action) {
          case 'activate':
            result = await User.updateMany(
              { _id: { $in: ids } },
              { $set: { isActive: true } }
            );
            break;
          case 'deactivate':
            result = await User.updateMany(
              { _id: { $in: ids } },
              { $set: { isActive: false } }
            );
            break;
          case 'delete':
            // Get users to delete
            const users = await User.find({ _id: { $in: ids } });
            const userIds = users.map(u => u._id);
            
            // Delete user URLs
            const urls = await Url.find({ user: { $in: userIds } });
            const urlIds = urls.map(url => url._id);
            
            await Url.deleteMany({ user: { $in: userIds } });
            await Click.deleteMany({ urlId: { $in: urlIds } });
            
            // Delete users
            result = await User.deleteMany({ _id: { $in: ids } });
            break;
          default:
            return res.status(400).json({
              success: false,
              message: 'Invalid action for users'
            });
        }
        break;
        
      case 'urls':
        switch (action) {
          case 'activate':
            result = await Url.updateMany(
              { _id: { $in: ids } },
              { $set: { isActive: true } }
            );
            break;
          case 'deactivate':
            result = await Url.updateMany(
              { _id: { $in: ids } },
              { $set: { isActive: false } }
            );
            break;
          case 'restrict':
            result = await Url.updateMany(
              { _id: { $in: ids } },
              { $set: { isRestricted: true } }
            );
            break;
          case 'unrestrict':
            result = await Url.updateMany(
              { _id: { $in: ids } },
              { $set: { isRestricted: false } }
            );
            break;
          case 'delete':
            // Delete URLs and associated data
            await Click.deleteMany({ urlId: { $in: ids } });
            await require('../models/UrlVersion').deleteMany({ urlId: { $in: ids } });
            result = await Url.deleteMany({ _id: { $in: ids } });
            break;
          default:
            return res.status(400).json({
              success: false,
              message: 'Invalid action for URLs'
            });
        }
        break;
        
      default:
        return res.status(400).json({
          success: false,
          message: 'Invalid type'
        });
    }
    
    res.json({
      success: true,
      message: `Bulk operation completed: ${action} ${result.modifiedCount || result.deletedCount} items`,
      count: result.modifiedCount || result.deletedCount
    });
    
  } catch (error) {
    console.error('Bulk operations error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to perform bulk operations'
    });
  }
};

module.exports = {
  getAdminStats,
  getAllUsers,
  getUserDetails,
  updateUser,
  deleteUser,
  getAllUrls,
  getUrlDetails,
  updateUrl,
  deleteUrl,
  sendMessageToUser,
  getSystemAnalytics,
  getUserUrls,
  bulkOperations
};
