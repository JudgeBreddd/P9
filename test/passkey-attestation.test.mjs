// A passkey whose authenticator sends a certificate (packed attestation with x5c) still registers through the same
// library P9's login uses (apps/server/auth.mjs): the certificate is parsed, its chain built to the trust anchor and its
// signature checked, all on @peculiar/x509 and its ASN.1 packages (and through them asn1js). P9 asks for no
// attestation, so the virtual authenticator in the other login tests never reaches this path.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { webcrypto as crypto } from 'node:crypto';
import { verifyRegistrationResponse, SettingsService } from '@simplewebauthn/server';
import { isoBase64URL, isoCBOR, isoUint8Array } from '@simplewebauthn/server/helpers';

// The @peculiar/x509 copy @simplewebauthn/server itself loads, not whichever one sits at the top of node_modules.
const x509 = await import(createRequire(fileURLToPath(import.meta.resolve('@simplewebauthn/server'))).resolve('@peculiar/x509'));
x509.cryptoProvider.set(crypto);
const ALG = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' };
const keys = () => crypto.subtle.generateKey(ALG, true, ['sign', 'verify']);
const day = 86400000, notBefore = new Date(Date.now() - day), notAfter = new Date(Date.now() + day);
const sha256 = async (b) => new Uint8Array(await crypto.subtle.digest('SHA-256', b));
// WebAuthn's ECDSA signatures are DER; WebCrypto gives r || s.
const der = (raw) => { const int = (b) => { let i = 0; while (i < b.length - 1 && b[i] === 0) i++; b = b.slice(i); return b[0] & 0x80 ? [0, ...b] : [...b]; };
  const r = int(raw.slice(0, 32)), s = int(raw.slice(32)); return Uint8Array.from([0x30, r.length + s.length + 4, 2, r.length, ...r, 2, s.length, ...s]); };

async function ca(name) {
  const k = await keys();
  const cert = await x509.X509CertificateGenerator.createSelfSigned({ serialNumber: '01', name, notBefore, notAfter, keys: k, signingAlgorithm: ALG,
    extensions: [new x509.BasicConstraintsExtension(true, undefined, true), new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign, true), await x509.SubjectKeyIdentifierExtension.create(k.publicKey)] });
  return { k, cert };
}
// One registration as an authenticator with a certificate sends it: the leaf signed by issuer, x5c = [leaf].
async function registration(issuer, challenge) {
  const att = await keys(), cred = await keys();
  const leaf = await x509.X509CertificateGenerator.create({ serialNumber: '02', subject: 'C=US, O=P9 test, OU=Authenticator Attestation, CN=P9 test key', issuer: issuer.cert.subject,
    notBefore, notAfter, publicKey: att.publicKey, signingKey: issuer.k.privateKey, signingAlgorithm: ALG,
    extensions: [new x509.BasicConstraintsExtension(false, undefined, true), await x509.AuthorityKeyIdentifierExtension.create(issuer.k.publicKey)] });
  const jwk = await crypto.subtle.exportKey('jwk', cred.publicKey), id = crypto.getRandomValues(new Uint8Array(16));
  const cose = isoCBOR.encode(new Map([[1, 2], [3, -7], [-1, 1], [-2, isoBase64URL.toBuffer(jwk.x)], [-3, isoBase64URL.toBuffer(jwk.y)]]));
  const authData = isoUint8Array.concat([await sha256(new TextEncoder().encode('localhost')), Uint8Array.of(0x45, 0, 0, 0, 0), crypto.getRandomValues(new Uint8Array(16)), Uint8Array.of(0, id.length), id, cose]);
  const clientData = new TextEncoder().encode(JSON.stringify({ type: 'webauthn.create', challenge, origin: 'https://localhost', crossOrigin: false }));
  const sig = der(new Uint8Array(await crypto.subtle.sign(ALG, att.privateKey, isoUint8Array.concat([authData, await sha256(clientData)]))));
  const attestationObject = isoCBOR.encode(new Map([['fmt', 'packed'], ['attStmt', new Map([['alg', -7], ['sig', sig], ['x5c', [new Uint8Array(leaf.rawData)]]])], ['authData', authData]]));
  return { id: isoBase64URL.fromBuffer(id), rawId: isoBase64URL.fromBuffer(id), type: 'public-key', clientExtensionResults: {},
    response: { clientDataJSON: isoBase64URL.fromBuffer(clientData), attestationObject: isoBase64URL.fromBuffer(attestationObject), transports: ['usb'] } };
}

test('passkey attestation: a packed x5c certificate chained to a trusted root registers; one from another root is refused', { timeout: 30000 }, async () => {
  const root = await ca('CN=P9 test root, O=P9 test, C=US'), other = await ca('CN=Other root, O=P9 test, C=US');
  SettingsService.setRootCertificates({ identifier: 'packed', certificates: [root.cert.toString('pem')] });
  const check = async (issuer) => { const challenge = isoBase64URL.fromBuffer(crypto.getRandomValues(new Uint8Array(32)));
    return verifyRegistrationResponse({ response: await registration(issuer, challenge), expectedChallenge: challenge, expectedOrigin: 'https://localhost', expectedRPID: 'localhost', requireUserVerification: true }); };
  const good = await check(root);
  assert.equal(good.verified, true);
  assert.equal(good.registrationInfo.fmt, 'packed');
  await assert.rejects(check(other), /certificate|path|anchor/i, 'a chain that does not reach the trusted root is refused');
  console.log('PASS passkey packed x5c attestation');
});
