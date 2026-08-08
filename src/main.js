import { Actor } from 'apify';

// Logger that uses Actor.log when running on Apify, console locally.
const log = {
    info: (msg) => (Actor.log ? Actor.log.info(msg) : console.log(`INFO  ${msg}`)),
    warning: (msg) => (Actor.log ? Actor.log.warning(msg) : console.warn(`WARN  ${msg}`)),
    error: (msg) => (Actor.log ? Actor.log.error(msg) : console.error(`ERROR ${msg}`)),
};

// Environment variable holding the Verimailx API key.
// Set it in the Apify console under "Environment variables" / Secrets.
const API_KEY_ENV = 'APIFY-VERIMAILX-API-KEY';
const VERIMAILX_BASE = 'https://api.verimailx.com';
const BULK_ENDPOINT = `${VERIMAILX_BASE}/bulk-validate`;
const BULK_MAX = 1000;

// Map Verimailx result values to the actor's existing overall verdict.
function mapResult(value) {
    if (value === 'valid') return 'valid';
    if (value === 'invalid') return 'invalid';
    // 'risky' and 'unknown' both fall through to 'unknown' for the actor's
    // three-state verdict. Verimailx's deliverability_score is preserved
    // on the result so consumers can distinguish risky vs unknown if needed.
    return 'unknown';
}

// Convert one Verimailx response item into the actor's output shape.
function toActorResult(item) {
    const verdict = mapResult(item.result);
    return {
        email: item.email,
        overall: verdict,
        result: item.result,                // raw Verimailx verdict (valid/invalid/risky/unknown)
        deliverabilityScore: item.deliverability_score ?? null,
        syntax: {
            passed: Boolean(item.is_syntax_valid),
        },
        mx: {
            passed: Boolean(item.is_mx_valid),
            domain: item.email?.includes('@') ? item.email.split('@').pop().toLowerCase() : '',
            records: (item.mx_hosts ?? []).map((exchange) => ({ exchange, priority: null })),
        },
        smtp: {
            passed: Boolean(item.is_smtp_valid),
            rejected: item.is_smtp_valid === false,
        },
        flags: {
            dnsValid: Boolean(item.is_dns_valid),
            disposable: Boolean(item.is_disposable),
            roleBased: Boolean(item.is_role_based),
        },
        checkedAt: new Date().toISOString(),
    };
}

// POST { emails: [...] } to /bulk-validate and return the results array.
async function callBulk(emails, apiKey) {
    const response = await fetch(BULK_ENDPOINT, {
        method: 'POST',
        headers: {
            'X-API-Key': apiKey,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ emails }),
    });

    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`Verimailx API returned ${response.status}: ${text || response.statusText}`);
    }

    const payload = await response.json();
    if (!Array.isArray(payload?.results)) {
        throw new Error(`Verimailx API returned unexpected shape: ${JSON.stringify(payload).slice(0, 200)}`);
    }
    return payload;
}

// Split an array into chunks of at most `size` items.
function chunk(array, size) {
    const chunks = [];
    for (let i = 0; i < array.length; i += size) {
        chunks.push(array.slice(i, i + size));
    }
    return chunks;
}

async function main() {
    await Actor.init();

    const apiKey = process.env[API_KEY_ENV];
    if (!apiKey) {
        log.error(`${API_KEY_ENV} environment variable is required. Set it in the Apify console (Secrets).`);
        await Actor.exit(1);
        return;
    }

    let input;
    try {
        input = await Actor.getInput();
    } catch (err) {
        log.error(`Failed to read input: ${err.message}`);
        await Actor.exit(1);
        return;
    }

    const rawEmails = Array.isArray(input?.emails) ? input.emails : [];
    const emails = [...new Set(rawEmails
        .filter((e) => typeof e === 'string' && e.trim().length > 0)
        .map((e) => e.trim().toLowerCase()))];
    const dropped = rawEmails.length - emails.length;

    if (dropped > 0) {
        log.warning(`Skipped ${dropped} non-string, empty, or duplicate input item(s).`);
    }

    if (emails.length === 0) {
        log.warning('No valid email strings provided in input. Exiting.');
        await Actor.exit();
        return;
    }

    const batches = chunk(emails, BULK_MAX);
    log.info(`Verifying ${emails.length} email(s) across ${batches.length} batch(es) of up to ${BULK_MAX}...`);

    let successCount = 0;
    let errorCount = 0;

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
        const batch = batches[batchIndex];
        try {
            const payload = await callBulk(batch, apiKey);
            const results = payload.results;

            if (results.length !== batch.length) {
                log.warning(`Batch ${batchIndex + 1}: Verimailx returned ${results.length} results for ${batch.length} emails.`);
            }

            for (const item of results) {
                const result = toActorResult(item);
                await Actor.pushData(result);
                log.info(`${result.email} -> ${result.overall} (verimailx:${result.result} score:${result.deliverabilityScore ?? '-'})`);
                successCount += 1;
            }

            if (typeof payload?.credits_remaining === 'number') {
                log.info(`Batch ${batchIndex + 1} done. Credits remaining: ${payload.credits_remaining}`);
            }
        } catch (error) {
            log.error(`Batch ${batchIndex + 1} failed: ${error?.message ?? error}`);
            for (const email of batch) {
                await Actor.pushData({
                    email,
                    overall: 'error',
                    error: error?.message ?? String(error),
                    checkedAt: new Date().toISOString(),
                });
            }
            errorCount += batch.length;
        }
    }

    log.info(`Done. success=${successCount} errors=${errorCount}`);
    await Actor.exit();
}

main().catch(async (err) => {
    log.error(`Fatal: ${err?.stack ?? err}`);
    try { await Actor.exit(1); } catch { /* noop */ }
    process.exit(1);
});
