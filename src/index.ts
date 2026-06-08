import { EventEmitter } from 'events';
import nacl from 'tweetnacl';
import { sha256 } from 'js-sha256';
import WebSocket from 'ws';

// ============================================================================
// CONFIGURATION & UTILS
// ============================================================================
const PROTOCOL_VERSION = "0.2.0"; // Bumped version to match your new backend constraints
const FIREBASE_CONFIG_URL = "https://clinchprotocol.web.app/network-config.json";

function toHex(arr: Uint8Array | number[]): string {
    return Array.from(arr).map((b: number) => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex: string): Uint8Array {
    const clean = hex.replace(/[^0-9a-fA-F]/g, '');
    const match = clean.match(/.{1,2}/g);
    if (!match) return new Uint8Array(0);
    return new Uint8Array(match.map((byte: string) => parseInt(byte, 16)));
}

// ============================================================================
// TYPES & STRICT STATE MACHINE
// ============================================================================
export type CoreStatus = 'OFFLINE' | 'CONNECTING' | 'IDLE' | 'RECONNECTING' | 'ERROR' | 'NEGOTIATING' | 'STALEMATE';

export enum NegotiationState {
    NEGOTIATING = 'NEGOTIATING',
    PROPOSED = 'PROPOSED',
    COUNTERED = 'COUNTERED',
    CONFIRMED = 'CONFIRMED',
    SIGNED = 'SIGNED',
    CANCELLED = 'CANCELLED'
}

export interface DiscoveryResult {
    agent_id: string;
    endpoint: string;
    categories: string[];
    capabilities: string[];
    supported_modes: string[] | null; // [FIX]: Replaced tags with supported_modes
    display_name: string | null;
    official_node: boolean;
    reputation_score: number;
}

export interface RegisterNodeOptions {
    supported_modes?: string[]; // [FIX]: Replaced tags with supported_modes
}

export interface DealArtifact {
    sessionId: string;
    buyerPubKey: string;
    sellerPubKey: string;
    item: string;
    price: number;
    terms: any;
    buyerSignature: string | null;
    sellerSignature: string | null;
    registrySignature?: string;
    chainHash?: string;
    timestamp: number;
}

export interface ConstraintVector {
    intent: string;
    category?: string;
    max_budget: number | null;
    [key: string]: any;
}

export interface SessionState {
    sessionId: string;
    targetId: string;
    state: NegotiationState;
    constraints: ConstraintVector;
    currentTurn: number;
    lastPrice: number;
    customInstructions?: string | null;
    artifact: DealArtifact | null;
    seenMessageIds: string[];
    sandboxSequence?: any;
    sandboxSession?: any;
}

export interface CoreConfig {
    registryUrl?: string;
    privateKeyHex: string;
    blindKeys?: Record<string, string>;
    timeoutMs?: number;
}

export interface SandboxConfig {
    downloadLLM?: boolean;
    modelUrl?: string;
    modelPath?: string;
    maxTurns?: number;
}

// ============================================================================
// CLINCH CORE LIBRARY (Buyer/Unified Protocol Layer)
// ============================================================================
export class ClinchCore extends EventEmitter {
    private config: CoreConfig;
    private keyPair: nacl.SignKeyPair;
    public pubKeyHex: string;
    public jwtToken: string | null = null;

    private cachedRegistryUrl: string | null = null;
    private ws: WebSocket | null = null;
    private sessions = new Map<string, SessionState>();

    public status: CoreStatus = 'OFFLINE';
    private reconnectAttempts = 0;
    private maxReconnectDelay = 30000;

    private isSandboxMode = false;
    private sandboxModelContext: any = null;
    private sandboxMaxTurns = 6;

    constructor(config: CoreConfig) {
        super();
        this.config = { timeoutMs: 8000, blindKeys: {}, ...config };
        this.keyPair = nacl.sign.keyPair.fromSecretKey(fromHex(config.privateKeyHex));
        this.pubKeyHex = toHex(this.keyPair.publicKey);
        if (this.config.registryUrl) this.cachedRegistryUrl = this.config.registryUrl;
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

    public exportSessions(): Record<string, SessionState> { return Object.fromEntries(this.sessions); }
    public importSessions(data: Record<string, SessionState>): void {
        for (const [id, session] of Object.entries(data)) this.sessions.set(id, session);
    }
    public getSession(id: string): SessionState | undefined { return this.sessions.get(id); }

    // --- DYNAMIC REGISTRY DISCOVERY ---
    private async getRegistryUrl(forceRefresh = false): Promise<string> {
        if (this.cachedRegistryUrl && !forceRefresh) return this.cachedRegistryUrl;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
        try {
            const res = await fetch(FIREBASE_CONFIG_URL, { signal: controller.signal });
            clearTimeout(timeout);
            const text = await res.text();
            const config = JSON.parse(text);
            this.cachedRegistryUrl = config.registry_nodes[PROTOCOL_VERSION] || config.registry_nodes["0.1.0"];
            return this.cachedRegistryUrl!;
        } catch (err: any) {
            clearTimeout(timeout);
            throw new Error(`Registry config fetch failed: ${err.message}. Is the computer able to access the url?`);
        }
    }

    // --- TRANSPORT AUTHENTICATION (Anti-Spam PoW) ---
    public async initialize(cachedToken?: string): Promise<void> {
        if (this.status === 'IDLE' || this.status === 'CONNECTING') return;
        this.setStatus('CONNECTING');

        try {
            const baseUrl = await this.getRegistryUrl();
            if (cachedToken) {
                this.jwtToken = cachedToken;
                this.setStatus('IDLE');
                return;
            }

            const challRes = await fetch(`${baseUrl}/api/auth/challenge`);
            if (!challRes.ok) throw new Error("Failed to fetch PoW challenge");
            const chall = await challRes.json();

            const powSolution = await this.solvePoW(chall.nonce, chall.difficulty);

            const verifyRes = await fetch(`${baseUrl}/api/auth/verify`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ challenge_id: chall.challenge_id, pow_solution: powSolution, pubKey: this.pubKeyHex })
            });

            if (!verifyRes.ok) throw new Error("PoW verification failed");
            this.jwtToken = (await verifyRes.json()).token;
            this.setStatus('IDLE');
        } catch (error: any) {
            this.setStatus('ERROR');
            throw new Error(`Initialization failed: ${error.message}`);
        }
    }

    private async solvePoW(nonce: string, difficultyBits: number): Promise<string> {
        let counter = 0;
        const CHUNK_SIZE = 10000;
        while (true) {
            for (let i = 0; i < CHUNK_SIZE; i++) {
                const attempt = counter.toString();
                const hashArray = sha256.create().update(nonce + this.pubKeyHex + attempt).array();
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

    // --- NETWORK REQUESTS (Auto-retry on Token Expiry) ---
    private async _makeFetch(baseUrl: string, endpoint: string, method: string, payload: any = {}): Promise<Response> {
        const msgBytes = new TextEncoder().encode(JSON.stringify(payload));
        const sig = toHex(nacl.sign.detached(msgBytes, this.keyPair.secretKey));

        const headers: any = { 'Content-Type': 'application/json', 'X-Clinch-PubKey': this.pubKeyHex, 'X-Clinch-Sig': sig };
        if (this.jwtToken) headers['Authorization'] = `Bearer ${this.jwtToken}`;

        return fetch(`${baseUrl}${endpoint}`, { method, headers, body: method !== 'GET' ? JSON.stringify(payload) : undefined });
    }

    public async request(endpoint: string, method: string, payload: any = {}): Promise<any> {
        const baseUrl = await this.getRegistryUrl();
        let res = await this._makeFetch(baseUrl, endpoint, method, payload);

        if (res.status === 401 && this.jwtToken) {
            this.jwtToken = null;
            await this.initialize();
            res = await this._makeFetch(baseUrl, endpoint, method, payload);
        }

        if (!res.ok) throw new Error(`Registry HTTP ${res.status}: ${await res.text()}`);
        return res.json();
    }

    public async connectDaemonStream(): Promise<void> {
        const baseUrl = await this.getRegistryUrl();
        if (!this.jwtToken) await this.initialize();

        const wsUrl = baseUrl.replace(/^http/, 'ws');
        this.ws = new WebSocket(wsUrl);

        this.ws.on('open', () => {
            this.reconnectAttempts = 0;
            const authPayload = { timestamp: Date.now(), pubKey: this.pubKeyHex };
            const sig = toHex(nacl.sign.detached(new TextEncoder().encode(JSON.stringify(authPayload)), this.keyPair.secretKey));
            this.ws?.send(JSON.stringify({ type: 'AUTH', token: this.jwtToken, payload: authPayload, sig }));
            this.emit('daemon_connected');
        });

        this.ws.on('message', (data) => {
            const msg = JSON.parse(data.toString());
            if (msg.type === 'CALLBACK') this.processIncoming(msg.payload);
        });

        this.ws.on('close', () => {
            this.reconnectAttempts++;
            const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), this.maxReconnectDelay);
            setTimeout(() => this.connectDaemonStream(), delay);
        });
    }

    // --- PROTOCOL CAPABILITIES ---
    public async discover(category: string): Promise<DiscoveryResult[]> {
        const baseUrl = await this.getRegistryUrl();
        const res = await fetch(`${baseUrl}/api/discover?category=${encodeURIComponent(category)}`);
        return (await res.json()).results || [];
    }

    // [FIX]: Added explicit agentId requirement and aligned supported_modes
    public async registerNode(
        agentId: string, 
        endpoint: string,
        categories: string[],
        capabilities: string[],
        options: RegisterNodeOptions = {}
    ): Promise<void> {
        const payload = {
            agent_id: agentId,
            endpoint,
            categories,
            capabilities,
            supported_modes: options.supported_modes || ["ANP/C"],
            timestamp: Date.now()
        };
        await this.request('/api/sellers/update-endpoint', 'POST', { payload });
    }

    public async proposeDeal(targetDomain: string, constraints: ConstraintVector): Promise<SessionState> {
        const payload: any = { target: targetDomain, constraints, timestamp: Date.now() };

        if (this.config.blindKeys && this.config.blindKeys[targetDomain]) {
            payload.blind_auth_token = this.config.blindKeys[targetDomain];
        }

        const res = await this.request(`/api/route/${targetDomain}/handshake`, 'POST', payload);

        const session: SessionState = {
            sessionId: res.session_id,
            targetId: targetDomain,
            state: NegotiationState.PROPOSED,
            constraints,
            currentTurn: 1,
            lastPrice: 0,
            customInstructions: res.custom_instructions || null,
            artifact: null,
            seenMessageIds: []
        };

        if (res.type === 'CONFIRM') { session.state = NegotiationState.CONFIRMED; session.lastPrice = res.price; }
        else if (res.type === 'COUNTER') { session.state = NegotiationState.COUNTERED; session.lastPrice = res.price; session.currentTurn = res.turn || 2; }
        else if (res.type === 'CANCEL') { session.state = NegotiationState.CANCELLED; }

        this.sessions.set(session.sessionId, session);
        return session;
    }

    public async counter(sessionId: string, price: number, reason: string): Promise<SessionState> {
        const session = this.sessions.get(sessionId);
        if (!session) throw new Error("Session not found");
        if (session.state === NegotiationState.SIGNED || session.state === NegotiationState.CANCELLED) {
            throw new Error(`Cannot counter, deal is ${session.state}`);
        }

        const payload: any = { session_id: sessionId, turn: session.currentTurn + 1, price, reason };
        if (this.config.blindKeys && this.config.blindKeys[session.targetId]) {
            payload.blind_auth_token = this.config.blindKeys[session.targetId];
        }

        const res = await this.request(`/api/route/${session.targetId}/counter`, 'POST', payload);

        session.currentTurn++;
        session.lastPrice = price;
        session.state = NegotiationState.COUNTERED;

        if (res.type === 'CONFIRM') { session.state = NegotiationState.CONFIRMED; session.lastPrice = res.price; }
        else if (res.type === 'COUNTER') { session.state = NegotiationState.COUNTERED; session.lastPrice = res.price; session.currentTurn = res.turn || session.currentTurn + 1; }
        else if (res.type === 'CANCEL') { session.state = NegotiationState.CANCELLED; }

        return session;
    }

    public async cancelSession(sessionId: string): Promise<SessionState> {
        const session = this.sessions.get(sessionId);
        if (!session) throw new Error("Session not found");
        await this.request(`/api/route/${session.targetId}/cancel`, 'POST', { session_id: sessionId });
        session.state = NegotiationState.CANCELLED;
        return session;
    }

    // --- CASCADING ITERATIVE SQUEEZE ---
    public async negotiateCascade(
        category: string,
        constraints: ConstraintVector,
        maxSellers = 3,
        strategy: 'sequential' | 'parallel' = 'sequential'
    ): Promise<{ sessionId: string, sellerId: string, finalPrice: number } | null> {
        this.emit('log', `[Cascade] Querying registry for matching sellers under "${category}"...`);
        const discovery = await this.discover(category);
        const sellers: DiscoveryResult[] = discovery.slice(0, maxSellers);

        if (sellers.length === 0) return null;

        if (strategy === 'parallel') {
            const sessionPromises = sellers.map(async (seller: DiscoveryResult) => {
                try {
                    const session = await this.proposeDeal(seller.agent_id, constraints);
                    if (session.state === NegotiationState.CONFIRMED && constraints.max_budget !== null && session.lastPrice <= constraints.max_budget) {
                        return { sellerId: seller.agent_id, sessionId: session.sessionId, outcome: 'deal', price: session.lastPrice };
                    }
                    return { sellerId: seller.agent_id, sessionId: session.sessionId, outcome: 'pending', price: Infinity };
                } catch (e: any) {
                    return { sellerId: seller.agent_id, sessionId: '', outcome: 'error', price: Infinity };
                }
            });

            const results = await Promise.all(sessionPromises);
            const successfulDeals = results.filter((r: any) => r.outcome === 'deal');
            if (successfulDeals.length === 0) return null;
            successfulDeals.sort((a: any, b: any) => a.price - b.price);
            const winner = successfulDeals[0];
            return { sessionId: winner.sessionId, sellerId: winner.sellerId, finalPrice: winner.price };
        }

        let bestDeal = null;
        let currentBudgetCeiling = constraints.max_budget || Infinity;

        for (const seller of sellers) {
            const sessionConstraints = { ...constraints, max_budget: currentBudgetCeiling === Infinity ? null : currentBudgetCeiling };
            try {
                const session = await this.proposeDeal(seller.agent_id, sessionConstraints);
                if (session.state === NegotiationState.CONFIRMED && session.lastPrice < currentBudgetCeiling) {
                    bestDeal = { sessionId: session.sessionId, sellerId: seller.agent_id, finalPrice: session.lastPrice };
                    currentBudgetCeiling = session.lastPrice;
                }
            } catch (e: any) { this.emit('log', `[Cascade] Error with ${seller.agent_id}: ${e.message}`); }
        }
        return bestDeal;
    }

    // --- AUTO-NEGOTIATOR SANDBOX ---
    public async sandbox(config: SandboxConfig = {}): Promise<void> {
        this.isSandboxMode = true;
        this.sandboxMaxTurns = config.maxTurns || 6;
        await this.setupSandbox(config);

        this.on('counter_received', async (session: SessionState) => {
            if (!this.isSandboxMode) return;
            if (session.constraints.max_budget !== null && session.lastPrice <= session.constraints.max_budget) {
                this.emit('log', `🎉 [Sandbox] Target met constraints! Suggesting confirmation.`);
                await this.counter(session.sessionId, session.lastPrice, "I accept this offer.");
                return;
            }
            if (session.currentTurn > this.sandboxMaxTurns) {
                await this.cancelSession(session.sessionId);
                return;
            }

            const promptStr = this.buildAgentPrompt(session.sessionId, `The price is $${session.lastPrice}`);
            if (!session.sandboxSequence) {
                session.sandboxSequence = this.sandboxModelContext.getSequence();
                const { LlamaChatSession, ChatMLChatWrapper } = await import('node-llama-cpp');
                session.sandboxSession = new LlamaChatSession({ contextSequence: session.sandboxSequence, systemPrompt: promptStr, chatWrapper: new ChatMLChatWrapper() });
            }

            let responseText = "";
            await session.sandboxSession.prompt(`The price is $${session.lastPrice}`, { maxTokens: 120, onTextChunk: (chunk: string) => { responseText += chunk; } });

            const match = responseText.match(/"price"\s*:\s*(\d+(?:\.\d{2})?)/i);
            const parsedOffer = match ? parseFloat(match[1]) : session.lastPrice * 0.9;
            await this.counter(session.sessionId, parsedOffer, "Counter offer from Sandbox Agent");
        });
    }

    private async setupSandbox(config: SandboxConfig = {}): Promise<void> {
        if (this.sandboxModelContext) return;
        let nodeLlama;
        try { nodeLlama = await import('node-llama-cpp'); } catch (e) { throw new Error("Sandbox requires 'node-llama-cpp'."); }
        const fs = await import('fs');
        const path = await import('path');
        const os = await import('os');
        const resolvedPath = path.resolve(config.modelPath || "./model.gguf");

        if (!fs.existsSync(resolvedPath)) throw new Error(`Model missing at ${resolvedPath}. Download required.`);

        const llama = await nodeLlama.getLlama();
        const model = await llama.loadModel({ modelPath: resolvedPath });
        this.sandboxModelContext = await model.createContext({ contextSize: 2048, threads: Math.max(1, os.cpus().length - 1) });
    }

    public buildAgentPrompt(sessionId: string, incomingMessage: string): string {
        const session = this.sessions.get(sessionId);
        if (!session) return "";
        const budgetText = session.constraints.max_budget ? `$${session.constraints.max_budget}` : `Unspecified (get best deal)`;
        const customInstructionsBlock = session.customInstructions ? `\nCUSTOM SELLER INSTRUCTIONS:\n"""\n${session.customInstructions}\n"""\n` : "";

        return `You are a professional AI purchasing agent negotiating via the Clinch Protocol.
NEGOTIATION STATE:
- Item: ${session.constraints.item}
- Your absolute max budget: ${budgetText}
- Current turn: ${session.currentTurn}
- Last seller price: $${session.lastPrice}
${customInstructionsBlock}
SELLER'S LATEST MESSAGE: "${incomingMessage}"

OUTPUT FORMAT:
You MUST respond ONLY in valid JSON matching this exact schema:
{"action": "counter" | "accept" | "exit", "price": <numeric value>, "message": "<One concise sentence>"}`;
    }

    // --- LOCAL SELLER STATE MANAGEMENT ---
    public registerIncomingSession(sessionId: string, targetPubKey: string, constraints: any): void {
        if (!this.sessions.has(sessionId)) {
            this.sessions.set(sessionId, { sessionId, targetId: targetPubKey, state: NegotiationState.NEGOTIATING, constraints, currentTurn: 1, lastPrice: 0, artifact: null, seenMessageIds: [] });
        }
    }

    public updateSessionStateLocally(sessionId: string, state: NegotiationState, price: number, turn?: number): void {
        const session = this.sessions.get(sessionId);
        if (session) { session.state = state; session.lastPrice = price; if (turn) session.currentTurn = turn; }
    }

    // --- BILATERAL SIGNATURE & COMMIT ---
    public async approveAndSign(sessionId: string): Promise<DealArtifact> {
        const session = this.sessions.get(sessionId);
        if (!session) throw new Error("Session not found");
        if (session.state !== NegotiationState.CONFIRMED) throw new Error(`Approval Gate Blocked: Session state is ${session.state}. Must be CONFIRMED.`);

        const artifact: DealArtifact = {
            sessionId: session.sessionId, buyerPubKey: this.pubKeyHex, sellerPubKey: session.targetId,
            item: session.constraints.item || 'Service', price: session.lastPrice, terms: session.constraints,
            buyerSignature: null, sellerSignature: null, timestamp: Date.now()
        };

        const msgBytes = new TextEncoder().encode(JSON.stringify({ sessionId: artifact.sessionId, item: artifact.item, price: artifact.price }));
        artifact.buyerSignature = toHex(nacl.sign.detached(msgBytes, this.keyPair.secretKey));

        const sigRes = await this.request(`/api/route/${session.targetId}/sign_request`, 'POST', { artifact });
        if (!sigRes.sellerSignature) throw new Error("Seller refused or failed to sign the artifact.");
        artifact.sellerSignature = sigRes.sellerSignature;

        const commitRes = await this.request(`/api/route/${sessionId}/commit`, 'POST', { artifact });
        artifact.registrySignature = commitRes.registry_sig;
        artifact.chainHash = commitRes.chain_hash;

        session.state = NegotiationState.SIGNED;
        session.artifact = artifact;
        return artifact;
    }

    public signAsSeller(artifact: DealArtifact): string {
        const session = this.sessions.get(artifact.sessionId);
        if (!session) throw new Error("Session not found in local state");
        if (session.state !== NegotiationState.CONFIRMED) throw new Error(`Cannot sign. Session state is ${session.state}, must be CONFIRMED`);
        if (!artifact.buyerSignature) throw new Error("Artifact is missing buyer signature");

        const msgBytes = new TextEncoder().encode(JSON.stringify({ sessionId: artifact.sessionId, item: artifact.item, price: artifact.price }));
        if (!nacl.sign.detached.verify(msgBytes, fromHex(artifact.buyerSignature), fromHex(artifact.buyerPubKey))) {
            throw new Error("Cryptographic verification of buyer signature failed");
        }

        return toHex(nacl.sign.detached(msgBytes, this.keyPair.secretKey));
    }

    private processIncoming(payload: any) {
        if (!payload.session_id) return;
        let session = this.sessions.get(payload.session_id);

        if (!session && payload.type === 'HANDSHAKE') {
            this.registerIncomingSession(payload.session_id, payload.buyer_pub_key, payload.constraints);
            session = this.sessions.get(payload.session_id);
        }

        if (!session) return;
        if (payload.msg_id) {
            if (session.seenMessageIds.includes(payload.msg_id)) return;
            session.seenMessageIds.push(payload.msg_id);
            if (session.seenMessageIds.length > 100) session.seenMessageIds.shift();
        }

        if (payload.type === 'CANCEL') { session.state = NegotiationState.CANCELLED; this.emit('session_cancelled', session); }
        else if (payload.type === 'COUNTER') { session.state = NegotiationState.COUNTERED; session.lastPrice = payload.price; session.currentTurn = payload.turn; this.emit('counter_received', session); }
        else if (payload.type === 'CONFIRM') { session.state = NegotiationState.CONFIRMED; session.lastPrice = payload.price; this.emit('approval_required', session); }
        else if (payload.type === 'COMMIT') { session.state = NegotiationState.SIGNED; session.artifact = payload.artifact; this.emit('deal_signed', session); }
    }
}

// ============================================================================
// THE CLINCH SELLER LIBRARY (EXPORT WRAPPER)
// ============================================================================
export class ClinchSeller extends ClinchCore {
    constructor(config: CoreConfig) {
        super(config);
    }
}
