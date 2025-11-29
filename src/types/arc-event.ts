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

export interface EventRelation {
  eventId?: string;
  roomId?: string;
  relationType?: string; // annotation | replace | redaction | reference
}

export interface MessageBody {
  text?: string;
  html?: string;
  formatted?: boolean;
}

export interface MediaInfo {
  url?: string;
  mime?: string;
  size?: number;
  name?: string;
}

export interface CryptoInfo {
  algorithm?: string;
  sessionId?: string;
  senderKey?: string;
}

export interface ArcEvent {
  // Messenger-focused core (like MessengerEventBase)
  source: string; // REQUIRED: e.g., "matrix" or "whatsapp"
  arcUserId: string; // Stable app/host ID (e.g., "@ach9:endurance.network")
  eventId?: string | null; // Unique event ID (e.g., Matrix $event:server)
  roomId?: string; // Chat/room ID (e.g., "!room:server" for Matrix, group@g.us for WA)
  senderId?: string; // Sender ID (e.g., "@user:server" for Matrix; aligns with sender)
  timestamp: number; // ms epoch (higher precision)
  type: string; // e.g., "message" | "reaction" | "receipt"
  encrypted?: boolean; // E2EE flag
  crypto?: CryptoInfo; // E2EE details
  relatesTo?: EventRelation; // Threading/relations (e.g., for reactions)
  content: unknown; // Payload (typed in subtypes)
  delivery?: any; // Delivery status (e.g., ack/read)
  raw?: any; // Raw SDK event for debugging
  ingestedAt?: number; // Ingestion timestamp (ms)
  updatedAt?: number; // Last update timestamp (ms)

  origin?: string; // e.g., "matrix:@user:server" (derive from source + senderId if missing)
  signature?: SigRef; // DB reference (optional; required for persistence)

  // Tracing/Envelope (merged)
  v?: 1; // Schema version
  traceId?: string;
  causationId?: string;
  correlationId?: string;
  ackPolicy?: "at-least-once"; // Delivery guarantee
  ttlMs?: number; // Time-to-live (ms)
  platform?: string; // e.g., "matrix" (derive from source)
}
