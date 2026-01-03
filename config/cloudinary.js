const cloudinary = require('cloudinary').v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true
});

// Function to upload image to Cloudinary
const uploadToCloudinary = async (fileBuffer, folder = 'url_shortener') => {
  return new Promise((resolve, reject) => {
    cloudinary.uploader.upload_stream(
      {
        folder: folder,
        resource_type: 'auto',
        transformation: [
          { width: 1200, height: 630, crop: 'limit' },
          { quality: 'auto' },
          { fetch_format: 'auto' }
        ]
      },
      (error, result) => {
        if (error) reject(error);
        else resolve(result);
      }
    ).end(fileBuffer);
  });
};

// Function to delete image from Cloudinary
const deleteFromCloudinary = async (publicId) => {
  try {
    const result = await cloudinary.uploader.destroy(publicId);
    return result;
  } catch (error) {
    console.error('Error deleting from Cloudinary:', error);
    throw error;
  }
};

// Function to upload multiple images
const uploadMultipleToCloudinary = async (files, folder = 'url_shortener') => {
  const uploadPromises = files.map(file => 
    uploadToCloudinary(file.buffer, folder)
  );
  return Promise.all(uploadPromises);
};

module.exports = {
  cloudinary,
  uploadToCloudinary,
  deleteFromCloudinary,
  uploadMultipleToCloudinary
};