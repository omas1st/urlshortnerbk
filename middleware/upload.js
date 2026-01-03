const multer = require('multer');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const cloudinary = require('../config/cloudinary').cloudinary;

// Configure Cloudinary storage
const cloudinaryStorage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: 'url_shortener',
    allowed_formats: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'],
    transformation: [{ width: 1200, height: 630, crop: 'limit' }],
    resource_type: 'auto'
  }
});

// Configure memory storage for validation
const memoryStorage = multer.memoryStorage();

// File filter
const fileFilter = (req, file, cb) => {
  // Accept images and PDFs
  const allowedMimeTypes = [
    'image/jpeg',
    'image/jpg',
    'image/png',
    'image/gif',
    'image/webp',
    'image/svg+xml',
    'application/pdf'
  ];
  
  if (allowedMimeTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Invalid file type. Only images and PDFs are allowed.'), false);
  }
};

// Size limits
const limits = {
  fileSize: 5 * 1024 * 1024, // 5MB
  files: 5 // Max 5 files
};

// Create upload instances
const uploadToCloudinary = multer({
  storage: cloudinaryStorage,
  fileFilter,
  limits
});

const uploadToMemory = multer({
  storage: memoryStorage,
  fileFilter,
  limits
});

// Helper to resolve a file url from different multer/cloudinary shapes
const resolveFileUrlFromReqFile = (file) => {
  if (!file) return null;

  // multer-storage-cloudinary often sets `path` to the final url
  if (file.path && typeof file.path === 'string') return file.path;

  // cloudinary SDK result sometimes exposes `secure_url` or `url`
  if (file.secure_url && typeof file.secure_url === 'string') return file.secure_url;
  if (file.url && typeof file.url === 'string') return file.url;

  // some libs use `location` or `publicUrl` or `filename`
  if (file.location && typeof file.location === 'string') return file.location;
  if (file.publicUrl && typeof file.publicUrl === 'string') return file.publicUrl;
  if (file.public_url && typeof file.public_url === 'string') return file.public_url;

  // Fallback: sometimes multer field has `destination` + `filename` (local disk)
  if (file.destination && file.filename) {
    return path.join(file.destination, file.filename);
  }

  return null;
};

// Middleware for single file upload
const uploadSingle = (fieldName) => {
  return (req, res, next) => {
    const upload = uploadToCloudinary.single(fieldName);
    
    upload(req, res, (err) => {
      if (err) {
        return res.status(400).json({
          success: false,
          message: err.message
        });
      }
      
      if (req.file) {
        // Prefer a resolved absolute URL where possible
        const resolved = resolveFileUrlFromReqFile(req.file);
        req.body[fieldName] = resolved || req.file.path || req.file.secure_url || req.file.url || null;
      }
      
      next();
    });
  };
};

// Middleware for multiple file upload
const uploadMultiple = (fieldName, maxCount = 5) => {
  return (req, res, next) => {
    const upload = uploadToCloudinary.array(fieldName, maxCount);
    
    upload(req, res, (err) => {
      if (err) {
        return res.status(400).json({
          success: false,
          message: err.message
        });
      }
      
      if (req.files && req.files.length > 0) {
        req.body[fieldName] = req.files.map(file => {
          return resolveFileUrlFromReqFile(file) || file.path || file.secure_url || file.url || null;
        }).filter(Boolean);
      }
      
      next();
    });
  };
};

// Middleware for memory storage (for processing before upload)
const uploadToBuffer = (fieldName) => {
  return (req, res, next) => {
    const upload = uploadToMemory.single(fieldName);
    
    upload(req, res, (err) => {
      if (err) {
        return res.status(400).json({
          success: false,
          message: err.message
        });
      }
      
      next();
    });
  };
};

// Process and upload file from buffer
const processAndUpload = async (fileBuffer, fileName, folder = 'url_shortener') => {
  try {
    const { uploadToCloudinary } = require('../config/cloudinary');
    const result = await uploadToCloudinary(fileBuffer, folder);
    
    return {
      url: result.secure_url,
      publicId: result.public_id,
      format: result.format,
      size: result.bytes,
      width: result.width,
      height: result.height
    };
  } catch (error) {
    console.error('Error processing and uploading file:', error);
    throw new Error('Failed to upload file');
  }
};

// Delete file from Cloudinary
const deleteFile = async (publicId) => {
  try {
    const { deleteFromCloudinary } = require('../config/cloudinary');
    await deleteFromCloudinary(publicId);
    return true;
  } catch (error) {
    console.error('Error deleting file:', error);
    throw new Error('Failed to delete file');
  }
};

// Validate image dimensions
const validateImageDimensions = (minWidth, minHeight) => {
  return async (req, res, next) => {
    try {
      if (!req.file) {
        return next();
      }
      
      // For Cloudinary uploads, we need to check after upload
      // This would be better implemented with a pre-upload validation
      next();
    } catch (error) {
      res.status(400).json({
        success: false,
        message: 'Image validation failed'
      });
    }
  };
};

// Compress image before upload
const compressImage = (quality = 80) => {
  return async (req, res, next) => {
    try {
      if (!req.file || !req.file.mimetype.startsWith('image/')) {
        return next();
      }
      
      // This would use a library like sharp or jimp
      // For now, we'll pass through and let Cloudinary handle compression
      next();
    } catch (error) {
      console.error('Image compression error:', error);
      next(); // Continue even if compression fails
    }
  };
};

module.exports = {
  uploadSingle,
  uploadMultiple,
  uploadToBuffer,
  processAndUpload,
  deleteFile,
  validateImageDimensions,
  compressImage,
  uploadToCloudinary,
  uploadToMemory
};
