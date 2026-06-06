import { EventEmitter } from 'events';
import nacl from 'tweetnacl';
import { sha256 } from 'js-sha256';
import WebSocket from 'ws';

export enum NegotiationState {
    NEGOTIATING = 'NEGOTIATING',
    PROPOSED = 'PROPOSED',
    COUNTERED = 'COUNTERED',
    CONFIRMED = 'CONFIRMED',
    SIGNED = 'SIGNED',
    CANCELLED = 'CANCELLED'
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
    registrySignature?: string; // NEW
    chainHash?: string;         // NEW
    timestamp: number;
}

export interface SessionState {
    sessionId: string;
    targetId: string;
    state: NegotiationState;
    constraints: any;
    currentTurn: number;
    lastPrice: number;
    customInstructions?: string; // NEW
    artifact: DealArtifact | null;
    seenMessageIds: string[];
}

export interface CoreConfig {
    registryUrl: string;
    privateKeyHex: string;
    blindKeys?: Record<string, string>; // NEW: Vault passes these in
}

function toHex(arr: Uint8Array): string {
    return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex: string): Uint8Array {
    const match = hex.replace(/[^0-9a-fA-F]/g, '').match(/.{1,2}/g);
    return match ? new Uint8Array(match.map(b => parseInt(b, 16))) : new Uint8Array(0);
}

export class ClinchCore extends EventEmitter {
    private config: CoreConfig;
    private keyPair: nacl.SignKeyPair;
    public pubKeyHex: string;
    public jwtToken: string | null = null;
    private ws: WebSocket | null = null;
    private sessions = new Map<string, SessionState>();

    constructor(config: CoreConfig) {
        super();
        this.config = { blindKeys: {}, ...config };
        this.keyPair = nacl.sign.keyPair.fromSecretKey(fromHex(config.privateKeyHex));
        this.pubKeyHex = toHex(this.keyPair.publicKey);
    }

    public exportSessions(): Record<string, SessionState> { return Object.fromEntries(this.sessions); }
    public importSessions(data: Record<string, SessionState>): void {
        for (const [id, session] of Object.entries(data)) this.sessions.set(id, session);
    }
    public getSession(id: string): SessionState | undefined { return this.sessions.get(id); }

    public async initialize(cachedToken?: string): Promise<void> {
        if (cachedToken) { this.jwtToken = cachedToken; return; }
        const challRes = await fetch(`${this.config.registryUrl}/api/auth/challenge`);
        if (!challRes.ok) throw new Error("Failed to fetch PoW challenge");
        const chall = await challRes.json();
        const powSolution = await this.solvePoW(chall.nonce, chall.difficulty);
        const verifyRes = await fetch(`${this.config.registryUrl}/api/auth/verify`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ challenge_id: chall.challenge_id, pow_solution: powSolution, pubKey: this.pubKeyHex })
        });
        if (!verifyRes.ok) throw new Error("PoW verification failed");
        this.jwtToken = (await verifyRes.json()).token;
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

    private async _makeFetch(endpoint: string, method: string, payload: any = {}): Promise<Response> {
        const msgBytes = new TextEncoder().encode(JSON.stringify(payload));
        const sig = toHex(nacl.sign.detached(msgBytes, this.keyPair.secretKey));
        const headers: any = { 'Content-Type': 'application/json', 'X-Clinch-PubKey': this.pubKeyHex, 'X-Clinch-Sig': sig };
        if (this.jwtToken) headers['Authorization'] = `Bearer ${this.jwtToken}`;
        return fetch(`${this.config.registryUrl}${endpoint}`, { method, headers, body: method !== 'GET' ? JSON.stringify(payload) : undefined });
    }

    public async request(endpoint: string, method: string, payload: any = {}): Promise<any> {
        let res = await this._makeFetch(endpoint, method, payload);
        if (res.status === 401 && this.jwtToken) {
            this.jwtToken = null;
            await this.initialize();
            res = await this._makeFetch(endpoint, method, payload);
        }
        if (!res.ok) throw new Error(`Registry HTTP ${res.status}: ${await res.text()}`);
        return res.json();
    }

    public connectDaemonStream(): void {
        if (!this.jwtToken) throw new Error("Must initialize Core with JWT before connecting stream");
        const wsUrl = this.config.registryUrl.replace(/^http/, 'ws');
        this.ws = new WebSocket(wsUrl);

        this.ws.on('open', () => {
            const authPayload = { timestamp: Date.now(), pubKey: this.pubKeyHex };
            const sig = toHex(nacl.sign.detached(new TextEncoder().encode(JSON.stringify(authPayload)), this.keyPair.secretKey));
            this.ws?.send(JSON.stringify({ type: 'AUTH', token: this.jwtToken, payload: authPayload, sig }));
            this.emit('daemon_connected');
        });

        this.ws.on('message', (data) => {
            const msg = JSON.parse(data.toString());
            if (msg.type === 'CALLBACK') this.processIncoming(msg.payload);
        });

        this.ws.on('close', () => setTimeout(() => this.connectDaemonStream(), 5000));
    }

    public async discover(category: string): Promise<any[]> {
        const res = await fetch(`${this.config.registryUrl}/api/discover?category=${encodeURIComponent(category)}`);
        return (await res.json()).results || [];
    }

    public async registerNode(endpoint: string, categories: string[], capabilities: string[]): Promise<void> {
        const payload = { agent_id: this.pubKeyHex, endpoint, categories, capabilities, timestamp: Date.now() };
        await this.request('/api/sellers/update-endpoint', 'POST', { payload });
    }

    public async proposeDeal(targetDomain: string, constraints: any): Promise<SessionState> {
        const payload: any = { target: targetDomain, constraints, timestamp: Date.now() };
        
        // Blind Key Pass Injection
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
            customInstructions: res.custom_instructions || null, // Saved from Registry DB
            artifact: null,
            seenMessageIds: []
        };
        
        if (res.type === 'CONFIRM') {
            session.state = NegotiationState.CONFIRMED;
            session.lastPrice = res.price;
        } else if (res.type === 'COUNTER') {
            session.state = NegotiationState.COUNTERED;
            session.lastPrice = res.price;
            session.currentTurn = res.turn || 2;
        } else if (res.type === 'CANCEL') {
            session.state = NegotiationState.CANCELLED;
        }
        
        this.sessions.set(session.sessionId, session);
        return session;
    }

    public async counter(sessionId: string, price: number, reason: string): Promise<SessionState> {
        const session = this.sessions.get(sessionId);
        if (!session) throw new Error("Session not found");
        if (session.state === NegotiationState.SIGNED || session.state === NegotiationState.CANCELLED) throw new Error(`Cannot counter, deal is ${session.state}`);

        const res = await this.request(`/api/route/${session.targetId}/counter`, 'POST', { session_id: sessionId, turn: session.currentTurn + 1, price, reason });
        
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

        // Registry commits and returns the 3rd Chain-of-Custody signature
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
