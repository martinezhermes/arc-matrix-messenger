#!/usr/bin/env node

// Debug script to understand Matrix verification structure
const sdk = require("matrix-js-sdk");

// Patch console.log to add timestamps
const originalLog = console.log;
console.log = (...args) => {
  originalLog(new Date().toISOString(), ...args);
};

// Create a fake request to analyze its structure
console.log("Creating mock verification request...");

// Log the actual SDK exports related to verification
console.log("\nSDK verification exports:");
console.log("VerificationRequest:", typeof sdk.VerificationRequest);
console.log("Crypto namespace:", typeof sdk.Crypto);

// Try to access verification-related classes
try {
  const { VerificationRequest } = require("matrix-js-sdk/lib/crypto/verification/request/VerificationRequest");
  console.log("VerificationRequest class found");
} catch (e) {
  console.log("VerificationRequest not found at expected path");
}

// Check for SAS verifier
try {
  const { SAS } = require("matrix-js-sdk/lib/crypto/verification/SAS");
  console.log("SAS class found");
} catch (e) {
  console.log("SAS not found at expected path");
}

console.log("\nTo properly debug, we need to inspect a real verification request object.");
console.log("The issue is that Element starts the verification, so we need to handle the 'start' phase properly.");

// Try to access the actual classes
try {
  const { VerificationRequest } = require("matrix-js-sdk/lib/crypto/verification/request/VerificationRequest");
  console.log("\nVerificationRequest prototype methods:");
  console.log(Object.getOwnPropertyNames(VerificationRequest.prototype).filter(name => name !== 'constructor'));
  
  const { SAS } = require("matrix-js-sdk/lib/crypto/verification/SAS");
  console.log("\nSAS prototype methods:");
  console.log(Object.getOwnPropertyNames(SAS.prototype).filter(name => name !== 'constructor'));
  
  // Check if we can find more info about phases
  console.log("\nChecking for phase constants...");
  const phases = require("matrix-js-sdk/lib/crypto/verification/request/VerificationRequest");
  if (phases.PHASE) {
    console.log("PHASE constants:", phases.PHASE);
  }
  
} catch (e) {
  console.log("Error accessing classes:", e.message);
}

// Also check what happens when we create a mock verifier
console.log("\nLooking for verification phases and methods...");
try {
  const mockRequest = {
    phase: 4, // started phase
    verifier: null,
    sasVerifier: null,
    accept: () => console.log("Mock accept called"),
    on: (event, handler) => console.log(`Mock on('${event}') called`)
  };
  
  console.log("Mock request structure works");
} catch (e) {
  console.log("Mock structure error:", e.message);
}
