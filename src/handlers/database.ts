// Refactored to Database class

import { MongoClient, Db, Collection, Document } from "mongodb";
import * as cli from "../cli/ui";
import config from "../config";

enum CollectionName {
	Messages = "messages",
	Contacts = "contacts",
	Acknowledgements = "acknowledgements",
	Reactions = "reactions"
}

class Database {
	private readonly dbName: string;
	private readonly uri: string;

	private client: MongoClient | null = null;
	private db: Db | null = null;

	public constructor() {
		this.uri = config.appDatabaseUri;
		this.dbName = config.dbName;
	}

	public async connect(): Promise<Db> {
		if (this.db) {
			return this.db as Db;
		}
		try {
			this.client = await MongoClient.connect(this.uri);
			this.db = this.client.db(this.dbName);
			return this.db as Db;
		} catch (error) {
			cli.printError(`Error connecting to ARC DB. ${error}`);
			throw error;
		}
	}

	public async disconnect(): Promise<void> {
		if (this.client) {
			await this.client.close();
			this.client = null;
			this.db = null; // Is there a db.close or similar method?
		}
	}

	public async upsertContact(contact: any, collection: Collection) {
		if (!contact || !contact.serialId) {
			cli.printError("Invalid or undefined contact provided");
			return;
		}
		try {
			const query = { serialId: contact.serialId };
			const update = { $set: contact };
			const res = await collection.updateOne(query, update, { upsert: true });
			const ns = `${this.dbName}.${collection.collectionName}`;
			const upserted = (res as any)?.upsertedId ? JSON.stringify((res as any).upsertedId) : "none";
			cli.printLog(
				`◇ Upsert contact: ${contact.serialId} → ${ns} (matched:${res.matchedCount}, modified:${res.modifiedCount}, upsertedId:${upserted})`
			);
		} catch (error) {
			cli.printError(`[Error upserting contact] ${error} for contact: ${contact.serialId}`);
		}
	}

	public async upsertReaction(reaction: any, reactionsCollection: Collection) {
		const reactionQuery = { "id.id": reaction.id.id, "msgId._serialized": reaction.msgId._serialized };
		const reactionUpdate = { $set: reaction };
		const paddedID = reaction.id.id;
		const res = await reactionsCollection.updateOne(reactionQuery, reactionUpdate, { upsert: true });
		const ns = `${this.dbName}.${reactionsCollection.collectionName}`;
		const upserted = (res as any)?.upsertedId ? JSON.stringify((res as any).upsertedId) : "none";
		const shouldLog = Boolean((res as any)?.upsertedId) || res.modifiedCount > 0 || res.matchedCount === 0;
		if (shouldLog) {
			cli.printLog(
				`◇ Upsert reaction: ${paddedID} (msgId:${reaction.msgId._serialized}) → ${ns} (matched:${res.matchedCount}, modified:${res.modifiedCount}, upsertedId:${upserted})`
			);
		}
	}

public async upsertMessage(enrichedMessage: any, messageCollection: Collection, fromEvent: string = "fetching_message") {
const msgQuery = { "id.id": enrichedMessage.id.id };
const msgUpdate = { $set: enrichedMessage, $unset: { t: "" } };
const truncatedID = enrichedMessage.id.id;
		const paddedID = truncatedID.padEnd(30, " ");
		const res = await messageCollection.updateOne(msgQuery, msgUpdate, { upsert: true });

		const ns = `${this.dbName}.${messageCollection.collectionName}`;
		const truncatedBody = enrichedMessage.body?.substring(0, 50) || "[no body]";
		const upserted = (res as any)?.upsertedId ? JSON.stringify((res as any).upsertedId) : "none";
		const shouldLog = Boolean((res as any)?.upsertedId) || res.modifiedCount > 0 || res.matchedCount === 0;
		if (shouldLog) {
			cli.printLog(
				`◇ Upsert from event ${fromEvent}: ${paddedID} | Message: ${truncatedBody} → ${ns} (matched:${res.matchedCount}, modified:${res.modifiedCount}, upsertedId:${upserted})`
			);
		}
	}

	public async upsertAck(ackDoc: any, ackCollection: Collection, fromEvent: string = "message_ack") {
		const ackQuery = { messageId: ackDoc.messageId };
		const ackUpdate = { $set: ackDoc };
		const res = await ackCollection.updateOne(ackQuery, ackUpdate, { upsert: true });

		const ns = `${this.dbName}.${ackCollection.collectionName}`;
		const logBody = ackDoc.body?.substring(0, 50) || "[no body]";
		const upserted = (res as any)?.upsertedId ? JSON.stringify((res as any).upsertedId) : "none";
		const shouldLog = Boolean((res as any)?.upsertedId) || res.modifiedCount > 0 || res.matchedCount === 0;
		if (shouldLog) {
			cli.printLog(
				`◇ Upsert ACK from event ${fromEvent}: ${ackDoc.messageId} | Ack: ${ackDoc.ackValue} | Sender: ${ackDoc.senderId} | Target: ${ackDoc.targetId} | Author: ${ackDoc.authorId || "[none]"} | Body: ${logBody} → ${ns} (matched:${res.matchedCount}, modified:${res.modifiedCount}, upsertedId:${upserted})`
			);
		}
	}

	public async reinitialize(): Promise<void> {
		const collectionsToReset = ["contacts", "messages", "reactions", "metadata"];

		try {
			const database = await this.connect();

			for (const collectionName of collectionsToReset) {
				if ((await database.listCollections({ name: collectionName }).toArray()).length > 0) {
					await database.collection(collectionName).drop();
				} else {
					cli.print(`Collection ${collectionName} does not exist. Skipping drop...`);
				}
				await database.createCollection(collectionName);
			}
		} catch (error) {
			cli.printError(`Error occurred: ${error}`);
		}
	}

	public async getCollections(...names: CollectionName[]): Promise<Collection<Document>[]> {
		if (!this.db) {
			throw new Error("Database not connected");
		}
		return names.map((name) => this.db!.collection<Document>(name));
	}
}

export { Database, CollectionName };
