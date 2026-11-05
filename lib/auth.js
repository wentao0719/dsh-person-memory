// Authorization for person-memory tools.
// A session may only touch the person bound to it; group sessions may only read public.
export function resolvePersonAccess(binding, requested) {
  const bound = String(binding?.personId ?? '').trim();
  const req = String(requested ?? '').trim();
  if (!bound) return { ok: false, reason: 'no-binding' };
  if (req && req !== bound) return { ok: false, reason: 'cross-person-denied' };
  return { ok: true, personId: bound, binding };
}

export function resolveRecallAudience(binding, requested) {
  const bound = binding?.audience === 'group' ? 'group' : 'private';
  const req = String(requested ?? '').trim();
  if (req && req !== bound) return { ok: false, reason: 'audience-denied' };
  return {
    ok: true,
    audience: bound,
    audienceKey: String(binding?.audienceKey ?? ''),
  };
}

export function resolveStatusPerson(binding, requested) {
  const bound = String(binding?.personId ?? '').trim();
  const req = String(requested ?? '').trim();
  if (!bound) {
    if (req) return { ok: false, reason: 'no-binding' };
    return { ok: true, personId: '' }; // aggregate stats only
  }
  if (req && req !== bound) return { ok: false, reason: 'cross-person-denied' };
  return { ok: true, personId: bound };
}
