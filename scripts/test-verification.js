#!/usr/bin/env node

// Test script to debug Matrix verification flow
const { createClient } = require('matrix-js-sdk');
const Olm = require('@matrix-org/olm');
const { LocalStorage } = require('node-localstorage');
const { LocalStorageCryptoStore } = require('matrix-js-sdk/lib/crypto/store/localStorage-crypto-store');
const readline = require('readline');

// Initialize Olm
(async () => {
  await Olm.init();
  global.Olm = Olm;
  
  console.log('Olm initialized');
  
  // Create readline interface
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  
  // Read config from environment
  const config = {
    homeserver: process.env.MATRIX_HOMESERVER || 'https://matrix.endurance.network',
    userId: process.env.MATRIX_USER_ID || '@ach9:endurance.network',
    password: process.env.MATRIX_USER_PASSWORD,
    deviceName: process.env.MATRIX_CLIENT_DEVICE_NAME || 'Test Verification Device'
  };
  
  console.log(`Creating client for ${config.userId} on ${config.homeserver}`);
  
  // Create crypto store
  const cryptoStore = new LocalStorageCryptoStore(new LocalStorage('.test-matrix-crypto'));
  
  // Create client
  const client = createClient({
    baseUrl: config.homeserver,
    userId: config.userId,
    cryptoStore: cryptoStore
  });
  
  // Login
  console.log('Logging in...');
  const loginResponse = await client.login('m.login.password', {
    user: config.userId,
    password: config.password,
    initial_device_display_name: config.deviceName
  });
  
  console.log(`Logged in with device ID: ${loginResponse.device_id}`);
  
  // Initialize crypto
  console.log('Initializing crypto...');
  await client.initCrypto();
  console.log('Crypto initialized');
  
  // Track active verification
  let activeVerifier = null;
  let activeSas = null;
  
  // Set up verification handlers
  client.on('crypto.verification.request', async (request) => {
    console.log('\n=== VERIFICATION REQUEST RECEIVED ===');
    console.log('From:', request.userId || request.sender);
    console.log('Device:', request.requestingDeviceId || request.fromDevice);
    console.log('Methods:', request.methods || request.getAvailableVerificationMethods?.());
    console.log('Request object keys:', Object.keys(request));
    
    try {
      // Accept the request
      console.log('Accepting verification request...');
      if (request.accept) {
        await request.accept();
        console.log('Request accepted');
      }
      
      // Start SAS verification
      console.log('Starting SAS verification...');
      let verifier;
      if (request.startVerification) {
        verifier = await request.startVerification('m.sas.v1');
      } else if (request.beginKeyVerification) {
        verifier = await request.beginKeyVerification('m.sas.v1');
      }
      
      if (!verifier) {
        console.error('Failed to start verifier!');
        return;
      }
      
      console.log('Verifier started, setting up event handlers...');
      activeVerifier = verifier;
      
      // Handle show_sas event
      verifier.on('show_sas', async (ev) => {
        console.log('\n=== SAS DISPLAYED ===');
        console.log('Event object keys:', Object.keys(ev));
        activeSas = ev;
        
        const decimals = ev.decimal || ev.sas?.decimal || ev.getDecimal?.();
        const emojis = ev.emoji || ev.sas?.emoji || ev.getEmoji?.();
        
        if (decimals) {
          console.log('Decimals:', decimals.join(' '));
        }
        if (emojis) {
          console.log('Emojis:', emojis.map(e => Array.isArray(e) ? e[0] : e).join(' '));
        }
        
        // Ask user to confirm
        rl.question('\nDo the numbers/emoji match? (y/n): ', async (answer) => {
          if (answer.toLowerCase() === 'y') {
            console.log('Confirming SAS...');
            try {
              // Try different ways to confirm
              if (ev.confirm) {
                console.log('Using ev.confirm()');
                await ev.confirm();
              } else if (verifier.confirm) {
                console.log('Using verifier.confirm()');
                await verifier.confirm();
              } else if (ev.sas?.confirm) {
                console.log('Using ev.sas.confirm()');
                await ev.sas.confirm();
              }
              
              // Now verify (send MAC)
              console.log('Calling verify()...');
              if (verifier.verify) {
                await verifier.verify();
              } else if (ev.verify) {
                await ev.verify();
              }
              
              console.log('Verification confirmed on our side');
            } catch (error) {
              console.error('Error during confirmation:', error);
            }
          } else {
            console.log('Cancelling verification...');
            if (verifier.cancel) {
              verifier.cancel();
            }
          }
        });
      });
      
      // Handle done event
      verifier.on('done', () => {
        console.log('\n=== VERIFICATION COMPLETED ===');
        console.log('✅ Device verified successfully!');
        activeVerifier = null;
        activeSas = null;
      });
      
      // Handle cancel event
      verifier.on('cancel', (e) => {
        console.log('\n=== VERIFICATION CANCELLED ===');
        console.log('Reason:', e.code || e.reason || JSON.stringify(e));
        activeVerifier = null;
        activeSas = null;
      });
      
      // Log all events on verifier
      const events = ['ready', 'start', 'accept', 'key', 'mac', 'show_sas', 'done', 'cancel'];
      events.forEach(event => {
        verifier.on(event, (data) => {
          console.log(`\n[VERIFIER EVENT: ${event}]`, data ? JSON.stringify(data).slice(0, 100) : '');
        });
      });
      
    } catch (error) {
      console.error('Error in verification handler:', error);
    }
  });
  
  // Start the client
  console.log('Starting Matrix client...');
  await client.startClient();
  
  console.log('\n=== READY FOR VERIFICATION ===');
  console.log(`Device: ${client.getDeviceId()}`);
  console.log('Waiting for verification request from Element...');
  console.log('Go to Element → Settings → Security → Sessions → Find this device → Verify');
  
  // Keep the process running
  process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    client.stopClient();
    rl.close();
    process.exit(0);
  });
  
})().catch(console.error);
