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
Object.defineProperty(exports, "__esModule", { value: true });
const index_1 = require("./src/index");
const fs = __importStar(require("fs"));
const TOKEN_FILE = './clinch-identity.txt';
const myHostAi = {
    async evaluateOffer() { return { action: 'counter' }; }
};
async function run() {
    console.log("=== CLINCH CORE: CACHED AUTH RUN ===\n");
    const clinch = new index_1.ClinchCore();
    let savedToken;
    if (fs.existsSync(TOKEN_FILE)) {
        savedToken = fs.readFileSync(TOKEN_FILE, 'utf-8');
        console.log("📂 Found saved JWT on disk!");
    }
    clinch.on('pow_started', (d) => console.log(`⚙️ Hard PoW Started (Difficulty: ${d.difficulty})...`));
    clinch.on('pow_solved', (d) => console.log(`🔓 PoW Solved in ${d.attempts} attempts!`));
    clinch.on('token_issued', (data) => {
        console.log(`💾 Core issued new JWT. Saving to disk...`);
        fs.writeFileSync(TOKEN_FILE, data.token);
    });
    try {
        await clinch.initialize(myHostAi, savedToken);
        console.log('✅ Core Initialized!');
        console.log('\n--- Searching (Requires Auth) ---');
        const searchRes = await clinch.search('iphone');
        console.log('🔍 Results:', searchRes.results);
        console.log('\n--- Negotiating (Requires Auth) ---');
        const sessionId = await clinch.negotiate('ANP-A.AMAZON.DEALS', { max_price: 500 });
        console.log('🤝 Session ID:', sessionId);
    }
    catch (e) {
        console.error("Test Failed:", e.message || e);
    }
}
run();
