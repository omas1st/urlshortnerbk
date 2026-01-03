const crypto = require('crypto');

// Generate short ID
const generateShortId = (length = 6) => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  
  for (let i = 0; i < length; i++) {
    const randomIndex = crypto.randomInt(0, chars.length);
    result += chars.charAt(randomIndex);
  }
  
  return result;
};

// Validate URL
const isValidUrl = (urlString) => {
  try {
    const url = new URL(urlString);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch (err) {
    return false;
  }
};

// Format number with commas
const formatNumber = (num) => {
  return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
};

// Format date
const formatDate = (date, format = 'short') => {
  const d = new Date(date);
  
  if (format === 'short') {
    return d.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    });
  } else if (format === 'long') {
    return d.toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  } else if (format === 'relative') {
    const now = new Date();
    const diff = now - d;
    const diffMinutes = Math.floor(diff / 60000);
    const diffHours = Math.floor(diff / 3600000);
    const diffDays = Math.floor(diff / 86400000);
    
    if (diffMinutes < 1) return 'Just now';
    if (diffMinutes < 60) return `${diffMinutes}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`;
    if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo ago`;
    return `${Math.floor(diffDays / 365)}y ago`;
  }
  
  return d.toISOString();
};

// Get time range dates
const getTimeRangeDates = (range) => {
  const now = new Date();
  let startDate;
  
  switch (range) {
    case 'today':
      startDate = new Date(now.setHours(0, 0, 0, 0));
      break;
    case 'yesterday':
      startDate = new Date(now.setDate(now.getDate() - 1));
      startDate.setHours(0, 0, 0, 0);
      const endDate = new Date(startDate);
      endDate.setDate(endDate.getDate() + 1);
      return { startDate, endDate };
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
      startDate = new Date(0); // All time
  }
  
  return { startDate, endDate: new Date() };
};

// Calculate percentage change
const calculatePercentageChange = (oldValue, newValue) => {
  if (oldValue === 0) {
    return newValue > 0 ? 100 : 0;
  }
  
  const change = ((newValue - oldValue) / oldValue) * 100;
  return parseFloat(change.toFixed(2));
};

// Generate password hash
const hashPassword = async (password) => {
  const bcrypt = require('bcryptjs');
  const salt = await bcrypt.genSalt(12);
  return await bcrypt.hash(password, salt);
};

// Verify password
const verifyPassword = async (password, hash) => {
  const bcrypt = require('bcryptjs');
  return await bcrypt.compare(password, hash);
};

// Sanitize string
const sanitizeString = (str) => {
  if (typeof str !== 'string') return str;
  
  return str
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/javascript:/gi, '')
    .replace(/on\w+="[^"]*"/gi, '')
    .replace(/on\w+='[^']*'/gi, '')
    .replace(/on\w+=\w+/gi, '')
    .trim();
};

// Truncate string
const truncateString = (str, length = 50) => {
  if (!str) return '';
  if (str.length <= length) return str;
  return str.substring(0, length) + '...';
};

// Generate random color
const generateRandomColor = () => {
  const colors = [
    '#FF6B6B', '#4ECDC4', '#FFD166', '#06D6A0', '#118AB2',
    '#EF476F', '#FFD166', '#06D6A0', '#118AB2', '#073B4C',
    '#7209B7', '#3A86FF', '#FB5607', '#8338EC', '#FF006E'
  ];
  return colors[Math.floor(Math.random() * colors.length)];
};

// Get device type from user agent
const getDeviceType = (userAgent) => {
  if (!userAgent) return 'desktop';
  
  const ua = userAgent.toLowerCase();
  
  if (/mobile|android|iphone|ipod/.test(ua)) {
    return 'mobile';
  } else if (/tablet|ipad/.test(ua)) {
    return 'tablet';
  } else {
    return 'desktop';
  }
};

// Get country from IP (mock - in production use a geoip service)
const getCountryFromIP = (ip) => {
  // This is a simple mock. In production, use a service like geoip-lite
  const ipToCountry = {
    '127.0.0.1': 'US',
    '::1': 'US'
  };
  
  return ipToCountry[ip] || 'US';
};

// Debounce function
const debounce = (func, wait) => {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
};

// Throttle function
const throttle = (func, limit) => {
  let inThrottle;
  return function executedFunction(...args) {
    if (!inThrottle) {
      func(...args);
      inThrottle = true;
      setTimeout(() => inThrottle = false, limit);
    }
  };
};

// Parse query string to object
const parseQueryString = (queryString) => {
  if (!queryString) return {};
  
  return queryString.split('&').reduce((acc, pair) => {
    const [key, value] = pair.split('=');
    if (key) {
      acc[decodeURIComponent(key)] = decodeURIComponent(value || '');
    }
    return acc;
  }, {});
};

// Convert object to query string
const toQueryString = (obj) => {
  return Object.keys(obj)
    .map(key => `${encodeURIComponent(key)}=${encodeURIComponent(obj[key])}`)
    .join('&');
};

// Deep clone object
const deepClone = (obj) => {
  return JSON.parse(JSON.stringify(obj));
};

// Check if object is empty
const isEmpty = (obj) => {
  return Object.keys(obj).length === 0;
};

// Sleep function
const sleep = (ms) => {
  return new Promise(resolve => setTimeout(resolve, ms));
};

// Validate email
const isValidEmail = (email) => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
};

// Validate password strength
const validatePasswordStrength = (password) => {
  const requirements = {
    length: password.length >= 8,
    lowercase: /[a-z]/.test(password),
    uppercase: /[A-Z]/.test(password),
    number: /\d/.test(password),
    special: /[!@#$%^&*(),.?":{}|<>]/.test(password)
  };
  
  const strength = Object.values(requirements).filter(Boolean).length;
  
  return {
    requirements,
    strength,
    score: (strength / 5) * 100,
    isValid: requirements.length && requirements.lowercase && 
              requirements.uppercase && requirements.number
  };
};

// Format file size
const formatFileSize = (bytes) => {
  if (bytes === 0) return '0 Bytes';
  
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

// Get file extension
const getFileExtension = (filename) => {
  return filename.split('.').pop().toLowerCase();
};

// Generate unique filename
const generateUniqueFilename = (originalName) => {
  const ext = getFileExtension(originalName);
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 15);
  return `${timestamp}_${random}.${ext}`;
};

module.exports = {
  generateShortId,
  isValidUrl,
  formatNumber,
  formatDate,
  getTimeRangeDates,
  calculatePercentageChange,
  hashPassword,
  verifyPassword,
  sanitizeString,
  truncateString,
  generateRandomColor,
  getDeviceType,
  getCountryFromIP,
  debounce,
  throttle,
  parseQueryString,
  toQueryString,
  deepClone,
  isEmpty,
  sleep,
  isValidEmail,
  validatePasswordStrength,
  formatFileSize,
  getFileExtension,
  generateUniqueFilename
};