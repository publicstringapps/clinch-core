"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ClinchSeller = exports.ClinchCore = void 0;
const events_1 = require("events");
const tweetnacl_1 = __importDefault(require("tweetnacl"));
const js_sha256_1 = require("js-sha256");
const ws_1 = __importDefault(require("ws"));
// ============================================================================
// CONFIGURATION & UTILS
// ============================================================================
const PROTOCOL_VERSION = "0.1.0";
const FIREBASE_CONFIG_URL = "https://clinchprotocol.web.app/network-config.json";
function toHex(arr) {
    return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}
// ============================================================================
// THE CLINCH CORE LIBRARY (Buyer)
// ============================================================================
class ClinchCore extends events_1.EventEmitter {
    config;
    cachedRegistryUrl = null;
    status = 'OFFLINE';
    reconnectAttempts = 0;
    maxReconnectDelay = 30000;
    jwtToken = null;
    identityPrivKey;
    identityPubKey;
    activeSessions = new Map();
    ws = null;
    // Sandbox Engine
    isSandboxMode = false;
    sandboxContext = null;
    sandboxSequence = null;
    sandboxSession = null;
    sandboxMaxTurns = 6;
    currentTurn = 0;
    lastKnownPrice = 0;
    activeNegotiationId = null;
    constructor(config = {}) {
        super();
        this.config = { timeoutMs: 5000, ...config };
        const keyPair = tweetnacl_1.default.sign.keyPair();
        this.identityPrivKey = keyPair.secretKey;
        this.identityPubKey = toHex(keyPair.publicKey);
        if (this.config.registryUrl) {
            this.cachedRegistryUrl = this.config.registryUrl;
        }
    }
    setStatus(newStatus) {
        if (this.status !== newStatus) {
            this.status = newStatus;
            this.emit('status_changed', this.status);
            if (this.status === 'IDLE')
                this.emit('log', `🟢 [State] ONLINE & IDLE`);
            else if (this.status === 'ERROR')
                this.emit('log', `🔴 [State] ERROR`);
            else if (this.status === 'NEGOTIATING')
                this.emit('log', `⚡ [State] NEGOTIATING (Turn ${this.currentTurn})`);
            else
                this.emit('log', `🟡 [State] ${this.status}`);
        }
    }
    async initialize(cachedToken) {
        if (this.status === 'IDLE' || this.status === 'CONNECTING')
            return;
        this.setStatus('CONNECTING');
        try {
            this.emit('log', '[Network] Fetching registry configuration...');
            await this.getRegistryUrl();
            if (cachedToken) {
                this.jwtToken = cachedToken;
                this.emit('log', "[Auth] Restored session from cached JWT. Skipping PoW.");
            }
            else {
                await this.registerNode();
            }
            await this.connectWebSocket();
            this.emit('initialized', { pubKey: this.identityPubKey, registry: this.cachedRegistryUrl });
        }
        catch (error) {
            this.setStatus('ERROR');
            this.emit('error', new Error(`Initialization failed: ${error.message}`));
            setTimeout(() => this.initialize(cachedToken), 5000);
        }
    }
    async getRegistryUrl(forceRefresh = false) {
        if (this.cachedRegistryUrl && !forceRefresh)
            return this.cachedRegistryUrl;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
        try {
            const res = await fetch(FIREBASE_CONFIG_URL, { signal: controller.signal });
            clearTimeout(timeout);
            const text = await res.text();
            const config = JSON.parse(text);
            this.cachedRegistryUrl = config.registry_nodes[PROTOCOL_VERSION];
            return this.cachedRegistryUrl;
        }
        catch (err) {
            clearTimeout(timeout);
            throw new Error(`Registry config fetch failed: ${err.message}`);
        }
    }
    async networkRequest(endpoint, options = {}, requireAuth = true) {
        const baseUrl = await this.getRegistryUrl();
        const headers = { ...options.headers };
        if (requireAuth && this.jwtToken)
            headers['Authorization'] = `Bearer ${this.jwtToken}`;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
        try {
            const res = await fetch(`${baseUrl}${endpoint}`, { ...options, headers, signal: controller.signal });
            clearTimeout(timeout);
            const text = await res.text();
            if (!res.ok)
                throw new Error(`HTTP ${res.status}: ${text}`);
            return JSON.parse(text);
        }
        catch (err) {
            clearTimeout(timeout);
            throw new Error(`Network request to ${endpoint} failed: ${err.message}`);
        }
    }
    async registerNode() {
        this.emit('log', "[Auth] Requesting PoW challenge from registry...");
        const challenge = await this.networkRequest('/api/auth/challenge', {}, false);
        const powSolution = await this.solvePoW(challenge.nonce, challenge.difficulty);
        this.emit('log', "[Auth] Submitting PoW solution...");
        const authRes = await this.networkRequest('/api/auth/verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                challenge_id: challenge.challenge_id,
                pow_solution: powSolution,
                pubKey: this.identityPubKey
            })
        }, false);
        this.jwtToken = authRes.token;
        this.emit('token_issued', { token: this.jwtToken });
    }
    async connectWebSocket() {
        return new Promise((resolve, reject) => {
            const wsUrl = this.cachedRegistryUrl.replace(/^http/, 'ws');
            this.emit('log', `[Network] Connecting to WebSocket at ${wsUrl}...`);
            this.ws = new ws_1.default(wsUrl);
            const connectionTimeout = setTimeout(() => {
                if (this.ws?.readyState !== ws_1.default.OPEN) {
                    this.ws?.close();
                    reject(new Error("WebSocket connection timeout"));
                }
            }, this.config.timeoutMs);
            this.ws.on('open', () => {
                clearTimeout(connectionTimeout);
                this.reconnectAttempts = 0;
                this.emit('log', '[Network] WebSocket connected. Sending AUTH...');
                this.ws.send(JSON.stringify({ type: 'AUTH', token: this.jwtToken }));
            });
            this.ws.on('message', (data) => {
                const msg = JSON.parse(data.toString());
                if (msg.type === 'AUTH_SUCCESS') {
                    this.setStatus('IDLE');
                    resolve();
                }
                if (msg.type === 'CALLBACK') {
                    this.emit('log', `🔔 [Network] Received callback for session ${msg.session_id}`);
                    this.emit('callback_received', { sessionId: msg.session_id, payload: msg.payload });
                    this.ws.send(JSON.stringify({ type: 'ACK', id: msg.id }));
                }
            });
            this.ws.on('error', (err) => {
                clearTimeout(connectionTimeout);
                if (this.status === 'CONNECTING')
                    reject(err);
            });
            this.ws.on('close', () => {
                clearTimeout(connectionTimeout);
                if (this.status !== 'OFFLINE')
                    this.handleReconnect();
            });
        });
    }
    handleReconnect() {
        this.setStatus('RECONNECTING');
        this.reconnectAttempts++;
        const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), this.maxReconnectDelay);
        setTimeout(() => this.connectWebSocket().catch(() => { }), delay);
    }
    disconnect() {
        this.setStatus('OFFLINE');
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
    }
    // --------------------------------------------------------------------------
    // UNIVERSAL PROMPT BUILDER
    // --------------------------------------------------------------------------
    /**
     * Generates a universally formatted System Prompt for external LLMs (Claude, OpenAI, Gemini).
     * Developers can pass this string directly to their AI to ensure protocol-compliant negotiation.
     */
    buildAgentPrompt(sessionId, incomingMessage) {
        const session = this.activeSessions.get(sessionId);
        if (!session)
            throw new Error("Cannot build prompt: Session not found.");
        const gap = this.lastKnownPrice - session.constraints.max_budget;
        const gapText = gap > 0 ? `-$${gap} (Over budget)` : `+$${Math.abs(gap)} (Under budget)`;
        return `You are a professional AI purchasing agent negotiating via the Clinch Protocol.
Your only goal is to secure the requested item below the maximum budget.

NEGOTIATION STATE:
- Item: ${session.constraints.item}
- Category: ${session.constraints.category || 'General'}
- Your absolute max budget: $${session.constraints.max_budget}
- Current turn: ${this.currentTurn}
- Last seller price: $${this.lastKnownPrice}
- Gap to budget: ${gapText}

SELLER'S LATEST MESSAGE:
"${incomingMessage}"

STRATEGY GUIDELINES:
- Turns 1-2: Open roughly 20-30% below budget to establish an anchor. Be professional but firm.
- Turns 3-5: Move in small, calculated increments (3-5%).
- Turn 6+: Issue a final, compelling offer.
- If the seller's price is at or below your max budget: You MUST choose "accept".

OUTPUT FORMAT:
You MUST respond ONLY in valid JSON matching this exact schema. Do not include markdown blocks (like \`\`\`json).
{
  "action": "counter" | "accept" | "exit",
  "price": <numeric value, no currency symbols>,
  "message": "<One concise sentence of negotiation dialogue>"
}`;
    }
    // --------------------------------------------------------------------------
    // PROTOCOL OPERATIONS
    // --------------------------------------------------------------------------
    async search(query, mode) {
        let url = `/api/discover?category=${encodeURIComponent(query)}`;
        if (mode)
            url += `&mode=${encodeURIComponent(mode)}`;
        return await this.networkRequest(url);
    }
    async negotiate(address, constraints) {
        this.emit('log', `[Protocol] Initiating handshake with ${address}...`);
        const parsed = this.parseAddress(address);
        const ephemeralKeys = tweetnacl_1.default.sign.keyPair();
        const ephemeralPubHex = toHex(ephemeralKeys.publicKey);
        const initPayload = {
            clinch_version: PROTOCOL_VERSION,
            mode: parsed.mode,
            constraints,
            session_pub_key: ephemeralPubHex,
            timestamp_utc: new Date().toISOString()
        };
        const msgUint8 = new TextEncoder().encode(JSON.stringify(initPayload));
        const signature = toHex(tweetnacl_1.default.sign.detached(msgUint8, ephemeralKeys.secretKey));
        const response = await this.networkRequest(`/api/route/${parsed.domain}/handshake`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...initPayload, sig: signature })
        });
        this.activeSessions.set(response.session_id, {
            sessionId: response.session_id,
            sellerId: parsed.domain,
            keyPair: ephemeralKeys,
            status: 'ACTIVE',
            constraints
        });
        this.activeNegotiationId = response.session_id;
        this.currentTurn = 1;
        this.setStatus('NEGOTIATING');
        return response.session_id;
    }
    async sendCounter(sessionId, price, reason) {
        const session = this.activeSessions.get(sessionId);
        if (!session)
            throw new Error("Active session not found");
        const payload = { session_id: sessionId, turn: this.currentTurn, price, reason };
        const buyer_sig = toHex(tweetnacl_1.default.sign.detached(new TextEncoder().encode(JSON.stringify(payload)), session.keyPair.secretKey));
        await this.networkRequest(`/api/route/${session.sellerId}/counter`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...payload, buyer_sig })
        });
    }
    async exitSession(sessionId) {
        const session = this.activeSessions.get(sessionId);
        if (!session)
            throw new Error("Session not found");
        const res = await this.networkRequest(`/api/route/${sessionId}/exit`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ seller_id: session.sellerId })
        });
        session.status = 'EXITED';
        session.exitTokenHash = res.token_hash;
        return res.token_hash;
    }
    // --------------------------------------------------------------------------
    // OUT-OF-THE-BOX SANDBOX (AUTO-TURN ENGINE)
    // --------------------------------------------------------------------------
    async sandbox(config = {}) {
        this.isSandboxMode = true;
        this.sandboxMaxTurns = config.maxTurns || 6;
        await this.initialize();
        await this.setupSandbox(config);
        this.on('callback_received', async (event) => {
            if (!this.isSandboxMode)
                return;
            await this.handleAutomaticSandboxTurn(event.sessionId, event.payload);
        });
        this.emit('log', "⚙️ [Sandbox] Auto-Negotiation engine bound and active.");
    }
    async setupSandbox(config = {}) {
        const settings = {
            downloadLLM: true,
            modelUrl: "https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf",
            modelPath: "./qwen2.5-1.5b-instruct-q4_k_m.gguf",
            ...config
        };
        // DYNAMIC IMPORTS: Won't break Webpack/Metro unless sandbox() is actually called!
        let nodeLlama;
        try {
            nodeLlama = await Promise.resolve().then(() => __importStar(require('node-llama-cpp')));
        }
        catch (e) {
            throw new Error("Sandbox requires 'node-llama-cpp'. Run: npm install node-llama-cpp");
        }
        const fs = await Promise.resolve().then(() => __importStar(require('fs')));
        const path = await Promise.resolve().then(() => __importStar(require('path')));
        const os = await Promise.resolve().then(() => __importStar(require('os')));
        const resolvedPath = path.resolve(settings.modelPath);
        if (!fs.existsSync(resolvedPath)) {
            if (!settings.downloadLLM)
                throw new Error(`Model missing at ${resolvedPath}`);
            this.emit('log', `[Sandbox] Downloading Qwen 1.5B Q4_K_M (1.1GB)...`);
            const { pipeline } = await Promise.resolve().then(() => __importStar(require('stream/promises')));
            const { Readable } = await Promise.resolve().then(() => __importStar(require('stream')));
            // @ts-ignore
            const response = await fetch(settings.modelUrl);
            if (!response.ok)
                throw new Error("Fetch failed: " + response.statusText);
            const fileStream = fs.createWriteStream(resolvedPath);
            await pipeline(Readable.fromWeb(response.body), fileStream);
            this.emit('log', "[Sandbox] Download complete.");
        }
        const llama = await nodeLlama.getLlama();
        const model = await llama.loadModel({ modelPath: resolvedPath });
        this.sandboxContext = await model.createContext({
            contextSize: 2048,
            threads: Math.min(4, Math.max(1, os.cpus().length - 1)),
            batchSize: 512
        });
    }
    async handleAutomaticSandboxTurn(sessionId, payload) {
        const session = this.activeSessions.get(sessionId);
        if (!session)
            return;
        this.currentTurn++;
        this.setStatus('NEGOTIATING');
        const incomingPrice = this.extractPrice(payload.message || JSON.stringify(payload), 'Counter');
        if (incomingPrice !== null)
            this.lastKnownPrice = incomingPrice;
        if (this.lastKnownPrice <= session.constraints.max_budget) {
            this.setStatus('CONVERGED');
            this.activeSessions.delete(sessionId);
            return;
        }
        if (this.currentTurn > this.sandboxMaxTurns) {
            this.setStatus('STALEMATE');
            await this.exitSession(sessionId);
            return;
        }
        const modelResponse = await this.sandboxEvaluate(session, payload.message || `The price is $${this.lastKnownPrice}`);
        const parsedOffer = this.extractPrice(modelResponse, 'Offer');
        const reasonLine = modelResponse.split('\n').find(l => l.startsWith('Reason:'));
        const reason = reasonLine ? reasonLine.replace('Reason:', '').trim() : "Suggesting a fair counter-offer.";
        if (parsedOffer !== null) {
            const finalOffer = Math.min(parsedOffer, session.constraints.max_budget);
            await this.sendCounter(sessionId, finalOffer, reason);
        }
    }
    async sandboxEvaluate(session, incomingOffer) {
        const { LlamaChatSession, ChatMLChatWrapper } = await Promise.resolve().then(() => __importStar(require('node-llama-cpp')));
        const systemPrompt = this.buildAgentPrompt(session.sessionId, incomingOffer);
        if (this.sandboxSequence)
            this.sandboxSequence.dispose();
        this.sandboxSequence = this.sandboxContext.getSequence();
        this.sandboxSession = new LlamaChatSession({
            contextSequence: this.sandboxSequence,
            systemPrompt: systemPrompt,
            chatWrapper: new ChatMLChatWrapper()
        });
        let responseText = "";
        await this.sandboxSession.prompt(incomingOffer, {
            maxTokens: 80,
            onTextChunk: (chunk) => { responseText += chunk; }
        });
        return responseText;
    }
    // --------------------------------------------------------------------------
    // UTILITIES
    // --------------------------------------------------------------------------
    extractPrice(text, prefix) {
        const regex = new RegExp(`${prefix}\\s*\\:?\\s*\\$?(\\d+(?:\\.\\d{2})?)`, 'i');
        const match = text.match(regex);
        if (match)
            return parseFloat(match[1]);
        const fallbackRegex = /"price"\s*:\s*(\d+(?:\.\d{2})?)/i;
        const fallbackMatch = text.match(fallbackRegex);
        return fallbackMatch ? parseFloat(fallbackMatch[1]) : null;
    }
    parseAddress(address) {
        const parts = address.split('.');
        if (parts.length < 2)
            throw new Error("Invalid Address Format");
        return { mode: parts[0], domain: parts.slice(1).join('.').toLowerCase(), route: '/' };
    }
    async solvePoW(nonce, difficultyBits) {
        let counter = 0;
        const CHUNK_SIZE = 10000;
        while (true) {
            for (let i = 0; i < CHUNK_SIZE; i++) {
                const attempt = counter.toString();
                const hashArray = js_sha256_1.sha256.create().update(nonce + this.identityPubKey + attempt).array();
                if (this.hasLeadingZeroBits(hashArray, difficultyBits))
                    return attempt;
                counter++;
            }
            await new Promise(resolve => setTimeout(resolve, 0));
        }
    }
    hasLeadingZeroBits(hash, bits) {
        let zeroBits = 0;
        for (const byte of hash) {
            if (byte === 0)
                zeroBits += 8;
            else {
                zeroBits += Math.clz32(byte) - 24;
                break;
            }
        }
        return zeroBits >= bits;
    }
}
exports.ClinchCore = ClinchCore;
class ClinchSeller extends events_1.EventEmitter {
    config;
    cachedRegistryUrl = null;
    sellerAuthToken = null;
    identityPrivKey;
    identityPubKey;
    constructor(config = {}) {
        super();
        this.config = { timeoutMs: 5000, ...config };
        const keyPair = tweetnacl_1.default.sign.keyPair();
        this.identityPrivKey = keyPair.secretKey;
        this.identityPubKey = toHex(keyPair.publicKey);
        if (this.config.registryUrl)
            this.cachedRegistryUrl = this.config.registryUrl;
    }
    async authenticate(authToken) {
        this.sellerAuthToken = authToken;
        if (!this.cachedRegistryUrl) {
            const res = await fetch(FIREBASE_CONFIG_URL);
            const config = JSON.parse(await res.text());
            this.cachedRegistryUrl = config.registry_nodes[PROTOCOL_VERSION];
        }
    }
    async registerEndpoint(record) {
        if (!this.sellerAuthToken)
            throw new Error("Must call authenticate() first.");
        const payload = {
            ...record,
            public_key: this.identityPubKey,
            record_sig: this.signData(record)
        };
        const res = await fetch(`${this.cachedRegistryUrl}/api/dashboard/sellers/register`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.sellerAuthToken}`
            },
            body: JSON.stringify(payload)
        });
        if (!res.ok)
            throw new Error(`Registration failed: ${await res.text()}`);
        return await res.json();
    }
    verifyBuyerSignature(payload, signatureHex, buyerSessionPubKeyHex) {
        try {
            const msgUint8 = new TextEncoder().encode(JSON.stringify(payload));
            const sigUint8 = new Uint8Array(signatureHex.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
            const pubKeyUint8 = new Uint8Array(buyerSessionPubKeyHex.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
            return tweetnacl_1.default.sign.detached.verify(msgUint8, sigUint8, pubKeyUint8);
        }
        catch (e) {
            return false;
        }
    }
    signData(data) {
        const msgUint8 = new TextEncoder().encode(JSON.stringify(data));
        return toHex(tweetnacl_1.default.sign.detached(msgUint8, this.identityPrivKey));
    }
}
exports.ClinchSeller = ClinchSeller;
