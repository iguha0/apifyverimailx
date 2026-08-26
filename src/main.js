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

// Pay-per-event charge fired once per address that reaches a real verdict.
const CHARGE_EVENT = 'email-verified';

// Cap on how much of a remote list file we will read (10 MB).
const MAX_FILE_BYTES = 10 * 1024 * 1024;

// RFC-5322-ish email syntax check. Mirrors the regex used in test.js so the
// local "syntax-only" path agrees with the unit tests.
const EMAIL_REGEX = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*\.[a-zA-Z]{2,}$/;

// Looser variant used to pull addresses out of arbitrary CSV/TXT content.
const EMAIL_SCAN_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*\.[a-zA-Z]{2,}/g;

function isValidSyntax(email) {
    return typeof email === 'string' && EMAIL_REGEX.test(email.trim());
}

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
        validationMode: 'full',
        checkedAt: new Date().toISOString(),
    };
}

// Build a syntax-only result for an email when no API key is configured.
// MX / SMTP / flags are null because those checks were not performed, and
// these results are never charged for.
function toSyntaxOnlyResult(email) {
    const passes = isValidSyntax(email);
    const domain = email.includes('@') ? email.split('@').pop().toLowerCase() : '';
    return {
        email,
        overall: passes ? 'unknown' : 'invalid',
        result: passes ? 'unknown' : 'invalid',
        deliverabilityScore: null,
        syntax: { passed: passes },
        mx: { passed: null, domain, records: [] },
        smtp: { passed: null, rejected: null },
        flags: { dnsValid: null, disposable: null, roleBased: null },
        validationMode: 'syntax-only',
        warning: 'Syntax check only — no DNS, MX or SMTP verification was performed, and this result was not charged for.',
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

// Pull every address out of a plain-text or CSV body. Works with one address
// per line, comma-separated values, and CSVs with arbitrary extra columns.
function extractEmails(text) {
    return text.match(EMAIL_SCAN_REGEX) ?? [];
}

// Download a remote .csv / .txt list and return the addresses it contains.
async function readEmailsFromUrl(url) {
    const response = await fetch(url, { redirect: 'follow' });
    if (!response.ok) {
        throw new Error(`Could not download the email list from ${url} — server returned ${response.status} ${response.statusText}.`);
    }

    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_FILE_BYTES) {
        throw new Error(`The file at ${url} is ${Math.round(declaredLength / 1024 / 1024)} MB. The limit is ${MAX_FILE_BYTES / 1024 / 1024} MB — split it into smaller files.`);
    }

    const text = await response.text();
    if (text.length > MAX_FILE_BYTES) {
        throw new Error(`The file at ${url} exceeds the ${MAX_FILE_BYTES / 1024 / 1024} MB limit — split it into smaller files.`);
    }

    return extractEmails(text);
}

// Read addresses out of an existing Apify dataset, e.g. the output of a
// scraper that ran earlier in the same workflow.
async function readEmailsFromDataset(datasetId, field) {
    const dataset = await Actor.openDataset(datasetId, { forceCloud: true });
    const { items } = await dataset.getData();
    const collected = [];

    for (const item of items) {
        if (field) {
            const value = item?.[field];
            if (typeof value === 'string') collected.push(...extractEmails(value));
            continue;
        }
        // No field named: scan every string value on the record.
        for (const value of Object.values(item ?? {})) {
            if (typeof value === 'string') collected.push(...extractEmails(value));
        }
    }

    return collected;
}

// Gather addresses from every input source the actor accepts.
async function collectEmails(input) {
    const collected = [];

    if (typeof input?.email === 'string' && input.email.trim()) {
        collected.push(input.email.trim());
    }

    if (Array.isArray(input?.emails)) {
        collected.push(...input.emails.filter((e) => typeof e === 'string'));
    }

    if (typeof input?.emailFileUrl === 'string' && input.emailFileUrl.trim()) {
        const fromFile = await readEmailsFromUrl(input.emailFileUrl.trim());
        log.info(`Read ${fromFile.length} address(es) from ${input.emailFileUrl.trim()}`);
        collected.push(...fromFile);
    }

    if (typeof input?.datasetId === 'string' && input.datasetId.trim()) {
        const fromDataset = await readEmailsFromDataset(input.datasetId.trim(), input.datasetField?.trim());
        log.info(`Read ${fromDataset.length} address(es) from dataset ${input.datasetId.trim()}`);
        collected.push(...fromDataset);
    }

    return collected;
}

async function main() {
    await Actor.init();

    // The Verimailx key is what makes real verification possible. Without it the
    // actor still runs so it produces usable output (and so Apify's automated QA
    // test passes without credentials), but it performs syntax checks only,
    // says so on every record, and charges nothing.
    const apiKey = process.env[API_KEY_ENV];
    const hasApiKey = Boolean(apiKey);
    if (!hasApiKey) {
        log.warning('='.repeat(78));
        log.warning(`${API_KEY_ENV} is not set, so full verification is unavailable.`);
        log.warning('This run performs SYNTAX CHECKS ONLY — no DNS, MX or SMTP verification.');
        log.warning('Nothing will be charged for these results.');
        log.warning('='.repeat(78));
    }

    let input;
    try {
        input = await Actor.getInput();
    } catch (err) {
        log.error(`Failed to read input: ${err.message}`);
        await Actor.exit(1);
        return;
    }

    let rawEmails;
    try {
        rawEmails = await collectEmails(input);
    } catch (err) {
        log.error(err.message);
        await Actor.fail(err.message);
        return;
    }

    const emails = [...new Set(rawEmails
        .filter((e) => typeof e === 'string' && e.trim().length > 0)
        .map((e) => e.trim().toLowerCase()))];
    const dropped = rawEmails.length - emails.length;

    if (dropped > 0) {
        log.warning(`Skipped ${dropped} empty or duplicate input item(s).`);
    }

    if (emails.length === 0) {
        const message = 'No email addresses found. Provide them via "email", "emails", "emailFileUrl", or "datasetId".';
        log.error(message);
        await Actor.fail(message);
        return;
    }

    const validationMode = hasApiKey ? 'full' : 'syntax-only';
    const batches = chunk(emails, BULK_MAX);
    log.info(`Verifying ${emails.length} email(s) across ${batches.length} batch(es) of up to ${BULK_MAX} (${validationMode} mode)...`);

    let successCount = 0;
    let errorCount = 0;
    let chargedCount = 0;

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
        const batch = batches[batchIndex];

        // Syntax-only path: no API calls, no charges.
        if (!hasApiKey) {
            for (const email of batch) {
                const result = toSyntaxOnlyResult(email);
                await Actor.pushData(result);
                log.info(`${result.email} -> ${result.overall} (${validationMode}, not charged)`);
                successCount += 1;
            }
            continue;
        }

        // Full path: call Verimailx /bulk-validate.
        try {
            const payload = await callBulk(batch, apiKey);
            const results = payload.results;

            if (results.length !== batch.length) {
                log.warning(`Batch ${batchIndex + 1}: Verimailx returned ${results.length} results for ${batch.length} emails.`);
            }

            for (const item of results) {
                const result = toActorResult(item);
                await Actor.pushData(result);

                // Charge only for addresses that reached a real verdict. This is
                // what bills the "Email Verified" pay-per-event price — without
                // it the actor delivers verification for free.
                try {
                    await Actor.charge({ eventName: CHARGE_EVENT, count: 1 });
                    chargedCount += 1;
                } catch (chargeError) {
                    log.warning(`Could not charge for ${result.email}: ${chargeError?.message ?? chargeError}`);
                }

                log.info(`${result.email} -> ${result.overall} (verimailx:${result.result} score:${result.deliverabilityScore ?? '-'})`);
                successCount += 1;
            }

            if (typeof payload?.credits_remaining === 'number') {
                log.info(`Batch ${batchIndex + 1} done. Credits remaining: ${payload.credits_remaining}`);
            }
        } catch (error) {
            // Failed batches are reported but never charged for.
            log.error(`Batch ${batchIndex + 1} failed: ${error?.message ?? error}`);
            for (const email of batch) {
                await Actor.pushData({
                    email,
                    overall: 'error',
                    result: 'unknown',
                    deliverabilityScore: null,
                    validationMode,
                    error: error?.message ?? String(error),
                    checkedAt: new Date().toISOString(),
                });
            }
            errorCount += batch.length;
        }
    }

    log.info(`Done. verified=${successCount} charged=${chargedCount} errors=${errorCount}`);
    await Actor.exit();
}

main().catch(async (err) => {
    log.error(`Fatal: ${err?.stack ?? err}`);
    try { await Actor.exit(1); } catch { /* noop */ }
    process.exit(1);
});
