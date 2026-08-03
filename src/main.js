import { Actor } from 'apify';
import dns from 'node:dns/promises';
import net from 'node:net';

// Logger that uses Actor.log when running on Apify, console locally.
const log = {
    info: (msg) => (Actor.log ? Actor.log.info(msg) : console.log(`INFO  ${msg}`)),
    warning: (msg) => (Actor.log ? Actor.log.warning(msg) : console.warn(`WARN  ${msg}`)),
    error: (msg) => (Actor.log ? Actor.log.error(msg) : console.error(`ERROR ${msg}`)),
};

// Email syntax regex.
//   - local-part: letters, digits, dots, underscores, %, +, -
//   - domain:     labels separated by dots, ending in a TLD of 2+ letters
//   - rejects strings with no local part, no domain, or no TLD
const EMAIL_REGEX = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*\.[a-zA-Z]{2,}$/;

const DNS_TIMEOUT_MS = 5000;
const SMTP_TIMEOUT_MS = 8000;
const SMTP_PORT = 25;

// ============================================================
// Check 1 — syntax
// ============================================================
function checkSyntax(email) {
    const value = typeof email === 'string' ? email.trim() : '';
    return {
        passed: value.length > 0 && EMAIL_REGEX.test(value),
        value,
    };
}

// ============================================================
// Check 2 — DNS MX lookup
// ============================================================
async function checkMx(email) {
    const atIndex = email.lastIndexOf('@');
    if (atIndex === -1) {
        return { passed: false, domain: '', records: [], error: 'No domain found in email.' };
    }
    const domain = email.slice(atIndex + 1).toLowerCase();

    try {
        const records = await Promise.race([
            dns.resolveMx(domain),
            new Promise((_, reject) => {
                setTimeout(() => reject(new Error(`DNS MX lookup timed out after ${DNS_TIMEOUT_MS}ms`)), DNS_TIMEOUT_MS);
            }),
        ]);
        const sorted = [...records].sort((a, b) => a.priority - b.priority);
        return {
            passed: records.length > 0,
            domain,
            records: sorted.map((r) => ({ exchange: r.exchange, priority: r.priority })),
        };
    } catch (error) {
        return {
            passed: false,
            domain,
            records: [],
            error: error.code ? `${error.code}: ${error.message}` : error.message,
        };
    }
}

// ============================================================
// Check 3 — simulated SMTP handshake
//   Performs: connect -> EHLO -> MAIL FROM -> RCPT TO -> QUIT
//   Robust to: multi-line SMTP replies, server-initiated errors, timeouts.
// ============================================================
function checkSmtp(email, mxHost) {
    return new Promise((resolve) => {
        if (!mxHost) {
            resolve({ passed: false, steps: [], error: 'No MX host available.' });
            return;
        }

        const steps = [];
        const EHLO_DOMAIN = 'email-verifier.local';
        const FROM_ADDR = `verifier@${EHLO_DOMAIN}`;

        let settled = false;
        let buffer = '';
        let bytes = 0;

        const socket = new net.Socket();
        socket.setTimeout(SMTP_TIMEOUT_MS);

        const timer = setTimeout(() => finish({
            passed: false,
            steps,
            error: `Timed out after ${SMTP_TIMEOUT_MS}ms`,
        }), SMTP_TIMEOUT_MS);

        const recordStep = (label, sent, response) => {
            steps.push({ step: label, sent: sent ?? null, response: response ?? null });
        };

        function finish(result) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try { socket.end(); } catch { /* noop */ }
            try { socket.destroy(); } catch { /* noop */ }
            resolve(result);
        }

        // SMTP responses are lines starting with a 3-digit code followed by
        // either SP (last line) or - (continuation). We accumulate full
        // responses — possibly multi-line — until we see one ending in SP.
        function consumeResponse() {
            const lines = buffer.split('\r\n');
            // If the last segment is incomplete (no trailing CRLF), keep it.
            if (!buffer.endsWith('\r\n')) {
                buffer = lines.pop() ?? '';
            } else {
                buffer = '';
            }
            for (const line of lines) {
                if (line.length < 3) continue;
                const code = parseInt(line.slice(0, 3), 10);
                const sep = line.charAt(3);
                if (Number.isNaN(code)) continue;
                if (sep === '-') continue; // continuation line
                // Final line: starts with digit code followed by SP
                return { code, line };
            }
            return null;
        }

        function send(line) {
            try {
                socket.write(`${line}\r\n`);
            } catch (err) {
                finish({ passed: false, steps, error: `Write failed: ${err.message}` });
            }
        }

        socket.on('data', (chunk) => {
            if (settled) return;
            buffer += chunk.toString('utf8');
            bytes += chunk.length;

            // Strict size cap to avoid infinite-buffer abuse.
            if (bytes > 65536) {
                finish({ passed: false, steps, error: 'SMTP response exceeded 64KB cap.' });
                return;
            }

            const reply = consumeResponse();
            if (!reply) return;

            const stepIndex = steps.length;

            // --- step 0 (greeting) ---
            if (stepIndex === 0) {
                if (reply.code !== 220) {
                    finish({
                        passed: false,
                        steps: [{ step: 'connect', sent: null, response: reply.line }],
                        error: `Server greeting failed (code ${reply.code}).`,
                    });
                    return;
                }
                recordStep('connect', null, reply.line);
                send(`EHLO ${EHLO_DOMAIN}`);
                return;
            }

            // --- step 1 (EHLO reply) ---
            if (stepIndex === 1) {
                if (reply.code === 250) {
                    recordStep('ehlo', `EHLO ${EHLO_DOMAIN}`, reply.line);
                    send(`MAIL FROM:<${FROM_ADDR}>`);
                    return;
                }
                if (reply.code === 421 || reply.code === 450) {
                    finish({
                        passed: false,
                        steps: [...steps, { step: 'ehlo', sent: `EHLO ${EHLO_DOMAIN}`, response: reply.line }],
                        error: `Service not available (code ${reply.code}).`,
                    });
                    return;
                }
                finish({
                    passed: false,
                    steps: [...steps, { step: 'ehlo', sent: `EHLO ${EHLO_DOMAIN}`, response: reply.line }],
                    error: `EHLO rejected (code ${reply.code}).`,
                });
                return;
            }

            // --- step 2 (MAIL FROM reply) ---
            if (stepIndex === 2) {
                if (reply.code === 250) {
                    recordStep('mail_from', `MAIL FROM:<${FROM_ADDR}>`, reply.line);
                    send(`RCPT TO:<${email}>`);
                    return;
                }
                finish({
                    passed: false,
                    steps: [...steps, { step: 'mail_from', sent: `MAIL FROM:<${FROM_ADDR}>`, response: reply.line }],
                    error: `MAIL FROM rejected (code ${reply.code}).`,
                });
                return;
            }

            // --- step 3 (RCPT TO reply) — final verdict ---
            if (stepIndex === 3) {
                const accepted = reply.code === 250 || reply.code === 251;
                recordStep('rcpt_to', `RCPT TO:<${email}>`, reply.line);
                send('QUIT');
                finish({
                    passed: accepted,
                    steps,
                    rejectionCode: accepted ? null : reply.code,
                    error: accepted ? null : `SMTP rejected recipient (code ${reply.code}).`,
                });
                return;
            }

            // --- step 4 (QUIT reply) ---
            if (stepIndex === 4) {
                recordStep('quit', 'QUIT', reply.line);
                finish({ passed: true, steps });
            }
        });

        socket.on('timeout', () => {
            finish({ passed: false, steps, error: `Socket timed out after ${SMTP_TIMEOUT_MS}ms` });
        });

        socket.on('error', (err) => {
            finish({ passed: false, steps, error: err.message });
        });

        try {
            socket.connect(SMTP_PORT, mxHost);
        } catch (err) {
            finish({ passed: false, steps, error: `Connect failed: ${err.message}` });
        }
    });
}

// ============================================================
// Aggregate per-email verification
// ============================================================
async function verifyEmail(emailInput) {
    const result = {
        email: typeof emailInput === 'string' ? emailInput : String(emailInput ?? ''),
        syntax: { passed: false },
        mx: { passed: false },
        smtp: { passed: false },
        overall: 'invalid',
        checkedAt: new Date().toISOString(),
    };

    try {
        // 1. Syntax
        result.syntax = checkSyntax(emailInput);
        if (!result.syntax.passed || !result.syntax.value) {
            result.overall = 'invalid';
            return result;
        }
        const normalized = result.syntax.value;

        // 2. MX
        result.mx = await checkMx(normalized);
        if (!result.mx.passed) {
            result.overall = 'invalid';
            return result;
        }

        // 3. SMTP
        const primaryMx = result.mx.records[0]?.exchange;
        result.smtp = await checkSmtp(normalized, primaryMx);

        // Verdict logic:
        //   - SMTP explicitly accepted the recipient -> "valid"
        //   - SMTP explicitly rejected (5xx-code rejectionCode) -> "invalid"
        //   - Otherwise (timeout, network error, ambiguous) -> "unknown"
        if (result.smtp.passed) {
            result.overall = 'valid';
        } else if (result.smtp.rejectionCode && result.smtp.rejectionCode >= 500 && result.smtp.rejectionCode < 600) {
            result.overall = 'invalid';
        } else if (result.smtp.rejectionCode) {
            // 4xx transient (e.g. 454 relay denied, 450 greylisted) — not definitive
            result.overall = 'unknown';
        } else {
            result.overall = 'unknown';
        }
    } catch (error) {
        result.error = error?.message ?? String(error);
    }

    return result;
}

// ============================================================
// Main entry point
// ============================================================
async function main() {
    await Actor.init();

    let input;
    try {
        input = await Actor.getInput();
    } catch (err) {
        log.error(`Failed to read input: ${err.message}`);
    }

    const rawEmails = Array.isArray(input?.emails) ? input.emails : [];
    const emails = rawEmails.filter((e) => typeof e === 'string' && e.trim().length > 0);
    const droppedCount = rawEmails.length - emails.length;

    if (droppedCount > 0) {
        log.warning(`Skipped ${droppedCount} non-string or empty input item(s).`);
    }

    if (emails.length === 0) {
        log.warning('No valid email strings provided in input. Exiting.');
        await Actor.exit();
        return;
    }

    log.info(`Verifying ${emails.length} email address(es)...`);

    let successCount = 0;
    let errorCount = 0;

    for (const email of emails) {
        try {
            const result = await verifyEmail(email);
            await Actor.pushData(result);
            log.info(`${result.email} -> ${result.overall} (syntax:${result.syntax.passed} mx:${result.mx.passed} smtp:${result.smtp.passed})`);
            successCount += 1;
        } catch (error) {
            const safeEmail = typeof email === 'string' ? email : '<invalid input>';
            await Actor.pushData({
                email: safeEmail,
                overall: 'error',
                error: error?.message ?? String(error),
                checkedAt: new Date().toISOString(),
            });
            log.error(`Failed to verify ${safeEmail}: ${error?.message ?? error}`);
            errorCount += 1;
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
