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

  it('uses the phone number for legacy iMessage contacts', () => {
    expect(resolveContactDestination(contact, 'imessage')).toBe('+14127087088');
  });

  it('does not use email fallback for text messages', () => {
    expect(resolveContactDestination({ email: 'seth@example.com' }, 'imessage')).toBe('');
  });

  it('uses phone numbers only for SMS and RCS', () => {
    expect(resolveContactDestination(contact, 'sms')).toBe('+14127087088');
    expect(resolveContactDestination(contact, 'rcs')).toBe('+14127087088');
    expect(resolveContactDestination({ email: 'seth@example.com' }, 'sms')).toBe('');
    expect(resolveContactDestination({ email: 'seth@example.com' }, 'rcs')).toBe('');
  });
});
