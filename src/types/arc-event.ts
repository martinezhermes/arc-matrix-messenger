export type SigRef =
	| string // "mongo://cluster/primaryDb#collection:sessionId?authDb=remoteAuth"
	| {
			scheme: "mongo";
			cluster?: string; // e.g. "arcRecursiveCore"
			database: string; // "ach9WhatsappHistory" | "ach9WhatsappSession"
			collection: string; // "messages" | "reactions" | "acks"
			sessionId: string; // "33781234567@c.us"
			authDatabase?: string; // "remoteAuth"
	  };

export interface ArcEvent {
	origin: string; // "whatsapp:<jid>"
	signature: SigRef; // REQUIRED
	sender: string;
	author: string;
	recipient: string;
	content: unknown;
	type: string; // "message" | "reaction" | ...
	appId: string; // exact host id (with @c.us)
	timestamp: number;

	source?: string; // "whatsapp"
	topic?: string | null; // "_" for MVP
	_id?: string;

	v?: 1;
	traceId?: string;
	causationId?: string;
	correlationId?: string;
	ackPolicy?: "at-least-once";
	ttlMs?: number;
}
