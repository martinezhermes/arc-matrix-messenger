import { Mongoose } from "mongoose";
import fs from "fs";

export interface MongoStoreOptions {
	mongoose: Mongoose;
	collectionNamePrefix?: string;
}

export class MongoStore {
	private mongoose: Mongoose;
	private collectionNamePrefix: string;

	constructor({ mongoose, collectionNamePrefix = "whatsapp" }: MongoStoreOptions) {
		if (!mongoose) throw new Error("A valid Mongoose instance is required for MongoStore.");
		this.mongoose = mongoose;
		this.collectionNamePrefix = collectionNamePrefix;
	}

	private getCollectionName(session: string): string {
		return `${this.collectionNamePrefix}-${session}.files`;
	}

	async sessionExists(options: any) {
		if (!this.mongoose.connection.db) {
			throw new Error("Database connection not established");
		}
		const collectionName = this.getCollectionName(options.session);
		const multiDeviceCollection = this.mongoose.connection.db.collection(collectionName);
		if (!multiDeviceCollection) {
			throw new Error("Collection not found");
		}
		const hasExistingSession = await multiDeviceCollection.countDocuments();
		return !!hasExistingSession;
	}

	async save(options: any) {
		if (!this.mongoose.connection.db) {
			throw new Error("Database connection not established");
		}
		const bucketName = `${this.collectionNamePrefix}-${options.session}`;
		const bucket = new this.mongoose.mongo.GridFSBucket(this.mongoose.connection.db, {
			bucketName: bucketName
		});
		await new Promise<void>((resolve, reject) => {
			fs.createReadStream(`${options.session}.zip`)
				.pipe(bucket.openUploadStream(`${options.session}.zip`))
				.on("error", (err) => reject(err))
				.on("close", () => resolve(undefined)); // Pass undefined to resolve
		});
		options.bucket = bucket;
		await this.deletePrevious(options);
	}

	async extract(options: any) {
		if (!this.mongoose.connection.db) {
			throw new Error("Database connection not established");
		}
		const bucketName = `${this.collectionNamePrefix}-${options.session}`;
		const bucket = new this.mongoose.mongo.GridFSBucket(this.mongoose.connection.db, {
			bucketName: bucketName
		});
		return new Promise<void>((resolve, reject) => {
			bucket
				.openDownloadStreamByName(`${options.session}.zip`)
				.pipe(fs.createWriteStream(options.path))
				.on("error", (err) => reject(err))
				.on("close", () => resolve(undefined)); // Pass undefined to resolve
		});
	}

	async delete(options: any) {
		if (!this.mongoose.connection.db) {
			throw new Error("Database connection not established");
		}
		const bucketName = `${this.collectionNamePrefix}-${options.session}`;
		const bucket = new this.mongoose.mongo.GridFSBucket(this.mongoose.connection.db, {
			bucketName: bucketName
		});
		const documents = await bucket
			.find({
				filename: `${options.session}.zip`
			})
			.toArray();

		documents.map(async (doc) => {
			return bucket.delete(doc._id);
		});
	}

	private async deletePrevious(options: any) {
		const documents = await options.bucket
			.find({
				filename: `${options.session}.zip`
			})
			.toArray();
		if (documents.length > 1) {
			const oldSession = documents.reduce((a, b) => (a.uploadDate < b.uploadDate ? a : b));
			return options.bucket.delete(oldSession._id);
		}
	}
}
