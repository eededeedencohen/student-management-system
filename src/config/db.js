import mongoose from 'mongoose';

/**
 * Builds the MongoDB connection string.
 * Supports the classic pattern where DATABASE contains a `<PASSWORD>` placeholder
 * that is substituted with DATABASE_PASSWORD. Falls back to MONGODB_URI if present.
 */
export const buildMongoUri = () => {
  const { DATABASE, DATABASE_PASSWORD, MONGODB_URI } = process.env;
  if (MONGODB_URI) return MONGODB_URI;
  if (!DATABASE) {
    throw new Error('Missing DATABASE (or MONGODB_URI) in environment / .env');
  }
  return DATABASE.replace('<PASSWORD>', encodeURIComponent(DATABASE_PASSWORD || ''));
};

export const connectDB = async () => {
  const uri = buildMongoUri();
  mongoose.set('strictQuery', true);
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 20000 });
  const { host, name } = mongoose.connection;
  console.log(`✅  MongoDB connected → ${host}/${name}`);
  return mongoose.connection;
};

export const disconnectDB = async () => {
  await mongoose.disconnect();
};

export default connectDB;
