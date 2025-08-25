import mongoose from "mongoose";
import { MemoryStore } from "matrix-js-sdk";
import * as cli from "../cli/ui";

interface MatrixStoreOptions {
  mongoose: typeof mongoose;
  collectionNamePrefix: string;
}

interface StoredCredentials {
  accessToken: string;
  deviceId: string;
  userId: string;
}

export class MatrixMongoStore {
  private mongoose: typeof mongoose;
  private collectionNamePrefix: string;
  private store: MemoryStore;

  constructor(options: MatrixStoreOptions) {
    this.mongoose = options.mongoose;
    this.collectionNamePrefix = options.collectionNamePrefix;
    this.store = new MemoryStore();
  }

  /**
   * Get the Matrix SDK store instance
   */
  getStore(): MemoryStore {
    return this.store;
  }

  /**
   * Store Matrix credentials in MongoDB
   */
  async storeCredentials(accessToken: string, deviceId: string, userId?: string): Promise<void> {
    try {
      if (!this.mongoose.connection.db) {
        throw new Error("Database connection not available");
      }
      const collection = this.mongoose.connection.db.collection(`${this.collectionNamePrefix}_credentials`);

      const credentials: StoredCredentials = {
        accessToken,
        deviceId,
        userId: userId || "default"
      };

      await collection.replaceOne({ userId: credentials.userId }, credentials, { upsert: true });

      cli.printLog(`Matrix credentials stored for ${credentials.userId}`);
    } catch (error) {
      cli.printError(`Failed to store Matrix credentials: ${error}`);
      throw error;
    }
  }

  /**
   * Retrieve stored Matrix credentials from MongoDB
   */
  async getStoredCredentials(userId?: string): Promise<StoredCredentials | null> {
    try {
      if (!this.mongoose.connection.db) {
        throw new Error("Database connection not available");
      }
      const collection = this.mongoose.connection.db.collection(`${this.collectionNamePrefix}_credentials`);

      const result = await collection.findOne({
        userId: userId || "default"
      } as any);
      const credentials = result ? (result as unknown as StoredCredentials) : null;

      if (credentials) {
        cli.printLog(`Matrix credentials found for ${credentials.userId}`);
        return credentials;
      } else {
        cli.printLog(`No Matrix credentials found for ${userId || "default"}`);
        return null;
      }
    } catch (error) {
      cli.printError(`Failed to retrieve Matrix credentials: ${error}`);
      return null;
    }
  }

  /**
   * Clear stored credentials
   */
  async clearCredentials(userId?: string): Promise<void> {
    try {
      if (!this.mongoose.connection.db) {
        throw new Error("Database connection not available");
      }
      const collection = this.mongoose.connection.db.collection(`${this.collectionNamePrefix}_credentials`);

      await collection.deleteOne({ userId: userId || "default" } as any);
      cli.printLog(`Matrix credentials cleared for ${userId || "default"}`);
    } catch (error) {
      cli.printError(`Failed to clear Matrix credentials: ${error}`);
      throw error;
    }
  }

  /**
   * Store sync state data
   */
  async storeSyncData(data: any): Promise<void> {
    try {
      if (!this.mongoose.connection.db) {
        throw new Error("Database connection not available");
      }
      const collection = this.mongoose.connection.db.collection(`${this.collectionNamePrefix}_sync`);

      await collection.replaceOne(
        { _id: "sync_state" } as any,
        { _id: "sync_state", data, updatedAt: new Date() },
        { upsert: true }
      );

      cli.printLog("Matrix sync state stored");
    } catch (error) {
      cli.printError(`Failed to store sync data: ${error}`);
      // Don't throw here as sync state is not critical
    }
  }

  /**
   * Retrieve sync state data
   */
  async getSyncData(): Promise<any | null> {
    try {
      if (!this.mongoose.connection.db) {
        throw new Error("Database connection not available");
      }
      const collection = this.mongoose.connection.db.collection(`${this.collectionNamePrefix}_sync`);

      const result = await collection.findOne({ _id: "sync_state" } as any);
      return result?.data || null;
    } catch (error) {
      cli.printError(`Failed to retrieve sync data: ${error}`);
      return null;
    }
  }
}
