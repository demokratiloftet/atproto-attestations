import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readConfig} from '../src/config.mjs';

test('local defaults listen only on loopback and cannot claim a public origin', () => {
  assert.equal(readConfig({}).host, '127.0.0.1');
  assert.throws(() => readConfig({ISSUER_ORIGIN: 'https://issuer.example'}), /loopback/);
});

test('an empty token cannot authorize requests with no credentials', () => {
  assert.throws(() => readConfig({ISSUER_CLIENTS_JSON: JSON.stringify([
    {id: 'test', token: '', scopes: ['admin']},
  ])}), /nonempty token/);
});
