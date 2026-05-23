# Clinch Core (`clinch-core`)

> **Autonomous Agent Negotiation Mediation Protocol — Edge Client & Seller SDK**

Clinch is a modular, edge-first protocol designed to mediate autonomous negotiations between a buyer AI agent and a seller AI agent. It allows agents to negotiate price and terms to a mutual, mathematically converged agreement without a human in the loop, and without the seller ever seeing the buyer's full profile.

Once an agreement is reached, Clinch issues a **cryptographically co-signed deal artifact** held by both parties. This SDK provides the complete network client, state machine, cryptographic signing engine, an optional out-of-the-box local LLM bargaining sandbox, and the server-side Seller SDK.

---

## 🎯 Project Aim & Philosophy

In the modern web, purchasing, SaaS licensing, transport, and commodity procurement involve endless manual comparisons, form-filling, and back-and-forth communication. Clinch replaces this overhead by allowing buyers to delegate constraints to a local agent that negotiates autonomously with the seller's hosted agent.

*   **Buyer Anonymity First**: The seller receives a simplified constraint vector (e.g., budget bracket, target category) rather than the buyer’s identity, private data, or raw history. All counter-offers are routed through the Registry proxy, guaranteeing 100% IP anonymity for the buyer.
*   **Edge-First Execution**: The buyer agent runs locally on-device. This SDK supports dynamically importing and running optimized 1.5B 4-bit quantized models in under **1.3 GB of RAM**, making it compatible with consumer hardware.
*   **Cryptographic Accountability**: Identity is proven via an Ed25519 identity key and Proof-of-Work (PoW). Every session uses throwaway, ephemeral session keys. The final co-signed deal artifact is self-verifying against the Registry's daily rotating key chain.
*   **Deterministic Hybrid Architecture**: The SDK decouples conversational language from protocol math. The LLM strictly generates persuasive copy while the core SDK evaluates numerical convergence, preventing AI hallucination or rule-bypassing.

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
*   `CONNECTING`: Resolving registry DNS and performing Proof-of-Work auth.
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

core.on('log', (message: string) => {
    console.log(`[LOG] ${message}`);
});

core.on('callback_received', (data: { sessionId: string, payload: any }) => {
    // Fired when the seller routes a callback counter-offer via the Registry WS
});

core.on('token_issued', (data: { token: string }) => {
    // Fired when PoW completes. Save this JWT to disk to skip PoW on next boot!
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
    core.on('status_changed', (status) => console.log(`👉 State: ${status}`));

    // 1. Initialize Sandbox: Handles network auth, downloads GGUF, & registers auto-listeners
    await core.sandbox({ downloadLLM: true });

    // 2. Initiate Negotiation: Session automatically transitions to 'NEGOTIATING'
    const sessionId = await core.negotiate('ANP/A.amazon.anp', {
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

## 🔌 Quickstart: Bring Your Own AI (Universal Prompt Builder)

If you are running in a cloud environment and want to leverage high-end hosted APIs (e.g. Claude 3.5 Sonnet or OpenAI GPT-4o), bypass the sandbox. 

`clinch-core` includes a **Universal Prompt Builder** (`buildAgentPrompt`) that automatically injects the current negotiation state, budget gaps, and strict JSON output schemas into a perfect system prompt for any LLM.

```javascript
import { ClinchCore } from 'clinch-core';
import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const core = new ClinchCore();

await core.initialize(); // Completes PoW and connects to WS

const sessionId = await core.negotiate('ANP/C.amazon.anp', {
    intent: 'purchase',
    item: 'Ninja Blender',
    max_budget: 85.00
});

core.on('callback_received', async (event) => {
    const sellerCounter = event.payload;

    // 1. Let the Core build the perfect state-aware protocol prompt
    const systemPrompt = core.buildAgentPrompt(sessionId, sellerCounter.message);
    
    // 2. Feed it to Claude/OpenAI
    const msg = await anthropic.messages.create({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 150,
      system: systemPrompt,
      messages: [{ role: "user", content: "Determine our next protocol move." }]
    });

    const aiDecision = JSON.parse(msg.content[0].text);

    // 3. Act on the deterministic JSON response
    if (aiDecision.action === 'accept') {
        console.log("Deal reached!");
        // Proceed to /commit
    } else {
        await core.sendCounter(sessionId, aiDecision.price, aiDecision.message);
    }
});
```

---

## 🏪 Quickstart: Building a Seller Node

`clinch-core` exports the `ClinchSeller` class to make building an Adapter Node or native seller server seamless. It handles dashboard authentication, endpoint registration, and cryptographic signature verification of buyer requests.

```javascript
import { ClinchSeller } from 'clinch-core';
import express from 'express';

const app = express();
app.use(express.json());

const seller = new ClinchSeller();

// Authenticate with your dashboard token and register your endpoint
await seller.authenticate('your-supabase-seller-jwt');
await seller.registerEndpoint({
    agent_id: 'amazon.anp',
    display_name: 'Amazon Adapter',
    endpoint: 'https://your-seller-api.com/anp',
    supported_modes: ['ANP/A', 'ANP/C'],
    categories: ['electronics'],
    capabilities: ['price_flex']
});

// Create your counter-offer route
app.post('/anp/counter', (req, res) => {
    const { session_id, turn, price, reason, buyer_sig } = req.body;
    
    // Verify the payload actually came from the buyer who holds the session key
    const isValid = seller.verifyBuyerSignature(
        { session_id, turn, price, reason }, 
        buyer_sig, 
        req.headers['x-buyer-pubkey']
    );

    if (!isValid) return res.status(401).send("Invalid signature");

    // Process logic and return standard counter JSON...
    res.json({ action: 'counter', price: 95.00, message: "Best I can do is $95." });
});
```

---

## 📖 API Reference

### Buyer Client (`ClinchCore`)

#### `new ClinchCore(config)`
*   `config.registryUrl` *(string)*: Override Firebase dynamic routing.
*   `config.timeoutMs` *(number)*: Connection timeout limit (Default: `5000`ms).

#### `async initialize(cachedToken?)`
Authenticates the node, completes Identity-Bound PoW, and connects the WebSocket.
*   `cachedToken` *(string)*: Saved JWT to skip PoW and restore connectivity instantly.

#### `async negotiate(address, constraints)`
Launches a cryptographic session handshake. Returns `sessionId`.
*   `address` *(string)*: e.g. `ANP/A.cloudflare.anp`.
*   `constraints` *(ConstraintVector)*: Must include `max_budget` (number).

#### `buildAgentPrompt(sessionId, incomingMessage)`
Returns a highly-optimized, state-aware string to pass to an external LLM as a System Prompt. Ensures the LLM outputs strict JSON matching the protocol rules.

#### `async sendCounter(sessionId, price, reason)`
Signs and dispatches a counter-offer to the seller via the Registry proxy.

#### `async exitSession(sessionId)`
Closes the active connection and generates a single-use re-engagement Callback token.

#### `async sandbox(config)`
Initializes the edge-AI execution context, downloads the GGUF, and auto-listens.
*   `config.downloadLLM` *(boolean)*: Default `true`.
*   `config.maxTurns` *(number)*: Turn limit threshold. Default `6`.

### Seller Client (`ClinchSeller`)

#### `async authenticate(authToken)`
Logs the seller node into the registry using a Dashboard JWT.

#### `async registerEndpoint(record)`
Publishes the seller's DNS-style record to the Registry so buyers can discover and route to it.

#### `verifyBuyerSignature(payload, signatureHex, pubKeyHex)`
Returns `boolean`. Cryptographically verifies that incoming counter-offers were signed by the exact ephemeral session key generated by the buyer during the handshake.

---

## 🔏 Cryptographic Guarantees
Clinch operates on a strictly zero-trust model. 
1. **Identity-Bound PoW**: Challenge hashes include the client's `pubKey`, making outsourcing/bot-farming mathematically impossible.
2. **Ephemeral Sessions**: `negotiate()` generates an ephemeral Session Key (`nacl.sign.keyPair()`). This key signs every individual message. If a session key is compromised, your global identity remains secure, and historical session logs remain completely un-linkable.
3. **Anonymity Proxy**: Counter-offers are routed strictly through the Registry. The seller never logs the buyer's IP address.
