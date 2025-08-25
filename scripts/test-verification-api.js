#!/usr/bin/env node

// Test script to understand Matrix verification API structure
const sdk = require("matrix-js-sdk");

console.log("Matrix SDK version:", sdk.VERSION || "unknown");

// Create a mock verification request to inspect its structure
const mockRequest = {
  accept: async () => console.log("accept() called"),
  startVerification: async (method) => {
    console.log("startVerification() called with:", method);
    return {
      on: (event, handler) => console.log(`Verifier registered handler for: ${event}`),
      confirm: async () => console.log("verifier.confirm() called"),
      verify: async () => console.log("verifier.verify() called"),
      cancel: () => console.log("verifier.cancel() called")
    };
  }
};

// Test the flow
(async () => {
  console.log("\nTesting verification flow:");
  await mockRequest.accept();
  const verifier = await mockRequest.startVerification("m.sas.v1");
  console.log("\nVerifier methods:", Object.keys(verifier));
})();
