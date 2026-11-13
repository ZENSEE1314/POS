import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createSign, generateKeyPairSync, randomBytes } from 'node:crypto';
import { AlipayProvider, canonicalString } from '../src/payments/alipay.ts';
import { WechatProvider } from '../src/payments/wechat.ts';

const merchant = generateKeyPairSync('rsa', { modulusLength: 2048 });
const remote = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = (k: any, type: 'private' | 'public') => k.export({ type: type === 'private' ? 'pkcs8' : 'spki', format: 'pem' }) as string;

test('alipay notify with a valid RSA2 signature parses to paid', () => {
  const provider = new AlipayProvider({ appId: 'app1', privateKeyPem: pem(merchant.privateKey, 'private'), alipayPublicKeyPem: pem(remote.publicKey, 'public') });
  const params: Record<string, string> = { app_id: 'app1', out_trade_no: 'NP1', trade_no: 'T9', total_amount: '12.34', trade_status: 'TRADE_SUCCESS', notify_id: 'n1', sign_type: 'RSA2' };
  params.sign = createSign('RSA-SHA256').update(canonicalString(params, true)).sign(pem(remote.privateKey, 'private'), 'base64');
  const n = provider.parseNotify({}, new URLSearchParams(params).toString());
  assert.deepEqual([n.paid, n.amountFen, n.outTradeNo, n.ackBody], [true, 1234, 'NP1', 'success']);
});

test('alipay notify with a tampered amount is rejected', () => {
  const provider = new AlipayProvider({ appId: 'app1', privateKeyPem: pem(merchant.privateKey, 'private'), alipayPublicKeyPem: pem(remote.publicKey, 'public') });
  const params: Record<string, string> = { app_id: 'app1', out_trade_no: 'NP1', trade_no: 'T9', total_amount: '12.34', trade_status: 'TRADE_SUCCESS', notify_id: 'n1', sign_type: 'RSA2' };
  params.sign = createSign('RSA-SHA256').update(canonicalString(params, true)).sign(pem(remote.privateKey, 'private'), 'base64');
  params.total_amount = '0.01';
  assert.throws(() => provider.parseNotify({}, new URLSearchParams(params).toString()), /bad alipay signature/);
});

function wechatNotify(apiV3Key: string, plain: object) {
  const nonce = randomBytes(6).toString('hex'); // 12 chars
  const aad = 'transaction';
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(apiV3Key), Buffer.from(nonce));
  cipher.setAAD(Buffer.from(aad));
  const enc = Buffer.concat([cipher.update(JSON.stringify(plain), 'utf8'), cipher.final()]);
  const ciphertext = Buffer.concat([enc, cipher.getAuthTag()]).toString('base64');
  const body = JSON.stringify({ id: 'evt1', resource: { ciphertext, nonce, associated_data: aad } });
  const ts = '1700000000';
  const rn = 'abc';
  const signature = createSign('RSA-SHA256').update(`${ts}\n${rn}\n${body}\n`).sign(pem(remote.privateKey, 'private'), 'base64');
  return { body, headers: { 'wechatpay-timestamp': ts, 'wechatpay-nonce': rn, 'wechatpay-signature': signature } };
}

test('wechat notify verifies the signature and decrypts the AES-GCM resource', () => {
  const key = '0123456789abcdef0123456789abcdef';
  const provider = new WechatProvider({ appId: 'a', mchId: 'm', serialNo: 's', apiV3Key: key, privateKeyPem: pem(merchant.privateKey, 'private'), platformPublicKeyPem: pem(remote.publicKey, 'public') });
  const { body, headers } = wechatNotify(key, { out_trade_no: 'NP2', transaction_id: 'wx9', trade_state: 'SUCCESS', amount: { total: 5600 } });
  const n = provider.parseNotify(headers, body);
  assert.deepEqual([n.paid, n.amountFen, n.outTradeNo, n.providerRef], [true, 5600, 'NP2', 'wx9']);
});

test('wechat notify with a wrong signature is rejected', () => {
  const key = '0123456789abcdef0123456789abcdef';
  const provider = new WechatProvider({ appId: 'a', mchId: 'm', serialNo: 's', apiV3Key: key, privateKeyPem: pem(merchant.privateKey, 'private'), platformPublicKeyPem: pem(remote.publicKey, 'public') });
  const { body, headers } = wechatNotify(key, { out_trade_no: 'NP2', transaction_id: 'wx9', trade_state: 'SUCCESS', amount: { total: 5600 } });
  assert.throws(() => provider.parseNotify({ ...headers, 'wechatpay-nonce': 'other' }, body), /bad wechatpay signature/);
});
