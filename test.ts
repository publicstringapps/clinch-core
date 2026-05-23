const { ClinchCore } = require('./index.js'); // Or wherever your compiled output is

const core = new ClinchCore();

// Bind all the beautiful new logs directly to your terminal
core.on('log', (msg) => console.log(msg));
core.on('error', (err) => console.error(`🚨 [CRITICAL ERROR]:`, err.message));

async function run() {
    console.log("=== CLINCH CORE CLIENT STARTING ===\n");
    
    // Pass undefined to force PoW, or pass your cached string
    await core.initialize(undefined); 
}

run();
