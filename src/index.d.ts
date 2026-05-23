import { EventEmitter } from 'events';
import nacl from 'tweetnacl';
export interface ParsedAddress {
    mode: string;
    domain: string;
    route: string;
}
export interface ClinchConfig {
    registryUrl?: string;
}
export interface ConstraintVector {
    intent: string;
    category?: string;
    max_price_usd_bracket?: string;
    [key: string]: any;
}
export interface SessionState {
    sessionId: string;
    sellerId: string;
    keyPair: nacl.SignKeyPair;
    status: 'ACTIVE' | 'EXITED' | 'CLOSED';
    exitTokenHash?: string;
}
export declare class ClinchCore extends EventEmitter {
    private isInitialized;
    private config;
    private cachedRegistryUrl;
    jwtToken: string | null;
    private identityPrivKey;
    identityPubKey: string;
    private activeSessions;
    private ws;
    constructor(config?: ClinchConfig);
    initialize(cachedToken?: string): Promise<void>;
    private registerNode;
    private getRegistryUrl;
    private networkRequest;
    private connectWebSocket;
    disconnect(): void;
    search(query: string, mode?: string): Promise<any>;
    negotiate(address: string, constraints: ConstraintVector): Promise<string>;
    exitSession(sessionId: string): Promise<string>;
    parseAddress(address: string): ParsedAddress;
    private solvePoW;
    private hasLeadingZeroBits;
}
