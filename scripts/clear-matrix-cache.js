#!/usr/bin/env node
/**
 * Clear Matrix cache (both local crypto store and MongoDB credentials)
 */

require("dotenv").config();
const mongoose = require("mongoose");
const fs = require("fs");
const path = require("path");

async function clearCache() {
  console.log("🧹 Clearing Matrix cache...");
  
  // 1. Clear local crypto store
  const cryptoDir = path.join(process.cwd(), ".matrix-crypto");
  if (fs.existsSync(cryptoDir)) {
    console.log("📁 Removing local crypto store...");
    fs.rmSync(cryptoDir, { recursive: true, force: true });
    console.log("✅ Local crypto store cleared");
  } else {
    console.log("ℹ️  No local crypto store found");
  }

  // 2. Clear MongoDB credentials
  try {
    const databaseUri = process.env.ARC_DATABASE_URI;
    if (!databaseUri) {
      console.log("⚠️  No ARC_DATABASE_URI found, skipping MongoDB cache clear");
      return;
    }

    const authDatabaseUri = `${databaseUri}/remoteAuth?authSource=admin`;
    console.log("🔌 Connecting to MongoDB...");
    
    await mongoose.connect(authDatabaseUri, {
      serverSelectionTimeoutMS: 5000,
      retryWrites: true
    });

    console.log("✅ Connected to MongoDB");

    // Get collection name prefix
    const appUser = process.env.ARC_USER || "ach9";
    const collectionPrefix = process.env.COLLECTION_NAME_PREFIX || `${appUser.toLowerCase()}MatrixSession`;
    
    console.log(`📦 Using collection prefix: ${collectionPrefix}`);

    // Clear credentials
    const credentialsCollection = `${collectionPrefix}_credentials`;
    console.log(`🗑️  Clearing collection: ${credentialsCollection}`);
    
    const db = mongoose.connection.db;
    const result = await db.collection(credentialsCollection).deleteMany({});
    console.log(`✅ Cleared ${result.deletedCount} credential records`);

    // Clear sync data
    const syncCollection = `${collectionPrefix}_sync`;
    console.log(`🗑️  Clearing collection: ${syncCollection}`);
    
    const syncResult = await db.collection(syncCollection).deleteMany({});
    console.log(`✅ Cleared ${syncResult.deletedCount} sync records`);

    console.log("🎉 Matrix cache cleared successfully!");
    
  } catch (error) {
    console.error("❌ Failed to clear MongoDB cache:", error.message);
  } finally {
    await mongoose.disconnect();
    console.log("🔌 Disconnected from MongoDB");
  }
}

clearCache().catch(console.error);
