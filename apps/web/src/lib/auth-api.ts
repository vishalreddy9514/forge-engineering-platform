import {
  AuthResponse,
  type LoginRequest,
  type PasswordResetConfirm,
  type RegisterRequest,
  UserProfile,
} from '@forge/types';

import { apiFetch, apiJson, setAccessToken } from './api';

const post = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });

async function startSession(path: string, body: unknown): Promise<AuthResponse> {
  const session = await apiJson(path, AuthResponse, post(body), { auth: false });
  setAccessToken(session.accessToken);
  return session;
}

export const authApi = {
  login: (body: LoginRequest) => startSession('/auth/login', body),
  register: (body: RegisterRequest) => startSession('/auth/register', body),
  async logout(): Promise<void> {
    try {
      await apiFetch('/auth/logout', { method: 'POST' }, { auth: false });
    } finally {
      setAccessToken(null);
    }
  },
  me: () => apiJson('/users/me', UserProfile),
  async requestPasswordReset(email: string): Promise<void> {
    await apiFetch('/auth/password-reset/request', post({ email }), { auth: false });
  },
  async confirmPasswordReset(body: PasswordResetConfirm): Promise<void> {
    await apiFetch('/auth/password-reset/confirm', post(body), { auth: false });
  },
};
