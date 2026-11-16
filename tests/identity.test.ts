// Reading who the session is from a row, called directly.

import { describe, expect, test } from 'claude-code/testing'

import { identityOf, mergeIdentity, routingIdentityOf } from '../hooks/identity.ts'

const ORG = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
const ACCOUNT = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'

describe('identityOf', () => {
  test('reads the four fields', () => {
    expect(identityOf({ 'organization.id': ORG, 'user.account_uuid': ACCOUNT, 'user.email': 'a.b+c@example.co.uk', 'user.id': 'abc123' }))
      .toEqual({ organizationId: ORG, accountUuid: ACCOUNT, email: 'a.b+c@example.co.uk', deviceId: 'abc123' })
  })

  const rejected: [string, unknown][] = [
    ['organization.id', 'not-a-uuid'],
    ['organization.id', 7],
    ['user.account_uuid', `${ACCOUNT}x`],
    ['user.email', 'no-at-sign'],
    ['user.email', 'two@@example.com'],
    ['user.email', 'a b@example.com'],
    ['user.email', 'a@nodot'],
    ['user.email', `${'a'.repeat(250)}@example.com`],
    ['user.email', 'a@example.com\n'],
    ['user.id', ''],
    ['user.id', 'has space'],
    ['user.id', 'x'.repeat(129)],
    ['user.id', ['array']],
  ]
  for (const [attribute, value] of rejected) {
    test(`ignores ${attribute}=${JSON.stringify(value).slice(0, 40)}`, () => {
      expect(identityOf({ [attribute]: value })).toEqual({})
    })
  }

  test('an inherited property is not read', () => {
    const attributes = Object.create({ 'user.email': 'proto@example.com' }) as Record<string, unknown>
    expect(identityOf(attributes)).toEqual({})
  })
})

describe('mergeIdentity', () => {
  test('answers the held object itself when nothing changed', () => {
    const held = { organizationId: ORG, email: 'a@example.com' }
    expect(mergeIdentity(held, { email: 'a@example.com' })).toBe(held)
    expect(mergeIdentity(held, {})).toBe(held)
  })

  test('adds and replaces, never removes', () => {
    const held = { organizationId: ORG, email: 'a@example.com' }
    expect(mergeIdentity(held, { email: 'b@example.com', deviceId: 'd1' })).toEqual({ organizationId: ORG, email: 'b@example.com', deviceId: 'd1' })
    expect(held).toEqual({ organizationId: ORG, email: 'a@example.com' })
  })
})

describe('routingIdentityOf', () => {
  const cases: [string, Record<string, unknown>, string | undefined][] = [
    ['an organization and an email', { 'organization.id': ORG, 'user.email': 'a@example.com', 'user.id': 'd1' }, `${ORG} a@example.com`],
    ['an organization alone (an API key, with OTEL_RESOURCE_ATTRIBUTES)', { 'organization.id': ORG }, undefined],
    ['an email alone', { 'user.email': 'a@example.com' }, undefined],
    ['neither (a cloud provider)', { 'session.id': 's' }, undefined],
    ['an organization not of its shape', { 'organization.id': 'org-1', 'user.email': 'a@example.com' }, undefined],
    ['an email not of its shape', { 'organization.id': ORG, 'user.email': 'a@example.com\n' }, undefined],
    ['a key that would override the stored email', { 'organization.id': ORG, 'user.email': 'a@example.com', 'kiro.user.email': 'b@example.com' }, undefined],
  ]
  for (const [name, attributes, want] of cases) test(name, () => expect(routingIdentityOf(attributes)).toBe(want))
})
