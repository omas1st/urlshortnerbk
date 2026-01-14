// config/database.js
// Robust MongoDB connection helper with caching and index sync.
// Will try common environment variables and fall back to a local MongoDB URI for development.

const mongoose = require('mongoose');

// Defensive: load dotenv if not already loaded (harmless if already called)
try {
  // eslint-disable-next-line global-require
  require('dotenv').config();
} catch (e) {
  // ignore
}

// Try multiple common env var names
const envUri = process.env.MONGO_URI || process.env.MONGODB_URI || process.env.MONGO_URL || process.env.MONGO_CONN || null;

// Development fallback (useful when running locally)
const LOCAL_FALLBACK = 'mongodb://127.0.0.1:27017/omsurl';

// Choose URI: prefer env; otherwise fall back (but warn)
const MONGO_URI = envUri || LOCAL_FALLBACK;

if (!envUri) {
  console.warn('⚠️  MONGO_URI / MONGODB_URI not found in environment variables.');
  console.warn(`Using local fallback MongoDB URI: ${LOCAL_FALLBACK}`);
  console.warn('If you meant to connect to Atlas or a remote cluster, set MONGO_URI in your environment or .env file.');
}

/**
 * Global cached connection object to avoid creating many connections
 * (works well for serverless environments and normal servers).
 */
let cached = global._mongooseCache || (global._mongooseCache = {
  conn: null,
  promise: null
});

/**
 * Sync indexes for all registered mongoose models.
 * Using syncIndexes() is safer than createIndexes for existing data.
 */
async function syncAllModelIndexes() {
  try {
    const modelNames = mongoose.modelNames();
    if (!modelNames || modelNames.length === 0) {
      console.log('No mongoose models registered yet; skipping index sync.');
      return;
    }

    for (const name of modelNames) {
      try {
        const model = mongoose.model(name);
        const res = await model.syncIndexes();
        console.log(`✅ Indexes synced for model "${name}":`, Array.isArray(res) ? `${res.length} ops` : JSON.stringify(res));
      } catch (modelErr) {
        console.error(`Error syncing indexes for model "${name}":`, modelErr && modelErr.message ? modelErr.message : modelErr);
      }
    }
  } catch (err) {
    console.error('Index sync overall error:', err && err.message ? err.message : err);
  }
}

/**
 * Connect to MongoDB with caching.
 * Returns the mongoose connection object.
 *
 * NOTE: older options like `useNewUrlParser` and `useUnifiedTopology` are removed
 * because they are no-ops / unsupported in modern Mongoose versions.
 */
async function connectDB() {
  if (cached.conn) {
    // Already connected
    return cached.conn;
  }

  if (!MONGO_URI || typeof MONGO_URI !== 'string' || MONGO_URI.trim() === '') {
    const msg = 'MongoDB connection string is not available. Please set MONGO_URI (or MONGODB_URI) in your environment.';
    console.error('❌', msg);
    throw new Error(msg);
  }

  if (!cached.promise) {
    // modern Mongoose (v6+) does not require useNewUrlParser/useUnifiedTopology flags
    const opts = {
      // Fail fast on server selection so we don't buffer forever
      serverSelectionTimeoutMS: 10000,
      socketTimeoutMS: 45000,
      // Do not buffer commands when not connected (fail fast)
      bufferCommands: false,
      // Prefer IPv4
      family: 4
    };

    // Mask URI in logs for safety, show whether local or remote
    const readableTarget = MONGO_URI.startsWith('mongodb://127.0.0.1') || MONGO_URI.startsWith('mongodb://localhost') ? 'local mongodb (127.0.0.1)' : 'configured MongoDB URI';
    console.log('Attempting MongoDB connection to:', readableTarget);

    cached.promise = mongoose.connect(MONGO_URI, opts)
      .then(async (mongooseInstance) => {
        console.log('✅ MongoDB connected successfully (connectDB).');

        // Sync indexes if models are already registered
        await syncAllModelIndexes();

        return mongooseInstance.connection;
      })
      .catch(err => {
        // Clear promise so subsequent attempts can retry
        cached.promise = null;
        console.error('❌ MongoDB connection failed in connectDB():', err && err.message ? err.message : err);
        // Re-throw so the caller knows the connect failed
        throw err;
      });
  }

  cached.conn = await cached.promise;
  return cached.conn;
}

/**
 * Mongoose connection event handlers (centralized)
 */
mongoose.connection.on('connected', () => {
  console.log('Mongoose connected to DB (event).');
});

mongoose.connection.on('error', (err) => {
  console.error('Mongoose connection error (event):', err && err.message ? err.message : err);
});

mongoose.connection.on('disconnected', () => {
  console.warn('Mongoose disconnected (event).');
});

mongoose.connection.on('reconnected', () => {
  console.log('Mongoose reconnected (event).');
});

/**
 * Export the connect function
 */
module.exports = connectDB;
