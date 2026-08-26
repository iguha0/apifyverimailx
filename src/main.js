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

// Bulk validation is asynchronous: the submit returns 202 with a job id, and the
// whole list is verified server-side. Nothing here holds a long connection open,
// so the old 150-second gateway ceiling no longer applies and there is no reason
// to chop the list into batches.
const SUBMIT_TIMEOUT_MS = 60_000;
const POLL_TIMEOUT_MS = 60_000;
const DOWNLOAD_TIMEOUT_MS = 180_000;

// The API documents a 5-10 second polling cadence. Seven keeps us comfortably
// inside even the Free plan's 1 request/second rate limit.
const POLL_INTERVAL_MS = 7_000;

// Upper bound on how long to wait for a job. The Actor's own run timeout is the
// real limit; this only stops a wedged job from polling forever.
const MAX_POLL_MS = 6 * 60 * 60 * 1000;

// Pay-per-event charge fired once per address that comes back with a verdict.
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Map a Verimailx verdict to the Actor's overall verdict.
function mapResult(value) {
    const v = String(value ?? '').toLowerCase();
    if (v === 'valid') return 'valid';
    if (v === 'invalid') return 'invalid';
    // A catch-all domain accepts mail for any address, so a mailbox behind one
    // cannot be confirmed — that is 'risky', not 'unknown', and it is the
    // distinction that decides whether an address is safe to send to.
    // Disposable and role-based mailboxes are risky for the same reason.
    if (v === 'risky' || v === 'catch_all' || v === 'catch-all'
        || v === 'disposable' || v === 'role_based' || v === 'role') return 'risky';
    return 'unknown';
}

// Read a value out of a CSV row under any of several plausible header names.
function pick(row, ...names) {
    for (const name of names) {
        if (row[name] !== undefined && row[name] !== '') return row[name];
    }
    return undefined;
}

function toBool(value) {
    if (value === undefined || value === null || value === '') return null;
    const v = String(value).trim().toLowerCase();
    if (['true', 'yes', 'y', '1'].includes(v)) return true;
    if (['false', 'no', 'n', '0'].includes(v)) return false;
    return null;
}

function toNumber(value) {
    if (value === undefined || value === null || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? Math.round(n) : null;
}

// Turn one row of the results CSV into a dataset record. Header names are read
// defensively — the whole row is also attached as `raw` so nothing is lost if a
// column is named differently than expected.
function rowToActorResult(row) {
    const email = String(pick(row, 'email', 'Email', 'address', 'email_address') ?? '').trim().toLowerCase();
    const verdict = pick(row, 'result', 'Result', 'status', 'verdict');
    const domain = email.includes('@') ? email.split('@').pop() : '';

    const disposable = toBool(pick(row, 'is_disposable', 'disposable'));
    const roleBased = toBool(pick(row, 'is_role_based', 'role_based', 'role'));
    const catchAll = toBool(pick(row, 'is_catch_all', 'catch_all', 'catchall'));

    // A catch-all flag counts as risky even when the verdict column doesn't say so.
    let overall = mapResult(verdict);
    if (overall === 'valid' && (catchAll === true || disposable === true || roleBased === true)) {
        overall = 'risky';
    }

    const mxRaw = pick(row, 'mx_hosts', 'mx', 'mx_records');
    const records = typeof mxRaw === 'string' && mxRaw.trim()
        ? mxRaw.split(/[;|,]/).map((h) => ({ exchange: h.trim(), priority: null })).filter((r) => r.exchange)
        : [];

    return {
        email,
        overall,
        result: verdict === undefined ? 'unknown' : String(verdict),
        deliverabilityScore: toNumber(pick(row, 'deliverability_score', 'score')),
        syntax: { passed: toBool(pick(row, 'is_syntax_valid', 'syntax_valid')) ?? isValidSyntax(email) },
        mx: { passed: toBool(pick(row, 'is_mx_valid', 'mx_valid')), domain, records },
        smtp: {
            passed: toBool(pick(row, 'is_smtp_valid', 'smtp_valid')),
            rejected: toBool(pick(row, 'is_smtp_valid', 'smtp_valid')) === false,
        },
        flags: {
            dnsValid: toBool(pick(row, 'is_dns_valid', 'dns_valid')),
            disposable,
            roleBased,
            catchAll,
        },
        validationMode: 'full',
        raw: row,
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
        flags: { dnsValid: null, disposable: null, roleBased: null, catchAll: null },
        validationMode: 'syntax-only',
        warning: 'Syntax check only — no DNS, MX or SMTP verification was performed, and this result was not charged for.',
        checkedAt: new Date().toISOString(),
    };
}

// Build a record for an address the service could not answer for. Same field
// shape as every other record so the dataset schema accepts it.
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
        flags: { dnsValid: null, disposable: null, roleBased: null, catchAll: null },
        validationMode,
        error: message,
        warning: 'This address could not be verified and was not charged for.',
        checkedAt: new Date().toISOString(),
    };
}

async function request(url, options, timeoutMs, what) {
    try {
        return await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
        if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
            throw new Error(`${what} did not answer within ${Math.round(timeoutMs / 1000)}s.`);
        }
        throw err;
    }
}

// Submit the whole list. Returns 202 with a job id; credits are deducted at
// submission and refunded automatically by the service if the job fails.
async function submitJob(emails, apiKey) {
    const response = await request(BULK_ENDPOINT, {
        method: 'POST',
        headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ emails }),
    }, SUBMIT_TIMEOUT_MS, 'Verimailx');

    const text = await response.text().catch(() => '');
    if (!response.ok) {
        if (response.status === 402) throw new Error(`Not enough Verimailx credits to verify ${emails.length} address(es). ${text}`);
        if (response.status === 401) throw new Error('Verimailx rejected the API key. Check APIFY-VERIMAILX-API-KEY on this Actor.');
        if (response.status === 429) throw new Error(`Verimailx rate limit reached. ${text}`);
        throw new Error(`Verimailx returned ${response.status}: ${text || response.statusText}`);
    }

    let payload;
    try {
        payload = JSON.parse(text);
    } catch {
        throw new Error(`Verimailx returned a non-JSON response: ${text.slice(0, 200)}`);
    }
    if (!payload?.job_id) throw new Error(`Verimailx accepted the list but returned no job_id: ${text.slice(0, 200)}`);
    return payload;
}

// How many consecutive "job not found" responses to tolerate before giving up.
// A couple are plausible while the job propagates; a steady stream means the
// status endpoint cannot see the job at all, and waiting will not fix that.
const MAX_NOT_FOUND = 5;

// Poll until the job reaches a terminal state.
async function pollJob(statusUrl, apiKey, jobId) {
    const startedAt = Date.now();
    let lastPercent = -1;
    let notFound = 0;

    log.info(`Polling ${statusUrl} every ${POLL_INTERVAL_MS / 1000}s.`);

    for (;;) {
        if (Date.now() - startedAt > MAX_POLL_MS) {
            throw new Error(`The verification job did not finish within ${Math.round(MAX_POLL_MS / 3600000)} hours.`);
        }

        await sleep(POLL_INTERVAL_MS);

        let payload;
        try {
            const response = await request(statusUrl, {
                headers: { 'X-API-Key': apiKey },
            }, POLL_TIMEOUT_MS, 'Verimailx status');
            const text = await response.text().catch(() => '');

            if (response.status === 404) {
                notFound += 1;
                if (notFound >= MAX_NOT_FOUND) {
                    throw new Error(
                        `The status endpoint does not recognise job ${jobId}. `
                        + `The submit returned it and the addresses were accepted, so the job is running — `
                        + `but GET ${statusUrl} answers 404, so its results cannot be collected. `
                        + `This is a fault in the verification service, not in this Actor. `
                        + `Response: ${text.slice(0, 200)}`,
                    );
                }
                log.warning(`Status check returned 404 (${notFound}/${MAX_NOT_FOUND}); the job may still be registering. Retrying in ${POLL_INTERVAL_MS / 1000}s.`);
                continue;
            }

            if (!response.ok) {
                // A transient poll failure is not a job failure — keep waiting.
                log.warning(`Status check returned ${response.status}; retrying in ${POLL_INTERVAL_MS / 1000}s.`);
                continue;
            }

            notFound = 0;
            payload = JSON.parse(text);
        } catch (err) {
            if (err?.message?.includes('does not recognise job')) throw err;
            log.warning(`Status check failed (${err?.message ?? err}); retrying in ${POLL_INTERVAL_MS / 1000}s.`);
            continue;
        }

        const percent = Number(payload?.progress_percent);
        if (Number.isFinite(percent) && percent !== lastPercent) {
            lastPercent = percent;
            log.info(`Verifying… ${percent}% (${payload.processed ?? '?'}/${payload.total ?? '?'})`);
        }

        if (payload?.status === 'completed') return payload;
        if (payload?.status === 'failed') {
            throw new Error(`Verimailx reported the job failed: ${payload.error ?? 'no reason given'}. Credits for a failed job are refunded automatically.`);
        }
    }
}

// Minimal RFC 4180 CSV parser: handles quoted fields, escaped quotes and
// embedded newlines. Returns an array of objects keyed by the header row.
function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;

    for (let i = 0; i < text.length; i += 1) {
        const c = text[i];

        if (inQuotes) {
            if (c === '"') {
                if (text[i + 1] === '"') { field += '"'; i += 1; } else { inQuotes = false; }
            } else {
                field += c;
            }
            continue;
        }

        if (c === '"') { inQuotes = true; continue; }
        if (c === ',') { row.push(field); field = ''; continue; }
        if (c === '\r') continue;
        if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
        field += c;
    }
    if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }

    if (rows.length === 0) return { headers: [], records: [] };
    const headers = rows[0].map((h) => h.trim());
    const records = rows.slice(1)
        .filter((r) => r.some((v) => v !== ''))
        .map((r) => Object.fromEntries(headers.map((h, idx) => [h, (r[idx] ?? '').trim()])));

    return { headers, records };
}

// Pull every address out of a plain-text or CSV body.
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

// Read addresses out of an existing Apify dataset.
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
    if (dropped > 0) log.warning(`Skipped ${dropped} empty or duplicate input item(s).`);

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

    let saved = 0;
    let charged = 0;

    const safePush = async (record) => {
        try {
            await Actor.pushData(record);
            saved += 1;
            return true;
        } catch (pushError) {
            log.error(`Could not save the result for ${record.email}: ${pushError?.message ?? pushError}`);
            return false;
        }
    };

    // Syntax-only path: no API calls, no charges.
    if (!hasApiKey) {
        log.info(`Checking ${emails.length} address(es), syntax only.`);
        for (const email of emails) {
            const result = toSyntaxOnlyResult(email);
            await safePush(result);
            log.info(`${result.email} -> ${result.overall} (syntax-only, not charged)`);
        }
        log.info(`Done. saved=${saved} charged=0`);
        await Actor.exit();
        return;
    }

    const edition = isFreeTier ? ' (free edition, not charged)' : '';
    log.info(`Submitting ${emails.length} address(es) for verification${edition}...`);

    let job;
    try {
        job = await submitJob(emails, apiKey);
    } catch (err) {
        log.error(err.message);
        await Actor.fail(err.message);
        return;
    }

    log.info(`Job ${job.job_id} accepted: ${job.total ?? emails.length} address(es), ${job.credits_used ?? '?'} credit(s) reserved, ${job.credits_remaining ?? '?'} remaining.`);
    log.info('Verification runs server-side. This Actor polls until it finishes — no need to keep anything open.');

    // Always poll the documented public endpoint, built from the job id.
    //
    // The submit response carries its own `status_url`, and following it is the
    // obvious thing to do — but in practice that field has come back pointing at
    // an internal host over plain http, which is unroutable from here and is not
    // something any API consumer should be handed. The public base is documented
    // and stable, so it is the safer source of truth. A mismatch is logged rather
    // than followed, so the leak stays visible without breaking the run.
    const statusUrl = `${BULK_ENDPOINT}?job_id=${encodeURIComponent(job.job_id)}`;
    if (job.status_url && !String(job.status_url).startsWith(VERIMAILX_BASE)) {
        log.warning(`The API returned status_url "${job.status_url}", which is not on ${VERIMAILX_BASE}. Ignoring it and polling the documented endpoint instead.`);
    }

    let final;
    try {
        final = await pollJob(statusUrl, apiKey, job.job_id);
    } catch (err) {
        log.error(err.message);
        for (const email of emails) await safePush(toErrorResult(email, err.message, 'full'));
        await Actor.fail(err.message);
        return;
    }

    if (final.summary) {
        const s = final.summary;
        log.info(`Verified: valid=${s.valid ?? 0} invalid=${s.invalid ?? 0} unknown=${s.unknown ?? 0} catch_all=${s.catch_all ?? 0} disposable=${s.disposable ?? 0} role=${s.role ?? 0}`);
    }

    if (!final.download_url) {
        const message = 'The job completed but returned no download_url, so there are no per-address results to save.';
        log.error(message);
        await Actor.fail(message);
        return;
    }

    let csvText;
    try {
        const response = await request(final.download_url, {}, DOWNLOAD_TIMEOUT_MS, 'Results download');
        if (!response.ok) throw new Error(`Results download returned ${response.status} ${response.statusText}.`);
        csvText = await response.text();
    } catch (err) {
        const message = `Could not download the results: ${err?.message ?? err}. The link is valid for ${final.download_url_expires_in ?? 3600}s — the job itself succeeded, so you can retrieve it manually with job_id ${final.job_id}.`;
        log.error(message);
        await Actor.fail(message);
        return;
    }

    const { headers, records } = parseCsv(csvText);
    // Logged so the exact column names of a real results file are visible in
    // the run log rather than inferred.
    log.info(`Results CSV columns: ${headers.join(', ') || '(none)'}`);

    if (records.length === 0) {
        const message = 'The results file contained no rows.';
        log.error(message);
        await Actor.fail(message);
        return;
    }

    for (const record of records) {
        const result = rowToActorResult(record);
        const ok = await safePush(result);

        // Charge only for addresses that reached a verdict, and only once the
        // row is safely in the dataset. The free edition never charges.
        if (ok && !isFreeTier) {
            try {
                await Actor.charge({ eventName: CHARGE_EVENT, count: 1 });
                charged += 1;
            } catch (chargeError) {
                log.warning(`Could not charge for ${result.email}: ${chargeError?.message ?? chargeError}`);
            }
        }
    }

    const missing = emails.length - records.length;
    if (missing > 0) {
        log.warning(`${missing} submitted address(es) were not present in the results file.`);
    }

    log.info(`Done. saved=${saved} charged=${charged} of ${emails.length} submitted.`);

    if (saved === 0) {
        await Actor.fail('No results could be saved. See the log for details.');
        return;
    }

    await Actor.exit();
}

main().catch(async (err) => {
    log.error(`Fatal: ${err?.stack ?? err}`);
    try { await Actor.exit(1); } catch { /* noop */ }
    process.exit(1);
});
