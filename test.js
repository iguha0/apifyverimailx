// Standalone unit test for the email verifier's regex and helper logic.
// Does not hit the network.
//
// Run with:  node test.js

import assert from 'node:assert/strict';

const EMAIL_REGEX = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*\.[a-zA-Z]{2,}$/;

function checkSyntax(email) {
    const value = typeof email === 'string' ? email.trim() : '';
    return {
        passed: value.length > 0 && EMAIL_REGEX.test(value),
        value,
    };
}

let passed = 0;
let failed = 0;

async function test(name, fn) {
    try {
        await fn();
        passed += 1;
        console.log(`  ✓ ${name}`);
    } catch (err) {
        failed += 1;
        console.error(`  ✗ ${name}\n      ${err.message}`);
    }
}

console.log('Email verifier unit tests\n');

// ---------- Valid syntax ----------
await test('accepts plain user@domain.tld', () => {
    assert.equal(checkSyntax('user@gmail.com').passed, true);
});
await test('accepts dots and + in local part', () => {
    assert.equal(checkSyntax('user.name+tag@sub.example.co').passed, true);
});
await test('accepts hyphenated domain', () => {
    assert.equal(checkSyntax('user@my-cool-site.io').passed, true);
});
await test('accepts multi-level subdomain', () => {
    assert.equal(checkSyntax('user@mail.team.example.com').passed, true);
});
await test('trims surrounding whitespace', () => {
    const r = checkSyntax('  user@gmail.com  ');
    assert.equal(r.passed, true);
    assert.equal(r.value, 'user@gmail.com');
});

// ---------- Invalid syntax ----------
await test('rejects empty string', () => assert.equal(checkSyntax('').passed, false));
await test('rejects null', () => assert.equal(checkSyntax(null).passed, false));
await test('rejects undefined', () => assert.equal(checkSyntax(undefined).passed, false));
await test('rejects number', () => assert.equal(checkSyntax(42).passed, false));
await test('rejects string with no @', () => assert.equal(checkSyntax('plainstring').passed, false));
await test('rejects missing local part', () => assert.equal(checkSyntax('@gmail.com').passed, false));
await test('rejects missing domain', () => assert.equal(checkSyntax('user@').passed, false));
await test('rejects domain with no TLD', () => assert.equal(checkSyntax('user@gmail').passed, false));
await test('rejects domain starting with dot', () => assert.equal(checkSyntax('user@.com').passed, false));
await test('rejects space inside address', () => assert.equal(checkSyntax('user @gmail.com').passed, false));
await test('rejects whitespace-only string', () => assert.equal(checkSyntax('   ').passed, false));
await test('rejects missing TLD after subdomain', () => assert.equal(checkSyntax('user@a.b').passed, false));

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) {
    console.error('✗ unit tests failed');
    process.exit(1);
}
console.log('✓ all unit tests passed');
