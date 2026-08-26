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

// The upstream gateway drops a request that stays idle for 150 seconds, and an
// SMTP handshake takes roughly five seconds per address, so a request carrying
// more than about thirty addresses times out before it can answer. Batches are
// therefore kept small and sent in sequence; a batch that still times out is
// split in half and retried once.
const BULK_MAX_DEFAULT = 20;
const BULK_MAX_ALLOWED = 40;
const REQUEST_TIMEOUT_MS = 140_000;

// Pay-per-event charge fired once per address that reaches a real verdict.
const CHARGE_EVENT = 'email-verified';

// Set FREE_TIER_LIMIT on an Actor to run it as a free, capped edition: at most
// this many addresses per run, and nothing is ever charged. Left unset, the
// Actor runs unlimited and bills per verified address.
const FREE_TIER_LIMIT = Number.parseInt(process.env.FREE_TIER_LIMIT ?? '', 10);
const isFreeTier = Number.isInteger(FREE_TIER_LIMIT) && FREE_TIER_LIMIT > 0;

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

// Build a record for an address the upstream service could not answer for.
// It carries the same field shape as every other record so the dataset schema
// accepts it — an error row that the schema rejects takes the whole run down.
function toErrorResult(email, message, validationMode) {
    const domain = email.includes('@') ? email.split('@').pop().toLowerCase() : '';
    return {
        email,
        overall: 'error',
        result: 'unknown',
        deliverabilityScore: null,
        syntax: { passed: isValidSyntax(email) },
        mx: { passed: null, domain, records: [] },
        smtp: { passed: null, rejected: null },
        flags: { dnsValid: null, disposable: null, roleBased: null },
        validationMode,
        error: message,
        warning: 'This address could not be verified and was not charged for.',
        checkedAt: new Date().toISOString(),
    };
}

// POST { emails: [...] } to /bulk-validate and return the results array.
async function callBulk(emails, apiKey) {
    let response;
    try {
        response = await fetch(BULK_ENDPOINT, {
            method: 'POST',
            headers: {
                'X-API-Key': apiKey,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ emails }),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
    } catch (err) {
        if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
            const timeoutError = new Error(`Verimailx did not answer within ${REQUEST_TIMEOUT_MS / 1000}s for a batch of ${emails.length}.`);
            timeoutError.isTimeout = true;
            throw timeoutError;
        }
        throw err;
    }

    if (!response.ok) {
        const text = await response.text().catch(() => '');
        const error = new Error(`Verimailx API returned ${response.status}: ${text || response.statusText}`);
        // The upstream gateway reports its own idle timeout as a 504; treat it
        // the same as a client-side timeout so the batch gets split and retried.
        error.isTimeout = response.status === 504 || text.includes('IDLE_TIMEOUT');
        throw error;
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

    const deduped = [...new Set(rawEmails
        .filter((e) => typeof e === 'string' && e.trim().length > 0)
        .map((e) => e.trim().toLowerCase()))];
    const dropped = rawEmails.length - deduped.length;

    if (dropped > 0) {
        log.warning(`Skipped ${dropped} empty or duplicate input item(s).`);
    }

    // Free edition: verify the first N addresses and say plainly how many were
    // left out, rather than silently truncating the list.
    let emails = deduped;
    if (isFreeTier && deduped.length > FREE_TIER_LIMIT) {
        emails = deduped.slice(0, FREE_TIER_LIMIT);
        log.warning('='.repeat(78));
        log.warning(`This free Actor verifies up to ${FREE_TIER_LIMIT} addresses per run.`);
        log.warning(`You submitted ${deduped.length}, so ${deduped.length - FREE_TIER_LIMIT} were NOT checked.`);
        log.warning('For unlimited runs at $0.30 per 1,000, use the full version:');
        log.warning('https://apify.com/cold_email_master/bulk-email-verifier-validator');
        log.warning('='.repeat(78));
    }

    if (emails.length === 0) {
        const message = 'No email addresses found. Provide them via "email", "emails", "emailFileUrl", or "datasetId".';
        log.error(message);
        await Actor.fail(message);
        return;
    }

    const requestedBatchSize = Number.parseInt(input?.batchSize ?? '', 10);
    const batchSize = Number.isInteger(requestedBatchSize) && requestedBatchSize > 0
        ? Math.min(requestedBatchSize, BULK_MAX_ALLOWED)
        : BULK_MAX_DEFAULT;

    const validationMode = hasApiKey ? 'full' : 'syntax-only';
    const batches = chunk(emails, batchSize);
    const edition = isFreeTier ? ', free edition, not charged' : '';
    log.info(`Verifying ${emails.length} email(s) in ${batches.length} batch(es) of up to ${batchSize} (${validationMode} mode${edition})...`);
    if (hasApiKey && emails.length > 200) {
        const minutes = Math.ceil((emails.length * 5) / 60);
        log.info(`Verification runs about five seconds per address, so expect roughly ${minutes} minute(s). Make sure this run's timeout allows for that.`);
    }

    let successCount = 0;
    let errorCount = 0;
    let chargedCount = 0;

    // A record the dataset schema rejects would otherwise throw and kill the
    // whole run, losing every result gathered so far.
    const safePush = async (record) => {
        try {
            await Actor.pushData(record);
            return true;
        } catch (pushError) {
            log.error(`Could not save the result for ${record.email}: ${pushError?.message ?? pushError}`);
            return false;
        }
    };

    // Verify one batch, splitting it in half and retrying if the upstream
    // service times out on a batch this size.
    const verifyBatch = async (batch, label, canSplit) => {
        try {
            const payload = await callBulk(batch, apiKey);
            const results = payload.results;

            if (results.length !== batch.length) {
                log.warning(`${label}: Verimailx returned ${results.length} results for ${batch.length} emails.`);
            }

            for (const item of results) {
                const result = toActorResult(item);
                await safePush(result);

                // Charge only for addresses that reached a real verdict. This is
                // what bills the "Email Verified" pay-per-event price — without
                // it the actor delivers verification for free. The free edition
                // skips this entirely.
                if (!isFreeTier) {
                    try {
                        await Actor.charge({ eventName: CHARGE_EVENT, count: 1 });
                        chargedCount += 1;
                    } catch (chargeError) {
                        log.warning(`Could not charge for ${result.email}: ${chargeError?.message ?? chargeError}`);
                    }
                }

                log.info(`${result.email} -> ${result.overall} (verimailx:${result.result} score:${result.deliverabilityScore ?? '-'})`);
                successCount += 1;
            }

            if (typeof payload?.credits_remaining === 'number') {
                log.info(`${label} done. Credits remaining: ${payload.credits_remaining}`);
            }
            return;
        } catch (error) {
            if (error?.isTimeout && canSplit && batch.length > 1) {
                const half = Math.ceil(batch.length / 2);
                log.warning(`${label} timed out at ${batch.length} addresses. Splitting into two smaller batches and retrying.`);
                await verifyBatch(batch.slice(0, half), `${label}a`, false);
                await verifyBatch(batch.slice(half), `${label}b`, false);
                return;
            }

            // Failed batches are reported but never charged for.
            const message = error?.message ?? String(error);
            log.error(`${label} failed: ${message}`);
            for (const email of batch) {
                await safePush(toErrorResult(email, message, validationMode));
                errorCount += 1;
            }
        }
    };

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
        const batch = batches[batchIndex];

        // Syntax-only path: no API calls, no charges.
        if (!hasApiKey) {
            for (const email of batch) {
                const result = toSyntaxOnlyResult(email);
                await safePush(result);
                log.info(`${result.email} -> ${result.overall} (${validationMode}, not charged)`);
                successCount += 1;
            }
            continue;
        }

        await verifyBatch(batch, `Batch ${batchIndex + 1}/${batches.length}`, true);
    }

    log.info(`Done. verified=${successCount} charged=${chargedCount} errors=${errorCount}`);

    // A run where nothing could be verified is a failure, whatever the exit
    // path — reporting it as a success leaves the caller with an empty dataset
    // and no reason to look at the log.
    if (successCount === 0 && errorCount > 0) {
        await Actor.fail(`No addresses could be verified — all ${errorCount} failed. See the log for the upstream error.`);
        return;
    }

    await Actor.exit();
}

main().catch(async (err) => {
    log.error(`Fatal: ${err?.stack ?? err}`);
    try { await Actor.exit(1); } catch { /* noop */ }
    process.exit(1);
});
