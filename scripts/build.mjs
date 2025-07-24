import esbuild from 'esbuild';
import { promises as fs } from 'fs';
import path from 'path';

const commonConfig = {
    bundle: true,
    sourcemap: true,
    minify: false,
    loader: {
        '.wasm': 'binary'
    },
};

const outdir = 'dist';

async function buildNode() {
    const nodeConfig = {
        ...commonConfig,
        platform: 'node',
        target: 'node18',
        entryPoints: ['src/core/index.mjs'],
    };

    await esbuild.build({
        ...nodeConfig,
        format: 'esm',
        outfile: `${outdir}/ltm.node.mjs`,
    });

    await esbuild.build({
        ...nodeConfig,
        format: 'cjs',
        outfile: `${outdir}/ltm.node.cjs`,
    });
}

async function buildWeb() {
    const webConfig = {
        ...commonConfig,
        platform: 'browser',
        entryPoints: ['src/core/index.mjs'],
    };

    await esbuild.build({
        ...webConfig,
        format: 'esm',
        outfile: `${outdir}/ltm.web.mjs`,
    });
    
    await esbuild.build({
        ...webConfig,
        format: 'iife',
        globalName: 'LTM',
        outfile: `${outdir}/ltm.web.js`,
        minify: true,
    });
}

async function buildCli() {
    await esbuild.build({
        ...commonConfig,
        platform: 'node',
        target: 'node18',
        entryPoints: ['src/cli/index.mjs'],
        outfile: `${outdir}/cli.mjs`,
        format: 'esm',
    });
}

async function main() {
    try {
        await fs.rm(outdir, { recursive: true, force: true });
        await fs.mkdir(outdir);
        
        // Run builds
        await Promise.all([buildNode(), buildWeb(), buildCli()]);

        console.log('[PASS] Build finished successfully.');
    } catch (e) {
        console.error('[FAIL] Build failed:', e);
        process.exit(1);
    }
}

main();

