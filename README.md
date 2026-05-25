# Clinch Core (`clinch-core`)

> **Agent Negotiation Protocol (ANP) — Edge Client & Seller SDK**

`clinch-core` is the programmatic engine of the Clinch Protocol. It provides the state machine, cryptographic signing interfaces, local LLM sandbox adapters, and server-side utilities required to implement both buyer and seller agents conforming to the **Agent Negotiation Protocol (ANP)**.

---

## 1. Protocol Architecture & Mechanics

The Agent Negotiation Protocol (ANP) governs how two autonomous software agents establish identity, declare capabilities, and reach a cryptographically verifiable agreement on price and terms.

### 1.1 Address Formatting & Routing
All destination routing in Clinch relies on structured, prefixed addresses:

$$\text{PROTOCOL\_MODE} \mathbin{.} \text{domain} \mathbin{.} \text{TLD}$$

*Example:* `ANP/C.amazon.anp`

The SDK parses the address to extract the negotiated **Protocol Mode** and target namespace domain before dispatching the initialization request.

### 1.2 Protocol Modes
Sellers declare which execution profiles they support. The SDK maps these mode flags to session parameters during handshake:

*   **`ANP/A`**: Standard native execution. Both buyer and seller agents run the local Clinch edge model. Best suited for high-volume, low-friction commodity exchanges.
*   **`ANP/B`**: Mixed execution. One side uses the native edge model, while the other runs a custom model or external API adapter.
*   **`ANP/C`**: Custom integration. Both agents run custom decision engines (e.g., GPT-4o, Claude 3.5, or proprietary heuristics). 

---

## 2. State Machine & Event Architecture

The SDK maintains an isolated, turn-based state machine for each active session. 

### Core Statuses (`CoreStatus`)
*   `OFFLINE`: Client is completely disconnected.
*   `CONNECTING`: Authenticating identity and performing local Proof-of-Work (PoW) verification.
*   `IDLE`: Connected and authenticated. Ready to initialize new sessions.
*   `RECONNECTING`: Socket connection lost; executing exponential backoff.
*   `NEGOTIATING`: Active, turn-based bargaining sequence in progress.
*   `CONVERGED`: Mathematical convergence reached; agreement co-signed.
*   `STALEMATE`: Negotiation terminated; max turns reached without convergence.
*   `ERROR`: Internal network, compilation, or cryptographic validation failure.

### Developer Event Subscriptions
```typescript
// Track the operational status of the client
core.on('status_changed', (status: CoreStatus) => {
    console.log(`[Status] Client changed to: ${status}`);
});

// Fired when a new negotiation handshake is completed
core.on('session_started', ({ sessionId, sellerId }) => {
    console.log(`[Session Started] Active ID: ${sessionId} targeting ${sellerId}`);
});

// Fired when a session reaches terminal state (deal converged or stalemate)
core.on('session_closed', ({ sessionId, outcome, finalPrice }) => {
    console.log(`[Session Closed] ID: ${sessionId} | Outcome: ${outcome} | Price: $${finalPrice}`);
});

// Fired when an out-of-band message is received via the WS callback channel
core.on('callback_received', ({ sessionId, payload }) => {
    console.log(`[Callback] Re-engagement for session ${sessionId} received`);
});
```

---

## 3. Installation

Install the library using your package manager:
```bash
npm install clinch-core
```

To run the local autonomous **Sandbox engine**, install the required peer dependency:
```bash
npm install node-llama-cpp
```
*(Note: `node-llama-cpp` is dynamically imported at runtime. Web builds or headless environments will not fail if this dependency is omitted, provided `.sandbox()` is not invoked).*

---

## 4. Integration Guide: Buyer Agents

### 4.1 Running the On-Device Sandbox
The local Sandbox runs an optimized **Qwen 2.5 1.5B Q4_K_M** model on local hardware resources. It automatically handles handshake math and turn-based counter-offers based on your strict constraints.

```javascript
const { ClinchCore } = require('clinch-core');

async function runAutonomousSession() {
    const core = new ClinchCore();

    core.on('log', (msg) => console.log(msg));
    core.on('session_closed', ({ finalPrice }) => {
        console.log(`✓ Negotiation completed at $${finalPrice}`);
    });

    // 1. Initialize local LLM, solve PoW, and connect WebSocket
    await core.sandbox({ downloadLLM: true });

    // 2. Begin autonomous negotiation
    const sessionId = await core.negotiate('ANP/C.amazon.anp', {
        intent: 'purchase',
        category: 'electronics',
        item: 'Ninja Blender',
        max_budget: 85.00
    });

    console.log(`Session active: ${sessionId}`);
}

runAutonomousSession();
```

### 4.2 Webhook & Horizontal Scale Pattern
For enterprise cloud environments where processes must remain stateless or scale horizontally across server pods, you must serialize and rehydrate active sessions dynamically. This ensures that when an asynchronous callback arrives, any pod can load the session state and use the matching ephemeral key to sign the next turn.

```javascript
import { ClinchCore } from 'clinch-core';
import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const core = new ClinchCore();

await core.initialize();

// 1. Start session
const sessionId = await core.negotiate('ANP/C.amazon.anp', {
    intent: 'purchase',
    item: 'Ninja Blender',
    max_budget: 85.00
});

// 2. Serialize and persist the state to your DB (Redis, Postgres, etc.)
const exportedState = core.exportSessionState(sessionId);
await db.saveSession(sessionId, exportedState);

// --- LATER, ON A DIFFERENT POD OR ASYNCHRONOUS WEBHOOK TRIGGER --- //

const webhookCore = new ClinchCore();
webhookCore.importSessionState(exportedState);

webhookCore.on('callback_received', async (event) => {
    // 3. Generate system prompt using rehydrated session data
    const systemPrompt = webhookCore.buildAgentPrompt(event.sessionId, event.payload.message);

    // 4. Evaluate with hosted LLM
    const msg = await anthropic.messages.create({
      model: "claude-3-5-sonnet-20241022",
      maxTokens: 150,
      system: systemPrompt,
      messages: [{ role: "user", content: "Calculate next move." }]
    });

    const decision = JSON.parse(msg.content[0].text);

    // 5. Submit cryptographic counter-offer
    if (decision.action === 'accept') {
        console.log("Agreement reached!");
    } else {
        await webhookCore.sendCounter(event.sessionId, decision.price, decision.message);
        // 6. Update DB with new turn state and counters
        await db.updateSession(event.sessionId, webhookCore.exportSessionState(event.sessionId));
    }
});
```

### 4.3 Cascading Multi-Seller Squeeze and Races
To implement market discovery, the SDK supports cascading negotiations across multiple matching sellers. The Core orchestrates two distinct optimization strategies:

#### Sequential Squeeze (Default)
Useful for high-value items where time is secondary to price. The SDK negotiates sequentially with each seller, using the converged deal price of the previous seller as the strict, maximum budget ceiling for the next. This dynamically forces sellers to underbid one another.

#### Parallel Race
Necessary for real-time services like ride-hailing or logistics. The SDK handshakes and conducts negotiations with all selected sellers concurrently in parallel. Once all sessions finish, it selects the absolute lowest price converged under your budget.

```javascript
// Triggers the cascading loop
const bestDeal = await core.negotiateCascade(
    'domain_name',          // Category to discover
    { intent: 'purchase', item: 'mybrand.io', max_budget: 150.00 },
    3,                      // Max sellers to target
    'sequential'            // 'sequential' | 'parallel'
);

if (bestDeal) {
    console.log(`🏆 Optimal deal secured with ${bestDeal.sellerId} at $${bestDeal.finalPrice}`);
}
```

### 4.4 Blind Key Pass (Credential Injection)
For sessions with services that require authorization tokens or API keys to operate (such as platform execution nodes), you can register these credentials locally.

The Core library securely stores these secrets and silently injects them into the handshake transport layer during session initialization. This prevents the API keys from ever being exposed to the AI model's context window, safeguarding you against prompt injection attacks.

```javascript
// Register the API credential locally bound to the domain namespace
core.registerSecret('apify.anp', 'apify_sec_key_xyz987', 'Apify Production Token');

// Handshaking with this address now automatically injects the credential silently
const sessionId = await core.negotiate('ANP/C.apify.anp', {
    intent: 'purchase',
    item: 'actor-scraper-run',
    max_budget: 5.00
});
```

---

## 5. Integration Guide: Seller Nodes

Sellers use the `ClinchSeller` class to build compliant, automated endpoints.

### 5.1 Decoupled Routing Architecture
To prevent centralized token expiration failures, Clinch separates ownership from routing:
1. **The Control Plane**: The merchant claims their domain name (e.g., `amazon.anp`) and binds their permanent public key to it once using the dashboard.
2. **The Data Plane**: The actual seller server is initialized with the matching permanent private key. On boot, the machine signs its dynamic endpoint configuration locally and publishes it to the registry. No JWTs are used on-wire for machine routing.

```javascript
import { ClinchSeller } from 'clinch-core';
import express from 'express';

const app = express();
app.use(express.json());

// 1. Initialize seller with the permanent cryptographic key
const seller = new ClinchSeller({ 
    privateKeyHex: process.env.SELLER_PRIVATE_KEY 
});

// 2. Publish endpoint to the registry on boot (Self-Signing)
await seller.registerEndpoint({
    agent_id: 'amazon.anp',
    endpoint: 'https://your-seller-api.com/anp/v1',
    supported_modes: ['ANP/C'],
    categories: ['electronics'],
    capabilities: ['price_flex']
});

// 3. Implement the standard ANP counter-offer endpoint
app.post('/anp/v1/counter', (req, res) => {
    const { session_id, turn, price, reason, buyer_sig } = req.body;

    // Cryptographically verify the buyer's ephemeral signature
    const isValid = seller.verifyBuyerSignature(
        { session_id, turn, price, reason },
        buyer_sig,
        req.headers['x-buyer-pubkey']
    );

    if (!isValid) return res.status(401).json({ error: "Invalid signature" });

    // Execute bargaining logic and respond
    res.json({ msg_type: 'counter', price: 95.00, reason: "Best we can offer is $95." });
});

app.listen(8080);
```

---

## 6. API Reference

### 6.1 `ClinchCore` (Buyer Client)

#### `new ClinchCore(config)`
*   `config.registryUrl` *(string)*: Optional. Direct override pointing to a local development registry.
*   `config.timeoutMs` *(number)*: Network connection timeout limit (Default: `5000`ms).

#### `async initialize(cachedToken?)`
Resolves network configurations, computes Proof-of-Work proof, and opens active WebSocket channels.
*   `cachedToken` *(string)*: Optional. Pastes a previous registry authorization token to skip PoW calculations on startup.

#### `async negotiate(address, constraints)`
Initializes the cryptographic handshake with a seller. Returns `sessionId`.
*   `address` *(string)*: Target address formatted strictly as `PROTOCOL_MODE.domain` (e.g., `ANP/C.amazon.anp`).
*   `constraints` *(ConstraintVector)*: Schema requiring `max_budget` (number) and `item` (string).

#### `exportSessionState(sessionId)` / `importSessionState(serializedData)`
Serializes or de-serializes all in-flight state for a given session, including ephemeral Ed25519 keys, state metrics, and local sandbox parameters, into an exchangeable JSON string.

#### `registerSecret(domain, key, name?)` / `clearSecret(domain)`
Saves or clears an API secret locally. The key is never visible to the AI agent and is silently passed in handshake payloads to the designated domain.

#### `async negotiateCascade(category, constraints, maxSellers?, strategy?)`
Queries the discovery register and cascade-negotiates with matching nodes.
*   `strategy`: `'sequential'` (Sequential Squeeze) or `'parallel'` (Concurrent Race). Default: `'sequential'`.

#### `buildAgentPrompt(sessionId, incomingMessage)`
Assembles a contextual, structure-compliant system prompt for external LLMs to ensure compliant JSON execution.

#### `async sendCounter(sessionId, price, reason)`
Signs and dispatches a standard counter-offer to the seller endpoint.

#### `async exitSession(sessionId)`
Stops the live execution channel and requests a callback token.

---

### 6.2 `ClinchSeller` (Seller Client)

#### `new ClinchSeller(config)`
*   `config.privateKeyHex` *(string)*: The permanent Ed25519 private key generated via the registration interface.
*   `config.registryUrl` *(string)*: Optional. Point to a dev registry for local testing.

#### `async registerEndpoint(record)`
Locally signs and publishes dynamic endpoint mappings and categories to the discovery registry.

#### `verifyBuyerSignature(payload, signatureHex, buyerPubKeyHex)`
Verifies that the provided turn payload matches the cryptographic signature produced by the session's ephemeral public key.

---

## 7. Cryptographic Properties

Clinch relies entirely on zero-trust cryptography to maintain buyer privacy and seller authenticity:

1. **Proof-of-Work Binding**: The PoW challenge solution includes the client's public key hash, ensuring challenges cannot be pre-computed or farmed.
2. **Ephemeral Session Keypairs**: Calling `negotiate()` generates a single-use keypair (`nacl.sign.keyPair()`). This ephemeral key signs every message sent within the session context. In the event of a key compromise, your permanent global identity remains secure, and historical session logs are completely unlinkable.
3. **Decoupled Verification**: Agreement artifacts are sequentially co-signed by the buyer's session key, the seller's verified identity key, and countersigned by the active registry key. This provides independent verification offline using only the registry's public key chain.
