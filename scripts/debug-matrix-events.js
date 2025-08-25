#!/usr/bin/env node

/**
 * Debug Matrix Events Script
 * Shows all Matrix events being received in real-time
 */

const { createClient } = require('matrix-js-sdk');
require('dotenv').config();

console.log('🔍 Matrix Event Debug Script\n');

if (!process.env.MATRIX_HOMESERVER || !process.env.MATRIX_USER_ID || !process.env.MATRIX_PASSWORD) {
  console.log('❌ Missing Matrix configuration. Please check your .env file has:');
  console.log('   MATRIX_HOMESERVER=...');
  console.log('   MATRIX_USER_ID=...');
  console.log('   MATRIX_PASSWORD=...');
  process.exit(1);
}

async function debugMatrixEvents() {
  const client = createClient({
    baseUrl: process.env.MATRIX_HOMESERVER,
    userId: process.env.MATRIX_USER_ID
  });

  // Login
  console.log('🔐 Logging in to Matrix...');
  try {
    await client.login("m.login.password", {
      user: process.env.MATRIX_USER_ID,
      password: process.env.MATRIX_PASSWORD
    });
    console.log('✅ Matrix login successful');
  } catch (error) {
    console.log('❌ Matrix login failed:', error.message);
    process.exit(1);
  }

  // Debug all events
  console.log('📡 Listening for Matrix events...\n');

  // Timeline events (messages, reactions, etc.)
  client.on('Room.timeline', (event, room, toStartOfTimeline) => {
    if (toStartOfTimeline) return;

    const eventType = event.getType();
    const sender = event.getSender();
    const content = event.getContent();
    const timestamp = new Date(event.getTs()).toISOString();
    
    console.log(`🔔 TIMELINE EVENT:`, {
      type: eventType,
      sender: sender,
      room: room.name || room.roomId,
      timestamp: timestamp,
      content: JSON.stringify(content, null, 2)
    });
    
    if (eventType === 'm.room.message') {
      console.log(`📨 MESSAGE: "${content.body}" from ${sender}`);
    } else if (eventType === 'm.reaction') {
      console.log(`😀 REACTION: ${content['m.relates_to']?.key} from ${sender}`);
    }
    console.log('---');
  });

  // Sync events
  client.on('sync', (state, prevState) => {
    console.log(`🔄 SYNC STATE: ${state} (previous: ${prevState})`);
    if (state === 'PREPARED') {
      console.log('✅ Matrix client ready - listening for events...');
      
      // List rooms for debugging
      const rooms = client.getRooms();
      console.log(`📂 Joined rooms (${rooms.length}):`);
      rooms.forEach(room => {
        const members = room.getMembers().length;
        console.log(`  - ${room.name || room.roomId} (${members} members)`);
      });
      console.log('');
    }
  });

  // Room events
  client.on('Room.myMembership', (room, membership, prevMembership) => {
    console.log(`🏠 ROOM MEMBERSHIP: ${membership} in ${room.name || room.roomId}`);
  });

  // Error events
  client.on('sync.unexpectedError', (error) => {
    console.log('❌ SYNC ERROR:', error.message);
  });

  // Start the client
  await client.startClient();
  
  console.log('🚀 Matrix client started. Send messages to see events...');
}

// Handle cleanup
process.on('SIGINT', () => {
  console.log('\n👋 Shutting down Matrix debug...');
  process.exit(0);
});

debugMatrixEvents().catch(error => {
  console.log('💥 Debug script error:', error.message);
  process.exit(1);
});
