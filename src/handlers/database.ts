// Refactored to Database class

import { MongoClient, Db, Collection, Document } from "mongodb";
import * as cli from "../cli/ui";
import config from "../config";

enum CollectionName {
	Messages = "messages",
	Contacts = "contacts",
	Acknowledgements = "acknowledgements",
	Reactions = "reactions",
  Events = "events"
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

  // Canonical Messenger Event insert (append-only for now)
  public async insertCanonicalEvent(event: any, eventsCollection: Collection) {
    try {
      const now = Date.now();
      const filter: any = {};
      if (event?.eventId && typeof event.eventId === 'string') {
        filter.source = event.source;
        filter.arcUserId = event.arcUserId;
        filter.eventId = event.eventId;
      } else if (event?.type === 'receipt') {
        filter.source = event.source;
        filter.arcUserId = event.arcUserId;
        filter.type = 'receipt';
        filter.roomId = event.roomId;
        filter.senderId = event.senderId;
        if (event?.relatesTo?.eventId) filter['relatesTo.eventId'] = event.relatesTo.eventId;
      } else {
        // Fallback (rare): use a composite that should remain stable
        filter.source = event.source;
        filter.arcUserId = event.arcUserId;
        filter.type = event.type;
        filter.roomId = event.roomId;
        filter.senderId = event.senderId;
        filter.timestamp = event.timestamp;
      }

      const update = {
        $setOnInsert: { ingestedAt: now, ingestedAtDate: new Date(now) },
        $set: { ...event, updatedAt: now }
      };

      await eventsCollection.updateOne(filter, update, { upsert: true });
      const ns = `${this.dbName}.${eventsCollection.collectionName}`;
      const eType = String(event?.type || 'unknown');
      let logId = String(event?.eventId || 'n/a');
      if (eType === 'receipt' && event?.relatesTo?.eventId) {
        logId = `n/a (target: ${event.relatesTo.eventId})`;
      }
      cli.printLog(`◇ Upsert CME: type=${eType} eventId=${logId} → ${ns}`);
    } catch (error) {
      cli.printError(`[Error upserting CME] ${error}`);
    }
  }

  // Backfill checkpoint helpers
  public async getBackfillState(arcUserId: string, roomId: string): Promise<{ lastTs?: number } | null> {
    const db = await this.connect();
    const col = db.collection("backfill_state");
    const doc = await col.findOne({ arcUserId, roomId } as any);
    return (doc as any) || null;
  }

  public async upsertBackfillState(arcUserId: string, roomId: string, lastTs: number): Promise<void> {
    const db = await this.connect();
    const col = db.collection("backfill_state");
    await col.updateOne(
      { arcUserId, roomId } as any,
      { $set: { arcUserId, roomId, lastTs, updatedAt: new Date() } },
      { upsert: true }
    );
  }

  public async ensureEventsIndexes(options?: { ttlReceiptsDays?: number; ttlTypingDays?: number }): Promise<void> {
    try {
      const db = await this.connect();
      const col = db.collection("events");

      // Drop legacy indexes if exist (appId -> arcUserId migration)
      const legacyIndexes = ["uniq_event", "room_timeline", "sender_timeline", "rel_event", "type_time", "uniq_receipt"];
      for (const indexName of legacyIndexes) {
        try {
          await col.dropIndex(indexName);
          cli.printLog(`◇ Dropped legacy ${indexName} index (appId-based)`);
        } catch (dropErr) {
          if ((dropErr as any).codeName !== "IndexNotFound") {
            cli.printWarning(`[events:index] Drop ${indexName} failed: ${dropErr}`);
          }
        }
      }

      await col.createIndex(
        { source: 1, arcUserId: 1, eventId: 1 },
        { name: "uniq_event", unique: true, partialFilterExpression: { eventId: { $type: "string" } } }
      );
      await col.createIndex({ arcUserId: 1, roomId: 1, timestamp: 1, _id: 1 }, { name: "room_timeline" });
      await col.createIndex({ arcUserId: 1, senderId: 1, timestamp: 1 }, { name: "sender_timeline" });
      await col.createIndex({ arcUserId: 1, "relatesTo.eventId": 1, timestamp: 1 }, { name: "rel_event" });
      await col.createIndex({ arcUserId: 1, type: 1, timestamp: 1 }, { name: "type_time" });
      await col.createIndex(
        { source: 1, arcUserId: 1, type: 1, roomId: 1, senderId: 1, "relatesTo.eventId": 1 },
        { name: "uniq_receipt", unique: true, partialFilterExpression: { type: "receipt" } }
      );

      if (options?.ttlReceiptsDays && options.ttlReceiptsDays > 0) {
        await col.createIndex(
          { ingestedAtDate: 1 },
          {
            name: "ttl_receipts",
            expireAfterSeconds: Math.floor(options.ttlReceiptsDays * 24 * 60 * 60),
            partialFilterExpression: { type: "receipt" }
          }
        );
      }
      if (options?.ttlTypingDays && options.ttlTypingDays > 0) {
        await col.createIndex(
          { ingestedAtDate: 1 },
          {
            name: "ttl_typing",
            expireAfterSeconds: Math.floor(options.ttlTypingDays * 24 * 60 * 60),
            partialFilterExpression: { type: "typing" }
          }
        );
      }

      cli.printLog("◇ Ensured indexes on events collection");
    } catch (e) {
      cli.printError(`[events:index] ${e}`);
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
