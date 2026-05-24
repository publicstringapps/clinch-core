# Clinch Core (`clinch-core`)

> **Autonomous Agent Negotiation Mediation Protocol — Edge Client & Seller SDK**

Clinch is a modular, edge-first protocol designed to mediate autonomous negotiations between a buyer AI agent and a seller AI agent. It allows agents to negotiate price and terms to a mutual, mathematically converged agreement without a human in the loop, and without the seller ever seeing the buyer's full profile.

Once an agreement is reached, Clinch issues a **cryptographically co-signed deal artifact** held by both parties. This SDK provides the complete network client, state-isolated session management, cryptographic signing engines, an optional out-of-the-box local LLM bargaining sandbox, and the server-side Seller SDK.

---

## 🎯 Project Aim & Philosophy

In the modern web, purchasing, SaaS licensing, transport, and commodity procurement involve endless manual comparisons, form-filling, and back-and-forth communication. Clinch replaces this overhead by allowing buyers to delegate constraints to a local agent that negotiates autonomously with the seller's hosted agent.

*   **Buyer Anonymity First**: The seller receives a simplified constraint vector (e.g., budget bracket, target category) rather than the buyer’s identity, private data, or raw history. All counter-offers are routed through the Registry proxy, guaranteeing 100% IP anonymity for the buyer.
*   **Edge-First Execution**: The buyer agent runs locally on-device. This SDK supports dynamically importing and running optimized 1.5B 4-bit quantized models in under **1.3 GB of RAM**, making it compatible with consumer hardware.
*   **Enterprise Concurrency**: Complete session isolation allows scaling horizontally. You can run hundreds of concurrent negotiations on a single server, serialize state, and resume negotiations across pod restarts or delayed webhooks.
*   **Cryptographic Accountability**: Identity is proven via Ed25519 keys and Proof-of-Work (PoW). The final co-signed deal artifact is self-verifying against the Registry's daily rotating key chain. Zero-trust machine-to-machine updates are enforced without centralized JWT expirations.

---

## 📦 Installation

To use `clinch-core` as a raw network client (Bring Your Own LLM or Seller Node):
```bash
npm install clinch-core
```

If you wish to use the **out-of-the-box local Sandbox engine** (Buyer Edge Mode), install the required peer dependency:
```bash
npm install node-llama-cpp
```
*(Note: `node-llama-cpp` is dynamically imported. Web/React Native builds will not fail if this is missing, provided `.sandbox()` is not called).*

---

## 🚦 Core State Machine & Event Architecture

`clinch-core` is driven by a strict network and negotiation state machine. You can subscribe to state transitions and real-time transaction logging to build clean, reactive user interfaces.

### Core Statuses (`CoreStatus`)
*   `OFFLINE`: Client is disconnected.
*   `CONNECTING`: Resolving registry configuration and performing Proof-of-Work auth.
*   `IDLE`: Connected and authenticated. Waiting for handshakes or callbacks.
*   `RECONNECTING`: Socket connection lost; executing exponential backoff.
*   `NEGOTIATING`: Active turn-based negotiation sequence in progress.
*   `CONVERGED`: Mathematical agreement reached successfully.
*   `STALEMATE`: Negotiation terminated; max turns reached without convergence.
*   `ERROR`: Internal network, cryptographic, or compilation failure.

### Event Emitters
```typescript
core.on('status_changed', (status: CoreStatus) => {
    console.log(`State transitioned to: ${status}`);
});

core.on('session_started', ({ sessionId, sellerId }) => {
    console.log(`Negotiation initiated with ${sellerId} (Session: ${sessionId})`);
});

core.on('session_closed', ({ sessionId, outcome, finalPrice }) => {
    console.log(`Session ${sessionId} closed. Outcome: ${outcome} at $${finalPrice}`);
});

core.on('callback_received', ({ sessionId, payload }) => {
    // Fired when the seller routes a callback counter-offer via the Registry WS
});
```

---

## ⚡ Quickstart: Out-of-the-Box Sandbox (Buyer)

The Sandbox automatically downloads an optimized **Qwen 2.5 1.5B Q4_K_M** model (~1.1GB), loads it securely into local RAM, and automatically wires up the WebSocket listeners to negotiate autonomously on incoming network events.

```javascript
const { ClinchCore } = require('clinch-core');

async function startLocalAgent() {
    const core = new ClinchCore();

    core.on('log', (msg) => console.log(msg));
    core.on('session_closed', ({ finalPrice }) => console.log(`Deal secured at $${finalPrice}!`));

    // 1. Initialize Sandbox: Handles network auth, downloads GGUF, & registers auto-listeners
    await core.sandbox({ downloadLLM: true });

    // 2. Initiate Negotiation: Session automatically transitions to 'NEGOTIATING'
    // Format: PROTOCOL_MODE.domain.anp (e.g., ANP/C.amazon.anp)
    const sessionId = await core.negotiate('ANP/C.amazon.anp', {
        intent: 'purchase',
        category: 'electronics',
        item: 'Ninja Blender',
        max_budget: 85.00 // Strictly enforced constraint
    });

    console.log(`🤖 Auto-agent listening on Session ${sessionId}`);
}

startLocalAgent();
```

---

## 🔌 Quickstart: Bring Your Own AI & Webhook Persistence

If you are running in a cloud environment (e.g., handling webhooks) and want to leverage high-end hosted APIs (e.g. Claude 3.5 Sonnet or OpenAI GPT-4o), bypass the sandbox. The Core provides **State Serialization** to survive server restarts.

```javascript
import { ClinchCore } from 'clinch-core';
import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const core = new ClinchCore();

await core.initialize(); 

// 1. Start session and save state to DB
const sessionId = await core.negotiate('ANP/C.amazon.anp', {
    intent: 'purchase',
    item: 'Ninja Blender',
    max_budget: 85.00
});
const savedState = core.exportSessionState(sessionId);
await db.save(sessionId, savedState);

// --- LATER, ON A DIFFERENT SERVER OR WEBHOOK --- //

const webhookCore = new ClinchCore();
webhookCore.importSessionState(savedState);

webhookCore.on('callback_received', async (event) => {
    // 2. Let the Core build the perfect state-aware protocol prompt
    const systemPrompt = webhookCore.buildAgentPrompt(event.sessionId, event.payload.message);

    // 3. Feed it to Claude/OpenAI
    const msg = await anthropic.messages.create({
      model: "claude-3-5-sonnet-20241022",
      maxTokens: 150,
      system: systemPrompt,
      messages: [{ role: "user", content: "Determine our next protocol move." }]
    });

    const aiDecision = JSON.parse(msg.content[0].text);

    // 4. Act on the deterministic JSON response
    if (aiDecision.action === 'accept') {
        console.log("Deal reached!");
    } else {
        await webhookCore.sendCounter(event.sessionId, aiDecision.price, aiDecision.message);
        // Reserialize and update DB after turn to maintain state sync
        await db.update(event.sessionId, webhookCore.exportSessionState(event.sessionId));
    }
});
```

---

## 🏪 Quickstart: Building a Seller Node

`clinch-core` exports the `ClinchSeller` class to make building a native seller server seamless.

**Architecture Note:** Seller Nodes do not use JWTs. You generate a permanent Ed25519 Keypair in the Clinch Dashboard, claim your domain, and pass the private key to your Node. The node securely self-publishes its endpoint and capabilities on boot.

```javascript
import { ClinchSeller } from 'clinch-core';
import express from 'express';

const app = express();
app.use(express.json());

// Initialize with your permanent Dashboard-generated Private Key
const seller = new ClinchSeller({ 
    privateKeyHex: process.env.SELLER_PRIVATE_KEY 
    // registryUrl: 'http://localhost:7860' // Optional: Override for local dev
});

// Publish your routing endpoint to the network on boot
await seller.registerEndpoint({
    agent_id: 'amazon.anp',
    endpoint: 'https://your-seller-api.com/anp/v1',
    supported_modes: ['ANP/C'],
    categories: ['electronics'],
    capabilities: ['price_flex']
});

// Create your counter-offer route
app.post('/anp/v1/counter', (req, res) => {
    const { session_id, turn, price, reason, buyer_sig } = req.body;

    // Verify the payload actually came from the buyer who holds the session key
    const isValid = seller.verifyBuyerSignature(
        { session_id, turn, price, reason },
        buyer_sig,
        req.headers['x-buyer-pubkey']
    );

    if (!isValid) return res.status(401).send("Invalid signature");

    // Process logic and return standard counter JSON...
    res.json({ msg_type: 'counter', price: 95.00, reason: "Best I can do is $95." });
});

app.listen(8080);
```

---

## 📖 API Reference

### Buyer Client (`ClinchCore`)

#### `new ClinchCore(config)`
*   `config.registryUrl` *(string)*: Override default dynamic configuration resolution for local testing.
*   `config.timeoutMs` *(number)*: Connection timeout limit (Default: `5000`ms).

#### `async initialize(cachedToken?)`
Authenticates the node on the network, completes Identity-Bound PoW, and connects the WebSocket.
*   `cachedToken` *(string)*: Optional. Re-use an existing network token to bypass PoW calculations on restart.

#### `async negotiate(address, constraints)`
Launches a cryptographic session handshake. Returns `sessionId`.
*   `address` *(string)*: Target seller address. Must include the protocol mode prefix (e.g., `ANP/C.amazon.anp`).
*   `constraints` *(ConstraintVector)*: Must include `max_budget` (number) and `item` (string).

#### `exportSessionState(sessionId)` / `importSessionState(serializedData)`
Serializes the active session—including the ephemeral cryptographic keys, current turn, and LLM context parameters—to a JSON string. Used to scale instances horizontally, survive pod restarts, or pick up negotiations across async callback windows.

#### `buildAgentPrompt(sessionId, incomingMessage)`
Returns a highly-optimized, state-aware string to pass to an external LLM as a System Prompt. Ensures the LLM outputs strict JSON matching the protocol rules.

#### `async sendCounter(sessionId, price, reason)`
Signs and dispatches a counter-offer to the seller via the Registry proxy.

#### `async exitSession(sessionId)`
Closes the active connection and generates a single-use re-engagement Callback token.

#### `async sandbox(config)`
Initializes the edge-AI execution context, downloads the GGUF, and auto-listens.

---

### Seller Client (`ClinchSeller`)

#### `new ClinchSeller(config)`
*   `config.privateKeyHex` *(string)*: The Ed25519 private key generated from the Clinch Dashboard. Used to cryptographically authenticate endpoint updates.
*   `config.registryUrl` *(string)*: Optional. Overrides Registry configuration resolution for local testing.

#### `async registerEndpoint(record)`
Publishes the seller's DNS-style record to the Registry so buyers can discover and route to it. Signed locally via the Ed25519 identity key.

#### `verifyBuyerSignature(payload, signatureHex, pubKeyHex)`
Returns `boolean`. Cryptographically verifies that incoming counter-offers were signed by the exact ephemeral session key generated by the buyer during the handshake.

---

## 🔏 Cryptographic Guarantees
Clinch operates on a strictly zero-trust model.
1. **Identity-Bound PoW**: Buyer challenge hashes include the client's `pubKey`, making outsourcing/bot-farming mathematically impossible.
2. **Ed25519 Seller Authority**: Seller endpoints and capabilities are updated via Ed25519 signatures, completely decoupling the control plane (Dashboard) from the data plane (Server).
3. **Ephemeral Sessions**: `negotiate()` generates an ephemeral Session Key. This key signs every individual message. If a session key is compromised, your global identity remains secure, and historical session logs remain completely un-linkable.
4. **Anonymity Proxy**: Counter-offers are routed strictly through the Registry. The seller never logs the buyer's IP address.
