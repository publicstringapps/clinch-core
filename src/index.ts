import { EventEmitter } from 'events';
import nacl from 'tweetnacl';
import { sha256 } from 'js-sha256';
import WebSocket from 'ws';

// ============================================================================
// CONFIGURATION & UTILS
// ============================================================================
const PROTOCOL_VERSION = "0.2.1";
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
    supported_modes: string[] | null;
    display_name: string | null;
    official_node: boolean;
    reputation_score: number;
}

export interface RegisterNodeOptions {
    supported_modes?: string[];
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
    lastMessage?: string | null; // <--- FIXED: Captured for daemon UI
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
            throw new Error(`Registry config fetch failed: ${err.message}`);
        }
    }

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

    public async discover(category: string): Promise<DiscoveryResult[]> {
        const baseUrl = await this.getRegistryUrl();
        const res = await fetch(`${baseUrl}/api/discover?category=${encodeURIComponent(category)}`);
        return (await res.json()).results || [];
    }

    public async registerNode(agentId: string, endpoint: string, categories: string[], capabilities: string[], options: RegisterNodeOptions = {}): Promise<void> {
        const payload = { agent_id: agentId, endpoint, categories, capabilities, supported_modes: options.supported_modes || ["ANP/C"], timestamp: Date.now() };
        await this.request('/api/sellers/update-endpoint', 'POST', { payload });
    }

    public async proposeDeal(targetDomain: string, constraints: ConstraintVector): Promise<SessionState> {
        const payload: any = { target: targetDomain, constraints, timestamp: Date.now() };
        if (this.config.blindKeys && this.config.blindKeys[targetDomain]) payload.blind_auth_token = this.config.blindKeys[targetDomain];

        const res = await this.request(`/api/route/${targetDomain}/handshake`, 'POST', payload);

        const session: SessionState = {
            sessionId: res.session_id,
            targetId: targetDomain,
            state: NegotiationState.PROPOSED,
            constraints,
            currentTurn: 1,
            lastPrice: 0,
            lastMessage: res.message || null,
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
        if (session.state === NegotiationState.SIGNED || session.state === NegotiationState.CANCELLED) throw new Error(`Cannot counter, deal is ${session.state}`);

        const payload: any = { session_id: sessionId, turn: session.currentTurn + 1, price, reason };
        if (this.config.blindKeys && this.config.blindKeys[session.targetId]) payload.blind_auth_token = this.config.blindKeys[session.targetId];

        const res = await this.request(`/api/route/${session.targetId}/counter`, 'POST', payload);

        session.currentTurn++;
        session.lastPrice = price;
        session.lastMessage = res.message || null;
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

    public registerIncomingSession(sessionId: string, targetPubKey: string, constraints: any): void {
        if (!this.sessions.has(sessionId)) {
            this.sessions.set(sessionId, { sessionId, targetId: targetPubKey, state: NegotiationState.NEGOTIATING, constraints, currentTurn: 1, lastPrice: 0, artifact: null, seenMessageIds: [] });
        }
    }

    public updateSessionStateLocally(sessionId: string, state: NegotiationState, price: number, turn?: number): void {
        const session = this.sessions.get(sessionId);
        if (session) { session.state = state; session.lastPrice = price; if (turn) session.currentTurn = turn; }
    }

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
        else if (payload.type === 'COUNTER') { 
            session.state = NegotiationState.COUNTERED; 
            session.lastPrice = payload.price; 
            session.currentTurn = payload.turn; 
            session.lastMessage = payload.message || null; // <--- FIXED
            this.emit('counter_received', session); 
        }
        else if (payload.type === 'CONFIRM') { session.state = NegotiationState.CONFIRMED; session.lastPrice = payload.price; session.lastMessage = payload.message || null; this.emit('approval_required', session); }
        else if (payload.type === 'COMMIT') { session.state = NegotiationState.SIGNED; session.artifact = payload.artifact; this.emit('deal_signed', session); }
    }
}
export class ClinchSeller extends ClinchCore {
    constructor(config: CoreConfig) { super(config); }
}
