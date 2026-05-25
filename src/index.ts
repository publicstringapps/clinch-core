import { EventEmitter } from 'events';
import nacl from 'tweetnacl';
import { sha256 } from 'js-sha256';
import WebSocket from 'ws';

// ============================================================================
// CONFIGURATION & UTILS
// ============================================================================
const PROTOCOL_VERSION = "0.1.0";
const FIREBASE_CONFIG_URL = "https://clinchprotocol.web.app/network-config.json";

function toHex(arr: Uint8Array | number[]): string {
    return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex: string): Uint8Array {
    const clean = hex.replace(/[^0-9a-fA-F]/g, '');
    const match = clean.match(/.{1,2}/g);
    if (!match) return new Uint8Array(0);
    return new Uint8Array(match.map(byte => parseInt(byte, 16)));
}

// ============================================================================
// TYPES & INTERFACES
// ============================================================================
export type CoreStatus =
    | 'OFFLINE'
    | 'CONNECTING'
    | 'IDLE'
    | 'RECONNECTING'
    | 'ERROR'
    | 'NEGOTIATING'
    | 'CONVERGED'
    | 'STALEMATE';

export interface ParsedAddress {
    mode: string;
    domain: string;
    route: string;
}

export interface ClinchConfig {
    registryUrl?: string;
    timeoutMs?: number;
}

export interface ConstraintVector {
    intent: string;
    category?: string;
    max_budget: number;
    [key: string]: any;
}

export interface SessionState {
    sessionId: string;
    sellerId: string;
    keyPair: nacl.SignKeyPair;
    status: 'ACTIVE' | 'EXITED' | 'CLOSED';
    exitTokenHash?: string;
    constraints: ConstraintVector;
    
    currentTurn: number;
    lastKnownPrice: number;

    sandboxSequence?: any; 
    sandboxSession?: any;
}

export interface SandboxConfig {
    downloadLLM?: boolean;
    modelUrl?: string;
    modelPath?: string;
    maxTurns?: number;
}

export interface AgentAdapter {
  evaluateOffer(sessionState: any, constraints: any): Promise<any>;
}

// ============================================================================
// THE CLINCH CORE LIBRARY (Buyer)
// ============================================================================

export class ClinchCore extends EventEmitter {
    private config: ClinchConfig;
    private cachedRegistryUrl: string | null = null;

    public status: CoreStatus = 'OFFLINE';
    private reconnectAttempts = 0;
    private maxReconnectDelay = 30000;

    public jwtToken: string | null = null;
    private identityPrivKey: Uint8Array;
    public identityPubKey: string;

    private activeSessions = new Map<string, SessionState>();
    private ws: WebSocket | null = null;

    // Blind Key Pass Local Secret Store
    private localSecrets = new Map<string, { key: string, name?: string }>();

    private isSandboxMode = false;
    private sandboxModelContext: any = null;
    private sandboxMaxTurns = 6;

    public get activeNegotiationId(): string | null {
        return Array.from(this.activeSessions.keys()).pop() || null;
    }

    constructor(config: ClinchConfig = {}) {
        super();
        this.config = { timeoutMs: 5000, ...config };

        const keyPair = nacl.sign.keyPair();
        this.identityPrivKey = keyPair.secretKey;
        this.identityPubKey = toHex(keyPair.publicKey);

        if (this.config.registryUrl) {
            this.cachedRegistryUrl = this.config.registryUrl;
        }
    }

    private setStatus(newStatus: CoreStatus) {
        if (this.status !== newStatus) {
            this.status = newStatus;
            this.emit('status_changed', this.status);

            if (this.status === 'IDLE') this.emit('log', `🟢 [State] ONLINE & IDLE`);
            else if (this.status === 'ERROR') this.emit('log', `🔴 [State] ERROR`);
            else this.emit('log', `🟡 [State] ${this.status}`);
        }
    }

    // --------------------------------------------------------------------------
    // BLIND KEY PASS MANAGERS (Silent API Key Handshake)
    // --------------------------------------------------------------------------
    public registerSecret(domain: string, key: string, name?: string): void {
        const normalizedDomain = domain.toLowerCase().trim();
        this.localSecrets.set(normalizedDomain, { key, name });
        this.emit('log', `[Security] Blind key registered for ${normalizedDomain} (${name || 'Unnamed'})`);
    }

    public clearSecret(domain: string): void {
        const normalizedDomain = domain.toLowerCase().trim();
        this.localSecrets.delete(normalizedDomain);
    }

    async initialize(cachedToken?: string): Promise<void> {
        if (this.status === 'IDLE' || this.status === 'CONNECTING') return;
        this.setStatus('CONNECTING');

        try {
            this.emit('log', '[Network] Fetching registry configuration...');
            await this.getRegistryUrl();

            if (cachedToken) {
                this.jwtToken = cachedToken;
                this.emit('log', "[Auth] Restored session from cached JWT. Skipping PoW.");
            } else {
                await this.registerNode();
            }

            await this.connectWebSocket();
            this.emit('initialized', { pubKey: this.identityPubKey, registry: this.cachedRegistryUrl });
        } catch (error: any) {
            this.setStatus('ERROR');
            this.emit('error', new Error(`Initialization failed: ${error.message}`));
            setTimeout(() => this.initialize(cachedToken), 5000);
        }
    }

    private async getRegistryUrl(forceRefresh = false): Promise<string> {
        if (this.cachedRegistryUrl && !forceRefresh) return this.cachedRegistryUrl;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
        try {
            const res = await fetch(FIREBASE_CONFIG_URL, { signal: controller.signal });
            clearTimeout(timeout);
            const text = await res.text();
            const config = JSON.parse(text);
            this.cachedRegistryUrl = config.registry_nodes[PROTOCOL_VERSION];
            return this.cachedRegistryUrl!;
        } catch (err: any) {
            clearTimeout(timeout);
            throw new Error(`Registry config fetch failed: ${err.message}`);
        }
    }

    private async networkRequest(endpoint: string, options: any = {}, requireAuth = true): Promise<any> {
        const baseUrl = await this.getRegistryUrl();
        const headers: any = { ...options.headers };
        if (requireAuth && this.jwtToken) headers['Authorization'] = `Bearer ${this.jwtToken}`;

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
        try {
            const res = await fetch(`${baseUrl}${endpoint}`, { ...options, headers, signal: controller.signal });
            clearTimeout(timeout);
            const text = await res.text();
            if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
            return JSON.parse(text);
        } catch (err: any) {
            clearTimeout(timeout);
            throw new Error(`Network request to ${endpoint} failed: ${err.message}`);
        }
    }

    private async registerNode(): Promise<void> {
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

    private async connectWebSocket(): Promise<void> {
        return new Promise((resolve, reject) => {
            const wsUrl = this.cachedRegistryUrl!.replace(/^http/, 'ws');
            this.emit('log', `[Network] Connecting to WebSocket at ${wsUrl}...`);

            this.ws = new WebSocket(wsUrl);
            const connectionTimeout = setTimeout(() => {
                if (this.ws?.readyState !== WebSocket.OPEN) {
                    this.ws?.close();
                    reject(new Error("WebSocket connection timeout"));
                }
            }, this.config.timeoutMs);

            this.ws.on('open', () => {
                clearTimeout(connectionTimeout);
                this.reconnectAttempts = 0;
                this.emit('log', '[Network] WebSocket connected. Sending AUTH...');
                this.ws!.send(JSON.stringify({ type: 'AUTH', token: this.jwtToken }));
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
                    this.ws!.send(JSON.stringify({ type: 'ACK', id: msg.id }));
                }
            });

            this.ws.on('error', (err: any) => {
                clearTimeout(connectionTimeout);
                if (this.status === 'CONNECTING') reject(err);
            });

            this.ws.on('close', () => {
                clearTimeout(connectionTimeout);
                if (this.status !== 'OFFLINE') this.handleReconnect();
            });
        });
    }

    private handleReconnect() {
        this.setStatus('RECONNECTING');
        this.reconnectAttempts++;
        const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), this.maxReconnectDelay);
        setTimeout(() => this.connectWebSocket().catch(() => {}), delay);
    }

    public disconnect() {
        this.setStatus('OFFLINE');
        if (this.ws) { this.ws.close(); this.ws = null; }
    }

    public exportSessionState(sessionId: string): string {
        const session = this.activeSessions.get(sessionId);
        if (!session) throw new Error("Session not found");

        const exportable = {
            sessionId: session.sessionId,
            sellerId: session.sellerId,
            status: session.status,
            exitTokenHash: session.exitTokenHash,
            constraints: session.constraints,
            currentTurn: session.currentTurn,
            lastKnownPrice: session.lastKnownPrice,
            ephemeralSecretKeyHex: toHex(session.keyPair.secretKey)
        };

        return JSON.stringify(exportable);
    }

    public importSessionState(serializedData: string): void {
        const data = JSON.parse(serializedData);
        const secretKey = fromHex(data.ephemeralSecretKeyHex);
        const keyPair = nacl.sign.keyPair.fromSecretKey(secretKey);

        this.activeSessions.set(data.sessionId, {
            sessionId: data.sessionId,
            sellerId: data.sellerId,
            status: data.status,
            exitTokenHash: data.exitTokenHash,
            constraints: data.constraints,
            currentTurn: data.currentTurn,
            lastKnownPrice: data.lastKnownPrice,
            keyPair: keyPair
        });

        this.emit('log', `[State] Rehydrated session ${data.sessionId} pointing at ${data.sellerId}`);
    }

    public getSession(sessionId: string): SessionState | undefined {
        return this.activeSessions.get(sessionId);
    }

    public buildAgentPrompt(sessionId: string, incomingMessage: string): string {
        const session = this.activeSessions.get(sessionId);
        if (!session) throw new Error("Cannot build prompt: Session not found.");

        const gap = session.lastKnownPrice - session.constraints.max_budget;
        const gapText = gap > 0 ? `-$${gap} (Over budget)` : `+$${Math.abs(gap)} (Under budget)`;

        return `You are a professional AI purchasing agent negotiating via the Clinch Protocol.
Your only goal is to secure the requested item below the maximum budget.

NEGOTIATION STATE:
- Item: ${session.constraints.item}
- Category: ${session.constraints.category || 'General'}
- Your absolute max budget: $${session.constraints.max_budget}
- Current turn: ${session.currentTurn}
- Last seller price: $${session.lastKnownPrice}
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

    async search(query: string, mode?: string): Promise<any> {
        let url = `/api/discover?category=${encodeURIComponent(query)}`;
        if (mode) url += `&mode=${encodeURIComponent(mode)}`;
        return await this.networkRequest(url);
    }

    async negotiate(address: string, constraints: ConstraintVector): Promise<string> {
        this.emit('log', `[Protocol] Initiating handshake with ${address}...`);
        const parsed = this.parseAddress(address);

        const ephemeralKeys = nacl.sign.keyPair();
        const ephemeralPubHex = toHex(ephemeralKeys.publicKey);

        const blindSecret = this.localSecrets.get(parsed.domain);

        const initPayload: any = {
            clinch_version: PROTOCOL_VERSION,
            mode: parsed.mode,
            constraints,
            session_pub_key: ephemeralPubHex,
            timestamp_utc: new Date().toISOString()
        };

        if (blindSecret) {
            initPayload.blind_auth_token = blindSecret.key;
            this.emit('log', `[Security] Silently injected blind token for ${parsed.domain} at transport layer`);
        }

        const msgUint8 = new TextEncoder().encode(JSON.stringify(initPayload));
        const signature = toHex(nacl.sign.detached(msgUint8, ephemeralKeys.secretKey));

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
            constraints,
            currentTurn: 1,
            lastKnownPrice: 0
        });

        this.setStatus('NEGOTIATING');
        this.emit('session_started', { sessionId: response.session_id, sellerId: parsed.domain });
        return response.session_id;
    }

    async sendCounter(sessionId: string, price: number, reason: string): Promise<void> {
        const session = this.activeSessions.get(sessionId);
        if (!session) throw new Error("Active session not found");

        const payload = { session_id: sessionId, turn: session.currentTurn, price, reason };
        const buyer_sig = toHex(nacl.sign.detached(
            new TextEncoder().encode(JSON.stringify(payload)),
            session.keyPair.secretKey
        ));

        const response = await this.networkRequest(`/api/route/${session.sellerId}/counter`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...payload, buyer_sig })
        });

        if (response.msg_type === 'accept' || response.status === 'COMMITTED') {
            session.status = 'CLOSED';
            session.lastKnownPrice = response.price || price;
            this.emit('session_closed', { sessionId, outcome: 'deal', finalPrice: session.lastKnownPrice });
        }
    }

    async exitSession(sessionId: string): Promise<string> {
        const session = this.activeSessions.get(sessionId);
        if (!session) throw new Error("Session not found");

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
    // CASCADING ITERATIVE NEGOTIATION (Squeeze vs. Parallel Concurrency)
    // --------------------------------------------------------------------------
    public async negotiateCascade(
        category: string, 
        constraints: ConstraintVector, 
        maxSellers = 3,
        strategy: 'sequential' | 'parallel' = 'sequential'
    ): Promise<{ sessionId: string, sellerId: string, finalPrice: number } | null> {
        this.emit('log', `[Cascade] Querying registry for matching sellers under "${category}"...`);
        const discovery = await this.search(category);
        const sellers = (discovery.results || []).slice(0, maxSellers);

        if (sellers.length === 0) {
            this.emit('log', `[Cascade] No matching sellers found for category: "${category}"`);
            return null;
        }

        // ── STRATEGY 1: PARALLEL RACE (High Urgency / Ride Hailing) ──
        if (strategy === 'parallel') {
            this.emit('log', `[Cascade] ⚡ Running PARALLEL RACE simultaneously across ${sellers.length} seller nodes...`);
            
            const sessionPromises = sellers.map(async (seller) => {
                const targetAddress = `ANP/C.${seller.agent_id}`;
                try {
                    const sessionId = await this.negotiate(targetAddress, constraints);
                    const result = await this.waitForSession(sessionId);
                    return { sellerId: seller.agent_id, sessionId, ...result };
                } catch (e: any) {
                    this.emit('log', `[Cascade] ⚠️ Connection failed for parallel channel ${seller.agent_id}: ${e.message}`);
                    return { sellerId: seller.agent_id, sessionId: '', outcome: 'stalemate' as const, price: Infinity };
                }
            });

            const results = await Promise.all(sessionPromises);
            const successfulDeals = results.filter(r => r.outcome === 'deal' && r.price <= constraints.max_budget);

            if (successfulDeals.length === 0) {
                this.emit('log', `[Cascade] ✗ Parallel race completed. No successful deals reached.`);
                return null;
            }

            successfulDeals.sort((a, b) => a.price - b.price);
            const winner = successfulDeals[0];

            this.emit('log', `[Cascade] 🏆 Parallel race complete! Lowest offer: $${winner.price} from ${winner.sellerId}`);
            return {
                sessionId: winner.sessionId,
                sellerId: winner.sellerId,
                finalPrice: winner.price
            };
        }

        // ── STRATEGY 2: SEQUENTIAL SQUEEZE (Low Urgency / Price Optimization) ──
        this.emit('log', `[Cascade] ➔ Running SEQUENTIAL SQUEEZE across ${sellers.length} seller nodes...`);
        let bestDeal: { sessionId: string, sellerId: string, finalPrice: number } | null = null;
        let currentBudgetCeiling = constraints.max_budget;

        for (const seller of sellers) {
            const targetAddress = `ANP/C.${seller.agent_id}`;
            this.emit('log', `\n[Cascade] Squeezing target: ${targetAddress} | Squeeze Ceiling: $${currentBudgetCeiling}`);

            const sessionConstraints = {
                ...constraints,
                max_budget: currentBudgetCeiling
            };

            try {
                const sessionId = await this.negotiate(targetAddress, sessionConstraints);
                const result = await this.waitForSession(sessionId);

                if (result.outcome === 'deal' && result.price < currentBudgetCeiling) {
                    this.emit('log', `[Cascade] ✓ Better deal clinched at $${result.price} from ${seller.agent_id}!`);
                    bestDeal = {
                        sessionId,
                        sellerId: seller.agent_id,
                        finalPrice: result.price
                    };
                    currentBudgetCeiling = result.price; 
                } else {
                    this.emit('log', `[Cascade] ✗ Seller ${seller.agent_id} failed to beat current best offer of $${currentBudgetCeiling}`);
                }
            } catch (e: any) {
                this.emit('log', `[Cascade] ⚠️ Dynamic session error with ${seller.agent_id}: ${e.message}`);
            }
        }

        return bestDeal;
    }

    private waitForSession(sessionId: string): Promise<{ outcome: 'deal' | 'stalemate', price: number }> {
        return new Promise((resolve) => {
            const onClosed = (event: any) => {
                if (event.sessionId === sessionId) {
                    this.off('session_closed', onClosed);
                    this.off('status_changed', onStatus);
                    resolve({ outcome: 'deal', price: event.finalPrice });
                }
            };
            const onStatus = (status: CoreStatus) => {
                if (status === 'STALEMATE') {
                    this.off('session_closed', onClosed);
                    this.off('status_changed', onStatus);
                    resolve({ outcome: 'stalemate', price: Infinity });
                }
            };
            this.on('session_closed', onClosed);
            this.on('status_changed', onStatus);
        });
    }

    async sandbox(config: SandboxConfig = {}): Promise<void> {
        this.isSandboxMode = true;
        this.sandboxMaxTurns = config.maxTurns || 6;

        await this.initialize();
        await this.setupSandbox(config);

        this.on('callback_received', async (event) => {
            if (!this.isSandboxMode) return;
            await this.handleAutomaticSandboxTurn(event.sessionId, event.payload);
        });
        this.emit('log', "⚙️ [Sandbox] Auto-Negotiation engine bound and active.");
    }

    private async setupSandbox(config: SandboxConfig = {}): Promise<void> {
        if (this.sandboxModelContext) return; 

        const settings = {
            downloadLLM: true,
            modelUrl: "https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf",
            modelPath: "./qwen2.5-1.5b-instruct-q4_k_m.gguf",
            ...config
        };

        let nodeLlama;
        try { nodeLlama = await import('node-llama-cpp'); }
        catch (e) { throw new Error("Sandbox requires 'node-llama-cpp'. Run: npm install node-llama-cpp"); }

        const fs = await import('fs');
        const path = await import('path');
        const os = await import('os');

        const resolvedPath = path.resolve(settings.modelPath);

        if (!fs.existsSync(resolvedPath)) {
            if (!settings.downloadLLM) throw new Error(`Model missing at ${resolvedPath}`);
            this.emit('log', `[Sandbox] Downloading Qwen 1.5B Q4_K_M (1.1GB)...`);
            const { pipeline } = await import('stream/promises');
            const { Readable } = await import('stream');

            const response = await fetch(settings.modelUrl);
            if (!response.ok) throw new Error("Fetch failed: " + response.statusText);

            const fileStream = fs.createWriteStream(resolvedPath);
            await pipeline(Readable.fromWeb(response.body as any), fileStream);
            this.emit('log', "[Sandbox] Download complete.");
        }

        const llama = await nodeLlama.getLlama();
        const model = await llama.loadModel({ modelPath: resolvedPath });

        this.sandboxModelContext = await model.createContext({
            contextSize: 2048,
            threads: Math.min(4, Math.max(1, os.cpus().length - 1)),
            batchSize: 512
        });
    }

    private async handleAutomaticSandboxTurn(sessionId: string, payload: any) {
        const session = this.activeSessions.get(sessionId);
        if (!session || session.status !== 'ACTIVE') return;

        session.currentTurn++;
        this.setStatus('NEGOTIATING');
        this.emit('log', `⚡ [Sandbox] Analyzing Turn ${session.currentTurn} for ${sessionId}`);

        const incomingPrice = this.extractPrice(payload.message || JSON.stringify(payload), 'Counter');
        if (incomingPrice !== null) session.lastKnownPrice = incomingPrice;

        if (session.lastKnownPrice > 0 && session.lastKnownPrice <= session.constraints.max_budget) {
            this.emit('log', `🎉 [Sandbox] Seller met budget conditions! Closing deal.`);
            await this.sendCounter(sessionId, session.lastKnownPrice, "I accept this offer.");
            return;
        }

        if (session.currentTurn > this.sandboxMaxTurns) {
            this.setStatus('STALEMATE');
            this.emit('log', `🛑 [Sandbox] Max turns reached. Exiting.`);
            await this.exitSession(sessionId);
            return;
        }

        const modelResponse = await this.sandboxEvaluate(session, payload.message || `The price is $${session.lastKnownPrice}`);
        const parsedOffer = this.extractPrice(modelResponse, 'Offer') || this.extractPrice(modelResponse, 'price');
        
        let reason = "Suggesting a fair counter-offer.";
        try {
            const parsedJson = JSON.parse(modelResponse.replace(/```json|```/g, "").trim());
            if (parsedJson.message) reason = parsedJson.message;
            else if (parsedJson.reason) reason = parsedJson.reason;
        } catch(e) {}

        if (parsedOffer !== null) {
            const finalOffer = Math.min(parsedOffer, session.constraints.max_budget);
            await this.sendCounter(sessionId, finalOffer, reason);
        } else {
            this.emit('log', `⚠️ [Sandbox] Failed to parse offer. Generating safe counter.`);
            await this.sendCounter(sessionId, session.lastKnownPrice * 0.9, "Can you do slightly better?");
        }
    }

    private async sandboxEvaluate(session: SessionState, incomingOffer: string): Promise<string> {
        const { LlamaChatSession, ChatMLChatWrapper } = await import('node-llama-cpp');

        const systemPrompt = this.buildAgentPrompt(session.sessionId, incomingOffer);

        if (!session.sandboxSequence) {
            session.sandboxSequence = this.sandboxModelContext.getSequence();
            session.sandboxSession = new LlamaChatSession({
                contextSequence: session.sandboxSequence,
                systemPrompt: systemPrompt,
                chatWrapper: new ChatMLChatWrapper()
            });
        }

        let responseText = "";
        await session.sandboxSession.prompt(incomingOffer, {
            maxTokens: 120,
            onTextChunk: (chunk: string) => { responseText += chunk; }
        });

        return responseText;
    }

    private extractPrice(text: string, prefix: string): number | null {
        const regex = new RegExp(`${prefix}\\s*\\:?\\s*\\$?(\\d+(?:\\.\\d{2})?)`, 'i');
        const match = text.match(regex);
        if (match) return parseFloat(match[1]);

        const fallbackRegex = /"price"\s*:\s*(\d+(?:\.\d{2})?)/i;
        const fallbackMatch = text.match(fallbackRegex);
        return fallbackMatch ? parseFloat(fallbackMatch[1]) : null;
    }

    public parseAddress(address: string): ParsedAddress {
        if (!address.includes('.')) throw new Error("Invalid Address Format. Expected MODE.domain (e.g. ANP/C.amazon.anp)");
        
        const firstDotIdx = address.indexOf('.');
        const mode = address.substring(0, firstDotIdx);
        const domain = address.substring(firstDotIdx + 1).toLowerCase();
        
        if (!mode.startsWith("ANP/")) throw new Error(`Invalid protocol mode '${mode}'. Must start with 'ANP/'`);

        return { mode, domain, route: '/' };
    }

    private async solvePoW(nonce: string, difficultyBits: number): Promise<string> {
        let counter = 0;
        const CHUNK_SIZE = 10000;
        while (true) {
            for (let i = 0; i < CHUNK_SIZE; i++) {
                const attempt = counter.toString();
                const hashArray = sha256.create().update(nonce + this.identityPubKey + attempt).array();
                if (this.hasLeadingZeroBits(hashArray, difficultyBits)) return attempt;
                counter++;
            }
            await new Promise(resolve => setTimeout(resolve, 0));
        }
    }

    private hasLeadingZeroBits(hash: number[], bits: number): boolean {
        let zeroBits = 0;
        for (const byte of hash) {
            if (byte === 0) zeroBits += 8;
            else { zeroBits += Math.clz32(byte) - 24; break; }
        }
        return zeroBits >= bits;
    }
}

// ============================================================================
// THE CLINCH SELLER LIBRARY (Server-Side)
// ============================================================================
export interface SellerRecord {
  agent_id:        string;
  endpoint:        string;
  supported_modes: string[];
  categories:      string[];
  capabilities:    string[];
  display_name?:   string; 
}

export class ClinchSeller extends EventEmitter {
  private config:           ClinchConfig;
  private cachedRegistryUrl: string | null = null;
  private identityPrivKey:  Uint8Array;
  public  identityPubKey:   string;

  constructor(config: ClinchConfig & { privateKeyHex?: string } = {}) {
    super();
    this.config = { timeoutMs: 8000, ...config };

    if (config.privateKeyHex) {
      try {
        const cleanHex = config.privateKeyHex.replace(/[^0-9a-fA-F]/g, '');
        if (cleanHex.length !== 128) {
            throw new Error(`Expected 128 hex chars (64 bytes), got ${cleanHex.length}`);
        }
        this.identityPrivKey = fromHex(cleanHex);
        const kp = nacl.sign.keyPair.fromSecretKey(this.identityPrivKey);
        this.identityPubKey = toHex(kp.publicKey);
        this.emit('log', `[Seller] Loaded permanent identity. PubKey: ${this.identityPubKey.substring(0, 12)}...`);
      } catch (e: any) {
        throw new Error(`[Seller] Invalid privateKeyHex in constructor: ${e.message}`);
      }
    } else {
      const kp = nacl.sign.keyPair();
      this.identityPrivKey = kp.secretKey;
      this.identityPubKey  = toHex(kp.publicKey);
      console.warn('[Seller] ⚠️  No privateKeyHex provided — using ephemeral key. Registry will reject updates unless this key is pre-registered.');
    }

    if (this.config.registryUrl) {
      this.cachedRegistryUrl = this.config.registryUrl;
    }
  }

  private async resolveRegistry(): Promise<string> {
    if (this.cachedRegistryUrl) return this.cachedRegistryUrl;
    const res = await fetch(FIREBASE_CONFIG_URL);
    const cfg = JSON.parse(await res.text());
    this.cachedRegistryUrl = cfg.registry_nodes[PROTOCOL_VERSION];
    return this.cachedRegistryUrl!;
  }

  async registerEndpoint(record: SellerRecord): Promise<any> {
    const registry = await this.resolveRegistry();

    const payload = { ...record, timestamp: Date.now() };
    const msgUint8 = new TextEncoder().encode(JSON.stringify(payload));
    const signature = toHex(nacl.sign.detached(msgUint8, this.identityPrivKey));

    const res = await fetch(`${registry}/api/sellers/update-endpoint`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        payload,
        public_key: this.identityPubKey,
        signature
      })
    });

    if (!res.ok) throw new Error(`Endpoint registration failed: ${await res.text()}`);
    const data = await res.json();
    this.emit('log', `[Seller] Registered: ${record.agent_id} → ${record.endpoint}`);
    return data;
  }

  verifyBuyerSignature(payload: any, signatureHex: string, buyerPubKeyHex: string): boolean {
    try {
      const msg    = new TextEncoder().encode(JSON.stringify(payload));
      const sig    = fromHex(signatureHex);
      const pubKey = fromHex(buyerPubKeyHex);
      return nacl.sign.detached.verify(msg, sig, pubKey);
    } catch {
      return false;
    }
  }
}
