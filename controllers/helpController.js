const { sendEmail } = require('../utils/emailService');
const Notification = require('../models/Notification');

// Send help message to admin
const sendHelpMessage = async (req, res) => {
  console.log('Help message endpoint hit:', {
    body: req.body,
    user: req.user ? req.user.email : 'anonymous',
    ip: req.ip,
    method: req.method,
    url: req.url
  });

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
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Help Request - ShortLink Pro</title>
          <style>
            body {
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
              line-height: 1.6;
              color: #333;
              margin: 0;
              padding: 0;
              background-color: #f9f9f9;
            }
            .email-container {
              max-width: 600px;
              margin: 0 auto;
              background-color: #ffffff;
              border-radius: 12px;
              overflow: hidden;
              box-shadow: 0 10px 30px rgba(0, 0, 0, 0.1);
            }
            .email-header {
              background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
              color: white;
              padding: 30px 40px;
              text-align: center;
            }
            .email-header h1 {
              margin: 0;
              font-size: 24px;
              font-weight: 600;
            }
            .email-header p {
              margin: 10px 0 0;
              opacity: 0.9;
              font-size: 14px;
            }
            .email-content {
              padding: 30px 40px;
            }
            .message-section {
              background: #f8fafc;
              border-radius: 10px;
              padding: 20px;
              margin: 20px 0;
              border-left: 4px solid #667eea;
            }
            .message-section h3 {
              color: #667eea;
              margin-top: 0;
              margin-bottom: 10px;
              font-size: 18px;
            }
            .message-text {
              background: white;
              padding: 15px;
              border-radius: 8px;
              border: 1px solid #e2e8f0;
              line-height: 1.6;
              white-space: pre-wrap;
            }
            .user-info {
              background: #f0f9ff;
              border-radius: 10px;
              padding: 20px;
              margin: 25px 0;
              border: 1px solid #bae6fd;
            }
            .user-info h3 {
              color: #0369a1;
              margin-top: 0;
              margin-bottom: 15px;
              font-size: 18px;
            }
            .info-grid {
              display: grid;
              grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
              gap: 15px;
            }
            .info-item {
              background: white;
              padding: 12px 15px;
              border-radius: 6px;
              border: 1px solid #e2e8f0;
            }
            .info-label {
              font-weight: 600;
              color: #64748b;
              font-size: 12px;
              text-transform: uppercase;
              letter-spacing: 0.5px;
              margin-bottom: 4px;
            }
            .info-value {
              color: #1e293b;
              font-size: 14px;
              word-break: break-all;
            }
            .email-footer {
              background: #f8fafc;
              padding: 25px 40px;
              border-top: 1px solid #e2e8f0;
              color: #64748b;
              font-size: 13px;
              text-align: center;
            }
            .email-footer p {
              margin: 5px 0;
            }
            .timestamp {
              color: #94a3b8;
              font-size: 12px;
              margin-top: 10px;
            }
            .action-buttons {
              margin-top: 25px;
              text-align: center;
            }
            .action-btn {
              display: inline-block;
              background: #667eea;
              color: white;
              padding: 10px 20px;
              border-radius: 6px;
              text-decoration: none;
              font-weight: 500;
              margin: 0 5px;
              transition: background-color 0.3s;
            }
            .action-btn:hover {
              background: #5a67d8;
            }
          </style>
        </head>
        <body>
          <div class="email-container">
            <div class="email-header">
              <h1>🆘 Help Request Received</h1>
              <p>ShortLink Pro Support System</p>
            </div>
            
            <div class="email-content">
              <h2 style="color: #1e293b; margin-top: 0;">New User Inquiry</h2>
              <p>A user has submitted a help request through the website.</p>
              
              <div class="message-section">
                <h3>📝 User's Message</h3>
                <div class="message-text">${message.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')}</div>
              </div>
              
              <div class="user-info">
                <h3>👤 User Information</h3>
                <div class="info-grid">
                  <div class="info-item">
                    <div class="info-label">User Status</div>
                    <div class="info-value">${req.user ? 'Registered User' : 'Guest User'}</div>
                  </div>
                  
                  ${req.user ? `
                    <div class="info-item">
                      <div class="info-label">User ID</div>
                      <div class="info-value">${req.user._id}</div>
                    </div>
                    <div class="info-item">
                      <div class="info-label">Email</div>
                      <div class="info-value">${req.user.email}</div>
                    </div>
                    <div class="info-item">
                      <div class="info-label">Username</div>
                      <div class="info-value">${req.user.username}</div>
                    </div>
                  ` : `
                    <div class="info-item">
                      <div class="info-label">IP Address</div>
                      <div class="info-value">${req.ip || 'Unknown'}</div>
                    </div>
                    <div class="info-item">
                      <div class="info-label">User Agent</div>
                      <div class="info-value" style="font-size: 12px;">${req.headers['user-agent'] || 'Unknown'}</div>
                    </div>
                  `}
                  
                  <div class="info-item">
                    <div class="info-label">Submission Time</div>
                    <div class="info-value">${new Date().toLocaleString('en-US', {
                      weekday: 'long',
                      year: 'numeric',
                      month: 'long',
                      day: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                      second: '2-digit',
                      timeZoneName: 'short'
                    })}</div>
                  </div>
                </div>
              </div>
              
              <div class="action-buttons">
                <a href="mailto:${req.user ? req.user.email : 'No email provided'}" class="action-btn">✉️ Reply to User</a>
                <a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}/admin/support" class="action-btn">⚙️ View in Admin Panel</a>
              </div>
            </div>
            
            <div class="email-footer">
              <p>This is an automated message from ShortLink Pro's Help System.</p>
              <p>Please respond to this inquiry within 24-48 hours.</p>
              <p class="timestamp">
                Message ID: ${Date.now()}-${Math.random().toString(36).substr(2, 9)}<br>
                System: ${process.env.NODE_ENV || 'development'}
              </p>
            </div>
          </div>
        </body>
      </html>
    `;
    
    // Also create plain text version for email clients that don't support HTML
    const plainTextContent = `
HELP REQUEST - ShortLink Pro
=============================

New user inquiry received.

MESSAGE:
${message}

USER INFORMATION:
${req.user ? `
  User ID: ${req.user._id}
  Email: ${req.user.email}
  Username: ${req.user.username}
  Status: Registered User
` : `
  IP Address: ${req.ip || 'Unknown'}
  User Agent: ${req.headers['user-agent'] || 'Unknown'}
  Status: Guest User
`}

TIMESTAMP: ${new Date().toLocaleString()}
SUBMITTED VIA: Website Help Form

Please respond to this inquiry promptly.
`;
    
    console.log('Attempting to send email to admin:', process.env.ADMIN_EMAIL);
    
    // Send email to admin
    const emailResult = await sendEmail({
      to: process.env.ADMIN_EMAIL,
      subject: `[Help Request] ${req.user ? `From: ${req.user.email}` : 'From: Guest User'} - ShortLink Pro`,
      text: plainTextContent,
      html: emailContent
    });
    
    // Check if email was sent successfully
    if (!emailResult.success) {
      console.error('Email sending failed:', {
        error: emailResult.error?.message,
        adminEmail: process.env.ADMIN_EMAIL,
        hasEmailConfig: !!(process.env.SMTP_HOST && process.env.SMTP_USER),
        environment: process.env.NODE_ENV
      });
      
      // Still try to create notification even if email fails
      try {
        const Admin = require('../models/User');
        const adminUser = await Admin.findOne({ email: process.env.ADMIN_EMAIL });
        
        if (adminUser) {
          await Notification.create({
            userId: adminUser._id,
            type: 'info',
            title: 'New Help Request (Email Failed)',
            message: `Help request from ${req.user ? req.user.email : 'anonymous user'}`,
            data: {
              message,
              user: userInfo,
              timestamp: new Date()
            },
            priority: 2,
            read: false
          });
        }
      } catch (notificationError) {
        console.error('Failed to create notification:', notificationError);
      }
      
      // Return success but inform about email failure
      return res.status(200).json({
        success: true,
        message: 'Message received and saved. However, email delivery failed. Admin has been notified in the system.',
        emailSent: false,
        notificationCreated: true
      });
    }
    
    console.log('Help email sent successfully:', {
      to: process.env.ADMIN_EMAIL,
      messageId: emailResult.info?.messageId,
      timestamp: new Date().toISOString()
    });
    
    // Create notification for admin in the system
    try {
      const Admin = require('../models/User');
      const adminUser = await Admin.findOne({ email: process.env.ADMIN_EMAIL });
      
      if (adminUser) {
        await Notification.create({
          userId: adminUser._id,
          type: 'info',
          title: 'New Help Request',
          message: `Help request from ${req.user ? req.user.email : 'anonymous user'}`,
          data: {
            message,
            user: userInfo,
            timestamp: new Date()
          },
          priority: 2,
          read: false
        });
        
        console.log('Notification created for admin:', adminUser.email);
      } else {
        console.log('Admin user not found in database. Skipping notification creation.');
      }
    } catch (notificationError) {
      console.error('Failed to create notification:', notificationError);
      // Don't fail the whole request if notification fails
    }
    
    res.json({
      success: true,
      message: 'Help message sent to admin. We will get back to you soon.',
      emailSent: true,
      notificationCreated: true
    });
    
  } catch (error) {
    console.error('Send help message error:', {
      message: error.message,
      stack: error.stack,
      userInfo: req.user ? req.user.email : 'anonymous'
    });
    
    res.status(500).json({
      success: false,
      message: 'Failed to process help message. Please try again later.',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
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
        icon: '🚀',
        questions: [
          {
            q: 'How do I create a short URL?',
            a: 'Simply paste your long URL in the input field on the homepage or dashboard, customize settings if needed, and click "Generate Short Link".'
          },
          {
            q: 'Do I need an account to create short URLs?',
            a: 'Yes, you need to create an account to generate short URLs. This allows us to provide analytics and management features.'
          },
          {
            q: 'Is there a limit to how many URLs I can shorten?',
            a: 'Free accounts have a generous limit of 100 URLs per month. Premium accounts have unlimited URL creation.'
          }
        ]
      },
      {
        id: 'features',
        title: 'Features',
        icon: '⚡',
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
          },
          {
            q: 'What is affiliate tracking?',
            a: 'Affiliate tracking allows you to add tracking parameters to your destination URLs and track conversions through cookies.'
          }
        ]
      },
      {
        id: 'analytics',
        title: 'Analytics',
        icon: '📊',
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
          },
          {
            q: 'Do you provide click maps or heatmaps?',
            a: 'Yes, premium accounts get access to geographic heatmaps showing where your clicks are coming from.'
          }
        ]
      },
      {
        id: 'account',
        title: 'Account & Security',
        icon: '🔒',
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
          },
          {
            q: 'Can I delete my account?',
            a: 'Yes, you can delete your account from the account settings page. This will permanently delete all your data.'
          }
        ]
      },
      {
        id: 'troubleshooting',
        title: 'Troubleshooting',
        icon: '🔧',
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
          },
          {
            q: 'Password protection not working',
            a: 'Clear your browser cache and cookies, then try again. If the issue persists, regenerate the short URL.'
          }
        ]
      },
      {
        id: 'billing',
        title: 'Billing & Plans',
        icon: '💰',
        questions: [
          {
            q: 'What payment methods do you accept?',
            a: 'We accept all major credit cards, PayPal, and bank transfers for enterprise plans.'
          },
          {
            q: 'Can I upgrade or downgrade my plan?',
            a: 'Yes, you can change your plan at any time. Pro-rated adjustments will be made to your billing.'
          },
          {
            q: 'Do you offer refunds?',
            a: 'We offer a 30-day money-back guarantee for all paid plans.'
          },
          {
            q: 'Can I cancel my subscription?',
            a: 'Yes, you can cancel your subscription at any time from your account settings.'
          }
        ]
      }
    ];
    
    res.json({
      success: true,
      topics,
      timestamp: new Date().toISOString()
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
      <!DOCTYPE html>
      <html>
        <head>
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background: ${type === 'bug' ? '#fef3c7' : type === 'feature' ? '#dbeafe' : '#f0f9ff'}; 
                     color: ${type === 'bug' ? '#92400e' : type === 'feature' ? '#1e40af' : '#0369a1'}; 
                     padding: 20px; border-radius: 8px; }
            .content { background: #f9f9f9; padding: 20px; border-radius: 8px; margin-top: 20px; }
            .rating { font-size: 24px; color: #f59e0b; margin: 10px 0; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h2>${type === 'bug' ? '🐛 Bug Report' : type === 'feature' ? '💡 Feature Request' : '📝 General Feedback'}</h2>
              ${rating ? `<div class="rating">${'★'.repeat(rating)}${'☆'.repeat(5-rating)} (${rating}/5)</div>` : ''}
            </div>
            <div class="content">
              <p><strong>Message:</strong></p>
              <p>${message.replace(/\n/g, '<br>')}</p>
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
                <li>Timestamp: ${new Date().toLocaleString()}</li>
              </ul>
            </div>
          </div>
        </body>
      </html>
    `;
    
    // Send feedback email
    await sendEmail({
      to: process.env.ADMIN_EMAIL,
      subject: `${type === 'bug' ? '[BUG]' : type === 'feature' ? '[FEATURE]' : '[FEEDBACK]'} - ShortLink Pro`,
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

// Emergency contact endpoint (for critical issues)
const emergencyContact = async (req, res) => {
  try {
    const { message, contactEmail, urgency } = req.body;
    
    if (!message || message.trim() === '') {
      return res.status(400).json({
        success: false,
        message: 'Emergency message is required'
      });
    }
    
    // Send emergency email with high priority
    await sendEmail({
      to: process.env.ADMIN_EMAIL,
      subject: `🚨 EMERGENCY - ${urgency || 'High Priority'} Issue - ShortLink Pro`,
      html: `
        <h2>🚨 Emergency Contact Received</h2>
        <p><strong>Urgency:</strong> ${urgency || 'High'}</p>
        <p><strong>Contact Email:</strong> ${contactEmail || 'Not provided'}</p>
        <p><strong>Message:</strong></p>
        <p>${message.replace(/\n/g, '<br>')}</p>
        <hr>
        <p><strong>Timestamp:</strong> ${new Date().toISOString()}</p>
        <p><strong>IP Address:</strong> ${req.ip}</p>
      `
    });
    
    res.json({
      success: true,
      message: 'Emergency message sent to admin. We will contact you shortly.'
    });
    
  } catch (error) {
    console.error('Emergency contact error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to send emergency message'
    });
  }
};

module.exports = {
  sendHelpMessage,
  getHelpTopics,
  submitFeedback,
  emergencyContact
};