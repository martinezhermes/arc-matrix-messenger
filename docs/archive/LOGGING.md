# Logging and Verbosity Guide

This project emits logs from two main sources:
- App CLI logs (our code, green/blue/yellow/red markers)
- matrix-js-sdk internal logs (e.g., FetchHttpApi, Crypto, device/key management)

The goal is to keep production output minimal while preserving debuggability.

## Log Families and What They Mean

- App CLI (our logger via `src/cli/ui.ts`)
  - info (green ◇): high-level status (startup, ready, SAS prompts)
  - warn (yellow ◇): non-fatal anomalies
  - error (red ◇): failures
  - debug (blue ◇): detailed traces useful for diagnosis

- Matrix SDK
  - FetchHttpApi: HTTP requests/responses to homeserver
    - Examples: `--> PUT /devices/{id}`, `--> GET /sync`, `keys/upload`, `sendToDevice`
  - Crypto: crypto engine lifecycle (init, device tracking, key backup)
    - Examples: `Crypto: initialising ...`, `checking for key backup`, `Backup is trusted locally`
  - DecryptionError: unable to decrypt an event due to missing session keys
    - Example: `Error decrypting event ... The sender's device has not sent us the keys for this message.`
  - Device list/keys query: downloading/refreshing device keys and cross-signing keys
    - Examples: `got device keys for ...`, `got cross-signing keys for ...`
  - Key backup: backup status and scheduling
    - Examples: `Found usable key backup v2`, `scheduleKeyBackupSend`

## How to Reduce Noise

Environment variables (take effect at startup):
- LOG_LEVEL: gates our CLI logs
  - silent | error | warn | info | debug
  - Default: info (set to warn to be quieter)
- MATRIX_SDK_LOG_LEVEL: gates matrix-js-sdk logs
  - silent | error | warn | info | debug
  - Default: error (keeps only SDK errors)
- VERBOSE: deprecated (legacy). Prefer LOG_LEVEL and MATRIX_SDK_LOG_LEVEL.

Examples:
```bash
# Quiet (recommended for normal operation)
export LOG_LEVEL=warn
export MATRIX_SDK_LOG_LEVEL=error

# Default (balanced)
export LOG_LEVEL=info
export MATRIX_SDK_LOG_LEVEL=error

# Deep debug (development)
export LOG_LEVEL=debug
export MATRIX_SDK_LOG_LEVEL=debug
```

## Why You Saw “Excessive” Logs

From the sample output:
- Lines starting with `FetchHttpApi:` and `Crypto:` are from matrix-js-sdk. These are hidden unless `MATRIX_SDK_LOG_LEVEL` is set to info/debug.
- Blue/green `◇` lines are our CLI logs. These follow `LOG_LEVEL`.

We now:
- Gate all app debug lines (`printLog`) behind LOG_LEVEL=debug.
- Default MATRIX_SDK_LOG_LEVEL to error.
- Provide LOG_LEVEL to control our own output.

## Typical Lines Explained (from the sample)

- `[dotenv@17.2.1] injecting env ...`
  - External dotenv loader output (environment bootstrap). Not from our logger.
- `◇ App Message Broker URL: ...`, `◇ App Database URI: ...`, `◇ App User: ...`
  - Our debug lines (now shown only at LOG_LEVEL=debug).
- `FetchHttpApi: --> GET/PUT ...`
  - SDK HTTP traffic; controlled by MATRIX_SDK_LOG_LEVEL.
- `Crypto: initialising ...`, `Loaded cross-signing public keys ...`
  - SDK crypto lifecycle; controlled by MATRIX_SDK_LOG_LEVEL.
- `Error decrypting event ... The sender's device has not sent us the keys ...`
  - SDK decryption errors; often occur until keys are shared/restored. Controlled by MATRIX_SDK_LOG_LEVEL.
- `Backup is trusted locally`, `Found usable key backup v2`
  - SDK key backup status; controlled by MATRIX_SDK_LOG_LEVEL.
- `◇ Encrypted message received ..., waiting for decryption...`
  - Our debug line (blue) indicating the app saw an encrypted event; shown only at LOG_LEVEL=debug.

## Recommended Presets

- Production: `LOG_LEVEL=warn`, `MATRIX_SDK_LOG_LEVEL=error`
- Staging/QA: `LOG_LEVEL=info`, `MATRIX_SDK_LOG_LEVEL=warn`
- Local debugging: `LOG_LEVEL=debug`, `MATRIX_SDK_LOG_LEVEL=debug`

## Notes on Sensitive Data

- We avoid printing credentials at info/warn/error. Some debug lines may include connection URIs; prefer not to use LOG_LEVEL=debug in shared terminals.
- If you must debug connection issues, temporarily set LOG_LEVEL=debug, reproduce, and then revert.
