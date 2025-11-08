export function validatePassword(password: string): string | null {
  const policy = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{8,}$/;
  if (!policy.test(String(password || ''))) {
    return 'Password must be at least 8 characters and include uppercase, lowercase, number, and symbol.';
  }
  return null;
}


