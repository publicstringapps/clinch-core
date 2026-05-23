import { EventEmitter } from 'events';
import nacl from 'tweetnacl';
export type CoreStatus = 'OFFLINE' | 'CONNECTING' | 'IDLE' | 'RECONNECTING' | 'ERROR' | 'NEGOTIATING' | 'CONVERGED' | 'STALEMATE';
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
export declare class ClinchCore extends EventEmitter {
    private config;
    private cachedRegistryUrl;
    status: CoreStatus;
    private reconnectAttempts;
    private maxReconnectDelay;
    jwtToken: string | null;
    private identityPrivKey;
    identityPubKey: string;
    private activeSessions;
    private ws;
    private isSandboxMode;
    private sandboxContext;
    private sandboxSequence;
    private sandboxSession;
    private sandboxMaxTurns;
    currentTurn: number;
    lastKnownPrice: number;
    activeNegotiationId: string | null;
    constructor(config?: ClinchConfig);
    private setStatus;
    initialize(cachedToken?: string): Promise<void>;
    private getRegistryUrl;
    private networkRequest;
    private registerNode;
    private connectWebSocket;
    private handleReconnect;
    disconnect(): void;
    /**
     * Generates a universally formatted System Prompt for external LLMs (Claude, OpenAI, Gemini).
     * Developers can pass this string directly to their AI to ensure protocol-compliant negotiation.
     */
    buildAgentPrompt(sessionId: string, incomingMessage: string): string;
    search(query: string, mode?: string): Promise<any>;
    negotiate(address: string, constraints: ConstraintVector): Promise<string>;
    sendCounter(sessionId: string, price: number, reason: string): Promise<void>;
    exitSession(sessionId: string): Promise<string>;
    sandbox(config?: SandboxConfig): Promise<void>;
    private setupSandbox;
    private handleAutomaticSandboxTurn;
    private sandboxEvaluate;
    private extractPrice;
    parseAddress(address: string): ParsedAddress;
    private solvePoW;
    private hasLeadingZeroBits;
}
export interface SellerRecord {
    agent_id: string;
    display_name: string;
    endpoint: string;
    supported_modes: string[];
    categories: string[];
    capabilities: string[];
}
export declare class ClinchSeller extends EventEmitter {
    private config;
    private cachedRegistryUrl;
    sellerAuthToken: string | null;
    private identityPrivKey;
    identityPubKey: string;
    constructor(config?: ClinchConfig);
    authenticate(authToken: string): Promise<void>;
    registerEndpoint(record: SellerRecord): Promise<any>;
    verifyBuyerSignature(payload: any, signatureHex: string, buyerSessionPubKeyHex: string): boolean;
    private signData;
}
