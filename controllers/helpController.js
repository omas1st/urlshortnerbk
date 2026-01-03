const { sendEmail } = require('../utils/emailService');
const Notification = require('../models/Notification');

// Send help message to admin
const sendHelpMessage = async (req, res) => {
  try {
    const { message } = req.body;
    
    if (!message || message.trim() === '') {
      return res.status(400).json({
        success: false,
        message: 'Message is required'
      });
    }
    
    // Get user info if logged in
    const userInfo = req.user ? {
      userId: req.user._id,
      email: req.user.email,
      username: req.user.username
    } : {
      ipAddress: req.ip,
      userAgent: req.headers['user-agent']
    };
    
    // Prepare email content
    const emailContent = `
      <h2>Help Request Received</h2>
      <p><strong>Message:</strong></p>
      <p>${message}</p>
      <hr>
      <p><strong>User Information:</strong></p>
      <ul>
        ${req.user ? `
          <li>User ID: ${req.user._id}</li>
          <li>Email: ${req.user.email}</li>
          <li>Username: ${req.user.username}</li>
        ` : `
          <li>IP Address: ${req.ip}</li>
          <li>User Agent: ${req.headers['user-agent']}</li>
        `}
        <li>Timestamp: ${new Date().toISOString()}</li>
      </ul>
    `;
    
    // Send email to admin
    await sendEmail({
      to: process.env.ADMIN_EMAIL,
      subject: 'Help Request - ShortLink Pro',
      html: emailContent
    });
    
    // Create notification for admin in the system
    // This assumes there's an admin user in the database
    const Admin = require('../models/User');
    const adminUser = await Admin.findOne({ email: process.env.ADMIN_EMAIL });
    
    if (adminUser) {
      await Notification.createForUser(adminUser._id, {
        type: 'info',
        title: 'New Help Request',
        message: `Help request from ${req.user ? req.user.email : 'anonymous user'}`,
        data: {
          message,
          user: userInfo,
          timestamp: new Date()
        },
        priority: 2
      });
    }
    
    res.json({
      success: true,
      message: 'Help message sent to admin. We will get back to you soon.'
    });
    
  } catch (error) {
    console.error('Send help message error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to send help message'
    });
  }
};

// Get help topics
const getHelpTopics = async (req, res) => {
  try {
    const topics = [
      {
        id: 'getting-started',
        title: 'Getting Started',
        questions: [
          {
            q: 'How do I create a short URL?',
            a: 'Simply paste your long URL in the input field on the homepage or dashboard, customize settings if needed, and click "Generate Short Link".'
          },
          {
            q: 'Do I need an account to create short URLs?',
            a: 'Yes, you need to create an account to generate short URLs. This allows us to provide analytics and management features.'
          }
        ]
      },
      {
        id: 'features',
        title: 'Features',
        questions: [
          {
            q: 'What is password protection?',
            a: 'Password protection allows you to set a password for your short URL. Users will need to enter the correct password before being redirected.'
          },
          {
            q: 'How do expiration dates work?',
            a: 'You can set an expiration date for your short URL. After this date, the URL will stop redirecting and show an expiration message.'
          },
          {
            q: 'What are smart dynamic links?',
            a: 'Smart dynamic links can redirect users to different destinations based on their country, device, time of day, or other factors.'
          },
          {
            q: 'How do QR codes work?',
            a: 'When you enable QR code generation, we create a QR code that links to your short URL. You can download and share this QR code.'
          }
        ]
      },
      {
        id: 'analytics',
        title: 'Analytics',
        questions: [
          {
            q: 'What analytics do you provide?',
            a: 'We provide detailed analytics including click counts, geographic data, device information, referral sources, and user engagement metrics.'
          },
          {
            q: 'How real-time are the analytics?',
            a: 'Analytics are updated in real-time. You can see clicks as they happen in the real-time analytics section.'
          },
          {
            q: 'Can I export my analytics data?',
            a: 'Yes, you can export your analytics data in CSV or JSON format from the analytics page.'
          }
        ]
      },
      {
        id: 'account',
        title: 'Account & Security',
        questions: [
          {
            q: 'How do I reset my password?',
            a: 'Click "Forgot password" on the login page. We\'ll send you an email with a link to reset your password.'
          },
          {
            q: 'Can I change my email address?',
            a: 'Yes, you can update your email address in your account settings.'
          },
          {
            q: 'Is my data secure?',
            a: 'Yes, we use industry-standard encryption and security practices to protect your data.'
          }
        ]
      },
      {
        id: 'troubleshooting',
        title: 'Troubleshooting',
        questions: [
          {
            q: 'My short URL is not working',
            a: 'Check if the URL is active, not expired, and not restricted. Also verify that the destination URL is valid and accessible.'
          },
          {
            q: 'Analytics are not showing',
            a: 'Make sure your URL has received clicks. Analytics are only shown after clicks are recorded.'
          },
          {
            q: 'QR code is not scanning',
            a: 'Ensure the QR code has sufficient contrast and size. Try generating a new QR code with different settings.'
          }
        ]
      }
    ];
    
    res.json({
      success: true,
      topics
    });
    
  } catch (error) {
    console.error('Get help topics error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get help topics'
    });
  }
};

// Submit feedback
const submitFeedback = async (req, res) => {
  try {
    const { type, message, rating } = req.body;
    
    if (!message || message.trim() === '') {
      return res.status(400).json({
        success: false,
        message: 'Message is required'
      });
    }
    
    // Get user info
    const userInfo = req.user ? {
      userId: req.user._id,
      email: req.user.email,
      username: req.user.username
    } : {
      ipAddress: req.ip
    };
    
    // Prepare feedback email
    const emailContent = `
      <h2>${type === 'bug' ? 'Bug Report' : 'Feature Request'}</h2>
      ${rating ? `<p><strong>Rating:</strong> ${rating}/5</p>` : ''}
      <p><strong>Message:</strong></p>
      <p>${message}</p>
      <hr>
      <p><strong>User Information:</strong></p>
      <ul>
        ${req.user ? `
          <li>User ID: ${req.user._id}</li>
          <li>Email: ${req.user.email}</li>
          <li>Username: ${req.user.username}</li>
        ` : `
          <li>IP Address: ${req.ip}</li>
        `}
        <li>Type: ${type || 'general'}</li>
        <li>Timestamp: ${new Date().toISOString()}</li>
      </ul>
    `;
    
    // Send feedback email
    await sendEmail({
      to: process.env.ADMIN_EMAIL,
      subject: `${type === 'bug' ? 'Bug Report' : 'Feature Request'} - ShortLink Pro`,
      html: emailContent
    });
    
    res.json({
      success: true,
      message: 'Thank you for your feedback! We appreciate your input.'
    });
    
  } catch (error) {
    console.error('Submit feedback error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to submit feedback'
    });
  }
};

module.exports = {
  sendHelpMessage,
  getHelpTopics,
  submitFeedback
};