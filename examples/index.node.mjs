import { readFile, writeFile } from 'fs/promises';
import { createTransaction } from './core.mjs';

async function main() {
    // 1. Get manifest path from command line arguments
    const manifestPath = process.argv[2] || 'manifest.example.json';
    
    // 2. Load manifest and private keys from files
    const manifest = JSON.parse(await readFile(manifestPath, 'utf-8'));
    const signerKeys = JSON.parse(await readFile('./private.json', 'utf-8'));

    // 3. Create the transaction
    const finalTransaction = await createTransaction(manifest, signerKeys);

    // 4. Write the transaction to a file
    await writeFile('transaction.bin', finalTransaction);

    // 5. Output the final result
    console.log(finalTransaction);
}

main().catch(console.error);
