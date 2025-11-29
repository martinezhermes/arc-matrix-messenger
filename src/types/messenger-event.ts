// Canonical Messenger Event (CME) types (Phase 2)

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

export interface MessengerEventBase {
  source: string; // messenger source, e.g., "matrix"
  arcUserId: string;  // stable identity (from ARC_USER_ID or WID)
  eventId?: string | null;
  roomId: string;
  senderId: string;
  timestamp: number; // ms epoch
  type: string;
  encrypted: boolean;
  crypto?: CryptoInfo;
  relatesTo?: EventRelation;
  content: any;
  delivery?: any;
  raw?: any;
  ingestedAt?: number;
  updatedAt?: number;
}

export interface MessageEvent extends MessengerEventBase {
  type: 'message';
  content: { body: MessageBody; msgtype?: string; media?: MediaInfo; mentions?: string[]; language?: string };
}

export interface ReactionEvent extends MessengerEventBase {
  type: 'reaction';
  content: { key: string; aggregatable?: boolean };
  relatesTo: EventRelation; // annotation → target message
}

export interface ReceiptEvent extends MessengerEventBase {
  type: 'receipt';
  content: { ack: 'read' | 'delivered' | 'seen'; scope?: 'self' | 'system' | 'user' };
  relatesTo: EventRelation;
}

export type MessengerEvent = MessageEvent | ReactionEvent | ReceiptEvent | MessengerEventBase;

