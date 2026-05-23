"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ClinchCore = void 0;
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
// THE CLINCH CORE LIBRARY
// ============================================================================
class ClinchCore extends events_1.EventEmitter {
    isInitialized = false;
    config;
    cachedRegistryUrl = null;
    jwtToken = null;
    // Agent Identity Keypair (Long-lived, used for Auth, NEVER for session messages)
    identityPrivKey;
    identityPubKey;
    // Active Sessions & Ephemeral Keys
    activeSessions = new Map();
    ws = null;
    constructor(config = {}) {
        super();
        this.config = config;
        // Generate Identity Key
        const keyPair = tweetnacl_1.default.sign.keyPair();
        this.identityPrivKey = keyPair.secretKey;
        this.identityPubKey = toHex(keyPair.publicKey);
        if (this.config.registryUrl) {
            this.cachedRegistryUrl = this.config.registryUrl;
        }
    }
    // --------------------------------------------------------------------------
    // INITIALIZATION & AUTH
    // --------------------------------------------------------------------------
    async initialize(cachedToken) {
        if (this.isInitialized)
            return;
        try {
            await this.getRegistryUrl();
            if (cachedToken) {
                this.jwtToken = cachedToken;
                this.emit('log', "[Core] Restored session from cached JWT. Skipping PoW.");
            }
            else {
                await this.registerNode();
            }
            await this.connectWebSocket();
            this.isInitialized = true;
            this.emit('initialized', { pubKey: this.identityPubKey, registry: this.cachedRegistryUrl });
        }
        catch (error) {
            this.emit('error', error);
            throw error;
        }
    }
    async registerNode() {
        this.emit('log', "[Core] No cached token found. Requesting PoW challenge...");
        const challenge = await this.networkRequest('/api/auth/challenge', {}, false);
        const powSolution = await this.solvePoW(challenge.nonce, challenge.difficulty);
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
    async getRegistryUrl(forceRefresh = false) {
        if (this.cachedRegistryUrl && !forceRefresh)
            return this.cachedRegistryUrl;
        const res = await fetch(FIREBASE_CONFIG_URL);
        const text = await res.text();
        try {
            const config = JSON.parse(text);
            this.cachedRegistryUrl = config.registry_nodes[PROTOCOL_VERSION];
            return this.cachedRegistryUrl;
        }
        catch (err) {
            throw new Error(`Failed to parse Firebase config.`);
        }
    }
    async networkRequest(endpoint, options = {}, requireAuth = true) {
        const baseUrl = await this.getRegistryUrl();
        const headers = { ...options.headers };
        if (requireAuth && this.jwtToken) {
            headers['Authorization'] = `Bearer ${this.jwtToken}`;
        }
        const res = await fetch(`${baseUrl}${endpoint}`, { ...options, headers });
        const text = await res.text();
        if (!res.ok)
            throw new Error(`HTTP ${res.status} on ${endpoint}: ${text}`);
        return JSON.parse(text);
    }
    // --------------------------------------------------------------------------
    // WEBSOCKET CONNECTION
    // --------------------------------------------------------------------------
    async connectWebSocket() {
        return new Promise((resolve, reject) => {
            const wsUrl = this.cachedRegistryUrl.replace(/^http/, 'ws');
            this.ws = new ws_1.default(wsUrl);
            this.ws.on('open', () => {
                this.ws.send(JSON.stringify({ type: 'AUTH', token: this.jwtToken }));
            });
            this.ws.on('message', (data) => {
                const msg = JSON.parse(data.toString());
                if (msg.type === 'AUTH_SUCCESS') {
                    this.emit('log', '[Core] WebSocket authenticated & listening.');
                    resolve();
                }
                if (msg.type === 'CALLBACK') {
                    this.emit('callback_received', {
                        sessionId: msg.session_id,
                        payload: msg.payload
                    });
                    this.ws.send(JSON.stringify({ type: 'ACK', id: msg.id }));
                }
                if (msg.type === 'ERROR') {
                    this.emit('error', new Error(msg.message));
                }
            });
            this.ws.on('error', (err) => {
                this.emit('error', err);
                reject(err);
            });
            this.ws.on('close', () => {
                this.emit('log', '[Core] WebSocket disconnected.');
            });
        });
    }
    disconnect() {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
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
        const signedPayload = { ...initPayload, sig: signature };
        const response = await this.networkRequest(`/api/route/${parsed.domain}/handshake`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(signedPayload)
        });
        const sessionId = response.session_id;
        this.activeSessions.set(sessionId, {
            sessionId,
            sellerId: parsed.domain,
            keyPair: ephemeralKeys,
            status: 'ACTIVE'
        });
        this.emit('session_started', { sessionId, sellerId: parsed.domain });
        return sessionId;
    }
    async exitSession(sessionId) {
        const session = this.activeSessions.get(sessionId);
        if (!session)
            throw new Error("Session not found or not active");
        const res = await this.networkRequest(`/api/route/${sessionId}/exit`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ seller_id: session.sellerId })
        });
        session.status = 'EXITED';
        session.exitTokenHash = res.token_hash;
        this.emit('session_exited', { sessionId, token_hash: res.token_hash });
        return res.token_hash;
    }
    // --------------------------------------------------------------------------
    // UTILITIES
    // --------------------------------------------------------------------------
    parseAddress(address) {
        const parts = address.split('.');
        if (parts.length < 2)
            throw new Error("Invalid Address Format. Expected MODE.DOMAIN.anp");
        return {
            mode: parts[0],
            domain: parts.slice(1).join('.').toLowerCase(),
            route: '/'
        };
    }
    async solvePoW(nonce, difficultyBits) {
        this.emit('pow_started', { difficulty: difficultyBits });
        let counter = 0;
        const CHUNK_SIZE = 5000;
        while (true) {
            for (let i = 0; i < CHUNK_SIZE; i++) {
                const attempt = counter.toString();
                const hashArray = js_sha256_1.sha256.create().update(nonce + this.identityPubKey + attempt).array();
                if (this.hasLeadingZeroBits(hashArray, difficultyBits)) {
                    this.emit('pow_solved', { attempts: counter });
                    return attempt;
                }
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
