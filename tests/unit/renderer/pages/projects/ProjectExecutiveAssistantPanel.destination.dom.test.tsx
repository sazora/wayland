import { describe, expect, it } from 'vitest';
import { resolveContactDestination } from '@/renderer/pages/projects/components/ProjectExecutiveAssistantPanel';

describe('resolveContactDestination', () => {
  const contact = {
    email: 'seth@example.com',
    phone: '+14127087088',
  };

  it('uses the email address for email messages', () => {
    expect(resolveContactDestination(contact, 'email')).toBe('seth@example.com');
  });

  it('uses the phone number for iMessage when one is available', () => {
    expect(resolveContactDestination(contact, 'imessage')).toBe('+14127087088');
  });

  it('falls back to email for iMessage contacts without a phone number', () => {
    expect(resolveContactDestination({ email: 'seth@example.com' }, 'imessage')).toBe('seth@example.com');
  });

  it('uses phone numbers only for SMS and RCS', () => {
    expect(resolveContactDestination(contact, 'sms')).toBe('+14127087088');
    expect(resolveContactDestination(contact, 'rcs')).toBe('+14127087088');
    expect(resolveContactDestination({ email: 'seth@example.com' }, 'sms')).toBe('');
    expect(resolveContactDestination({ email: 'seth@example.com' }, 'rcs')).toBe('');
  });
});
