// Matrix build stub for legacy WhatsApp Fetcher to keep TypeScript happy.
// This file intentionally avoids importing 'whatsapp-web.js' and provides
// minimal types/APIs used by other parts of the system.

import * as cli from "../cli/ui";

export interface FetchProgress {
  totalContacts: number;
  processedContacts: number;
  totalMessages: number;
  processedMessages: number;
  currentContact: string;
  startTime: Date;
  lastCheckpoint?: {
    contactId: string;
    lastMessageId?: string;
  };
}

export interface FetchOptions {
  batchSize?: number;
  maxRetries?: number;
  maxConcurrentBatches?: number;
  checkpointInterval?: number; // in minutes
  onProgress?: (progress: FetchProgress) => void;
  resumeFrom?: {
    contactId: string;
    lastMessageId?: string;
  };
}

// Kept for compatibility with previous exports
export type EnrichedContact = any;

export class Fetcher {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_client: any, _database: any) {
    // Legacy WhatsApp fetcher disabled in Matrix build
  }

  async enrichContact(contact: any): Promise<any> {
    return contact;
  }

  async enrichMessage(message: any): Promise<any> {
    return message;
  }

  async fetchAllContacts(): Promise<void> {
    cli.printLog("Fetcher.fetchAllContacts() noop (Matrix build)");
  }

  async fetchAllMessages(_nMessages: number = Infinity): Promise<void> {
    cli.printLog("Fetcher.fetchAllMessages() noop (Matrix build)");
  }

  async fetchAllMessagesOneByOne(_nMessages: number = Infinity): Promise<void> {
    cli.printLog("Fetcher.fetchAllMessagesOneByOne() noop (Matrix build)");
  }

  async fetchAllMessagesFromContact(_contactId: string, _nMessages: number = Infinity): Promise<void> {
    cli.printLog("Fetcher.fetchAllMessagesFromContact() noop (Matrix build)");
  }

  async newFetchAllMessages(_nMessages: number = Infinity, _options: FetchOptions = {}): Promise<FetchProgress> {
    cli.printLog("Fetcher.newFetchAllMessages() noop (Matrix build)");
    return {
      totalContacts: 0,
      processedContacts: 0,
      totalMessages: 0,
      processedMessages: 0,
      currentContact: "",
      startTime: new Date()
    };
  }

  async fetchAllMessagesForContact(_contact: any, _nMessages: number): Promise<any[]> {
    return [];
  }
}
