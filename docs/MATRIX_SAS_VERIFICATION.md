# Matrix SAS Device Verification: Incident and Resolution

Last updated: 2025-08-24

## Summary

- Symptom: SAS verification between our Node.js app (matrix-js-sdk) and Element cancelled early (m.key.verification.cancel) before emojis were shown.
- Root cause: Duplicate or competing verifiers and timing issues. Creating a local verifier or driving the handshake incorrectly raced with Element, leading to peer-side cancellation. Missing timely binding to the SDK-created verifier (`req.verifier`) meant we progressed without `show_sas` listeners (appearing as instant cancel).
- Resolution: Passive, race-free pattern that:
  - Accepts requests immediately.
  - Never creates a local verifier or sends manual to-device events.
  - Binds once to the SDK-provided verifier.
  - Drives the entire handshake via `verifier.verify()` only.
  - Uses strict txn guards (`boundTxns`, `begunHandshakeTxns`) and a pending request map.

## Sequence

```mermaid
sequenceDiagram
participant A as App (matrix-js-sdk)
participant E as Element Client
participant T as To-Device

A->T: m.key.verification.request (acceptor role)
A->E: request.accept() (SDK sends m.key.verification.ready when needed)
E->T: m.key.verification.start
A->A: SDK emits crypto.verification.start (verifier)
A->A: bind(verifier); verifier.verify()
A->E: (SDK may send m.key.verification.accept if required)
E-->A: show_sas (emoji/decimal)
A->A: user confirms (CLI 'y')
A->E: (SDK) m.key.verification.mac
E-->A: m.key.verification.mac
A->E: (SDK) m.key.verification.done
E-->A: m.key.verification.done
note over A,E: Devices marked verified; secrets may be imported if SSSS key available
```

## Stable Pattern (TypeScript excerpts)

- Accept passively and bind when SDK attaches `req.verifier`:

```ts
// Typescript
(client as any).on?.("crypto.verification.request", async (req: any) => {
  const txnId = req.transactionId;
  if (txnId) pendingVerificationRequests.set(txnId, req);
  await req.accept?.(); // passive accept
  req.on?.("change", () => {
    const v = (req as any).verifier;
    const tid = v?.transactionId || req.transactionId;
    if (!v || !tid || boundTxns.has(tid)) return;
    bindVerifierEventHandlers(v, tid);
  });
});
```

- Preferred bind path when SDK emits `start`:

```ts
// Typescript
(client as any).on?.("crypto.verification.start", (verifier: any, req?: any) => {
  const txnId = verifier?.transactionId || req?.transactionId || req?.transaction_id;
  if (!txnId || boundTxns.has(txnId)) return;
  bindVerifierEventHandlers(verifier, txnId);
});
```

- To-device fallback when `start` seen before `req.verifier` exists:

```ts
// Typescript
client.on(ClientEvent.ToDeviceEvent, (event) => {
  if (event.getType() !== "m.key.verification.start") return;
  const txnId = event.getContent()?.transaction_id;
  if (!txnId || boundTxns.has(txnId)) return;
  const req = pendingVerificationRequests.get(txnId);
  const v = req?.verifier;
  if (v) bindVerifierEventHandlers(v, txnId);
});
```

- Core binder (single bind; drive via `verify()`; cleanup on done/cancel):

```ts
// Typescript
function bindVerifierEventHandlers(verifier: any, txnId: string) {
  if (boundTxns.has(txnId)) return;
  boundTxns.add(txnId);
  activeVerifier = verifier;

  verifier.on?.("show_sas", async (ev: any) => {
    activeSas = ev;
    if (pendingVerifierDecision === "confirm") {
      pendingVerifierDecision = null;
      await ev.confirm?.();
      await verifier.verify(); // send MAC; await peer MAC/done
    }
  });

  verifier.on?.("done", cleanup);
  verifier.on?.("cancel", () => cleanup());

  (async () => {
    if (begunHandshakeTxns.has(txnId)) return;
    begunHandshakeTxns.add(txnId);
    await verifier.verify(); // let SDK orchestrate accept/start/MAC/done
  })();

  function cleanup() {
    activeVerifier = null;
    activeSas = null;
    boundTxns.delete(txnId);
    begunHandshakeTxns.delete(txnId);
    pendingVerificationRequests.delete(txnId);
    pendingVerifierDecision = null;
  }
}
```

## Failure Mode

- Cancel occurs immediately after `m.key.verification.start`; no emoji UI shown.
- Logs show cancellation reason “user cancelled” from Element.

Contributing factors:
- We previously created our own verifier (`beginKeyVerification` or equivalent) while Element also started one.
- We attempted low-level sequencing (e.g., sending accept/MAC/done manually).
- We did not bind to `req.verifier` quickly enough, so `show_sas` landed without our listeners.

## Resolution

- Do not create verifiers or send start/accept manually on inbound flows.
- Accept the request, store by `transaction_id`, and bind exactly once to the SDK-provided verifier.
- Call `verifier.verify()` to drive the progression (SDK handles role-appropriate messages).
- Guard with:
  - `boundTxns`: prevent duplicate binding/handlers.
  - `begunHandshakeTxns`: prevent multiple `verify()` calls.
  - `pendingVerificationRequests`: correlate to-device `start` to the request.

Validated outcome:
- SAS emojis/decimals shown, user confirms.
- MACs exchanged, `m.key.verification.done` sent/received.
- Devices verified; cross-signing secrets imported if configured; backup restored.

## Operational Runbook

- Trigger:
  - Start the app and Element; initiate verification from either side.
- Expected logs (highlights):
  - `[verification.request] ...`
  - `Accepted; waiting for Element to start…`
  - `[bindVerifier] calling verify() to progress SAS ...`
  - `SAS Emoji: ...`
  - `SAS Decimals: ...`
  - `✅ Verification finished.`
- CLI:
  - Type `y` then Enter when emojis match.
  - If typed early, a queued confirm is applied on `show_sas`.

Success criteria:
- Devices show as verified on both sides.
- Cross-signing status becomes trusted; SSSS import may run when configured.

## Troubleshooting

- Cancel before `show_sas`:
  - Ensure no calls to `beginKeyVerification` or manual `start`/`accept`/`mac`/`done`.
  - Confirm `req.accept()` is called only once.
  - Verify both handlers are active:
    - `crypto.verification.start`
    - `req.on("change")` fallback (binds when `req.verifier` appears)
  - Check that `boundTxns` and `begunHandshakeTxns` prevent duplicate work.
- Multiple Element clients:
  - Ensure only one Element instance responds to the same request.
- Stuck after confirmation:
  - Confirm `verifier.verify()` is called after `show_sas.confirm()` (we do this automatically).
- Spurious cancels:
  - Ignore `cancel` for unknown or completed txn IDs (optional guard).

## Secret Storage (SSSS)

- Default service mode: no SSSS participation to avoid interactive prompts and post-SAS flips.
- Optional import:
  - Set `MATRIX_RECOVERY_KEY_B64` to a 32-byte base64 key to allow SDK-led import of cross-signing / backup secrets.
  - The app provides `cryptoCallbacks.getSecretStorageKey` when valid.

Example env var:
```
MATRIX_RECOVERY_KEY_B64=base64_of_32_bytes_key
```

## Post-Verification Behavior

- Device trust becomes verified.
- Cross-signing secrets may be imported (if SSSS key provided).
- Backup can restore automatically once keys are available.

## Future Hardening (optional)

- Metrics per txn: `accept_sent`, `start_seen`, `bound`, `verify_called`, `show_sas_seen`, `mac_sent`, `done_sent`.
- Ignore cancels for non-active txn IDs.
- CLI UX: show device names; better queued confirm messaging.
- Integration script examples under `scripts/` for replayable flows.
